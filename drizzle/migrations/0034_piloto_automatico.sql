-- Piloto automático (empresas con la función piloto_automatico; hoy LED LIGHTS): trabaja de
-- noche sin intervención y le pregunta a la usuaria por correo lo que no puede decidir solo.
--   piloto_config: activo, correo de avisos, tope de valor para aprobar solo, hora de inicio.
--   piloto_ejecuciones: una por empresa y noche — los pasos hechos y su resultado (la
--     «memoria» diaria) y cuándo se envió el reporte.
--   piloto_decisiones: preguntas con opciones; se responden con un enlace firmado del correo
--     (token) o desde la bandeja de la aplicación. Mientras esperan, los demás pasos siguen.
CREATE TABLE IF NOT EXISTS public.piloto_config (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  activo boolean NOT NULL DEFAULT false,
  correo text,
  tope_valor numeric(18,2) NOT NULL DEFAULT 5000000,
  hora_inicio integer NOT NULL DEFAULT 18 CHECK (hora_inicio BETWEEN 0 AND 23),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.piloto_ejecuciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  noche date NOT NULL,
  estado text NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso', 'terminada', 'error')),
  pasos jsonb NOT NULL DEFAULT '[]'::jsonb,
  resumen jsonb NOT NULL DEFAULT '{}'::jsonb,
  reporte_enviado_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, noche)
);

CREATE TABLE IF NOT EXISTS public.piloto_decisiones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  ejecucion_id uuid REFERENCES public.piloto_ejecuciones(id) ON DELETE SET NULL,
  clave text NOT NULL,
  tipo text NOT NULL,
  referencia_id text,
  titulo text NOT NULL,
  pregunta text NOT NULL,
  opciones jsonb NOT NULL DEFAULT '[]'::jsonb,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'respondida', 'aplicada', 'descartada')),
  respuesta text,
  instruccion text,
  token text NOT NULL UNIQUE DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  notificada_at timestamptz,
  respondida_at timestamptz,
  aplicada_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, clave)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.piloto_config, public.piloto_ejecuciones, public.piloto_decisiones TO authenticated;
GRANT ALL ON public.piloto_config, public.piloto_ejecuciones, public.piloto_decisiones TO service_role;
ALTER TABLE public.piloto_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.piloto_ejecuciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.piloto_decisiones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS piloto_config_members ON public.piloto_config;
CREATE POLICY piloto_config_members ON public.piloto_config FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
DROP POLICY IF EXISTS piloto_ejecuciones_members ON public.piloto_ejecuciones;
CREATE POLICY piloto_ejecuciones_members ON public.piloto_ejecuciones FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
DROP POLICY IF EXISTS piloto_decisiones_members ON public.piloto_decisiones;
CREATE POLICY piloto_decisiones_members ON public.piloto_decisiones FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
DROP TRIGGER IF EXISTS piloto_config_updated_at ON public.piloto_config;
CREATE TRIGGER piloto_config_updated_at BEFORE UPDATE ON public.piloto_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS piloto_ejecuciones_updated_at ON public.piloto_ejecuciones;
CREATE TRIGGER piloto_ejecuciones_updated_at BEFORE UPDATE ON public.piloto_ejecuciones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS piloto_decisiones_updated_at ON public.piloto_decisiones;
CREATE TRIGGER piloto_decisiones_updated_at BEFORE UPDATE ON public.piloto_decisiones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

NOTIFY pgrst, 'reload schema';
