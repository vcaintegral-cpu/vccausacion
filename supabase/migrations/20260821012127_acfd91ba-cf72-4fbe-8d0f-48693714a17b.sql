ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS paid_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS payment_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_config jsonb;

CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  receipt_number text NOT NULL,
  payment_date date NOT NULL,
  method text NOT NULL,
  account_code text NOT NULL,
  account_name text,
  payable_account text,
  check_number text,
  amount numeric NOT NULL,
  balance_before numeric NOT NULL DEFAULT 0,
  balance_after numeric NOT NULL DEFAULT 0,
  notes text,
  status text NOT NULL DEFAULT 'generado',
  siigo_status text NOT NULL DEFAULT 'no_enviado',
  siigo_id text,
  siigo_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_receipts TO authenticated;
GRANT ALL ON public.payment_receipts TO service_role;
ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_receipts_member_read" ON public.payment_receipts
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "payment_receipts_member_write" ON public.payment_receipts
  FOR INSERT TO authenticated WITH CHECK (public.is_company_member(company_id));
CREATE POLICY "payment_receipts_member_update" ON public.payment_receipts
  FOR UPDATE TO authenticated USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

CREATE TABLE IF NOT EXISTS public.payment_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.payment_receipts(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  account_code text NOT NULL,
  account_name text,
  debit numeric NOT NULL DEFAULT 0,
  credit numeric NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_receipt_lines TO authenticated;
GRANT ALL ON public.payment_receipt_lines TO service_role;
ALTER TABLE public.payment_receipt_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_receipt_lines_member_read" ON public.payment_receipt_lines
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "payment_receipt_lines_member_write" ON public.payment_receipt_lines
  FOR INSERT TO authenticated WITH CHECK (public.is_company_member(company_id));

CREATE TABLE IF NOT EXISTS public.payment_receipt_sequences (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  prefix text NOT NULL DEFAULT 'RP-',
  last_number bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.payment_receipt_sequences TO authenticated;
GRANT ALL ON public.payment_receipt_sequences TO service_role;
ALTER TABLE public.payment_receipt_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_receipt_sequences_member_read" ON public.payment_receipt_sequences
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

CREATE OR REPLACE FUNCTION public.invoice_payable_amount(_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    NULLIF((SELECT COALESCE(sum(j.credit), 0)
              FROM public.journal_lines j
              JOIN public.invoices i2 ON i2.id = j.invoice_id
             WHERE j.invoice_id = _invoice_id
               AND btrim(COALESCE(j.account_code,'')) = btrim(COALESCE(i2.payable_account,''))
               AND COALESCE(j.credit,0) > 0), 0),
    (SELECT COALESCE(i.total,0) - COALESCE(i.retefuente,0) - COALESCE(i.reteiva,0) - COALESCE(i.reteica,0)
       FROM public.invoices i WHERE i.id = _invoice_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.create_payment_receipt(
  _invoice_id uuid,
  _payment_date date,
  _method text,
  _account_code text,
  _account_name text DEFAULT NULL,
  _amount numeric DEFAULT NULL,
  _check_number text DEFAULT NULL,
  _notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_cxp numeric;
  v_saldo numeric;
  v_valor numeric;
  v_seq bigint;
  v_prefix text;
  v_number text;
  v_receipt public.payment_receipts%ROWTYPE;
  v_payable text;
  v_estado text;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura no existe.');
  END IF;
  IF NOT public.is_company_member(v_inv.company_id) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura no pertenece a una empresa del usuario.');
  END IF;
  IF v_inv.voucher_number IS NULL AND v_inv.status NOT IN ('causada','sincronizada','historico') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura debe estar causada antes de generar un recibo de pago.');
  END IF;

  v_payable := btrim(COALESCE(v_inv.payable_account, ''));
  IF v_payable = '' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'La factura no tiene cuenta por pagar definida.');
  END IF;
  IF COALESCE(btrim(_account_code),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Seleccione la cuenta de caja o banco desde la cual se paga.');
  END IF;
  IF _method NOT IN ('caja','banco','cheque','otro') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Medio de pago no válido.');
  END IF;

  v_cxp := round(public.invoice_payable_amount(_invoice_id)::numeric, 2);
  v_saldo := round((v_cxp - COALESCE(v_inv.paid_amount,0))::numeric, 2);
  IF v_saldo <= 0.004 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAGADA', 'message', 'Esta cuenta por pagar ya está totalmente pagada.');
  END IF;

  v_valor := round(COALESCE(_amount, v_saldo)::numeric, 2);
  IF v_valor <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'El valor a pagar debe ser mayor que cero.');
  END IF;
  IF v_valor > v_saldo + 0.004 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EXCEDE',
      'message', 'El valor a pagar supera el saldo pendiente de la cuenta por pagar.');
  END IF;

  INSERT INTO public.payment_receipt_sequences (company_id, last_number)
  VALUES (v_inv.company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
    SET last_number = public.payment_receipt_sequences.last_number + 1, updated_at = now()
  RETURNING last_number, prefix INTO v_seq, v_prefix;
  v_number := COALESCE(v_prefix,'RP-') || lpad(v_seq::text, 6, '0');

  INSERT INTO public.payment_receipts (
    company_id, invoice_id, receipt_number, payment_date, method, account_code, account_name,
    payable_account, check_number, amount, balance_before, balance_after, notes, created_by)
  VALUES (
    v_inv.company_id, v_inv.id, v_number, COALESCE(_payment_date, current_date), _method,
    btrim(_account_code), _account_name, v_payable, _check_number, v_valor, v_saldo,
    round((v_saldo - v_valor)::numeric, 2), _notes, auth.uid())
  RETURNING * INTO v_receipt;

  INSERT INTO public.payment_receipt_lines (receipt_id, company_id, invoice_id, account_code, account_name, debit, credit, position)
  VALUES
    (v_receipt.id, v_inv.company_id, v_inv.id, v_payable, 'Cuenta por pagar proveedor', v_valor, 0, 0),
    (v_receipt.id, v_inv.company_id, v_inv.id, btrim(_account_code), _account_name, 0, v_valor, 1);

  v_estado := CASE WHEN round((COALESCE(v_inv.paid_amount,0) + v_valor)::numeric,2) >= v_cxp - 0.004
                   THEN 'pagada' ELSE 'parcial' END;

  UPDATE public.invoices
     SET paid_amount = round((COALESCE(paid_amount,0) + v_valor)::numeric, 2),
         payment_status = v_estado,
         payment_enabled = true
   WHERE id = v_inv.id;

  RETURN jsonb_build_object('ok', true, 'receipt_id', v_receipt.id, 'receipt_number', v_number,
    'amount', v_valor, 'balance_after', round((v_saldo - v_valor)::numeric,2), 'payment_status', v_estado);
END;
$$;

REVOKE ALL ON FUNCTION public.create_payment_receipt(uuid, date, text, text, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_payment_receipt(uuid, date, text, text, text, numeric, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_payable_amount(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_payable_amount(uuid) TO authenticated;