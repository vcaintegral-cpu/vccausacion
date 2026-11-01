-- Fuentes de documentos: carpetas de Google Drive u OneDrive/SharePoint por
-- empresa, una para COMPRAS y otra para EGRESOS, revisadas automáticamente.

-- Conexión OAuth por empresa y proveedor. Guarda el refresh token: solo el
-- servidor (service_role) la lee; no tiene políticas para usuarios.
CREATE TABLE IF NOT EXISTS public.document_connections (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_email text,
  refresh_token text NOT NULL,
  scopes text,
  connected_by uuid,
  connected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, provider)
);
GRANT ALL ON public.document_connections TO service_role;
ALTER TABLE public.document_connections ENABLE ROW LEVEL SECURITY;

-- Estados de autorización de un solo uso (protección CSRF del flujo OAuth).
CREATE TABLE IF NOT EXISTS public.oauth_states (
  state uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL,
  user_id uuid NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.oauth_states TO service_role;
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- Carpeta elegida por empresa y propósito, y resultado de la última revisión.
CREATE TABLE IF NOT EXISTS public.document_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('compras', 'egresos')),
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  folder_url text NOT NULL,
  folder_id text NOT NULL,
  drive_id text,
  folder_name text,
  month_subfolder text,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_status text,
  last_result jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, purpose)
);
GRANT SELECT ON public.document_sources TO authenticated;
GRANT ALL ON public.document_sources TO service_role;
ALTER TABLE public.document_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read document sources" ON public.document_sources
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- Cada archivo visto en una fuente: evita traerlo dos veces y conserva la
-- pista de pago del nombre ("Corriente16 - ...") para el cruce de egresos.
CREATE TABLE IF NOT EXISTS public.document_source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  folder_path text,
  period text,
  file_type text,
  mime_type text,
  size_bytes bigint,
  external_modified_at timestamptz,
  fingerprint text,
  payment_sources text[],
  payment_day integer,
  status text NOT NULL DEFAULT 'queued',
  message text,
  upload_id uuid REFERENCES public.bulk_uploads(id) ON DELETE SET NULL,
  bulk_item_id uuid REFERENCES public.bulk_upload_items(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS document_source_files_company_idx ON public.document_source_files (company_id, purpose, period);
GRANT SELECT ON public.document_source_files TO authenticated;
GRANT ALL ON public.document_source_files TO service_role;
ALTER TABLE public.document_source_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read document source files" ON public.document_source_files
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- Bandeja de egresos: soportes de pago y extractos traídos de la carpeta de
-- egresos, pendientes de cruzar con las facturas. El estado se cambia por el
-- servidor (después de validar membresía) para que no se alteren rutas ni huellas.
CREATE TABLE IF NOT EXISTS public.payment_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_file_id uuid REFERENCES public.document_source_files(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('soporte_pago', 'extracto')),
  file_name text NOT NULL,
  folder_path text,
  period text,
  storage_path text NOT NULL,
  mime_type text,
  size_bytes bigint,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'revisado', 'descartado')),
  notes text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS payment_documents_company_idx ON public.payment_documents (company_id, status, created_at DESC);
GRANT SELECT ON public.payment_documents TO authenticated;
GRANT ALL ON public.payment_documents TO service_role;
ALTER TABLE public.payment_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read payment documents" ON public.payment_documents
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
