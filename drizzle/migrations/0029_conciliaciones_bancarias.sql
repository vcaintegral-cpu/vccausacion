-- Conciliación bancaria (todas las empresas): resultado por cuenta y mes, con las partidas
-- conciliatorias al corte, para usarlas en el mes siguiente.
CREATE TABLE IF NOT EXISTS public.conciliaciones_bancarias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  periodo text NOT NULL,
  cuenta_etiqueta text NOT NULL,
  cuenta_contable text,
  saldo_extracto_inicial numeric(18,2),
  saldo_extracto_final numeric(18,2),
  saldo_libros_inicial numeric(18,2),
  saldo_libros_final numeric(18,2),
  partidas jsonb NOT NULL DEFAULT '[]'::jsonb,
  resumen jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, periodo, cuenta_etiqueta)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conciliaciones_bancarias TO authenticated;
GRANT ALL ON public.conciliaciones_bancarias TO service_role;
ALTER TABLE public.conciliaciones_bancarias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conciliaciones_members ON public.conciliaciones_bancarias;
CREATE POLICY conciliaciones_members ON public.conciliaciones_bancarias FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
DROP TRIGGER IF EXISTS conciliaciones_updated_at ON public.conciliaciones_bancarias;
CREATE TRIGGER conciliaciones_updated_at BEFORE UPDATE ON public.conciliaciones_bancarias
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- El reporte mensual de pagos (hojas de bancos y efectivo) también se guarda en la bandeja
-- de egresos, para leer de ahí los movimientos de las cuentas que no tienen extracto en Excel.
ALTER TABLE public.payment_documents DROP CONSTRAINT IF EXISTS payment_documents_kind_check;
ALTER TABLE public.payment_documents ADD CONSTRAINT payment_documents_kind_check
  CHECK (kind IN ('soporte_pago', 'extracto', 'relacion_pagos'));

NOTIFY pgrst, 'reload schema';
