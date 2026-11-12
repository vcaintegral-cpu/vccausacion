DROP POLICY IF EXISTS "read retention bases" ON public.retention_base_tables;
CREATE POLICY "read retention bases" ON public.retention_base_tables
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.company_members m WHERE m.user_id = auth.uid()));