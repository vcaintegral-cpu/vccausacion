ALTER TABLE public.learning_rules
  ADD COLUMN IF NOT EXISTS iva_aplica boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS iva_rate numeric,
  ADD COLUMN IF NOT EXISTS iva_treatment text,
  ADD COLUMN IF NOT EXISTS iva_account text,
  ADD COLUMN IF NOT EXISTS retefuente_aplica boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retefuente_rate numeric,
  ADD COLUMN IF NOT EXISTS retefuente_account text,
  ADD COLUMN IF NOT EXISTS reteiva_aplica boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reteiva_rate numeric,
  ADD COLUMN IF NOT EXISTS reteiva_account text,
  ADD COLUMN IF NOT EXISTS reteica_aplica boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reteica_rate numeric,
  ADD COLUMN IF NOT EXISTS reteica_account text,
  ADD COLUMN IF NOT EXISTS otras_aplica boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS otras_rate numeric,
  ADD COLUMN IF NOT EXISTS otras_account text,
  ADD COLUMN IF NOT EXISTS payable_account text,
  ADD COLUMN IF NOT EXISTS payment_form text,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by uuid;

UPDATE public.learning_rules
   SET iva_aplica = true, iva_rate = iva
 WHERE COALESCE(iva, 0) > 0 AND iva_aplica = false;

DROP TRIGGER IF EXISTS learning_rules_updated_at ON public.learning_rules;
CREATE TRIGGER learning_rules_updated_at
BEFORE UPDATE ON public.learning_rules
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS learning_rules_lookup_idx
  ON public.learning_rules (company_id, provider_nit, item_type);

CREATE TABLE IF NOT EXISTS public.learning_rule_changes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES public.learning_rules(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  field text NOT NULL,
  field_label text,
  old_value text,
  new_value text,
  changed_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.learning_rule_changes TO authenticated;
GRANT ALL ON public.learning_rule_changes TO service_role;

ALTER TABLE public.learning_rule_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Miembros ven cambios de reglas de su empresa"
  ON public.learning_rule_changes FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

CREATE POLICY "Miembros registran cambios de reglas de su empresa"
  ON public.learning_rule_changes FOR INSERT TO authenticated
  WITH CHECK (public.is_company_member(company_id));

CREATE INDEX IF NOT EXISTS learning_rule_changes_rule_idx
  ON public.learning_rule_changes (rule_id, created_at DESC);