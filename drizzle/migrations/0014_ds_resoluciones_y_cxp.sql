CREATE TABLE public.ds_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  prefix text NOT NULL,
  from_number integer NOT NULL,
  to_number integer NOT NULL,
  approval_date date NOT NULL,
  validity_months integer NOT NULL DEFAULT 12,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ds_resolutions TO authenticated;
GRANT ALL ON public.ds_resolutions TO service_role;
ALTER TABLE public.ds_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ds_resolutions_member ON public.ds_resolutions FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
ALTER TABLE public.company_parameters ADD COLUMN IF NOT EXISTS ds_payable_account text NOT NULL DEFAULT '23359501';