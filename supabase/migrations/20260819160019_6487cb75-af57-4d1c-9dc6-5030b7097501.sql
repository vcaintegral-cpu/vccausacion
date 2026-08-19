REVOKE EXECUTE ON FUNCTION public.sync_provider_drafts(uuid, jsonb, text, jsonb) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.undo_provider_draft_sync(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.apply_draft_sync_changes(uuid, jsonb, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.sync_provider_drafts(uuid, jsonb, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undo_provider_draft_sync(uuid) TO authenticated;