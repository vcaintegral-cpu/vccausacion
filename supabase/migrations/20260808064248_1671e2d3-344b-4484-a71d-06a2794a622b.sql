CREATE TABLE public.accounting_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  imported_by uuid NOT NULL,
  file_name text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  period text,
  excel_row integer NOT NULL,
  account_code text,
  account_name text,
  provider_nit text,
  provider_name text,
  branch text,
  voucher text,
  sequence text,
  entry_date_text text,
  description text,
  detail text,
  cost_center text,
  debit numeric,
  credit numeric,
  debit_text text,
  credit_text text,
  original_row_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX accounting_history_company_idx ON public.accounting_history (company_id, excel_row);
CREATE INDEX accounting_history_account_idx ON public.accounting_history (company_id, account_code);
CREATE INDEX accounting_history_nit_idx ON public.accounting_history (company_id, provider_nit);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_history TO authenticated;
GRANT ALL ON public.accounting_history TO service_role;

ALTER TABLE public.accounting_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Miembros gestionan el historial de su empresa"
ON public.accounting_history FOR ALL TO authenticated
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));