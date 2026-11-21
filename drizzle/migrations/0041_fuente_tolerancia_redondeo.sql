-- Guardas de valores de origen: misma tolerancia de redondeo que la validación de la app (src/lib/source-values.ts).
-- 1) La suma de renglones puede diferir del subtotal/IVA del documento hasta ~medio centavo por renglón (tope $1):
--    precios unitarios con 3 decimales redondean cada renglón a centavos.
-- 2) Si los renglones + impuestos + recargo dan el total del documento, los renglones son la base real
--    (descuento ya aplicado en los renglones o subtotal bruto leído del PDF).
-- 3) El total del documento manda: cuadra con o sin restar el descuento (en el Excel de recibidos el subtotal ya es neto).
-- 4) Con ajuste al peso (42958101) en el asiento, los débitos pueden diferir del subtotal + IVA hasta $1.
-- Idempotente (CREATE OR REPLACE). Lo demás queda exactamente igual a 0024.

CREATE OR REPLACE FUNCTION public.guard_invoice_source_values() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s jsonb; v numeric; d numeric; c numeric; field text; tol numeric; sub_eff numeric; desc_ef numeric;
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
   tol := least(100, ceil(jsonb_array_length(s->'lines') / 2.0));
   SELECT coalesce(sum((x->>'subtotal')::numeric),0) INTO v FROM jsonb_array_elements(s->'lines') x;
   sub_eff := (s->>'subtotal')::numeric;
   IF abs(v - sub_eff) > tol AND jsonb_array_length(s->'lines') > 0
      AND abs(v + (s->>'iva')::numeric + (s->>'impoconsumo')::numeric + (s->>'surcharge')::numeric - (s->>'total')::numeric) <= tol + 1 THEN
    sub_eff := v;
   END IF;
   IF abs(v - sub_eff) > tol THEN RAISE EXCEPTION 'Diferencia con la fuente: suma de subtotal de las líneas'; END IF;
   FOREACH field IN ARRAY ARRAY['iva','impoconsumo'] LOOP
    SELECT coalesce(sum((x->>field)::numeric),0) INTO v FROM jsonb_array_elements(s->'lines') x;
    -- INC solo en el total del documento: las líneas no lo discriminan (suma 0).
    IF abs(v - (s->>field)::numeric) > tol AND NOT (field = 'impoconsumo' AND v = 0) THEN RAISE EXCEPTION 'Diferencia con la fuente: suma de % de las líneas',field; END IF;
   END LOOP;
   desc_ef := CASE WHEN sub_eff = (s->>'subtotal')::numeric THEN (s->>'discount')::numeric ELSE 0 END;
   IF abs(sub_eff+(s->>'iva')::numeric+(s->>'impoconsumo')::numeric+(s->>'surcharge')::numeric-desc_ef-(s->>'total')::numeric)>100
      AND abs(sub_eff+(s->>'iva')::numeric+(s->>'impoconsumo')::numeric+(s->>'surcharge')::numeric-(s->>'total')::numeric)>100 THEN
    RAISE EXCEPTION 'Diferencia con la fuente: total del documento';
   END IF;
   SELECT coalesce(sum(debit),0),coalesce(sum(credit),0) INTO d,c FROM public.journal_lines WHERE invoice_id=NEW.id;
   IF round(d*100) <> round(c*100) OR d=0 THEN RAISE EXCEPTION 'Diferencia con la fuente: asiento no cuadrado'; END IF;
   SELECT coalesce(sum(credit),0) INTO v FROM public.journal_lines WHERE invoice_id=NEW.id AND account_code ~ '^(22|23|1330)';
   IF round(v*100) <> (s->>'total')::numeric THEN RAISE EXCEPTION 'Diferencia con la fuente: retenciones + anticipo + CxP'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

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
-- El recargo global del documento también es un débito del asiento.
-- (un recargo de $1 o menos puede ir, en cambio, al ajuste al peso 42958101).
IF round(v*100)<>(s->>'subtotal')::numeric+(s->>'iva')::numeric+(s->>'impoconsumo')::numeric+(s->>'surcharge')::numeric
   AND NOT (round(v*100)=(s->>'subtotal')::numeric+(s->>'iva')::numeric+(s->>'impoconsumo')::numeric AND abs((s->>'surcharge')::numeric)<=100)
   AND NOT (EXISTS(SELECT 1 FROM public.journal_lines WHERE invoice_id=NEW.id AND account_code='42958101')
            AND abs(round(v*100)-((s->>'subtotal')::numeric+(s->>'iva')::numeric+(s->>'impoconsumo')::numeric+(s->>'surcharge')::numeric))<=100)
THEN RAISE EXCEPTION 'Diferencia con la fuente: los débitos no conservan los valores'; END IF;
END IF;
RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_invoice_source_values(), public.validate_source_approval() FROM PUBLIC,anon,authenticated;
