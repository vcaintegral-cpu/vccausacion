ALTER TABLE public.puc_accounts
  ADD COLUMN IF NOT EXISTS excel_active boolean,
  ADD COLUMN IF NOT EXISTS siigo_active boolean,
  ADD COLUMN IF NOT EXISTS siigo_is_movement boolean,
  ADD COLUMN IF NOT EXISTS siigo_seen_at timestamp with time zone;

COMMENT ON COLUMN public.puc_accounts.excel_active IS 'Estado estructural de la cuenta según la última importación Excel; no reemplaza la evidencia de Siigo.';
COMMENT ON COLUMN public.puc_accounts.siigo_active IS 'Estado operativo confirmado por sincronización real con Siigo.';
COMMENT ON COLUMN public.puc_accounts.siigo_is_movement IS 'Indica que la cuenta fue observada con movimiento real en Siigo.';
COMMENT ON COLUMN public.puc_accounts.siigo_seen_at IS 'Última fecha en que la cuenta fue confirmada en datos reales de Siigo.';

UPDATE public.puc_accounts
SET excel_active = active
WHERE excel_active IS NULL AND source = 'excel';

UPDATE public.puc_accounts
SET siigo_active = true,
    siigo_is_movement = true,
    siigo_seen_at = COALESCE(synced_at, now())
WHERE siigo_code IS NOT NULL OR siigo_id IS NOT NULL OR source = 'siigo';