UPDATE public.processing_jobs
SET error_code = 'DETACHED_ARRAY_BUFFER',
    error_stage = COALESCE(error_stage, processing_stage, 'processing'),
    user_message = 'Etapa: processing · Código: DETACHED_ARRAY_BUFFER · El PDF fue leído, pero el worker reutilizó un buffer transferido. Puede reintentarse después de la corrección.'
WHERE status = 'error'
  AND error_message ILIKE '%detached ArrayBuffer%';

UPDATE public.bulk_upload_items bi
SET stage = COALESCE(bi.stage, 'processing'),
    user_message = 'Etapa: processing · Código: DETACHED_ARRAY_BUFFER · El PDF fue leído, pero el worker reutilizó un buffer transferido. Puede reintentarse después de la corrección.'
WHERE bi.status = 'error'
  AND bi.error_message ILIKE '%detached ArrayBuffer%';