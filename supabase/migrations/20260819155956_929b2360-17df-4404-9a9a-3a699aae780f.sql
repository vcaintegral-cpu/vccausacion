-- 1) Marcas de sincronización en la factura
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS sync_event_id uuid,
  ADD COLUMN IF NOT EXISTS sync_source_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS sync_source_label text,
  ADD COLUMN IF NOT EXISTS sync_applied_at timestamptz;

-- 2) Historial de sincronizaciones masivas
CREATE TABLE IF NOT EXISTS public.draft_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider_nit text,
  provider_name text,
  source_invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  source_label text,
  action text NOT NULL DEFAULT 'todos',
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  invoice_count integer NOT NULL DEFAULT 0,
  result text,
  event_key text NOT NULL UNIQUE,
  undone_at timestamptz,
  undone_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.draft_sync_events TO authenticated;
GRANT ALL ON public.draft_sync_events TO service_role;
ALTER TABLE public.draft_sync_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Miembros ven las sincronizaciones de su empresa" ON public.draft_sync_events;
CREATE POLICY "Miembros ven las sincronizaciones de su empresa"
  ON public.draft_sync_events FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Miembros registran sincronizaciones de su empresa" ON public.draft_sync_events;
CREATE POLICY "Miembros registran sincronizaciones de su empresa"
  ON public.draft_sync_events FOR INSERT TO authenticated
  WITH CHECK (public.is_company_member(company_id) AND created_by = auth.uid());

CREATE INDEX IF NOT EXISTS draft_sync_events_company_idx ON public.draft_sync_events (company_id, created_at DESC);

-- 3) Aplicador de cambios contables sobre UNA factura (solo configuración, nunca valores)
CREATE OR REPLACE FUNCTION public.apply_draft_sync_changes(_invoice_id uuid, _changes jsonb, _reverse boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  c jsonb;
  v_kind text; v_old text; v_new text; v_name text; v_tmp text;
  v_rows integer := 0; k integer;
BEGIN
  FOR c IN SELECT value FROM jsonb_array_elements(coalesce(_changes, '[]'::jsonb)) LOOP
    v_kind := c->>'kind';
    v_old := btrim(coalesce(c->>'old',''));
    v_new := btrim(coalesce(c->>'new',''));
    v_name := c->>'name';
    IF _reverse THEN v_tmp := v_old; v_old := v_new; v_new := v_tmp; END IF;
    IF v_new = '' OR v_new = v_old THEN CONTINUE; END IF;

    IF v_kind = 'gasto' THEN
      UPDATE public.invoice_lines SET account_code = v_new, account_name = coalesce(v_name, account_name)
        WHERE invoice_id = _invoice_id AND btrim(coalesce(account_code,'')) = v_old;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;
      UPDATE public.journal_lines SET account_code = v_new, account_name = coalesce(v_name, account_name)
        WHERE invoice_id = _invoice_id AND btrim(coalesce(account_code,'')) = v_old AND coalesce(debit,0) > 0;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;

    ELSIF v_kind = 'iva' THEN
      UPDATE public.invoice_lines
         SET iva_account_code = CASE WHEN btrim(coalesce(iva_account_code,'')) = v_old THEN v_new ELSE iva_account_code END,
             iva_operational_account = CASE WHEN btrim(coalesce(iva_operational_account,'')) = v_old THEN v_new ELSE iva_operational_account END
       WHERE invoice_id = _invoice_id
         AND (btrim(coalesce(iva_account_code,'')) = v_old OR btrim(coalesce(iva_operational_account,'')) = v_old);
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;
      UPDATE public.journal_lines SET account_code = v_new, account_name = coalesce(v_name, account_name)
        WHERE invoice_id = _invoice_id AND btrim(coalesce(account_code,'')) = v_old AND coalesce(debit,0) > 0;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;

    ELSIF v_kind IN ('retefuente','reteiva','reteica','otras') THEN
      UPDATE public.invoice_lines
         SET ret_account_code = CASE WHEN btrim(coalesce(ret_account_code,'')) = v_old THEN v_new ELSE ret_account_code END,
             ret_operational_account = CASE WHEN btrim(coalesce(ret_operational_account,'')) = v_old THEN v_new ELSE ret_operational_account END
       WHERE invoice_id = _invoice_id
         AND (btrim(coalesce(ret_account_code,'')) = v_old OR btrim(coalesce(ret_operational_account,'')) = v_old);
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;
      UPDATE public.journal_lines SET account_code = v_new, account_name = coalesce(v_name, account_name)
        WHERE invoice_id = _invoice_id AND btrim(coalesce(account_code,'')) = v_old AND coalesce(credit,0) > 0;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;

    ELSIF v_kind = 'payable' THEN
      UPDATE public.invoices
         SET payable_account = v_new, payable_manual = true, payable_source = 'sincronizacion',
             payable_updated_at = now(), payable_updated_by = auth.uid()
       WHERE id = _invoice_id AND btrim(coalesce(payable_account,'')) = v_old;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;
      UPDATE public.journal_lines SET account_code = v_new, account_name = coalesce(v_name, account_name)
        WHERE invoice_id = _invoice_id AND btrim(coalesce(account_code,'')) = v_old AND coalesce(credit,0) > 0;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;

    ELSIF v_kind = 'cost_center' THEN
      UPDATE public.invoices SET cost_center = v_new
        WHERE id = _invoice_id AND btrim(coalesce(cost_center,'')) = v_old;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;
      UPDATE public.journal_lines SET cost_center = v_new
        WHERE invoice_id = _invoice_id AND btrim(coalesce(cost_center,'')) = v_old;
      GET DIAGNOSTICS k = ROW_COUNT; v_rows := v_rows + k;
    END IF;
  END LOOP;
  RETURN v_rows;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_draft_sync_changes(uuid, jsonb, boolean) FROM anon, authenticated;

-- 4) Sincronización masiva a los demás borradores del mismo proveedor
CREATE OR REPLACE FUNCTION public.sync_provider_drafts(_source_invoice_id uuid, _changes jsonb, _event_key text, _known jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_src public.invoices%ROWTYPE;
  v_evt public.draft_sync_events%ROWTYPE;
  v_nit text;
  v_conflicts jsonb := '[]'::jsonb;
  v_affected jsonb := '[]'::jsonb;
  v_count integer := 0;
  r record; c jsonb; v_known timestamptz; v_rows integer; v_label text; v_code text;
BEGIN
  IF coalesce(btrim(_event_key),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Falta el identificador del evento de sincronización.');
  END IF;

  SELECT * INTO v_evt FROM public.draft_sync_events WHERE event_key = _event_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'event_id', v_evt.id,
      'updated', v_evt.invoice_count, 'conflicts', v_evt.conflicts, 'message', v_evt.result);
  END IF;

  SELECT * INTO v_src FROM public.invoices WHERE id = _source_invoice_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'message', 'La factura de origen no existe.'); END IF;
  IF NOT public.is_company_member(v_src.company_id) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'No tiene permiso para modificar la contabilización de esta empresa.');
  END IF;

  v_nit := regexp_replace(split_part(coalesce(v_src.provider_nit,''), '-', 1), '\D', '', 'g');
  IF v_nit = '' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'El proveedor de la factura no tiene NIT: no es posible identificar los borradores relacionados.');
  END IF;

  -- Validación de cuentas destino: deben existir, estar activas y permitir movimiento.
  FOR c IN SELECT value FROM jsonb_array_elements(coalesce(_changes,'[]'::jsonb)) LOOP
    IF (c->>'kind') = 'cost_center' THEN CONTINUE; END IF;
    v_code := btrim(coalesce(c->>'new',''));
    IF v_code = '' THEN
      RETURN jsonb_build_object('ok', false, 'message', 'Uno de los cambios no tiene cuenta contable de destino.');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.puc_accounts p
      WHERE p.company_id = v_src.company_id AND btrim(p.code) = v_code
        AND coalesce(p.active, true) AND coalesce(p.is_movement, true)
    ) THEN
      RETURN jsonb_build_object('ok', false, 'message',
        'La cuenta ' || v_code || ' no existe, está inactiva o no permite movimiento en el PUC de la empresa.');
    END IF;
  END LOOP;

  FOR r IN
    SELECT i.* FROM public.invoices i
    WHERE i.company_id = v_src.company_id
      AND i.id <> v_src.id
      AND i.status = 'borrador'
      AND i.voucher_number IS NULL
      AND i.siigo_id IS NULL
      AND coalesce(i.siigo_status,'') <> 'sincronizada'
      AND regexp_replace(split_part(coalesce(i.provider_nit,''), '-', 1), '\D', '', 'g') = v_nit
    ORDER BY i.issue_date DESC NULLS LAST
  LOOP
    v_label := coalesce(nullif(concat_ws('-', r.prefix, r.number), ''), 'Sin número');
    SELECT (k->>'updated_at')::timestamptz INTO v_known
      FROM jsonb_array_elements(coalesce(_known,'[]'::jsonb)) k
     WHERE (k->>'id')::uuid = r.id;

    IF v_known IS NULL OR r.updated_at > v_known + interval '1 second' THEN
      v_conflicts := v_conflicts || jsonb_build_object('invoice_id', r.id, 'label', v_label,
        'message', 'Este borrador fue modificado por otro usuario. Revise los cambios antes de aplicar la sincronización.');
      CONTINUE;
    END IF;

    v_rows := public.apply_draft_sync_changes(r.id, _changes, false);
    IF v_rows > 0 THEN
      v_count := v_count + 1;
      v_affected := v_affected || jsonb_build_object('invoice_id', r.id, 'label', v_label, 'rows', v_rows);
      UPDATE public.invoices
         SET sync_source_invoice_id = v_src.id,
             sync_source_label = coalesce(nullif(concat_ws('-', v_src.prefix, v_src.number), ''), 'Sin número'),
             sync_applied_at = now()
       WHERE id = r.id;
    END IF;
  END LOOP;

  INSERT INTO public.draft_sync_events (
    company_id, provider_nit, provider_name, source_invoice_id, source_label, action,
    changes, affected, conflicts, invoice_count, result, event_key, created_by)
  VALUES (
    v_src.company_id, v_src.provider_nit, v_src.provider_name, v_src.id,
    coalesce(nullif(concat_ws('-', v_src.prefix, v_src.number), ''), 'Sin número'), 'todos',
    coalesce(_changes,'[]'::jsonb), v_affected, v_conflicts, v_count,
    v_count || ' borrador(es) actualizados · ' || jsonb_array_length(v_conflicts) || ' con conflicto',
    _event_key, auth.uid())
  RETURNING * INTO v_evt;

  UPDATE public.invoices SET sync_event_id = v_evt.id
   WHERE id IN (SELECT (a->>'invoice_id')::uuid FROM jsonb_array_elements(v_affected) a);

  RETURN jsonb_build_object('ok', true, 'already', false, 'event_id', v_evt.id,
    'updated', v_count, 'conflicts', v_conflicts, 'message', v_evt.result);
END;
$$;

-- 5) Deshacer una sincronización: restaura solo lo que esa operación cambió
CREATE OR REPLACE FUNCTION public.undo_provider_draft_sync(_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_evt public.draft_sync_events%ROWTYPE;
  a jsonb; v_id uuid; v_count integer := 0; v_rows integer;
BEGIN
  SELECT * INTO v_evt FROM public.draft_sync_events WHERE id = _event_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'message', 'La sincronización no existe.'); END IF;
  IF NOT public.is_company_member(v_evt.company_id) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'No tiene permiso sobre esta empresa.');
  END IF;
  IF v_evt.undone_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'message', 'Esta sincronización ya fue deshecha.');
  END IF;

  FOR a IN SELECT value FROM jsonb_array_elements(v_evt.affected) LOOP
    v_id := (a->>'invoice_id')::uuid;
    IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = v_id AND i.status = 'borrador'
                 AND i.voucher_number IS NULL AND i.siigo_id IS NULL) THEN
      v_rows := public.apply_draft_sync_changes(v_id, v_evt.changes, true);
      IF v_rows > 0 THEN
        v_count := v_count + 1;
        UPDATE public.invoices
           SET sync_event_id = NULL, sync_source_invoice_id = NULL, sync_source_label = NULL, sync_applied_at = NULL
         WHERE id = v_id;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.draft_sync_events
     SET undone_at = now(), undone_by = auth.uid(),
         result = coalesce(result,'') || ' · Deshecha: ' || v_count || ' borrador(es) restaurados'
   WHERE id = _event_id;

  RETURN jsonb_build_object('ok', true, 'restored', v_count,
    'message', v_count || ' borrador(es) restaurados a su configuración anterior.');
END;
$$;

-- 6) Tiempo real
ALTER TABLE public.invoices REPLICA IDENTITY FULL;
ALTER TABLE public.invoice_lines REPLICA IDENTITY FULL;
ALTER TABLE public.journal_lines REPLICA IDENTITY FULL;
ALTER TABLE public.draft_sync_events REPLICA IDENTITY FULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices','invoice_lines','journal_lines','draft_sync_events'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;