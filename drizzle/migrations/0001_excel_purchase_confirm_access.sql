GRANT EXECUTE ON FUNCTION public.confirm_excel_purchase(uuid,jsonb,jsonb,jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.validate_purchase_import_scope() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.bulk_uploads WHERE id=NEW.upload_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'La carga no pertenece a la empresa'; END IF;
 IF NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.invoices WHERE id=NEW.invoice_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'Factura de otra empresa'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_import_scope BEFORE INSERT OR UPDATE ON public.purchase_import_items FOR EACH ROW EXECUTE FUNCTION public.validate_purchase_import_scope();
REVOKE ALL ON FUNCTION public.validate_purchase_import_scope() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_purchase_import_scope() TO service_role;