ALTER TABLE public.bulk_upload_items
  ADD COLUMN IF NOT EXISTS storage_bucket text NOT NULL DEFAULT 'facturas',
  ADD COLUMN IF NOT EXISTS download_status text,
  ADD COLUMN IF NOT EXISTS stored_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS content_status text,
  ADD COLUMN IF NOT EXISTS extracted_text text,
  ADD COLUMN IF NOT EXISTS company_validation text;