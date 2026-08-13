ALTER TABLE public.bulk_upload_items
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS provider_nit text,
  ADD COLUMN IF NOT EXISTS buyer_name text,
  ADD COLUMN IF NOT EXISTS buyer_nit text,
  ADD COLUMN IF NOT EXISTS issue_date date,
  ADD COLUMN IF NOT EXISTS read_status text;