ALTER TABLE public.bulk_uploads
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_stage text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.processing_jobs
  ADD COLUMN IF NOT EXISTS lease_until timestamptz;

DROP INDEX IF EXISTS public.idx_processing_jobs_item_type;
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_item_type
  ON public.processing_jobs (item_id, job_type);

CREATE OR REPLACE FUNCTION public.claim_jobs(_worker_id text, _limit integer DEFAULT 3, _job_type text DEFAULT NULL::text)
 RETURNS SETOF processing_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH elegibles AS (
    SELECT j.id,
           j.priority,
           j.created_at,
           row_number() OVER (PARTITION BY COALESCE(j.upload_id, j.id) ORDER BY j.created_at ASC) AS turno
    FROM public.processing_jobs j
    WHERE j.status = 'pending'
      AND j.attempt_count < j.max_attempts
      AND (_job_type IS NULL OR j.job_type = _job_type)
  ),
  candidatos AS (
    SELECT e.id
    FROM elegibles e
    ORDER BY e.priority ASC, e.turno ASC, e.created_at ASC
    LIMIT GREATEST(COALESCE(_limit, 3), 1)
    FOR UPDATE OF e SKIP LOCKED
  )
  UPDATE public.processing_jobs j
  SET status = 'processing',
      processing_stage = 'iniciando',
      locked_at = now(),
      locked_by = _worker_id,
      lease_until = now() + interval '5 minutes',
      attempt_count = j.attempt_count + 1,
      started_at = COALESCE(j.started_at, now()),
      error_code = NULL,
      error_message = NULL
  FROM candidatos c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_stale_jobs(_minutes integer DEFAULT 5)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH liberados AS (
    UPDATE public.processing_jobs
    SET status = 'pending', locked_at = NULL, locked_by = NULL, lease_until = NULL, processing_stage = 'reencolado'
    WHERE status IN ('processing','reading','extracting_data','accounting','syncing_siigo')
      AND locked_at IS NOT NULL
      AND COALESCE(lease_until, locked_at + make_interval(mins => GREATEST(COALESCE(_minutes,5),1))) < now()
      AND attempt_count < max_attempts
    RETURNING 1
  )
  SELECT count(*)::integer FROM liberados;
$function$;
