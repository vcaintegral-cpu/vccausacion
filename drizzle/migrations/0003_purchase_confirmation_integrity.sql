CREATE OR REPLACE FUNCTION public.confirm_excel_purchase_validated(_item_id uuid, _actor uuid, _choices jsonb, _journal jsonb, _retentions jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE company uuid; result uuid;
BEGIN
 SELECT company_id INTO company FROM public.purchase_import_items WHERE id=_item_id;
 IF _actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=company AND user_id=_actor) THEN RAISE EXCEPTION 'Acceso no autorizado'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(company::text,0));
 PERFORM set_config('request.jwt.claim.sub',_actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',_actor,'role','service_role')::text,true);
 result := public.confirm_excel_purchase(_item_id,_choices,_journal,_retentions);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.confirm_excel_purchase_validated(uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_excel_purchase_validated(uuid,uuid,jsonb,jsonb,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.protect_purchase_confirmation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  IF NEW.invoice_id IS NOT NULL OR NEW.status='completed' THEN RAISE EXCEPTION 'Confirme la compra mediante la validación contable'; END IF;
  IF TG_OP='UPDATE' AND OLD.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'Una compra confirmada no se puede modificar'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_confirmation_guard BEFORE INSERT OR UPDATE ON public.purchase_import_items FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_confirmation();
REVOKE ALL ON FUNCTION public.protect_purchase_confirmation() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.protect_purchase_confirmation() TO service_role;
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.confirm_excel_purchase(uuid,jsonb,jsonb,jsonb)'::regprocedure) INTO definition;
 definition := replace(definition, 'provider_nit=h->>''provider_nit'' AND import_source IS DISTINCT FROM ''excel_credit_note''', 'regexp_replace(split_part(provider_nit,''-'',1),''[^0-9]'','''',''g'')=regexp_replace(h->>''provider_nit'',''[^0-9]'','''',''g'') AND status IN (''causada'',''sincronizada'',''historico'') AND import_source IS DISTINCT FROM ''excel_credit_note''');
 EXECUTE definition;
END $migration$;