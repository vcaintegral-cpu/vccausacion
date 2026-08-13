CREATE TABLE public.bulk_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  file_name text NOT NULL,
  storage_path text,
  size_bytes bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'uploaded',
  files_found integer NOT NULL DEFAULT 0,
  pdf_found integer NOT NULL DEFAULT 0,
  skipped_files integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bulk_uploads TO authenticated;
GRANT ALL ON public.bulk_uploads TO service_role;
ALTER TABLE public.bulk_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bulk_uploads company members" ON public.bulk_uploads
  FOR ALL TO authenticated
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

CREATE TABLE public.bulk_upload_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.bulk_uploads(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  storage_path text,
  size_bytes bigint NOT NULL DEFAULT 0,
  fingerprint text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  stage text,
  error_message text,
  user_message text,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  invoice_number text,
  invoice_total numeric,
  score numeric,
  needs_review boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bulk_upload_items TO authenticated;
GRANT ALL ON public.bulk_upload_items TO service_role;
ALTER TABLE public.bulk_upload_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bulk_upload_items company members" ON public.bulk_upload_items
  FOR ALL TO authenticated
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

CREATE INDEX bulk_uploads_company_idx ON public.bulk_uploads (company_id, created_at DESC);
CREATE INDEX bulk_upload_items_upload_idx ON public.bulk_upload_items (upload_id, position);
CREATE INDEX bulk_upload_items_status_idx ON public.bulk_upload_items (company_id, status);
CREATE UNIQUE INDEX bulk_upload_items_fingerprint_idx
  ON public.bulk_upload_items (company_id, fingerprint)
  WHERE fingerprint IS NOT NULL;

CREATE TRIGGER bulk_uploads_updated_at BEFORE UPDATE ON public.bulk_uploads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER bulk_upload_items_updated_at BEFORE UPDATE ON public.bulk_upload_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();