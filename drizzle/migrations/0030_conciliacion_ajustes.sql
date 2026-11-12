-- Conciliación bancaria (todas las empresas): ajustes al peso enviados a Siigo como
-- comprobante contable desde la conciliación (diferencia entre el RC/RP y el banco dentro
-- del tope). Uno por diferencia (clave estable); con identidad de Siigo no se modifica,
-- no se borra ni se reenvía.
CREATE TABLE IF NOT EXISTS public.conciliacion_ajustes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  periodo text NOT NULL,
  cuenta_etiqueta text NOT NULL,
  clave text NOT NULL,
  fecha date NOT NULL,
  valor numeric(18,2) NOT NULL,
  cuenta_banco text NOT NULL,
  cuenta_ajuste text NOT NULL,
  tercero_nit text NOT NULL,
  comprobante_origen text,
  descripcion text,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'error')),
  siigo_id text,
  siigo_nombre text,
  siigo_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, clave)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conciliacion_ajustes TO authenticated;
GRANT ALL ON public.conciliacion_ajustes TO service_role;
ALTER TABLE public.conciliacion_ajustes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conciliacion_ajustes_members ON public.conciliacion_ajustes;
CREATE POLICY conciliacion_ajustes_members ON public.conciliacion_ajustes FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
DROP TRIGGER IF EXISTS conciliacion_ajustes_updated_at ON public.conciliacion_ajustes;
CREATE TRIGGER conciliacion_ajustes_updated_at BEFORE UPDATE ON public.conciliacion_ajustes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.conciliacion_ajustes_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.siigo_id IS NOT NULL THEN
      RAISE EXCEPTION 'El ajuste ya está en Siigo (%); no se puede borrar.', coalesce(OLD.siigo_nombre, OLD.siigo_id);
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.siigo_id IS NOT NULL AND (
       NEW.siigo_id IS DISTINCT FROM OLD.siigo_id
    OR NEW.valor IS DISTINCT FROM OLD.valor
    OR NEW.fecha IS DISTINCT FROM OLD.fecha
    OR NEW.cuenta_banco IS DISTINCT FROM OLD.cuenta_banco
    OR NEW.cuenta_ajuste IS DISTINCT FROM OLD.cuenta_ajuste
    OR NEW.tercero_nit IS DISTINCT FROM OLD.tercero_nit
    OR NEW.estado IS DISTINCT FROM OLD.estado
  ) THEN
    RAISE EXCEPTION 'El ajuste ya está en Siigo (%); no se modifica ni se reenvía.', coalesce(OLD.siigo_nombre, OLD.siigo_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS conciliacion_ajustes_inmutable ON public.conciliacion_ajustes;
CREATE TRIGGER conciliacion_ajustes_inmutable BEFORE UPDATE OR DELETE ON public.conciliacion_ajustes
  FOR EACH ROW EXECUTE FUNCTION public.conciliacion_ajustes_inmutable();

NOTIFY pgrst, 'reload schema';
