ALTER TABLE public.company_parameters ADD COLUMN ds_cost_center_mode text;
ALTER TABLE public.company_parameters ADD COLUMN fc_cost_center_mode text;
COMMENT ON COLUMN public.company_parameters.ds_cost_center_mode IS 'Centro de costo del tipo DS en Siigo: no | permite | exige (leído de /v1/document-types).';
COMMENT ON COLUMN public.company_parameters.fc_cost_center_mode IS 'Centro de costo del tipo FC en Siigo: no | permite | exige (leído de /v1/document-types).';