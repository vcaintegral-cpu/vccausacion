-- Isolated PostgreSQL only. Load the current public schema and the v2 migration first.
-- Run with psql -v ON_ERROR_STOP=1 -f src/lib/draft-sync.database.test.sql.
-- Synthetic fixtures are always rolled back; never run this suite against production.
BEGIN;
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
INSERT INTO auth.users(id) VALUES ('10000000-0000-0000-0000-000000000001');
INSERT INTO public.companies(id,name,nit,created_by) VALUES
 ('20000000-0000-0000-0000-000000000001','Sync test company','999111000','10000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000002','Other test company','999111001','10000000-0000-0000-0000-000000000001');
INSERT INTO public.puc_accounts(company_id,code,name) SELECT '20000000-0000-0000-0000-000000000001'::uuid,c,c
 FROM unnest(ARRAY['51350501','621033','14350101','22050501']) c;
INSERT INTO public.invoices(id,company_id,created_by,number,provider_nit,subtotal,total,raw_extraction,status,buyer_nit)
SELECT ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 CASE WHEN n=6 THEN '20000000-0000-0000-0000-000000000002'::uuid ELSE '20000000-0000-0000-0000-000000000001'::uuid END,
 '10000000-0000-0000-0000-000000000001',n::text,CASE WHEN n=5 THEN '888222000' ELSE '888111000' END,200,200,
 '{"account_decisions":{"1":{"code":"14350101","origin":"MANUAL","itemType":"producto","productCode":"INV1"}},"productos_nuevos":{"1":{"codigo":"INV1","nombre":"Inventory"}}}'::jsonb,
 CASE WHEN n=4 THEN 'aprobada' ELSE 'borrador' END, CASE WHEN n=6 THEN '999111001' ELSE '999111000' END FROM generate_series(1,6) n;
INSERT INTO public.invoice_lines(id,invoice_id,company_id,position,account_code,item_type,code,description,total,unit_value)
SELECT ('40000000-0000-0000-0000-'||lpad((n*10+p)::text,12,'0'))::uuid,
 ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 CASE WHEN n=6 THEN '20000000-0000-0000-0000-000000000002'::uuid ELSE '20000000-0000-0000-0000-000000000001'::uuid END,p,
 CASE WHEN p=1 THEN '14350101' WHEN n=1 THEN '621033' WHEN n=3 THEN NULL ELSE '51350501' END,
 CASE WHEN p=1 THEN 'producto' ELSE 'gasto' END,CASE WHEN p=1 THEN 'INV1' ELSE NULL END,'Material',100,100
 FROM generate_series(1,6) n CROSS JOIN generate_series(0,1) p;
INSERT INTO public.journal_lines(invoice_id,company_id,account_code,debit,credit,position)
SELECT invoice_id,company_id,coalesce(account_code,''),100,0,position FROM public.invoice_lines
 WHERE company_id IN ('20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002');

DO $$
DECLARE res jsonb; undo jsonb; known jsonb; plans jsonb; before2 jsonb; before3 jsonb; ev uuid; events_before integer;
 src uuid:='30000000-0000-0000-0000-000000000001'; d2 uuid:='30000000-0000-0000-0000-000000000002'; d3 uuid:='30000000-0000-0000-0000-000000000003';
 changes jsonb:='[{"kind":"gasto","old":"51350501","new":"621033","name":"Expense"}]';
BEGIN
 SELECT jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at)) INTO known FROM public.invoices WHERE id<>src;
 SELECT jsonb_agg(jsonb_build_object('invoice_id',invoice_id,'lines',jsonb_build_array(jsonb_build_object(
  'id',id,'position',position,'old_account',account_code,'account_code','621033','account_name','Expense','item_type','gasto','code',null)))) INTO plans
 FROM public.invoice_lines WHERE invoice_id IN(d2,d3) AND position=0;
 before2:=public.draft_sync_state_v2(d2); before3:=public.draft_sync_state_v2(d3);
 res:=public.sync_provider_drafts_v2(src,changes,'test-expense',known,plans,true);
 IF res->>'ok'<>'true' OR (res->>'updated')::integer<>2 THEN RAISE EXCEPTION 'Expected two updated drafts: %',res; END IF;
 ev:=(res->>'event_id')::uuid;
 IF EXISTS(SELECT 1 FROM public.invoice_lines WHERE invoice_id IN(d2,d3) AND position=0 AND account_code<>'621033') THEN RAISE EXCEPTION 'Expense/missing account not assigned'; END IF;
 IF EXISTS(SELECT 1 FROM public.invoice_lines WHERE position=1 AND (account_code<>'14350101' OR code<>'INV1' OR item_type<>'producto')) THEN RAISE EXCEPTION 'Inventory overwritten'; END IF;
 IF (SELECT raw_extraction->'account_decisions'->'0'->>'origin' FROM public.invoices WHERE id=d2)<>'MANUAL' THEN RAISE EXCEPTION 'Manual decision missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.invoice_lines WHERE invoice_id IN('30000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000006') AND position=0 AND account_code<>'51350501') THEN RAISE EXCEPTION 'Scope isolation failed'; END IF;
 IF public.sync_provider_drafts_v2(src,changes,'test-expense',known,plans,true)->>'already'<>'true' THEN RAISE EXCEPTION 'Duplicate event applied'; END IF;
 undo:=public.undo_provider_draft_sync_v2(ev);
 IF undo->>'ok'<>'true' OR (undo->>'restored')::integer<>2 THEN RAISE EXCEPTION 'Undo failed: %',undo; END IF;
 IF (public.draft_sync_state_v2(d2)#>'{lines}')<>before2->'lines' OR (public.draft_sync_state_v2(d2)#>'{journal}')<>before2->'journal'
 OR (SELECT raw_extraction FROM public.invoices WHERE id=d2)<>before2#>'{invoice,raw_extraction}' THEN RAISE EXCEPTION 'Undo did not restore exact account/product/decision/journal'; END IF;
 IF (public.draft_sync_state_v2(d3)#>'{lines}')<>before3->'lines' THEN RAISE EXCEPTION 'Undo did not restore missing account'; END IF;
 IF public.undo_provider_draft_sync_v2(ev)->>'already'<>'true' THEN RAISE EXCEPTION 'Undo not idempotent'; END IF;
 RAISE NOTICE 'PASS: mixed inventory/expense + missing account, manual metadata, isolation, apply/readback/undo/readback, idempotency';

 SELECT jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at)) INTO known FROM public.invoices WHERE id<>src;
 res:=public.sync_provider_drafts_v2(src,changes,'test-concurrent',known,plans,true); ev:=(res->>'event_id')::uuid;
 UPDATE public.invoices SET notes='Later manual edit' WHERE id=d2;
 undo:=public.undo_provider_draft_sync_v2(ev);
 IF undo->>'ok'<>'false' OR (SELECT notes FROM public.invoices WHERE id=d2)<>'Later manual edit'
 OR EXISTS(SELECT 1 FROM public.invoice_lines WHERE invoice_id IN(d2,d3) AND position=0 AND account_code<>'621033') THEN RAISE EXCEPTION 'Concurrent edit overwritten or partial undo'; END IF;
 RAISE NOTICE 'PASS: later edits block the whole undo without partial restoration';

 SELECT jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at-interval '1 minute')) INTO known FROM public.invoices WHERE id<>src;
 res:=public.sync_provider_drafts_v2(src,changes,'test-stale',known,plans,true);
 IF jsonb_array_length(res->'conflicts')<1 THEN RAISE EXCEPTION 'Stale version not detected'; END IF;
 RAISE NOTICE 'PASS: stale drafts are conflicts';

 SELECT jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at)) INTO known FROM public.invoices WHERE id<>src;
 before2:=public.draft_sync_state_v2(d2);
 res:=public.sync_provider_drafts_v2(src,'[{"kind":"cost_center","old":"","new":"CENTRO"}]','test-center',known,'[]',false);
 IF (public.draft_sync_state_v2(d2)->'lines')<>before2->'lines' THEN RAISE EXCEPTION 'Cost center changed line accounts'; END IF;
 IF res->>'ok'<>'true' THEN RAISE EXCEPTION 'Cost center sync failed'; END IF;
 RAISE NOTICE 'PASS: cost-center-only sync does not classify or assign lines';

 UPDATE public.invoice_lines SET item_type='producto',code='P1' WHERE invoice_id=src AND position=0;
 UPDATE public.invoices SET raw_extraction=raw_extraction || '{"productos_nuevos":{"0":{"codigo":"P1","nombre":"New product"}}}'::jsonb WHERE id=src;
 SELECT jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at)) INTO known FROM public.invoices WHERE id<>src;
 SELECT jsonb_build_array(jsonb_build_object('invoice_id',d2,'lines',jsonb_build_array(jsonb_build_object(
  'id',id,'position',position,'old_account',account_code,'account_code',account_code,'account_name',account_name,'item_type','producto','code','P1')))) INTO plans
 FROM public.invoice_lines WHERE invoice_id=d2 AND position=0;
 before2:=public.draft_sync_state_v2(d2);
 res:=public.sync_provider_drafts_v2(src,'[{"kind":"tipo","old":"gasto","new":"producto"}]','test-product',known,plans,true);
 ev:=(res->>'event_id')::uuid;
 IF (res->>'updated')::integer<>1 OR (SELECT code FROM public.invoice_lines WHERE invoice_id=d2 AND position=0)<>'P1'
 OR (SELECT raw_extraction->'productos_nuevos'->'0'->>'codigo' FROM public.invoices WHERE id=d2)<>'P1' THEN RAISE EXCEPTION 'Explicit product classification not recorded'; END IF;
 undo:=public.undo_provider_draft_sync_v2(ev);
 IF undo->>'ok'<>'true' OR public.draft_sync_state_v2(d2)->'lines'<>before2->'lines'
 OR (SELECT raw_extraction FROM public.invoices WHERE id=d2)<>before2#>'{invoice,raw_extraction}' THEN RAISE EXCEPTION 'Undo did not restore product classification and metadata'; END IF;
 RAISE NOTICE 'PASS: explicit classification, new-product metadata and exact undo';

 SELECT count(*) INTO events_before FROM public.draft_sync_events;
 SELECT jsonb_build_array(jsonb_build_object('invoice_id',d2,'lines',jsonb_build_array(jsonb_build_object(
  'id',id,'position',position,'old_account',account_code,'account_code','621033','account_name','Wrong','item_type','producto','code','P1')))) INTO plans
 FROM public.invoice_lines WHERE invoice_id=d2 AND position=1;
 BEGIN
  PERFORM public.sync_provider_drafts_v2(src,changes,'test-malicious',known,plans,true);
  RAISE EXCEPTION 'Invalid inventory overwrite accepted';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='Invalid inventory overwrite accepted' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.draft_sync_events)<>events_before OR (SELECT account_code FROM public.invoice_lines WHERE invoice_id=d2 AND position=1)<>'14350101' THEN RAISE EXCEPTION 'Failed sync leaked partial writes'; END IF;
 IF EXISTS(SELECT 1 FROM public.invoices WHERE subtotal<>200 OR total<>200) OR EXISTS(SELECT 1 FROM public.invoice_lines WHERE total<>100 OR unit_value<>100)
 OR EXISTS(SELECT 1 FROM public.journal_lines WHERE debit<>100 OR credit<>0) THEN RAISE EXCEPTION 'Synchronization changed monetary values'; END IF;
 IF has_function_privilege('anon','public.sync_provider_drafts_v2(uuid,jsonb,text,jsonb,jsonb,boolean)','EXECUTE')
 OR has_function_privilege('authenticated','public.draft_sync_state_v2(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Private functions exposed'; END IF;
 RAISE NOTICE 'PASS: server rejects inventory overwrite atomically; amounts preserved; private snapshots inaccessible';

 PERFORM set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000099',true);
 IF public.sync_provider_drafts_v2(src,changes,'test-expense',known,plans,true)->>'ok'<>'false' THEN RAISE EXCEPTION 'Unauthorized event replay disclosed state'; END IF;
 IF public.undo_provider_draft_sync_v2(ev)->>'ok'<>'false' THEN RAISE EXCEPTION 'Unauthorized undo allowed'; END IF;
 RAISE NOTICE 'PASS: membership required for sync, duplicate replay and undo';
END $$;
ROLLBACK;