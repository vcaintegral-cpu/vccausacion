-- Compras de inventario: los renglones de PRODUCTO o SERVICIO pueden aprobarse con
-- cuentas 14 (inventarios: 1435 mercancías, 1498 otros inventarios, etc.).
-- Los renglones de gasto siguen exigiendo cuentas 5, 6, 7, 15, 16 o 17.
-- La herramienta solo asigna cuentas 14 a las empresas con la función
-- "productos_inventario" encendida en su perfil (src/empresas/<empresa>/perfil.ts).
CREATE OR REPLACE FUNCTION public.guard_purchase_expense_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.status IN ('aprobado','causada') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
  IF EXISTS(
    SELECT 1 FROM public.invoice_lines l
   WHERE l.invoice_id=NEW.id
     AND (
       coalesce(l.account_code,'') !~ '^[0-9]+$'
       OR NOT (
         coalesce(l.account_code,'') ~ '^(5|6|7|15|16|17)'
         OR (coalesce(l.account_code,'') ~ '^14' AND l.item_type IN ('producto','servicio'))
       )
     )
  ) THEN
    RAISE EXCEPTION 'Pendiente de cuenta: hay una línea sin cuenta válida (gasto 5, 6, 7, 15, 16, 17; inventario 14 solo en renglones de producto).';
  END IF;
 END IF;
 RETURN NEW;
END; $$;