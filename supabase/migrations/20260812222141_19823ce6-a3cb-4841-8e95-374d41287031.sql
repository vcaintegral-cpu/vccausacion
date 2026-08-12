
REVOKE ALL ON FUNCTION public.history_provider_accounts(uuid, text[], int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.history_top_accounts(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.history_provider_accounts(uuid, text[], int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.history_top_accounts(uuid, int) TO authenticated;
