-- Piloto automático nocturno (empresas con la función piloto_automatico).
-- NO es una migración: se ejecuta una sola vez en el SQL de Supabase (Lovable Cloud →
-- Database → SQL), reemplazando el valor entre <>.
-- Cada 10 minutos de 00:00 a 11:59 UTC = 7:00 p. m. a 6:59 a. m. de Colombia. Cada llamada
-- avanza un paso por empresa; la ventana real de cada empresa la define su hora de inicio en
-- la pantalla «Piloto automático». Usa el mismo secreto de la revisión de Drive
-- (document_sync_cron_secret, creado con docs/fuentes-documentos-cron.sql).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://<URL-PUBLICADA-DE-LA-APP>/api/cron/piloto', 'piloto_url');

select cron.schedule(
  'piloto-automatico-nocturno',
  '*/10 0-11 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'piloto_url'),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'document_sync_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Para revisar ejecuciones:  select * from cron.job_run_details order by start_time desc limit 20;
-- Para desactivarlo:         select cron.unschedule('piloto-automatico-nocturno');
