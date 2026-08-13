ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS iva_treatment_mode text NOT NULL DEFAULT 'mixto',
  ADD COLUMN IF NOT EXISTS iva_account_descontable text,
  ADD COLUMN IF NOT EXISTS iva_account_gasto text,
  ADD COLUMN IF NOT EXISTS iva_account_costo text;

CREATE TABLE IF NOT EXISTS public.iva_treatment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider_nit text,
  concept text,
  expense_account text,
  treatment text NOT NULL,
  iva_account text,
  times_used integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.iva_treatment_rules TO authenticated;
GRANT ALL ON public.iva_treatment_rules TO service_role;

ALTER TABLE public.iva_treatment_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Miembros gestionan las reglas de IVA de su empresa"
ON public.iva_treatment_rules FOR ALL TO authenticated
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));

CREATE INDEX IF NOT EXISTS iva_treatment_rules_lookup
  ON public.iva_treatment_rules (company_id, provider_nit, expense_account);

CREATE TRIGGER iva_treatment_rules_updated_at
BEFORE UPDATE ON public.iva_treatment_rules
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.history_iva_treatment(_company_id uuid, _nits text[] DEFAULT NULL, _limit integer DEFAULT 300)
RETURNS TABLE(provider_nit text, expense_account text, iva_account text, uses bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH mov AS (
    SELECT h.provider_nit,
           coalesce(h.provider_nit,'') || '|' || coalesce(h.voucher,'') || '|' || coalesce(h.sequence,'') || '|' || coalesce(h.entry_date_text,'') AS g,
           btrim(h.account_code) AS code,
           coalesce(h.account_name,'') AS nm,
           coalesce(h.debit,0) AS debit
    FROM public.accounting_history h
    WHERE h.company_id = _company_id
      AND public.is_company_member(_company_id)
      AND coalesce(btrim(h.account_code),'') <> ''
      AND (_nits IS NULL OR h.provider_nit = ANY(_nits))
  ),
  gastos AS (
    SELECT g, provider_nit, code FROM mov
    WHERE debit > 0 AND left(code,1) IN ('5','6','7') AND nm NOT ILIKE '%iva%'
  ),
  ivas AS (
    SELECT g, code FROM mov
    WHERE debit > 0
      AND (code LIKE '2408%' OR nm ILIKE '%iva%')
      AND left(code,4) NOT IN ('2365','2367','2368')
  )
  SELECT gastos.provider_nit, gastos.code, ivas.code, count(*)::bigint
  FROM gastos JOIN ivas ON ivas.g = gastos.g
  GROUP BY 1,2,3
  ORDER BY 4 DESC
  LIMIT LEAST(COALESCE(_limit,300), 2000);
$$;