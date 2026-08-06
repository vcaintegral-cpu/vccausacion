ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS siigo_status text NOT NULL DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS siigo_id text,
  ADD COLUMN IF NOT EXISTS siigo_number text,
  ADD COLUMN IF NOT EXISTS siigo_document_url text,
  ADD COLUMN IF NOT EXISTS siigo_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS siigo_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS siigo_synced_by uuid,
  ADD COLUMN IF NOT EXISTS siigo_error text;

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'gasto';

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS auto_learning boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.learning_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider_nit text,
  provider_name text,
  concept text,
  account_code text NOT NULL,
  account_name text,
  cost_center text,
  iva numeric NOT NULL DEFAULT 0,
  retentions text,
  item_type text NOT NULL DEFAULT 'gasto',
  active boolean NOT NULL DEFAULT true,
  times_used integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_rules TO authenticated;
GRANT ALL ON public.learning_rules TO service_role;

ALTER TABLE public.learning_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "learning rules access" ON public.learning_rules;
CREATE POLICY "learning rules access" ON public.learning_rules
  FOR ALL TO authenticated
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

CREATE INDEX IF NOT EXISTS learning_rules_company_provider_idx
  ON public.learning_rules (company_id, provider_nit);