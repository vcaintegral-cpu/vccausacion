ALTER TABLE public.processing_jobs
  ADD COLUMN IF NOT EXISTS error_stage text,
  ADD COLUMN IF NOT EXISTS error_stack text,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false;

ALTER TABLE public.bulk_upload_items
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false;

UPDATE public.processing_jobs
SET retryable = true
WHERE status = 'error'
  AND job_type = 'document_processing'
  AND error_code <> 'DUPLICATE';

UPDATE public.bulk_upload_items bi
SET retryable = true
WHERE bi.status = 'error'
  AND EXISTS (
    SELECT 1
    FROM public.processing_jobs pj
    WHERE pj.item_id = bi.id
      AND pj.retryable = true
  );