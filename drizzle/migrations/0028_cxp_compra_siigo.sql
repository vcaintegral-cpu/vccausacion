-- Egresos (todas las empresas): identificador de la compra de Siigo de cada vencimiento
-- de CxP, para analizar diferencias entre el pago y el saldo (retenciones) y, con la
-- confirmación de la usuaria, corregir la compra en Siigo antes de hacer el recibo de pago.
ALTER TABLE public.siigo_cuentas_por_pagar ADD COLUMN IF NOT EXISTS siigo_purchase_id text;