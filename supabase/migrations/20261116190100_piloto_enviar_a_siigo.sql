-- Piloto automático: envío a Siigo. Por seguridad empieza APAGADO (modo prueba): el piloto evalúa las
-- compras del mes de trabajo y reporta qué enviaría, sin aprobar, causar ni enviar nada. La usuaria lo
-- enciende desde la pantalla «Piloto automático» cuando haya verificado el resultado.
ALTER TABLE public.piloto_config ADD COLUMN IF NOT EXISTS enviar_a_siigo boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
