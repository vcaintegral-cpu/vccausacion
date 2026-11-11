-- Egresos y recibos de pago (RP) en Siigo — núcleo global: todas las empresas.
--   siigo_cuentas_por_pagar: saldos de las CxP leídos de Siigo (/v1/accounts-payable),
--     con la factura del proveedor a la que corresponde cada vencimiento (FC-1-757).
--   egresos: cada pago del mes (leído del reporte de pagos de la empresa) con su
--     propuesta de RP: pago de una o varias facturas, abono, anticipo o RP detallado.
--   egreso_reglas: lo que la usuaria enseña en pantalla (cuenta de banco de cada
--     origen de pago y la cuenta/tipo de cada concepto), para el mes siguiente.
-- Un egreso con identidad en Siigo no se borra ni se reenvía (trigger).

CREATE TABLE IF NOT EXISTS public.siigo_cuentas_por_pagar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  prefix text NOT NULL,
  consecutive bigint NOT NULL,
  quote integer NOT NULL DEFAULT 1,
  due_date date,
  balance numeric(18,2) NOT NULL DEFAULT 0,
  provider_nit text,
  provider_name text,
  cost_center text,
  factura_proveedor text,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, prefix, consecutive, quote)
);
CREATE INDEX IF NOT EXISTS siigo_cxp_company_provider_idx ON public.siigo_cuentas_por_pagar (company_id, provider_nit);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.siigo_cuentas_por_pagar TO authenticated;
GRANT ALL ON public.siigo_cuentas_por_pagar TO service_role;
ALTER TABLE public.siigo_cuentas_por_pagar ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS siigo_cxp_members ON public.siigo_cuentas_por_pagar;
CREATE POLICY siigo_cxp_members ON public.siigo_cuentas_por_pagar FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

CREATE TABLE IF NOT EXISTS public.egresos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period text NOT NULL,
  origen text NOT NULL DEFAULT 'excel',
  origen_archivo text,
  clave text NOT NULL,
  fila integer,
  fecha date NOT NULL,
  descripcion text,
  tercero_nombre text,
  tercero_nit text,
  valor numeric(18,2) NOT NULL CHECK (valor > 0),
  cuenta_etiqueta text,
  relacion text,
  aplicacion text,
  observaciones text,
  tipo text NOT NULL DEFAULT 'por_definir'
    CHECK (tipo IN ('por_definir', 'pago_facturas', 'anticipo', 'detallado', 'omitir')),
  propuesta jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado text NOT NULL DEFAULT 'por_revisar'
    CHECK (estado IN ('por_revisar', 'listo', 'aprobado', 'enviando', 'enviado', 'error', 'omitido')),
  motivos text[] NOT NULL DEFAULT '{}',
  editado_por_usuaria boolean NOT NULL DEFAULT false,
  siigo_id text,
  siigo_nombre text,
  siigo_error text,
  siigo_payload jsonb,
  enviado_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, clave)
);
CREATE INDEX IF NOT EXISTS egresos_company_period_idx ON public.egresos (company_id, period);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.egresos TO authenticated;
GRANT ALL ON public.egresos TO service_role;
ALTER TABLE public.egresos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS egresos_members ON public.egresos;
CREATE POLICY egresos_members ON public.egresos FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));

-- Un egreso ya creado en Siigo conserva su identidad, valor y propuesta: no se borra ni se reenvía.
CREATE OR REPLACE FUNCTION public.guard_egreso_siigo() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.siigo_id IS NOT NULL THEN RAISE EXCEPTION 'El egreso ya está en Siigo (%); no se puede borrar.', coalesce(OLD.siigo_nombre, OLD.siigo_id); END IF;
    RETURN OLD;
  END IF;
  IF OLD.siigo_id IS NOT NULL AND (
       NEW.siigo_id IS DISTINCT FROM OLD.siigo_id
    OR NEW.valor IS DISTINCT FROM OLD.valor
    OR NEW.propuesta IS DISTINCT FROM OLD.propuesta
    OR NEW.tipo IS DISTINCT FROM OLD.tipo) THEN
    RAISE EXCEPTION 'El egreso ya está en Siigo (%); no se modifica ni se reenvía.', coalesce(OLD.siigo_nombre, OLD.siigo_id);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS egresos_guard_siigo ON public.egresos;
CREATE TRIGGER egresos_guard_siigo BEFORE UPDATE OR DELETE ON public.egresos
  FOR EACH ROW EXECUTE FUNCTION public.guard_egreso_siigo();

CREATE TABLE IF NOT EXISTS public.egreso_reglas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  clase text NOT NULL CHECK (clase IN ('banco', 'concepto')),
  patron text NOT NULL,
  tipo text,
  cuenta_debito text,
  tercero_nit text,
  cuenta_banco text,
  payment_type_id text,
  notas text,
  veces integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, clase, patron)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.egreso_reglas TO authenticated;
GRANT ALL ON public.egreso_reglas TO service_role;
ALTER TABLE public.egreso_reglas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS egreso_reglas_members ON public.egreso_reglas;
CREATE POLICY egreso_reglas_members ON public.egreso_reglas FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
DROP TRIGGER IF EXISTS egreso_reglas_updated_at ON public.egreso_reglas;
CREATE TRIGGER egreso_reglas_updated_at BEFORE UPDATE ON public.egreso_reglas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
