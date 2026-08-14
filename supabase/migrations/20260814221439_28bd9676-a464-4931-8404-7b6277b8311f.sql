-- 1) Evitar auto-vinculación a cualquier empresa
CREATE OR REPLACE FUNCTION public.is_company_admin(_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = _company_id
      AND m.user_id = auth.uid()
      AND m.role IN ('propietario', 'admin', 'administrador')
  );
$$;

DROP POLICY IF EXISTS "members insert" ON public.company_members;
CREATE POLICY "members insert" ON public.company_members
  FOR INSERT TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "members delete" ON public.company_members;
CREATE POLICY "members delete" ON public.company_members
  FOR DELETE TO authenticated
  USING (public.is_company_admin(company_id) OR user_id = auth.uid());

-- 2) Ejecución de funciones: denegar todo y permitir solo lo que la app usa
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.is_company_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.history_provider_accounts(uuid, text[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.history_top_accounts(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.history_iva_treatment(uuid, text[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.history_provider_payable_accounts(uuid, text[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.history_top_payable_accounts(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.provider_payable_candidates(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_invoice_to_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revert_invoice_posting(uuid) TO authenticated;