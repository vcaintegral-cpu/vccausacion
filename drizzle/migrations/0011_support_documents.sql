ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS doc_kind text NOT NULL DEFAULT 'compra';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS vendor_id_type text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS vendor_is_natural boolean;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS vendor_declarant boolean;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS vendor_filled jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS iva_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS ds_dian_status text;
CREATE INDEX IF NOT EXISTS invoices_company_doc_kind_idx ON public.invoices (company_id, doc_kind);
ALTER TABLE public.bulk_uploads ADD COLUMN IF NOT EXISTS doc_kind text NOT NULL DEFAULT 'compra';

CREATE TABLE public.company_parameters (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  address text,
  city text,
  department text,
  country text,
  phone text,
  email text,
  ds_document_id integer,
  ds_document_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.company_parameters TO authenticated;
GRANT ALL ON public.company_parameters TO service_role;
ALTER TABLE public.company_parameters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read company parameters" ON public.company_parameters FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "members insert company parameters" ON public.company_parameters FOR INSERT TO authenticated WITH CHECK (public.is_company_member(company_id));
CREATE POLICY "members update company parameters" ON public.company_parameters FOR UPDATE TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));