CREATE POLICY "facturas read own" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'facturas' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "facturas insert own" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'facturas' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "facturas delete own" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'facturas' AND (storage.foldername(name))[1] = auth.uid()::text);