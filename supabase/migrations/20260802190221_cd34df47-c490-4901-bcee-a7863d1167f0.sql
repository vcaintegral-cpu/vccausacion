-- profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text,
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "own profile write" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- companies
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  nit text,
  currency text NOT NULL DEFAULT 'COP',
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.company_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'contador',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);

CREATE OR REPLACE FUNCTION public.is_company_member(_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.company_members m WHERE m.company_id = _company_id AND m.user_id = auth.uid());
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company members read" ON public.companies FOR SELECT TO authenticated USING (public.is_company_member(id));
CREATE POLICY "create company" ON public.companies FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "company members update" ON public.companies FOR UPDATE TO authenticated USING (public.is_company_member(id)) WITH CHECK (public.is_company_member(id));
CREATE POLICY "company owner delete" ON public.companies FOR DELETE TO authenticated USING (created_by = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_members TO authenticated;
GRANT ALL ON public.company_members TO service_role;
ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read own rows" ON public.company_members FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_company_member(company_id));
CREATE POLICY "members insert" ON public.company_members FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() OR public.is_company_member(company_id));
CREATE POLICY "members delete" ON public.company_members FOR DELETE TO authenticated USING (public.is_company_member(company_id));

-- puc
CREATE TABLE public.puc_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  nature text NOT NULL DEFAULT 'debito',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.puc_accounts TO authenticated;
GRANT ALL ON public.puc_accounts TO service_role;
ALTER TABLE public.puc_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "puc access" ON public.puc_accounts FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

-- cost centers
CREATE TABLE public.cost_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cost_centers TO authenticated;
GRANT ALL ON public.cost_centers TO service_role;
ALTER TABLE public.cost_centers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cost centers access" ON public.cost_centers FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

-- providers
CREATE TABLE public.providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  nit text NOT NULL,
  name text NOT NULL,
  address text,
  city text,
  phone text,
  email text,
  regime text,
  economic_activity text,
  default_expense_account text,
  default_payable_account text DEFAULT '220505',
  default_iva_account text DEFAULT '240801',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, nit)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.providers TO authenticated;
GRANT ALL ON public.providers TO service_role;
ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "providers access" ON public.providers FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

-- accounting rules
CREATE TABLE public.accounting_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  match_type text NOT NULL DEFAULT 'keyword',
  match_value text NOT NULL,
  account_code text NOT NULL,
  account_name text,
  priority int NOT NULL DEFAULT 100,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_rules TO authenticated;
GRANT ALL ON public.accounting_rules TO service_role;
ALTER TABLE public.accounting_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rules access" ON public.accounting_rules FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

-- tax rates
CREATE TABLE public.tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  rate numeric NOT NULL DEFAULT 0,
  min_base numeric NOT NULL DEFAULT 0,
  account_code text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_rates TO authenticated;
GRANT ALL ON public.tax_rates TO service_role;
ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "taxes access" ON public.tax_rates FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

-- invoices
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  prefix text,
  number text,
  issue_date date,
  due_date date,
  provider_nit text,
  provider_name text,
  provider_address text,
  provider_city text,
  provider_phone text,
  provider_email text,
  cufe text,
  payment_form text,
  payment_method text,
  currency text DEFAULT 'COP',
  cost_center text,
  notes text,
  subtotal numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0,
  iva numeric NOT NULL DEFAULT 0,
  impoconsumo numeric NOT NULL DEFAULT 0,
  retefuente numeric NOT NULL DEFAULT 0,
  reteiva numeric NOT NULL DEFAULT 0,
  reteica numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'borrador',
  dian_status text,
  file_path text,
  file_name text,
  raw_extraction jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoices access" ON public.invoices FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text,
  description text,
  quantity numeric NOT NULL DEFAULT 1,
  unit_value numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0,
  iva numeric NOT NULL DEFAULT 0,
  retention numeric NOT NULL DEFAULT 0,
  impoconsumo numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  account_code text,
  account_name text,
  position int NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_lines TO authenticated;
GRANT ALL ON public.invoice_lines TO service_role;
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoice lines access" ON public.invoice_lines FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

CREATE TABLE public.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_code text NOT NULL,
  account_name text,
  debit numeric NOT NULL DEFAULT 0,
  credit numeric NOT NULL DEFAULT 0,
  cost_center text,
  position int NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_lines TO authenticated;
GRANT ALL ON public.journal_lines TO service_role;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "journal access" ON public.journal_lines FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

-- learning log
CREATE TABLE public.learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider_nit text,
  concept text,
  account_code text NOT NULL,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_events TO authenticated;
GRANT ALL ON public.learning_events TO service_role;
ALTER TABLE public.learning_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "learning access" ON public.learning_events FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));