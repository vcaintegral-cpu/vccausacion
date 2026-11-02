-- Bases mínimas de retención (tabla legal, GLOBAL para todas las empresas) y
-- concepto de cada retención configurada en la empresa.

-- Una fila por año gravable: valor de la UVT y conceptos con su base en UVT.
-- concepts = [{ "id", "concepto", "base_uvt", "tarifa_declarante", "tarifa_no_declarante", "notas" }]
CREATE TABLE IF NOT EXISTS public.retention_base_tables (
  year integer PRIMARY KEY CHECK (year BETWEEN 2000 AND 2100),
  uvt numeric NOT NULL CHECK (uvt > 0),
  concepts jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.retention_base_tables TO authenticated;
GRANT ALL ON public.retention_base_tables TO service_role;
ALTER TABLE public.retention_base_tables ENABLE ROW LEVEL SECURITY;
-- Tabla legal común: cualquier usuario con sesión la consulta; la editan los
-- usuarios que pertenecen a alguna empresa (contadores de la firma).
CREATE POLICY "read retention bases" ON public.retention_base_tables
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "members write retention bases" ON public.retention_base_tables
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.company_members m WHERE m.user_id = auth.uid()));
CREATE POLICY "members update retention bases" ON public.retention_base_tables
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.company_members m WHERE m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.company_members m WHERE m.user_id = auth.uid()));

-- Concepto legal de cada retención de la empresa (id del concepto en retention_base_tables).
ALTER TABLE public.tax_rates ADD COLUMN IF NOT EXISTS retention_concept text;
