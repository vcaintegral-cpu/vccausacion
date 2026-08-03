-- Owner can always read their own company (needed for returning representation on insert)
CREATE POLICY "company owner read" ON public.companies
FOR SELECT TO authenticated
USING (created_by = auth.uid());

-- Auto-register the creator as member
CREATE OR REPLACE FUNCTION public.add_company_owner_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'propietario')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;

REVOKE EXECUTE ON FUNCTION public.add_company_owner_member() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS on_company_created ON public.companies;
CREATE TRIGGER on_company_created
AFTER INSERT ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.add_company_owner_member();

ALTER TABLE public.company_members ADD CONSTRAINT company_members_unique UNIQUE (company_id, user_id);