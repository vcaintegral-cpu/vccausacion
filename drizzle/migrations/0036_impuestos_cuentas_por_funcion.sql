-- Cuentas contables de cada impuesto por función, tal como las configura Siigo (reporte de
-- impuestos en Excel: Ventas, Compras, Devolución ventas, Devolución compras). La cuenta de
-- compras sigue siendo account_code (la que usa la causación de compras). Los códigos se
-- guardan como TEXTO de solo dígitos, sin completar ni recortar.
-- excel_code: código del impuesto en el reporte de Siigo.
ALTER TABLE public.tax_rates
  ADD COLUMN IF NOT EXISTS account_sales text,
  ADD COLUMN IF NOT EXISTS account_sales_return text,
  ADD COLUMN IF NOT EXISTS account_purchase_return text,
  ADD COLUMN IF NOT EXISTS excel_code text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_rates_cuentas_solo_digitos') THEN
    ALTER TABLE public.tax_rates
      ADD CONSTRAINT tax_rates_cuentas_solo_digitos CHECK (
        (account_sales IS NULL OR account_sales ~ '^[0-9]+$')
        AND (account_sales_return IS NULL OR account_sales_return ~ '^[0-9]+$')
        AND (account_purchase_return IS NULL OR account_purchase_return ~ '^[0-9]+$')
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';