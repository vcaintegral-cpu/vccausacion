CREATE TABLE IF NOT EXISTS public.siigo_credentials (
  id text PRIMARY KEY DEFAULT 'default',
  username text NOT NULL,
  access_key text NOT NULL,
  partner_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.siigo_credentials TO service_role;
ALTER TABLE public.siigo_credentials ENABLE ROW LEVEL SECURITY;