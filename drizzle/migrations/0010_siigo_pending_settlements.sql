ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS advance_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS siigo_pending_label text;

CREATE TABLE public.siigo_pending_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ajuste_peso','anticipo')),
  amount numeric NOT NULL,
  account_code text,
  provider_nit text,
  provider_name text,
  invoice_label text,
  siigo_number text,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','registrado')),
  resolved_at timestamptz,
  resolved_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, kind)
);
GRANT SELECT, INSERT, UPDATE ON public.siigo_pending_settlements TO authenticated;
GRANT ALL ON public.siigo_pending_settlements TO service_role;
ALTER TABLE public.siigo_pending_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read settlements" ON public.siigo_pending_settlements FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "members insert settlements" ON public.siigo_pending_settlements FOR INSERT TO authenticated WITH CHECK (public.is_company_member(company_id));
CREATE POLICY "members update settlements" ON public.siigo_pending_settlements FOR UPDATE TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

UPDATE public.invoices SET advance_amount = 1000000 WHERE prefix = 'BUF' AND number = '1277' AND provider_nit LIKE '8419585%' AND siigo_id IS NULL;