ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS posted_by uuid,
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS voucher_number text,
  ADD COLUMN IF NOT EXISTS processing_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_by uuid,
  ADD COLUMN IF NOT EXISTS posting_error text;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_company_voucher_uk
  ON public.invoices (company_id, voucher_number)
  WHERE voucher_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.voucher_sequences (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  prefix text NOT NULL DEFAULT '',
  last_number bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.voucher_sequences TO authenticated;
GRANT ALL ON public.voucher_sequences TO service_role;
ALTER TABLE public.voucher_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Miembros consultan consecutivos" ON public.voucher_sequences
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

DROP TRIGGER IF EXISTS voucher_sequences_updated_at ON public.voucher_sequences;
CREATE TRIGGER voucher_sequences_updated_at BEFORE UPDATE ON public.voucher_sequences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.post_invoice(_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_dup public.invoices%ROWTYPE;
  v_seq bigint;
  v_prefix text;
  v_voucher text;
  v_debit numeric;
  v_credit numeric;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'La factura no existe.');
  END IF;
  IF NOT public.is_company_member(v_inv.company_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'La factura no pertenece a una empresa del usuario.');
  END IF;

  -- Idempotencia: si ya tiene comprobante, no se genera otro.
  IF v_inv.voucher_number IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'voucher_number', v_inv.voucher_number,
      'message', 'Factura ya causada.');
  END IF;

  IF v_inv.status NOT IN ('aprobado') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ESTADO', 'message',
      'La factura debe estar aprobada antes de causarla.');
  END IF;

  -- Bloqueo: otra ejecución la tomó hace menos de 5 minutos.
  IF v_inv.processing_at IS NOT NULL AND v_inv.processing_at > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EN_PROCESO', 'message', 'La factura está siendo procesada.');
  END IF;

  -- Segunda validación de duplicados justo antes de generar el comprobante.
  SELECT * INTO v_dup FROM public.invoices o
   WHERE o.company_id = v_inv.company_id
     AND o.id <> v_inv.id
     AND (
       (COALESCE(v_inv.cufe,'') <> '' AND o.cufe = v_inv.cufe)
       OR (COALESCE(v_inv.provider_nit,'') <> '' AND COALESCE(v_inv.number,'') <> ''
           AND o.provider_nit = v_inv.provider_nit AND o.number = v_inv.number
           AND COALESCE(o.prefix,'') = COALESCE(v_inv.prefix,''))
     )
     AND (o.voucher_number IS NOT NULL OR o.status IN ('causada','sincronizada') OR o.siigo_status = 'sincronizada')
   LIMIT 1;
  IF FOUND THEN
    UPDATE public.invoices SET posting_error = 'Posible factura duplicada: ya existe una causación para el mismo proveedor y número.'
      WHERE id = v_inv.id;
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICADA', 'duplicate_id', v_dup.id,
      'voucher_number', v_dup.voucher_number,
      'message', 'Posible factura duplicada: ya existe una causación para el mismo proveedor y número.');
  END IF;

  SELECT COALESCE(sum(debit),0), COALESCE(sum(credit),0) INTO v_debit, v_credit
    FROM public.journal_lines WHERE invoice_id = v_inv.id;
  IF v_debit = 0 AND v_credit = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SIN_COMPROBANTE', 'message', 'La factura no tiene movimientos contables.');
  END IF;
  IF abs(v_debit - v_credit) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DESCUADRE', 'message', 'El comprobante está descuadrado.');
  END IF;

  UPDATE public.invoices SET processing_at = now(), processing_by = auth.uid() WHERE id = v_inv.id;

  INSERT INTO public.voucher_sequences (company_id, last_number)
  VALUES (v_inv.company_id, 1)
  ON CONFLICT (company_id) DO UPDATE SET last_number = public.voucher_sequences.last_number + 1
  RETURNING last_number, prefix INTO v_seq, v_prefix;

  v_voucher := COALESCE(v_prefix,'') || lpad(v_seq::text, 6, '0');

  UPDATE public.invoices
     SET voucher_number = v_voucher,
         status = 'causada',
         posted_at = now(),
         posted_by = auth.uid(),
         posting_error = NULL,
         processing_at = NULL,
         processing_by = NULL
   WHERE id = v_inv.id;

  RETURN jsonb_build_object('ok', true, 'already', false, 'voucher_number', v_voucher);
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_invoice(uuid) TO authenticated;