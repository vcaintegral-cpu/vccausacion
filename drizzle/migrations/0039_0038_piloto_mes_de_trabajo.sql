-- Piloto automático: mes de trabajo. El piloto solo causa documentos de ese mes y pasa al siguiente
-- únicamente cuando la usuaria confirma que el mes quedó completo (facturas, egresos y conciliación).
-- NULL = el mes actual de Colombia.
ALTER TABLE public.piloto_config ADD COLUMN IF NOT EXISTS mes_trabajo date;

NOTIFY pgrst, 'reload schema';