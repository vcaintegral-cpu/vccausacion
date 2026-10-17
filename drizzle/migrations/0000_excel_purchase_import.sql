CREATE TABLE public.purchase_import_settings (
 company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
 config jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_import_settings TO authenticated;
GRANT ALL ON public.purchase_import_settings TO service_role;
ALTER TABLE public.purchase_import_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_settings_members ON public.purchase_import_settings FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
CREATE TABLE public.purchase_import_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 upload_id uuid NOT NULL REFERENCES public.bulk_uploads(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
 position integer NOT NULL,
 document jsonb NOT NULL,
 choices jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL DEFAULT 'pending',
 error_message text,
 invoice_id uuid REFERENCES public.invoices(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(upload_id, position)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_import_items TO authenticated;
GRANT ALL ON public.purchase_import_items TO service_role;
ALTER TABLE public.purchase_import_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_items_members ON public.purchase_import_items FOR ALL TO authenticated USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));
ALTER TABLE public.providers ADD COLUMN IF NOT EXISTS purchase_tax_profile jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS import_source text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS purchase_import_data jsonb;
CREATE INDEX purchase_import_company_idx ON public.purchase_import_items(company_id, created_at DESC);
CREATE OR REPLACE FUNCTION public.confirm_excel_purchase(_item_id uuid, _choices jsonb, _journal jsonb, _retentions jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE item public.purchase_import_items%ROWTYPE; doc jsonb; h jsonb; inv_id uuid; line jsonb; pos integer := 0; debit_sum numeric; credit_sum numeric; affected uuid;
BEGIN
 SELECT * INTO item FROM public.purchase_import_items WHERE id = _item_id FOR UPDATE;
 IF NOT FOUND OR NOT public.is_company_member(item.company_id) OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Acceso no autorizado'; END IF;
 IF item.invoice_id IS NOT NULL THEN RETURN item.invoice_id; END IF;
 doc := item.document; h := doc->'header';
 IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = item.company_id AND regexp_replace(split_part(nit, '-', 1), '[^0-9]', '', 'g') = regexp_replace(h->>'buyer_nit', '[^0-9]', '', 'g')) THEN RAISE EXCEPTION 'Comprador diferente a la empresa activa'; END IF;
 IF EXISTS (SELECT 1 FROM public.invoices WHERE company_id = item.company_id AND ((nullif(h->>'cufe','') IS NOT NULL AND lower(cufe)=lower(h->>'cufe')) OR (regexp_replace(split_part(provider_nit,'-',1),'[^0-9]','','g')=regexp_replace(h->>'provider_nit','[^0-9]','','g') AND coalesce(prefix,'')=coalesce(h->>'prefix','') AND number=h->>'number'))) THEN RAISE EXCEPTION 'Esta factura ya está registrada (PDF, ZIP o Excel)'; END IF;
 SELECT coalesce(sum((v->>'debit')::numeric),0), coalesce(sum((v->>'credit')::numeric),0) INTO debit_sum, credit_sum FROM jsonb_array_elements(_journal) v;
 IF debit_sum <> credit_sum OR debit_sum <= 0 THEN RAISE EXCEPTION 'El asiento no está cuadrado al peso'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(_journal) v WHERE nullif(v->>'account_code','') IS NULL) THEN RAISE EXCEPTION 'Pendiente de cuenta'; END IF;
 IF doc->>'kind' = 'credit_note' THEN
  affected := nullif(_choices->>'affectedInvoiceId','')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE id=affected AND company_id=item.company_id AND provider_nit=h->>'provider_nit' AND import_source IS DISTINCT FROM 'excel_credit_note') THEN RAISE EXCEPTION 'Seleccione la factura afectada del mismo proveedor'; END IF;
 END IF;
 INSERT INTO public.providers(company_id,nit,name,address,city,phone,email) VALUES(item.company_id,h->>'provider_nit',h->>'provider_name',h->>'provider_address',h->>'provider_city',h->>'provider_phone',h->>'provider_email') ON CONFLICT(company_id,nit) DO NOTHING;
 INSERT INTO public.invoices(company_id,created_by,prefix,number,issue_date,due_date,provider_nit,provider_name,provider_address,provider_city,provider_phone,provider_email,buyer_nit,buyer_name,cufe,payment_form,payment_method,currency,cost_center,notes,subtotal,discount,iva,impoconsumo,retefuente,reteiva,reteica,total,status,file_name,raw_extraction,import_source,purchase_import_data,voucher_number,approved_by,approved_at,posted_by,posted_at,payable_account,paid_amount,payment_status)
 VALUES(item.company_id,auth.uid(),h->>'prefix',h->>'number',nullif(h->>'issue_date','')::date,nullif(h->>'due_date','')::date,h->>'provider_nit',h->>'provider_name',h->>'provider_address',h->>'provider_city',h->>'provider_phone',h->>'provider_email',h->>'buyer_nit',h->>'buyer_name',h->>'cufe',h->>'payment_form',h->>'payment_method',coalesce(h->>'currency','COP'),nullif(_choices->>'costCenter',''),h->>'notes',(h->>'subtotal')::numeric,(h->>'discount')::numeric,(h->>'iva')::numeric,(h->>'impoconsumo')::numeric,coalesce((_retentions->>'retefuente')::numeric,0),coalesce((_retentions->>'reteiva')::numeric,0),coalesce((_retentions->>'reteica')::numeric,0),(h->>'total')::numeric,'causada',(SELECT file_name FROM public.bulk_uploads WHERE id=item.upload_id),doc,CASE WHEN doc->>'kind'='credit_note' THEN 'excel_credit_note' ELSE 'excel_recibidos' END,jsonb_build_object('choices',_choices,'document',doc),'EX-'||left(item.upload_id::text,8)||'-'||item.position,auth.uid(),now(),auth.uid(),now(),nullif(_choices->>'payableAccount',''),least((h->>'advances')::numeric,(h->>'total')::numeric),CASE WHEN (h->>'advances')::numeric >= (h->>'total')::numeric THEN 'pagado' ELSE 'pendiente' END) RETURNING id INTO inv_id;
 FOR line IN SELECT value FROM jsonb_array_elements(doc->'lines') LOOP
  INSERT INTO public.invoice_lines(invoice_id,company_id,description,code,quantity,unit_value,discount,iva,impoconsumo,total,account_code,position,item_type)
  VALUES(inv_id,item.company_id,line->>'description',line->>'code',coalesce((line->>'quantity')::numeric,1),coalesce((line->>'unit_value')::numeric,0),coalesce((line->>'discount')::numeric,0),coalesce((line->>'iva')::numeric,0),coalesce((line->>'impoconsumo')::numeric,0),coalesce((line->>'total')::numeric,0),_choices->'accounts'->>pos,pos,'gasto');
  pos := pos+1;
 END LOOP;
 pos:=0;
 FOR line IN SELECT value FROM jsonb_array_elements(_journal) LOOP
  INSERT INTO public.journal_lines(invoice_id,company_id,account_code,account_name,debit,credit,cost_center,position) VALUES(inv_id,item.company_id,line->>'account_code',line->>'account_name',(line->>'debit')::numeric,(line->>'credit')::numeric,nullif(line->>'cost_center',''),pos);
  pos:=pos+1;
 END LOOP;
 UPDATE public.purchase_import_items SET invoice_id=inv_id,status='completed',choices=_choices,error_message=NULL,updated_at=now() WHERE id=item.id;
 UPDATE public.bulk_uploads SET processed_count=(SELECT count(*) FROM public.purchase_import_items WHERE upload_id=item.upload_id AND status='completed'), status=CASE WHEN NOT EXISTS(SELECT 1 FROM public.purchase_import_items WHERE upload_id=item.upload_id AND status<>'completed') THEN 'completed' ELSE 'completed_with_errors' END, finished_at=now() WHERE id=item.upload_id;
 RETURN inv_id;
END $$;
REVOKE ALL ON FUNCTION public.confirm_excel_purchase(uuid,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_excel_purchase(uuid,jsonb,jsonb,jsonb) TO service_role;