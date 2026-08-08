ALTER TABLE public.puc_accounts
  ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'auxiliar',
  ADD COLUMN IF NOT EXISTS parent_code text,
  ADD COLUMN IF NOT EXISTS has_children boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_movement boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS siigo_id text,
  ADD COLUMN IF NOT EXISTS siigo_code text,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;

CREATE INDEX IF NOT EXISTS puc_accounts_company_movement_idx ON public.puc_accounts (company_id, is_movement, code);

CREATE TABLE IF NOT EXISTS public.account_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE CASCADE,
  suggested_code text NOT NULL,
  used_code text,
  reason text NOT NULL,
  siigo_id text,
  siigo_code text,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_resolutions TO authenticated;
GRANT ALL ON public.account_resolutions TO service_role;

ALTER TABLE public.account_resolutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account resolutions access" ON public.account_resolutions
  FOR ALL TO authenticated
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));