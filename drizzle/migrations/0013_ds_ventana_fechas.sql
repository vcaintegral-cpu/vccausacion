ALTER TABLE public.company_parameters ADD COLUMN IF NOT EXISTS ds_window_days integer NOT NULL DEFAULT 10;
ALTER TABLE public.company_parameters ADD COLUMN IF NOT EXISTS ds_date_ref text NOT NULL DEFAULT 'fin_mes';
COMMENT ON COLUMN public.company_parameters.ds_date_mode IS 'DEPRECATED: reemplazada por ds_window_days + ds_date_ref (ventana de fechas Siigo)';