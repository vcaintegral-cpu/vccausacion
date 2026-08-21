CREATE TABLE public.siigo_payment_types (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  siigo_id text NOT NULL,
  name text NOT NULL,
  method text NOT NULL DEFAULT 'credito',
  type text,
  account_code text,
  account_name text,
  active boolean NOT NULL DEFAULT true,
  due_date_required boolean NOT NULL DEFAULT false,
  raw jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, siigo_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.siigo_payment_types TO authenticated;
GRANT ALL ON public.siigo_payment_types TO service_role;
ALTER TABLE public.siigo_payment_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members manage company payment types" ON public.siigo_payment_types
  FOR ALL TO authenticated
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_type_id text,
  ADD COLUMN IF NOT EXISTS payment_type_name text,
  ADD COLUMN IF NOT EXISTS payment_form_manual boolean NOT NULL DEFAULT false;