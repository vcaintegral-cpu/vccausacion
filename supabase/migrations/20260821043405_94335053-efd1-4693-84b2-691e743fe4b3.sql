ALTER TABLE public.providers
  ADD COLUMN IF NOT EXISTS siigo_id text,
  ADD COLUMN IF NOT EXISTS siigo_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS siigo_sync_status text;

CREATE INDEX IF NOT EXISTS providers_company_siigo_idx ON public.providers (company_id, siigo_id);