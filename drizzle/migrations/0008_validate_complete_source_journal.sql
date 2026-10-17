CREATE OR REPLACE FUNCTION public.validate_source_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s jsonb; v numeric; field text; n integer;
BEGIN
IF TG_OP='UPDATE' AND OLD.source_values IS NOT NULL AND NEW.raw_extraction->'valores_origen' IS DISTINCT FROM OLD.source_values THEN RAISE EXCEPTION 'La copia de origen no puede cambiar'; END IF;
IF TG_OP='INSERT' AND (NEW.source_override IS NOT NULL OR NEW.value_modified) THEN RAISE EXCEPTION 'Las correcciones requieren permiso y motivo'; END IF;
s:=coalesce(NEW.source_override,NEW.source_values);
IF s IS NULL THEN RETURN NEW; END IF;
FOREACH field IN ARRAY ARRAY['subtotal','iva','impoconsumo','discount','surcharge','total'] LOOP
IF NOT (s ? field) OR jsonb_typeof(s->field)<>'number' OR (s->>field)::numeric<>trunc((s->>field)::numeric) THEN RAISE EXCEPTION 'Origen inválido: % debe estar en centavos enteros',field; END IF;
END LOOP;
IF NEW.status IN ('aprobado','causada') AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
SELECT count(*) INTO n FROM public.invoice_lines WHERE invoice_id=NEW.id;
IF n<>jsonb_array_length(s->'lines') THEN RAISE EXCEPTION 'Diferencia con la fuente: faltan líneas'; END IF;
IF EXISTS(SELECT 1 FROM public.invoice_lines l WHERE l.invoice_id=NEW.id AND (s->'lines'->l.position IS NULL OR round(l.total*100)<>(s->'lines'->l.position->>'subtotal')::numeric OR round(l.iva*100)<>(s->'lines'->l.position->>'iva')::numeric OR round(l.impoconsumo*100)<>(s->'lines'->l.position->>'impoconsumo')::numeric)) THEN RAISE EXCEPTION 'Diferencia con la fuente: detalle modificado'; END IF;
SELECT coalesce(sum(debit),0) INTO v FROM public.journal_lines WHERE invoice_id=NEW.id AND account_code<>'42958101';
IF round(v*100)<>(s->>'subtotal')::numeric+(s->>'iva')::numeric+(s->>'impoconsumo')::numeric THEN RAISE EXCEPTION 'Diferencia con la fuente: los débitos no conservan los valores'; END IF;
END IF;
RETURN NEW;
END $$;
CREATE TRIGGER validate_complete_source BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.validate_source_approval();
REVOKE ALL ON FUNCTION public.validate_source_approval() FROM PUBLIC,anon,authenticated;
COMMENT ON COLUMN public.invoices.source_values IS 'Immutable original amounts in integer cents; invoice monetary columns remain currency units.';