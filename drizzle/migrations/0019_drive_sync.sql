-- Importador automático de compras desde Google Drive.

-- Conexión OAuth con Google por empresa. Guarda el refresh token: solo el
-- servidor (service_role) puede leerla; no tiene políticas para usuarios.
CREATE TABLE IF NOT EXISTS public.google_drive_connections (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  google_email text,
  refresh_token text NOT NULL,
  scopes text,
  connected_by uuid,
  connected_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.google_drive_connections TO service_role;
ALTER TABLE public.google_drive_connections ENABLE ROW LEVEL SECURITY;

-- Estados de autorización pendientes (protección CSRF del flujo OAuth).
CREATE TABLE IF NOT EXISTS public.google_oauth_states (
  state uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.google_oauth_states TO service_role;
ALTER TABLE public.google_oauth_states ENABLE ROW LEVEL SECURITY;

-- Carpeta raíz de Drive que se revisa por empresa y resultado de la última ejecución.
CREATE TABLE IF NOT EXISTS public.drive_sync_sources (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  root_folder_id text NOT NULL,
  root_folder_name text,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_status text,
  last_result jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.drive_sync_sources TO authenticated;
GRANT ALL ON public.drive_sync_sources TO service_role;
ALTER TABLE public.drive_sync_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read drive sources" ON public.drive_sync_sources
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- Cada archivo de Drive visto por el importador: evita traerlo dos veces y
-- conserva la pista de pago del nombre ("Corriente16 - ...") para los egresos.
CREATE TABLE IF NOT EXISTS public.drive_sync_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  drive_file_id text NOT NULL,
  name text NOT NULL,
  folder_path text,
  period text,
  mime_type text,
  size_bytes bigint,
  drive_modified_at timestamptz,
  fingerprint text,
  payment_sources text[],
  payment_day integer,
  status text NOT NULL DEFAULT 'queued',
  message text,
  upload_id uuid REFERENCES public.bulk_uploads(id) ON DELETE SET NULL,
  bulk_item_id uuid REFERENCES public.bulk_upload_items(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS drive_sync_files_company_period_idx ON public.drive_sync_files (company_id, period);
GRANT SELECT ON public.drive_sync_files TO authenticated;
GRANT ALL ON public.drive_sync_files TO service_role;
ALTER TABLE public.drive_sync_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read drive files" ON public.drive_sync_files
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
