ALTER TABLE public.tax_rates ADD COLUMN IF NOT EXISTS siigo_code text;
ALTER TABLE public.tax_rates ADD COLUMN IF NOT EXISTS siigo_synced_at timestamptz;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS siigo_trace jsonb;