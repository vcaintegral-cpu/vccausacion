CREATE TABLE public.provider_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider_nit text NOT NULL,
  provider_name text,
  keyword text NOT NULL DEFAULT '(todas)',
  expense_account text,
  expense_account_name text,
  iva_treatment text NOT NULL DEFAULT 'descontable',
  iva_account text,
  inc_account text,
  retention_account text,
  retention_rate numeric,
  retention_base text,
  payable_account text,
  source text NOT NULL DEFAULT 'manual',
  times_used integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider_nit, keyword)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_rules TO authenticated;
GRANT ALL ON public.provider_rules TO service_role;

ALTER TABLE public.provider_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Miembros gestionan reglas de su empresa"
ON public.provider_rules
FOR ALL
TO authenticated
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));

CREATE TRIGGER set_provider_rules_updated_at
BEFORE UPDATE ON public.provider_rules
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();