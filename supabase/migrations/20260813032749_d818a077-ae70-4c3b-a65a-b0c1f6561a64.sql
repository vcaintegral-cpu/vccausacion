CREATE TABLE public.processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL DEFAULT 'document_processing',
  upload_id uuid REFERENCES public.bulk_uploads(id) ON DELETE CASCADE,
  item_id uuid REFERENCES public.bulk_upload_items(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by uuid,
  file_name text NOT NULL DEFAULT '',
  storage_bucket text NOT NULL DEFAULT 'facturas',
  storage_path text,
  status text NOT NULL DEFAULT 'pending',
  processing_stage text,
  priority integer NOT NULL DEFAULT 100,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_at timestamptz,
  locked_by text,
  error_code text,
  error_message text,
  user_message text,
  ai_result jsonb,
  payload jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.processing_jobs TO authenticated;
GRANT ALL ON public.processing_jobs TO service_role;

ALTER TABLE public.processing_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Miembros administran los trabajos de su empresa"
ON public.processing_jobs FOR ALL TO authenticated
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));

CREATE TRIGGER processing_jobs_updated_at
BEFORE UPDATE ON public.processing_jobs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_processing_jobs_queue ON public.processing_jobs (status, priority, created_at);
CREATE INDEX idx_processing_jobs_upload ON public.processing_jobs (upload_id);
CREATE INDEX idx_processing_jobs_company ON public.processing_jobs (company_id, status);
CREATE UNIQUE INDEX idx_processing_jobs_item_type ON public.processing_jobs (item_id, job_type) WHERE item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.release_stale_jobs(_minutes integer DEFAULT 5)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH liberados AS (
    UPDATE public.processing_jobs
    SET status = 'pending', locked_at = NULL, locked_by = NULL, processing_stage = 'reencolado'
    WHERE status IN ('processing','reading','extracting_data','accounting','syncing_siigo')
      AND locked_at IS NOT NULL
      AND locked_at < now() - make_interval(mins => GREATEST(COALESCE(_minutes,5),1))
      AND attempt_count < max_attempts
    RETURNING 1
  )
  SELECT count(*)::integer FROM liberados;
$$;

CREATE OR REPLACE FUNCTION public.claim_jobs(_worker_id text, _limit integer DEFAULT 3, _job_type text DEFAULT NULL)
RETURNS SETOF public.processing_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidatos AS (
    SELECT j.id
    FROM public.processing_jobs j
    WHERE j.status = 'pending'
      AND j.attempt_count < j.max_attempts
      AND (_job_type IS NULL OR j.job_type = _job_type)
    ORDER BY j.priority ASC, j.created_at ASC
    LIMIT GREATEST(COALESCE(_limit, 3), 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.processing_jobs j
  SET status = 'processing',
      processing_stage = 'iniciando',
      locked_at = now(),
      locked_by = _worker_id,
      attempt_count = j.attempt_count + 1,
      started_at = COALESCE(j.started_at, now()),
      error_code = NULL,
      error_message = NULL
  FROM candidatos c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_upload_jobs(_upload_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cancelados AS (
    UPDATE public.processing_jobs j
    SET status = 'cancelled', processing_stage = 'cancelado', locked_at = NULL, locked_by = NULL
    WHERE j.upload_id = _upload_id
      AND j.status = 'pending'
      AND EXISTS (SELECT 1 FROM public.processing_jobs k WHERE k.id = j.id AND public.is_company_member(k.company_id))
    RETURNING 1
  )
  SELECT count(*)::integer FROM cancelados;
$$;

CREATE OR REPLACE FUNCTION public.resume_upload_jobs(_upload_id uuid, _include_errors boolean DEFAULT false)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH reanudados AS (
    UPDATE public.processing_jobs j
    SET status = 'pending',
        processing_stage = 'reencolado',
        locked_at = NULL,
        locked_by = NULL,
        error_code = NULL,
        error_message = NULL,
        attempt_count = CASE WHEN j.status = 'error' THEN 0 ELSE j.attempt_count END
    WHERE j.upload_id = _upload_id
      AND (j.status = 'cancelled' OR (_include_errors AND j.status = 'error'))
      AND EXISTS (SELECT 1 FROM public.processing_jobs k WHERE k.id = j.id AND public.is_company_member(k.company_id))
    RETURNING 1
  )
  SELECT count(*)::integer FROM reanudados;
$$;

REVOKE ALL ON FUNCTION public.claim_jobs(text, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_jobs(text, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.release_stale_jobs(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.release_stale_jobs(integer) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_upload_jobs(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_upload_jobs(uuid, boolean) TO authenticated, service_role;