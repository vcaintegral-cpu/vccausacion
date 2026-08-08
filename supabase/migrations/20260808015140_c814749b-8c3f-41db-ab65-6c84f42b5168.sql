ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS buyer_nit text,
  ADD COLUMN IF NOT EXISTS buyer_name text;