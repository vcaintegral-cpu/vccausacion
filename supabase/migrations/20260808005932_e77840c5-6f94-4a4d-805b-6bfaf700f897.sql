CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_company_cufe
  ON public.invoices (company_id, cufe)
  WHERE cufe IS NOT NULL AND cufe <> '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_company_number
  ON public.invoices (company_id, provider_nit, COALESCE(prefix, ''), number)
  WHERE (cufe IS NULL OR cufe = '') AND provider_nit IS NOT NULL AND number IS NOT NULL AND number <> '';