CREATE OR REPLACE FUNCTION public.enforce_invoice_buyer_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_nit text;
  v_buyer_nit text;
BEGIN
  SELECT regexp_replace(split_part(coalesce(c.nit,''), '-', 1), '\D', '', 'g')
    INTO v_company_nit
  FROM public.companies c WHERE c.id = NEW.company_id;

  v_buyer_nit := regexp_replace(split_part(coalesce(NEW.buyer_nit,''), '-', 1), '\D', '', 'g');

  IF coalesce(v_company_nit,'') = '' THEN
    RAISE EXCEPTION 'La empresa activa no tiene NIT configurado. Registre el NIT antes de guardar facturas.';
  END IF;

  IF v_buyer_nit = '' THEN
    RAISE EXCEPTION 'No fue posible verificar el NIT del comprador de la factura. Verifique la factura manualmente antes de continuar.';
  END IF;

  IF NOT (
    v_buyer_nit = v_company_nit
    OR (length(v_buyer_nit) = length(v_company_nit) + 1 AND v_buyer_nit LIKE v_company_nit || '%')
    OR (length(v_company_nit) = length(v_buyer_nit) + 1 AND v_company_nit LIKE v_buyer_nit || '%')
  ) THEN
    RAISE EXCEPTION 'Factura no pertenece a la empresa seleccionada. El NIT del comprador (%) no coincide con el NIT de la empresa activa (%).', v_buyer_nit, v_company_nit;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_buyer_company_check ON public.invoices;
CREATE TRIGGER invoices_buyer_company_check
BEFORE INSERT OR UPDATE OF company_id, buyer_nit ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_buyer_company();