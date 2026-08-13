ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS uses_cost_centers boolean;
COMMENT ON COLUMN public.companies.uses_cost_centers IS 'NULL = pendiente de configurar; true = la empresa maneja centros de costo; false = no los maneja';
ALTER TABLE public.puc_accounts ADD COLUMN IF NOT EXISTS requires_cost_center boolean NOT NULL DEFAULT false;