
CREATE INDEX IF NOT EXISTS accounting_history_company_imported_idx
  ON public.accounting_history (company_id, imported_at DESC);
CREATE INDEX IF NOT EXISTS accounting_history_provider_account_idx
  ON public.accounting_history (company_id, provider_nit, account_code)
  WHERE account_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_events_company_provider_idx
  ON public.learning_events (company_id, provider_nit);
CREATE INDEX IF NOT EXISTS learning_rules_company_active_idx
  ON public.learning_rules (company_id, active);

CREATE OR REPLACE FUNCTION public.history_provider_accounts(_company_id uuid, _nits text[], _limit int DEFAULT 500)
RETURNS TABLE(provider_nit text, concept text, account_code text, uses bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT h.provider_nit,
         COALESCE(NULLIF(btrim(h.detail), ''), h.description) AS concept,
         btrim(h.account_code) AS account_code,
         count(*)::bigint AS uses
  FROM public.accounting_history h
  WHERE h.company_id = _company_id
    AND public.is_company_member(_company_id)
    AND h.provider_nit = ANY(_nits)
    AND COALESCE(btrim(h.account_code), '') <> ''
  GROUP BY 1, 2, 3
  ORDER BY 4 DESC
  LIMIT LEAST(COALESCE(_limit, 500), 2000);
$$;

CREATE OR REPLACE FUNCTION public.history_top_accounts(_company_id uuid, _limit int DEFAULT 300)
RETURNS TABLE(provider_nit text, concept text, account_code text, uses bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH recientes AS (
    SELECT h.provider_nit, h.description, h.detail, h.account_code
    FROM public.accounting_history h
    WHERE h.company_id = _company_id
      AND public.is_company_member(_company_id)
      AND COALESCE(btrim(h.account_code), '') <> ''
    ORDER BY h.imported_at DESC
    LIMIT 20000
  )
  SELECT NULL::text AS provider_nit,
         COALESCE(NULLIF(btrim(r.detail), ''), r.description) AS concept,
         btrim(r.account_code) AS account_code,
         count(*)::bigint AS uses
  FROM recientes r
  GROUP BY 2, 3
  ORDER BY 4 DESC
  LIMIT LEAST(COALESCE(_limit, 300), 1000);
$$;

GRANT EXECUTE ON FUNCTION public.history_provider_accounts(uuid, text[], int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.history_top_accounts(uuid, int) TO authenticated;
