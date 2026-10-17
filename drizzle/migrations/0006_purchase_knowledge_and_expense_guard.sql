CREATE INDEX IF NOT EXISTS invoices_company_provider_date_idx ON public.invoices(company_id, provider_nit, issue_date DESC);
CREATE OR REPLACE FUNCTION public.purchase_company_knowledge(_company_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
WITH movements AS (
 SELECT h.provider_nit, coalesce(h.detail,h.description,'') AS concept,h.account_code,h.account_name,h.debit,h.credit,h.voucher,
 CASE WHEN h.entry_date_text ~ '^\d{2}/\d{2}/\d{4}$' THEN to_date(h.entry_date_text,'DD/MM/YYYY') ELSE NULL END AS entry_date
 FROM public.accounting_history h WHERE h.company_id=_company_id AND h.voucher ~ '^(FC|DS)-'
 UNION ALL
 SELECT i.provider_nit,coalesce(l.description,''),l.account_code,l.account_name,l.quantity*l.unit_value-l.discount,0,coalesce(i.voucher_number,i.siigo_number,concat_ws('-',i.prefix,i.number)),i.issue_date
 FROM public.invoices i JOIN public.invoice_lines l ON l.invoice_id=i.id
 WHERE i.company_id=_company_id AND i.status IN ('aprobado','causada','sincronizada','historico')
 UNION ALL
 SELECT i.provider_nit,'',j.account_code,j.account_name,j.debit,j.credit,coalesce(i.voucher_number,i.siigo_number,concat_ws('-',i.prefix,i.number)),i.issue_date
 FROM public.invoices i JOIN public.journal_lines j ON j.invoice_id=i.id
 WHERE i.company_id=_company_id AND i.status IN ('aprobado','causada','sincronizada','historico') AND (j.account_code ~ '^(24|236|22|23)' OR j.account_code='51157001')
), expenses AS (
 SELECT provider_nit,concept,account_code,voucher,entry_date,count(*) AS weight FROM movements
 WHERE debit>0 AND account_code ~ '^(5|6|7|15|16|17)' AND account_code<>'51157001'
 GROUP BY provider_nit,concept,account_code,voucher,entry_date
), documents AS (
 SELECT provider_nit,voucher,entry_date,
 max(account_code) FILTER(WHERE credit>0 AND account_code ~ '^(22|23)' AND account_code !~ '^236') AS payable_account,
 max(account_code) FILTER(WHERE debit>0 AND (account_code ~ '^2408' OR account_code='51157001')) AS iva_account,
 max(account_code) FILTER(WHERE credit>0 AND account_code ~ '^2365') AS retention_account,
 max(substring(account_name from '([0-9]+[.,]?[0-9]*)\s*%')) FILTER(WHERE credit>0 AND account_code ~ '^2365') AS retention_rate,
 bool_or(account_name ILIKE '%vigilancia%' OR concept ~* 'AIU|ADMINISTRACION|UTILIDAD|IMPREVISTOS') AS aiu
 FROM movements GROUP BY provider_nit,voucher,entry_date
), latest AS (SELECT DISTINCT ON(provider_nit) * FROM documents ORDER BY provider_nit,entry_date DESC NULLS LAST,voucher DESC)
SELECT jsonb_build_object('history',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM expenses e),'[]'::jsonb),'profiles',coalesce((SELECT jsonb_agg(to_jsonb(l)) FROM latest l),'[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.purchase_company_knowledge(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.purchase_company_knowledge(uuid) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.guard_purchase_expense_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.status IN ('aprobado','causada') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
  IF EXISTS(SELECT 1 FROM public.invoice_lines l WHERE l.invoice_id=NEW.id AND (coalesce(l.account_code,'') !~ '^(5|6|7|15|16|17)' OR coalesce(l.account_code,'') !~ '^[0-9]+$')) THEN
   RAISE EXCEPTION 'Pendiente de cuenta: hay una línea sin cuenta de gasto válida (grupos 5, 6, 7, 15, 16, 17).';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER purchase_expense_approval_guard BEFORE UPDATE OF status ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_expense_approval();