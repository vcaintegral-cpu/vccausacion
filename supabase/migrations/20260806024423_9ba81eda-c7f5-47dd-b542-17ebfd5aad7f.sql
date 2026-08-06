CREATE TABLE IF NOT EXISTS public.ai_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade unique,
  provider text not null default 'lovable',
  model text not null default 'openai/gpt-5.6-sol',
  api_key text,
  extraction_prompt text not null default '',
  mapping_prompt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_settings TO authenticated;
GRANT ALL ON public.ai_settings TO service_role;
ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members manage ai settings" ON public.ai_settings;
CREATE POLICY "members manage ai settings" ON public.ai_settings FOR ALL TO authenticated
  USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));