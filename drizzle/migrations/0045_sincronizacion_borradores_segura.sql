-- Scope: all companies. No invoice values are changed; new events record exact undo state.
CREATE OR REPLACE FUNCTION public.draft_sync_state_v2(_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
SELECT jsonb_build_object(
 'invoice', (SELECT to_jsonb(i) FROM public.invoices i WHERE i.id=_id),
 'lines', coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.invoice_lines l WHERE l.invoice_id=_id),'[]'::jsonb),
 'journal', coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM public.journal_lines j WHERE j.invoice_id=_id),'[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.draft_sync_state_v2(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_provider_drafts_v2(
 _source_invoice_id uuid, _changes jsonb, _event_key text, _known jsonb,
 _plans jsonb DEFAULT '[]'::jsonb, _inventory_enabled boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 src public.invoices%ROWTYPE; evt public.draft_sync_events%ROWTYPE; r public.invoices%ROWTYPE;
 l public.invoice_lines%ROWTYPE; s public.invoice_lines%ROWTYPE;
 nit text; c jsonb; p jsonb; plan jsonb; before_state jsonb; after_state jsonb;
 v_affected jsonb := '[]'; v_conflicts jsonb := '[]'; general_changes jsonb;
 known_time timestamptz; rows_changed integer; k integer; count_changed integer := 0;
 account text; old_account text; item text; product text; decision jsonb; raw jsonb;
 source_product jsonb; account_change boolean; type_change boolean; label text;
BEGIN
 SELECT * INTO src FROM public.invoices WHERE id=_source_invoice_id FOR UPDATE;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_company_member(src.company_id) THEN
  RETURN jsonb_build_object('ok',false,'message','No tiene permiso sobre la factura de origen.');
 END IF;
 IF coalesce(btrim(_event_key),'')='' THEN RAISE EXCEPTION 'Falta identificador del evento'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_event_key,0));
 SELECT * INTO evt FROM public.draft_sync_events WHERE event_key=_event_key;
 IF FOUND THEN
  IF evt.company_id<>src.company_id OR evt.source_invoice_id<>src.id THEN RAISE EXCEPTION 'Evento no autorizado'; END IF;
  RETURN jsonb_build_object('ok',true,'already',true,'event_id',evt.id,'updated',evt.invoice_count,'conflicts',evt.conflicts);
 END IF;
 nit := regexp_replace(split_part(coalesce(src.provider_nit,''),'-',1),'\D','','g');
 IF nit='' THEN RAISE EXCEPTION 'Falta NIT del proveedor'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(_changes) LOOP
  IF c->>'kind' NOT IN ('gasto','tipo','iva','retefuente','reteiva','reteica','otras','payable','cost_center') THEN
   RAISE EXCEPTION 'Cambio no permitido';
  END IF;
  IF c->>'kind'='tipo' THEN
   IF c->>'new' NOT IN ('gasto','producto','costo','servicio') THEN RAISE EXCEPTION 'Clasificación no válida'; END IF;
   CONTINUE;
  END IF;
  IF c->>'kind'='cost_center' THEN CONTINUE; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.puc_accounts a WHERE a.company_id=src.company_id
    AND btrim(a.code)=c->>'new' AND coalesce(a.active,true) AND coalesce(a.is_movement,true)) THEN
   RAISE EXCEPTION 'La cuenta de destino no está habilitada en el PUC de la empresa';
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value),'[]') INTO general_changes FROM jsonb_array_elements(_changes)
 WHERE value->>'kind' NOT IN ('gasto','tipo');
 INSERT INTO public.draft_sync_events(company_id,provider_nit,provider_name,source_invoice_id,source_label,action,changes,event_key,created_by)
 VALUES(src.company_id,src.provider_nit,src.provider_name,src.id,concat_ws('-',src.prefix,src.number),'todos_v2',_changes,_event_key,auth.uid()) RETURNING * INTO evt;
 FOR r IN SELECT i.* FROM public.invoices i WHERE i.company_id=src.company_id AND i.id<>src.id
  AND i.status='borrador' AND i.voucher_number IS NULL AND i.siigo_id IS NULL AND i.siigo_number IS NULL
  AND coalesce(i.siigo_status,'')<>'sincronizada'
  AND regexp_replace(split_part(coalesce(i.provider_nit,''),'-',1),'\D','','g')=nit ORDER BY i.id FOR UPDATE LOOP
  SELECT (value->>'updated_at')::timestamptz INTO known_time FROM jsonb_array_elements(_known) WHERE value->>'id'=r.id::text;
  label := coalesce(nullif(concat_ws('-',r.prefix,r.number),''),'Sin número');
  IF known_time IS NULL OR known_time<>r.updated_at THEN
   v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('invoice_id',r.id,'label',label,'message','El borrador cambió; vuelva a abrirlo antes de sincronizar.'));
   CONTINUE;
  END IF;
  PERFORM 1 FROM public.invoice_lines WHERE invoice_id=r.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.journal_lines WHERE invoice_id=r.id ORDER BY id FOR UPDATE;
  before_state := public.draft_sync_state_v2(r.id);
  rows_changed := public.apply_draft_sync_changes(r.id,general_changes,false);
  SELECT value INTO plan FROM jsonb_array_elements(_plans) WHERE value->>'invoice_id'=r.id::text;
  raw := coalesce(r.raw_extraction,'{}');
  FOR p IN SELECT value FROM jsonb_array_elements(coalesce(plan->'lines','[]')) LOOP
   SELECT * INTO l FROM public.invoice_lines WHERE id=(p->>'id')::uuid AND invoice_id=r.id;
   IF NOT FOUND OR l.position<>(p->>'position')::integer OR l.account_code IS DISTINCT FROM p->>'old_account' THEN
    RAISE EXCEPTION 'El renglón cambió; no se aplicó la sincronización';
   END IF;
   account := btrim(p->>'account_code'); old_account := btrim(coalesce(l.account_code,''));
   item := p->>'item_type'; product := p->>'code';
   SELECT * INTO s FROM public.invoice_lines WHERE invoice_id=src.id AND btrim(account_code)=account ORDER BY position LIMIT 1;
   IF NOT FOUND THEN RAISE EXCEPTION 'La cuenta no coincide con la factura de origen'; END IF;
   account_change := EXISTS(SELECT 1 FROM jsonb_array_elements(_changes) AS ch(value) WHERE ch.value->>'kind'='gasto' AND ch.value->>'new'=account
    AND (ch.value->>'old'=old_account OR (old_account='' AND (SELECT count(*) FROM jsonb_array_elements(_changes) x WHERE x->>'kind'='gasto')=1)));
   type_change := EXISTS(SELECT 1 FROM jsonb_array_elements(_changes) AS ch(value) WHERE ch.value->>'kind'='tipo'
    AND ch.value->>'new'=item AND (ch.value->>'old'=l.item_type OR account_change));
   IF NOT account_change AND NOT (type_change AND account=old_account) THEN RAISE EXCEPTION 'Renglón no elegible para el cambio'; END IF;
   IF old_account LIKE '14%' AND account NOT LIKE '14%' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(_changes) AS ch(value) WHERE ch.value->>'kind'='gasto' AND ch.value->>'old'=old_account AND ch.value->>'new'=account
   ) THEN RAISE EXCEPTION 'La cuenta de inventario no se puede reemplazar implícitamente'; END IF;
   IF account !~ '^(5|6|7|15|16|17)[0-9]*$' AND NOT (_inventory_enabled AND account ~ '^14[0-9]+$') THEN
    RAISE EXCEPTION 'Cuenta de gasto, costo o inventario no válida';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.puc_accounts a WHERE a.company_id=src.company_id AND btrim(a.code)=account
    AND coalesce(a.active,true) AND coalesce(a.is_movement,true)) THEN RAISE EXCEPTION 'Cuenta no habilitada'; END IF;
   IF item NOT IN ('gasto','producto','costo','servicio') OR (NOT type_change AND item IS DISTINCT FROM s.item_type) THEN
    RAISE EXCEPTION 'La clasificación no coincide con el cambio confirmado';
   END IF;
   IF item='producto' AND product IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.products pr WHERE pr.company_id=src.company_id AND pr.code=product AND coalesce(pr.active,true)
   ) AND product IS DISTINCT FROM s.code THEN RAISE EXCEPTION 'Producto no disponible en la empresa'; END IF;
   -- Preserve stored amounts. Only move the shared engine's existing debit, never compute new values.
   IF old_account<>account THEN
    UPDATE public.journal_lines SET account_code=account,account_name=p->>'account_name'
     WHERE invoice_id=r.id AND btrim(coalesce(account_code,''))=old_account AND coalesce(debit,0)>0;
    GET DIAGNOSTICS k=ROW_COUNT;
    IF k=0 AND NOT EXISTS(SELECT 1 FROM public.journal_lines WHERE invoice_id=r.id AND account_code=account AND debit>0) THEN
     RAISE EXCEPTION 'Falta el débito del renglón; recalcule el borrador antes de sincronizar';
    END IF;
   END IF;
   UPDATE public.invoice_lines SET account_code=account,account_name=p->>'account_name',item_type=item,code=product WHERE id=l.id;
   decision := jsonb_build_object('code',account,'name',p->>'account_name','origin','MANUAL','reason','Cambio confirmado por sincronización del proveedor.',
    'confidence','ALTA','score',1,'error',null,'itemType',item,'productCode',product);
   raw := jsonb_set(raw,'{account_decisions}',coalesce(raw->'account_decisions','{}') || jsonb_build_object(l.position::text,decision),true);
   source_product := src.raw_extraction->'productos_nuevos'->s.position::text;
   raw := jsonb_set(raw,'{productos_nuevos}',(coalesce(raw->'productos_nuevos','{}') - l.position::text) ||
    CASE WHEN item='producto' AND source_product->>'codigo'=product THEN jsonb_build_object(l.position::text,source_product) ELSE '{}'::jsonb END,true);
   rows_changed := rows_changed+1;
  END LOOP;
  IF rows_changed>0 THEN
   UPDATE public.invoices SET raw_extraction=raw,sync_event_id=evt.id,sync_source_invoice_id=src.id,
    sync_source_label=evt.source_label,sync_applied_at=now() WHERE id=r.id;
   after_state := public.draft_sync_state_v2(r.id);
   v_affected := v_affected || jsonb_build_array(jsonb_build_object('invoice_id',r.id,'label',label,'before',before_state,'after',after_state));
   count_changed := count_changed+1;
  END IF;
 END LOOP;
 UPDATE public.draft_sync_events SET affected=v_affected,conflicts=v_conflicts,invoice_count=count_changed,
  result=count_changed || ' borrador(es) actualizados' WHERE id=evt.id;
 RETURN jsonb_build_object('ok',true,'event_id',evt.id,'updated',count_changed,'conflicts',v_conflicts);
END $$;
REVOKE ALL ON FUNCTION public.sync_provider_drafts_v2(uuid,jsonb,text,jsonb,jsonb,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sync_provider_drafts_v2(uuid,jsonb,text,jsonb,jsonb,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.undo_provider_draft_sync_v2(_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE evt public.draft_sync_events%ROWTYPE; a jsonb; b jsonb; x jsonb; r public.invoices%ROWTYPE; l public.invoice_lines%ROWTYPE;
 j public.journal_lines%ROWTYPE; prior public.invoices%ROWTYPE; n integer:=0;
BEGIN
 SELECT * INTO evt FROM public.draft_sync_events WHERE id=_event_id FOR UPDATE;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_company_member(evt.company_id) THEN
  RETURN jsonb_build_object('ok',false,'message','No tiene permiso sobre la sincronización.');
 END IF;
 IF evt.action<>'todos_v2' THEN RETURN public.undo_provider_draft_sync(_event_id); END IF;
 IF evt.undone_at IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'already',true,'restored',0,'message','La sincronización ya fue deshecha.'); END IF;
 -- Validate every document before restoring any: concurrent edits cannot be overwritten or partially undone.
 FOR a IN SELECT value FROM jsonb_array_elements(evt.affected) ORDER BY value->>'invoice_id' LOOP
  SELECT * INTO r FROM public.invoices WHERE id=(a->>'invoice_id')::uuid FOR UPDATE;
  IF NOT FOUND OR r.company_id<>evt.company_id OR r.status<>'borrador' OR r.siigo_id IS NOT NULL OR r.siigo_number IS NOT NULL OR r.voucher_number IS NOT NULL THEN
   RETURN jsonb_build_object('ok',false,'message','Un borrador ya no es editable. No se deshizo ningún cambio.');
  END IF;
  PERFORM 1 FROM public.invoice_lines WHERE invoice_id=r.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.journal_lines WHERE invoice_id=r.id ORDER BY id FOR UPDATE;
  IF public.draft_sync_state_v2(r.id) IS DISTINCT FROM a->'after' THEN
   RETURN jsonb_build_object('ok',false,'message','Un borrador fue modificado después. No se deshizo ningún cambio para conservar esa edición.');
  END IF;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(evt.affected) LOOP
  b:=a->'before';
  FOR x IN SELECT value FROM jsonb_array_elements(b->'lines') LOOP
   l:=jsonb_populate_record(NULL::public.invoice_lines,x);
   UPDATE public.invoice_lines SET account_code=l.account_code,account_name=l.account_name,item_type=l.item_type,code=l.code,description=l.description,
    iva_account_code=l.iva_account_code,iva_operational_account=l.iva_operational_account,
    ret_account_code=l.ret_account_code,ret_operational_account=l.ret_operational_account WHERE id=l.id;
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(b->'journal') LOOP
   j:=jsonb_populate_record(NULL::public.journal_lines,x);
   UPDATE public.journal_lines SET account_code=j.account_code,account_name=j.account_name,cost_center=j.cost_center WHERE id=j.id;
  END LOOP;
  prior:=jsonb_populate_record(NULL::public.invoices,b->'invoice');
  UPDATE public.invoices SET raw_extraction=prior.raw_extraction,cost_center=prior.cost_center,
   payable_account=prior.payable_account,payable_manual=prior.payable_manual,payable_source=prior.payable_source,
   payable_updated_at=prior.payable_updated_at,payable_updated_by=prior.payable_updated_by,
   sync_event_id=prior.sync_event_id,sync_source_invoice_id=prior.sync_source_invoice_id,
   sync_source_label=prior.sync_source_label,sync_applied_at=prior.sync_applied_at WHERE id=prior.id;
  n:=n+1;
 END LOOP;
 UPDATE public.draft_sync_events SET undone_at=now(),undone_by=auth.uid() WHERE id=evt.id;
 RETURN jsonb_build_object('ok',true,'restored',n,'message',n || ' borrador(es) restaurados a su configuración anterior.');
END $$;
REVOKE ALL ON FUNCTION public.undo_provider_draft_sync_v2(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.undo_provider_draft_sync_v2(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';