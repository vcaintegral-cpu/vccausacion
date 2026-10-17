CREATE OR REPLACE FUNCTION public.confirm_excel_purchase_validated(_item_id uuid, _actor uuid, _choices jsonb, _journal jsonb, _retentions jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE company uuid; result uuid; doc_kind text; config jsonb; voucher text;
BEGIN
 SELECT company_id,document->>'kind' INTO company,doc_kind FROM public.purchase_import_items WHERE id=_item_id;
 IF _actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=company AND user_id=_actor) THEN RAISE EXCEPTION 'Acceso no autorizado'; END IF;
 SELECT s.config INTO config FROM public.purchase_import_settings s WHERE company_id=company;
 voucher := CASE WHEN doc_kind='credit_note' THEN config->>'creditVoucher' WHEN doc_kind='equivalent' THEN config->>'equivalentVoucher' ELSE config->>'purchaseVoucher' END;
 IF nullif(voucher,'') IS NULL THEN RAISE EXCEPTION 'Configure el comprobante para este tipo de documento'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(company::text,0));
 PERFORM set_config('request.jwt.claim.sub',_actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',_actor,'role','service_role')::text,true);
 result := public.confirm_excel_purchase(_item_id,_choices,_journal,_retentions);
 UPDATE public.invoices SET purchase_import_data=purchase_import_data||jsonb_build_object('voucher',voucher) WHERE id=result AND NOT (purchase_import_data ? 'voucher');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.confirm_excel_purchase_validated(uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_excel_purchase_validated(uuid,uuid,jsonb,jsonb,jsonb) TO service_role;