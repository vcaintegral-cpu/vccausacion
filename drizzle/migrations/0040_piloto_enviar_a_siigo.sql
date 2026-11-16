ALTER TABLE public.piloto_config ADD COLUMN IF NOT EXISTS enviar_a_siigo boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';