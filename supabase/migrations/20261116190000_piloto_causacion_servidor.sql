-- Piloto automático: la causación del Excel RECIBIDOS corre en el servidor con el rol de servicio,
-- sin sesión de usuaria. Las funciones de resumen del histórico (SECURITY INVOKER, filtradas por
-- _company_id) solo estaban autorizadas para «authenticated»; se autorizan también para «service_role».
-- No cambia lo que ve ninguna usuaria: el navegador sigue usando su propia sesión.
GRANT EXECUTE ON FUNCTION public.history_provider_accounts(uuid, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.history_top_accounts(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.history_iva_treatment(uuid, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.history_provider_payable_accounts(uuid, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.history_top_payable_accounts(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.provider_payable_candidates(uuid, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
