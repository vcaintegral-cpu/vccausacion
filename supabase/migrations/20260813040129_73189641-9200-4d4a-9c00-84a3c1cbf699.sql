CREATE OR REPLACE FUNCTION public.claim_jobs(_worker_id text, _limit integer DEFAULT 3, _job_type text DEFAULT NULL::text)
 RETURNS SETOF processing_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH orden AS (
    SELECT j.id,
           j.priority,
           j.created_at,
           row_number() OVER (PARTITION BY COALESCE(j.upload_id, j.id) ORDER BY j.created_at ASC) AS turno
    FROM public.processing_jobs j
    WHERE j.status = 'pending'
      AND j.attempt_count < j.max_attempts
      AND (_job_type IS NULL OR j.job_type = _job_type)
  ),
  seleccion AS (
    SELECT o.id
    FROM orden o
    ORDER BY o.priority ASC, o.turno ASC, o.created_at ASC
    LIMIT GREATEST(COALESCE(_limit, 3), 1)
  ),
  candidatos AS (
    SELECT j.id
    FROM public.processing_jobs j
    WHERE j.id IN (SELECT id FROM seleccion)
      AND j.status = 'pending'
    FOR UPDATE SKIP LOCKED
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
