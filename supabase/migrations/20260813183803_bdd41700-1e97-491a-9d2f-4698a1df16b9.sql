ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS default_payable_account text;

CREATE INDEX IF NOT EXISTS accounting_history_company_nit_idx
  ON public.accounting_history (company_id, provider_nit);

CREATE OR REPLACE FUNCTION public.history_provider_payable_accounts(_company_id uuid, _nits text[], _limit integer DEFAULT 50)
RETURNS TABLE(provider_nit text, account_code text, uses bigint, credit_total numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT h.provider_nit,
         btrim(h.account_code) AS account_code,
         count(*)::bigint AS uses,
         COALESCE(sum(h.credit), 0)::numeric AS credit_total
  FROM public.accounting_history h
  WHERE h.company_id = _company_id
    AND public.is_company_member(_company_id)
    AND h.provider_nit = ANY(_nits)
    AND COALESCE(btrim(h.account_code), '') <> ''
    AND (btrim(h.account_code) LIKE '22%' OR btrim(h.account_code) LIKE '23%')
    AND btrim(h.account_code) NOT LIKE '2365%'
    AND btrim(h.account_code) NOT LIKE '2367%'
    AND btrim(h.account_code) NOT LIKE '2368%'
    AND COALESCE(h.credit, 0) > 0
  GROUP BY 1, 2
  ORDER BY 3 DESC
  LIMIT LEAST(COALESCE(_limit, 50), 500);
$$;

CREATE OR REPLACE FUNCTION public.history_top_payable_accounts(_company_id uuid, _limit integer DEFAULT 20)
RETURNS TABLE(account_code text, uses bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT btrim(h.account_code) AS account_code, count(*)::bigint AS uses
  FROM public.accounting_history h
  WHERE h.company_id = _company_id
    AND public.is_company_member(_company_id)
    AND COALESCE(btrim(h.account_code), '') <> ''
    AND (btrim(h.account_code) LIKE '22%' OR btrim(h.account_code) LIKE '23%')
    AND btrim(h.account_code) NOT LIKE '2365%'
    AND btrim(h.account_code) NOT LIKE '2367%'
    AND btrim(h.account_code) NOT LIKE '2368%'
    AND COALESCE(h.credit, 0) > 0
  GROUP BY 1
  ORDER BY 2 DESC
  LIMIT LEAST(COALESCE(_limit, 20), 100);
$$;