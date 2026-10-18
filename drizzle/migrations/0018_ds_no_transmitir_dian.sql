ALTER TABLE public.company_parameters ADD COLUMN IF NOT EXISTS ds_batch_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS ds_unauthorized_transmission boolean NOT NULL DEFAULT false;
UPDATE public.invoices SET ds_unauthorized_transmission = true
WHERE doc_kind = 'soporte' AND siigo_id IS NOT NULL AND lower(coalesce(ds_dian_status,'')) ~ '(sent|accept|valid|reject|process)';