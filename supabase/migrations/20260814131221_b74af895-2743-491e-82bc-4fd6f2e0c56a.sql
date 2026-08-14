ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payable_account text,
  ADD COLUMN IF NOT EXISTS payable_source text,
  ADD COLUMN IF NOT EXISTS payable_suggested text,
  ADD COLUMN IF NOT EXISTS payable_manual boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payable_updated_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS payable_updated_by uuid,
  ADD COLUMN IF NOT EXISTS payable_confidence numeric;

CREATE OR REPLACE FUNCTION public.provider_payable_candidates(_company_id uuid, _nits text[])
RETURNS TABLE(provider_nit text, account_code text, uses bigint, last_used timestamp with time zone, source text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH hist AS (
    SELECT h.provider_nit,
           btrim(h.account_code) AS account_code,
           count(*)::bigint AS uses,
           max(h.imported_at) AS last_used,
           'historial'::text AS source
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
  ),
  fact AS (
    SELECT i.provider_nit,
           btrim(j.account_code) AS account_code,
           count(*)::bigint AS uses,
           max(COALESCE(i.posted_at, i.approved_at, i.updated_at)) AS last_used,
           'facturas'::text AS source
    FROM public.journal_lines j
    JOIN public.invoices i ON i.id = j.invoice_id
    WHERE j.company_id = _company_id
      AND public.is_company_member(_company_id)
      AND i.provider_nit = ANY(_nits)
      AND (i.status IN ('aprobado', 'causada', 'sincronizada') OR i.siigo_status = 'sincronizada')
      AND COALESCE(j.credit, 0) > 0
      AND COALESCE(btrim(j.account_code), '') <> ''
      AND (btrim(j.account_code) LIKE '22%' OR btrim(j.account_code) LIKE '23%')
      AND btrim(j.account_code) NOT LIKE '2365%'
      AND btrim(j.account_code) NOT LIKE '2367%'
      AND btrim(j.account_code) NOT LIKE '2368%'
    GROUP BY 1, 2
  )
  SELECT * FROM hist
  UNION ALL
  SELECT * FROM fact;
$function$;