CREATE POLICY "facturas read company" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'facturas'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
  AND public.is_company_member(((storage.foldername(name))[2])::uuid)
);