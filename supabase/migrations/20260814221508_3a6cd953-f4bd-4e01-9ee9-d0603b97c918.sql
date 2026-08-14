ALTER FUNCTION public.history_provider_accounts(uuid, text[], integer) SECURITY INVOKER;
ALTER FUNCTION public.history_top_accounts(uuid, integer) SECURITY INVOKER;
ALTER FUNCTION public.history_iva_treatment(uuid, text[], integer) SECURITY INVOKER;
ALTER FUNCTION public.history_provider_payable_accounts(uuid, text[], integer) SECURITY INVOKER;
ALTER FUNCTION public.history_top_payable_accounts(uuid, integer) SECURITY INVOKER;
ALTER FUNCTION public.provider_payable_candidates(uuid, text[]) SECURITY INVOKER;