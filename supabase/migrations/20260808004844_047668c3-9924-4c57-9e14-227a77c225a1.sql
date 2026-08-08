ALTER TABLE public.products ADD COLUMN IF NOT EXISTS siigo_id text;
CREATE INDEX IF NOT EXISTS products_company_code_idx ON public.products (company_id, code);