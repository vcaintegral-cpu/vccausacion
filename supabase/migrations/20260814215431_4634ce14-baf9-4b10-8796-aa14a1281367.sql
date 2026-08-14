CREATE TABLE public.invoice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  status text NOT NULL,
  siigo_status text,
  action text NOT NULL,
  message text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.invoice_events TO authenticated;
GRANT ALL ON public.invoice_events TO service_role;

ALTER TABLE public.invoice_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Miembros ven la trazabilidad de su empresa"
ON public.invoice_events FOR SELECT TO authenticated
USING (public.is_company_member(company_id));

CREATE POLICY "Miembros registran trazabilidad de su empresa"
ON public.invoice_events FOR INSERT TO authenticated
WITH CHECK (public.is_company_member(company_id));

CREATE INDEX invoice_events_invoice_idx ON public.invoice_events (invoice_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.log_invoice_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_action text;
  v_message text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'Factura creada';
    v_message := NULL;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.siigo_status IS NOT DISTINCT FROM OLD.siigo_status THEN
      RETURN NEW;
    END IF;
    v_action := CASE
      WHEN NEW.siigo_status = 'sincronizada' AND OLD.siigo_status IS DISTINCT FROM 'sincronizada' THEN 'Siigo confirmó la creación del documento'
      WHEN NEW.siigo_status = 'sincronizando' AND OLD.siigo_status IS DISTINCT FROM 'sincronizando' THEN 'Enviada a Siigo'
      WHEN NEW.siigo_status = 'error' AND OLD.siigo_status IS DISTINCT FROM 'error' THEN 'Error de sincronización con Siigo'
      WHEN NEW.status = 'causada' AND OLD.status IS DISTINCT FROM 'causada' THEN 'Causación generada'
      WHEN NEW.status = 'aprobado' AND OLD.status IS DISTINCT FROM 'aprobado' THEN 'Factura aprobada'
      WHEN NEW.status = 'borrador' AND OLD.status IS DISTINCT FROM 'borrador' THEN 'Devuelta a borrador'
      WHEN NEW.status = 'historico' AND OLD.status IS DISTINCT FROM 'historico' THEN 'Factura enviada al histórico'
      ELSE 'Cambio de estado'
    END;
    v_message := COALESCE(
      NULLIF(NEW.siigo_error, ''),
      NULLIF(NEW.posting_error, ''),
      CASE WHEN NEW.siigo_id IS NOT NULL AND OLD.siigo_id IS DISTINCT FROM NEW.siigo_id
           THEN 'ID Siigo: ' || NEW.siigo_id ELSE NULL END,
      CASE WHEN NEW.voucher_number IS NOT NULL AND OLD.voucher_number IS DISTINCT FROM NEW.voucher_number
           THEN 'Comprobante ' || NEW.voucher_number ELSE NULL END
    );
  END IF;

  INSERT INTO public.invoice_events (company_id, invoice_id, status, siigo_status, action, message, created_by)
  VALUES (NEW.company_id, NEW.id, NEW.status, NEW.siigo_status, v_action, v_message, auth.uid());
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_event_log
AFTER INSERT OR UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.log_invoice_event();

CREATE OR REPLACE FUNCTION public.return_invoice_to_draft(_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_inv public.invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'message', 'La factura no existe.'); END IF;
  IF NOT public.is_company_member(v_inv.company_id) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura no pertenece a una empresa del usuario.');
  END IF;
  IF v_inv.siigo_id IS NOT NULL OR v_inv.siigo_status = 'sincronizada' OR v_inv.status IN ('sincronizada','historico') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura ya fue sincronizada con Siigo y no puede editarse.');
  END IF;
  IF v_inv.voucher_number IS NOT NULL OR v_inv.status = 'causada' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura ya está causada. Primero revierta la causación.');
  END IF;
  UPDATE public.invoices
     SET status = 'borrador', approved_at = NULL, approved_by = NULL,
         siigo_status = 'pendiente', siigo_error = NULL, posting_error = NULL
   WHERE id = _invoice_id;
  RETURN jsonb_build_object('ok', true, 'message', 'Factura devuelta a borrador.');
END;
$$;

CREATE OR REPLACE FUNCTION public.revert_invoice_posting(_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_inv public.invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'message', 'La factura no existe.'); END IF;
  IF NOT public.is_company_member(v_inv.company_id) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura no pertenece a una empresa del usuario.');
  END IF;
  IF v_inv.siigo_id IS NOT NULL OR v_inv.siigo_status = 'sincronizada' OR v_inv.status IN ('sincronizada','historico') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura ya fue sincronizada con Siigo: no se puede revertir la causación.');
  END IF;
  IF v_inv.voucher_number IS NULL AND v_inv.status <> 'causada' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura no está causada.');
  END IF;
  UPDATE public.invoices
     SET status = 'aprobado', voucher_number = NULL, posted_at = NULL, posted_by = NULL,
         posting_error = NULL, siigo_status = 'pendiente', siigo_error = NULL,
         processing_at = NULL, processing_by = NULL
   WHERE id = _invoice_id;
  RETURN jsonb_build_object('ok', true, 'message', 'Causación revertida. La factura vuelve a estado aprobado.');
END;
$$;