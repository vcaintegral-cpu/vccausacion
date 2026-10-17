ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS source_values jsonb;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS source_override jsonb;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS value_modified boolean NOT NULL DEFAULT false;
CREATE TABLE public.invoice_value_changes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES public.invoices(id), company_id uuid NOT NULL REFERENCES public.companies(id), previous_values jsonb NOT NULL, new_values jsonb NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) > 0), changed_by uuid NOT NULL, changed_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.invoice_value_changes TO authenticated;
GRANT ALL ON public.invoice_value_changes TO service_role;
ALTER TABLE public.invoice_value_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_value_audit_read ON public.invoice_value_changes FOR SELECT TO authenticated USING(public.is_company_member(company_id));
CREATE OR REPLACE FUNCTION public.guard_invoice_source_values() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s jsonb; v numeric; d numeric; c numeric; field text;
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.source_values := NEW.raw_extraction->'valores_origen';
 ELSE
  IF OLD.source_values IS NOT NULL AND NEW.source_values IS DISTINCT FROM OLD.source_values THEN RAISE EXCEPTION 'Los valores de origen son inmutables'; END IF;
  IF OLD.source_values IS NULL THEN NEW.source_values := NEW.raw_extraction->'valores_origen'; END IF;
  IF (NEW.source_override IS DISTINCT FROM OLD.source_override OR NEW.value_modified IS DISTINCT FROM OLD.value_modified) AND coalesce(current_setting('app.correct_invoice_values',true),'') <> NEW.id::text THEN RAISE EXCEPTION 'Corrija valores con permiso y motivo'; END IF;
 END IF;
 s := coalesce(NEW.source_override, NEW.source_values);
 IF s IS NOT NULL THEN
  FOREACH field IN ARRAY ARRAY['subtotal','iva','impoconsumo','discount','total'] LOOP
   v := (to_jsonb(NEW)->>field)::numeric;
   IF round(v*100) <> (s->>field)::numeric THEN RAISE EXCEPTION 'Diferencia con la fuente: %', field; END IF;
  END LOOP;
  IF NEW.status IN ('aprobado','causada') AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
   FOREACH field IN ARRAY ARRAY['subtotal','iva','impoconsumo'] LOOP
    SELECT coalesce(sum((x->>field)::numeric),0) INTO v FROM jsonb_array_elements(s->'lines') x;
    IF v <> (s->>field)::numeric THEN RAISE EXCEPTION 'Diferencia con la fuente: suma de % de las líneas',field; END IF;
   END LOOP;
   IF abs((s->>'subtotal')::numeric+(s->>'iva')::numeric+(s->>'impoconsumo')::numeric-(s->>'discount')::numeric+(s->>'surcharge')::numeric-(s->>'total')::numeric)>100 THEN RAISE EXCEPTION 'Diferencia con la fuente: total del documento'; END IF;
   SELECT coalesce(sum(debit),0),coalesce(sum(credit),0) INTO d,c FROM public.journal_lines WHERE invoice_id=NEW.id;
   IF round(d*100) <> round(c*100) OR d=0 THEN RAISE EXCEPTION 'Diferencia con la fuente: asiento no cuadrado'; END IF;
   SELECT coalesce(sum(credit),0) INTO v FROM public.journal_lines WHERE invoice_id=NEW.id AND account_code ~ '^(22|23|1330)';
   IF round(v*100) <> (s->>'total')::numeric THEN RAISE EXCEPTION 'Diferencia con la fuente: retenciones + anticipo + CxP'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_source_invoice BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_source_values();
CREATE OR REPLACE FUNCTION public.guard_source_invoice_line() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s jsonb; l jsonb; inv uuid;
BEGIN
 inv:=NEW.invoice_id;
 SELECT coalesce(source_override,source_values) INTO s FROM public.invoices WHERE id=inv;
 IF s IS NULL THEN RETURN NEW; END IF;
 l:=s->'lines'->NEW.position;
 IF l IS NULL OR round(NEW.total*100)<>(l->>'subtotal')::numeric OR round(NEW.iva*100)<>(l->>'iva')::numeric OR round(NEW.impoconsumo*100)<>(l->>'impoconsumo')::numeric THEN RAISE EXCEPTION 'Los valores e impuestos de la línea son de solo lectura'; END IF;
 IF TG_OP='UPDATE' AND (NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.unit_value IS DISTINCT FROM OLD.unit_value OR NEW.discount IS DISTINCT FROM OLD.discount) AND coalesce(current_setting('app.correct_invoice_values',true),'') <> inv::text THEN RAISE EXCEPTION 'Los valores de la línea son de solo lectura'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_source_line BEFORE INSERT OR UPDATE ON public.invoice_lines FOR EACH ROW EXECUTE FUNCTION public.guard_source_invoice_line();
CREATE OR REPLACE FUNCTION public.correct_invoice_source_values(_invoice_id uuid,_values jsonb,_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE i public.invoices%ROWTYPE;
BEGIN
 SELECT * INTO i FROM public.invoices WHERE id=_invoice_id FOR UPDATE;
 IF NOT FOUND OR NOT public.is_company_admin(i.company_id) THEN RAISE EXCEPTION 'No tiene permiso para corregir valores'; END IF;
 IF i.status<>'borrador' OR i.siigo_id IS NOT NULL THEN RAISE EXCEPTION 'Solo se corrigen borradores sin enviar'; END IF;
 IF length(trim(coalesce(_reason,'')))=0 THEN RAISE EXCEPTION 'El motivo es obligatorio'; END IF;
 IF jsonb_typeof(_values->'lines')<>'array' OR (_values->>'total')::numeric<=0 THEN RAISE EXCEPTION 'Valores inválidos'; END IF;
 PERFORM set_config('app.correct_invoice_values',i.id::text,true);
 INSERT INTO public.invoice_value_changes(invoice_id,company_id,previous_values,new_values,reason,changed_by) VALUES(i.id,i.company_id,coalesce(i.source_override,i.source_values),_values,trim(_reason),auth.uid());
 UPDATE public.invoices SET source_override=_values,value_modified=true,subtotal=(_values->>'subtotal')::numeric/100,iva=(_values->>'iva')::numeric/100,impoconsumo=(_values->>'impoconsumo')::numeric/100,discount=(_values->>'discount')::numeric/100,total=(_values->>'total')::numeric/100,posting_error='Valor modificado manualmente: revise y recalcule el asiento' WHERE id=i.id;
 UPDATE public.invoice_lines SET total=(_values->'lines'->position->>'subtotal')::numeric/100,iva=(_values->'lines'->position->>'iva')::numeric/100,impoconsumo=(_values->'lines'->position->>'impoconsumo')::numeric/100,unit_value=((_values->'lines'->position->>'subtotal')::numeric/100+discount)/nullif(quantity,0) WHERE invoice_id=i.id;
END $$;
REVOKE ALL ON FUNCTION public.correct_invoice_source_values(uuid,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.correct_invoice_source_values(uuid,jsonb,text) TO authenticated;
REVOKE ALL ON FUNCTION public.guard_invoice_source_values(),public.guard_source_invoice_line() FROM PUBLIC,anon,authenticated;