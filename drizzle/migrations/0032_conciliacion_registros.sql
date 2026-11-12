-- Conciliación bancaria (todas las empresas): además de ajustes al peso y reclasificaciones,
-- se registran desde la conciliación:
--   registro_rc: entrada del extracto sin RC → recibo de caja detallado (débito al banco,
--     crédito a la cuenta escogida, cuenta_ajuste);
--   ajuste: diferencia de valor ajustada con comprobante contable contra la cuenta escogida;
--   lote: varias líneas marcadas en un solo documento (RP, RC o comprobante contable), con
--     sus movimientos en detalle para cruzarlos con el extracto.
-- Las salidas sin RP una a una se registran como recibo de pago en Egresos y pagos (egresos).
-- Partidas que la usuaria deja como conciliatorias, con su nota, en conciliaciones_bancarias.partidas.
ALTER TABLE public.conciliacion_ajustes DROP CONSTRAINT IF EXISTS conciliacion_ajustes_tipo_check;
ALTER TABLE public.conciliacion_ajustes ADD CONSTRAINT conciliacion_ajustes_tipo_check
  CHECK (tipo IN ('ajuste_peso', 'reclasificacion', 'registro_rc', 'ajuste', 'lote'));
ALTER TABLE public.conciliacion_ajustes ADD COLUMN IF NOT EXISTS detalle jsonb;

NOTIFY pgrst, 'reload schema';
