-- Guarda de aprobación: los débitos del asiento se comparan también contra el subtotal efectivo (renglones),
-- como hace la app (src/lib/source-values.ts: subtotalEfectivo). Caso: PDF leído con subtotal bruto y descuento
-- aparte mientras los renglones y el asiento ya van netos. Idempotente (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.validate_source_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s jsonb; v numeric; field text; n integer; tol numeric; lsum numeric; sub_eff numeric; deb numeric; ext numeric;
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
-- Subtotal efectivo (igual que subtotalEfectivo en la app): si el subtotal impreso no cuadra con los renglones pero
-- renglones + impuestos + recargo = total, los renglones son la base real (descuento ya aplicado / subtotal bruto del PDF).
tol := least(100, ceil(jsonb_array_length(s->'lines') / 2.0));
SELECT coalesce(sum((x->>'subtotal')::numeric),0) INTO lsum FROM jsonb_array_elements(s->'lines') x;
sub_eff := (s->>'subtotal')::numeric;
IF abs(lsum - sub_eff) > tol AND jsonb_array_length(s->'lines') > 0
   AND abs(lsum + (s->>'iva')::numeric + (s->>'impoconsumo')::numeric + (s->>'surcharge')::numeric - (s->>'total')::numeric) <= tol + 1 THEN
  sub_eff := lsum;
END IF;
deb := round(v*100);
ext := (s->>'iva')::numeric+(s->>'impoconsumo')::numeric;
-- El recargo global del documento también es un débito del asiento.
-- (un recargo de $1 o menos puede ir, en cambio, al ajuste al peso 42958101).
IF deb <> (s->>'subtotal')::numeric+ext+(s->>'surcharge')::numeric
   AND deb <> sub_eff+ext+(s->>'surcharge')::numeric
   AND NOT (deb = (s->>'subtotal')::numeric+ext AND abs((s->>'surcharge')::numeric)<=100)
   AND NOT (deb = sub_eff+ext AND abs((s->>'surcharge')::numeric)<=100)
   AND NOT (EXISTS(SELECT 1 FROM public.journal_lines WHERE invoice_id=NEW.id AND account_code='42958101')
            AND (abs(deb-((s->>'subtotal')::numeric+ext+(s->>'surcharge')::numeric))<=100
              OR abs(deb-(sub_eff+ext+(s->>'surcharge')::numeric))<=100))
THEN RAISE EXCEPTION 'Diferencia con la fuente: los débitos no conservan los valores'; END IF;
END IF;
RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_source_approval() FROM PUBLIC,anon,authenticated;