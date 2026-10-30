-- Revisión automática diaria del importador de Google Drive.
-- NO es una migración: se ejecuta una sola vez en el SQL de Supabase (Lovable
-- Cloud → Database → SQL), reemplazando los dos valores entre <>.
-- Hora: 23:00–23:45 UTC = 6:00–6:45 p. m. de Colombia, cuatro pasadas de 15
-- minutos para que un mes con muchas facturas entre completo el mismo día
-- (cada pasada toma hasta DRIVE_SYNC_MAX_FILES PDF, 20 por defecto).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- URL publicada de la app + ruta del importador, y el mismo valor de DRIVE_SYNC_CRON_SECRET.
select vault.create_secret('https://<URL-PUBLICADA-DE-LA-APP>/api/cron/drive-sync', 'drive_sync_url');
select vault.create_secret('<MISMO-VALOR-DE-DRIVE_SYNC_CRON_SECRET>', 'drive_sync_cron_secret');

select cron.schedule(
  'drive-sync-diario',
  '*/15 23 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'drive_sync_url'),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'drive_sync_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Para revisar ejecuciones:  select * from cron.job_run_details order by start_time desc limit 20;
-- Para desactivarla:         select cron.unschedule('drive-sync-diario');
