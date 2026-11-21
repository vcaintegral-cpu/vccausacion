-- Guarda de valores de origen: el IVA (e INC) de los renglones puede diferir del del documento hasta medio peso por
-- renglón (tope $2), porque el proveedor redondea el impuesto a pesos enteros (5.042 × 19 % = 957,98; factura 958).
-- Misma tolerancia que src/lib/source-values.ts. El subtotal conserva la de 0041. Idempotente (CREATE OR REPLACE).

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
    IF abs(v - (s->>field)::numeric) > least(200, greatest(1, 50 * jsonb_array_length(s->'lines'))) AND NOT (field = 'impoconsumo' AND v = 0) THEN RAISE EXCEPTION 'Diferencia con la fuente: suma de % de las líneas',field; END IF;
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
REVOKE ALL ON FUNCTION public.guard_invoice_source_values() FROM PUBLIC,anon,authenticated;
