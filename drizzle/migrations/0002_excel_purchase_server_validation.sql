REVOKE EXECUTE ON FUNCTION public.confirm_excel_purchase(uuid,jsonb,jsonb,jsonb) FROM authenticated;
CREATE OR REPLACE FUNCTION public.confirm_excel_purchase_validated(_item_id uuid, _actor uuid, _choices jsonb, _journal jsonb, _retentions jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE company uuid; result uuid;
BEGIN
 SELECT company_id INTO company FROM public.purchase_import_items WHERE id=_item_id;
 IF _actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=company AND user_id=_actor) THEN RAISE EXCEPTION 'Acceso no autorizado'; END IF;
 PERFORM set_config('request.jwt.claim.sub',_actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',_actor,'role','service_role')::text,true);
 result := public.confirm_excel_purchase(_item_id,_choices,_journal,_retentions);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.confirm_excel_purchase_validated(uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_excel_purchase_validated(uuid,uuid,jsonb,jsonb,jsonb) TO service_role;