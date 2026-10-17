ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS siigo_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS siigo_error_kind text,
  ADD COLUMN IF NOT EXISTS siigo_reconciled_note text,
  ADD COLUMN IF NOT EXISTS siigo_reconciled_by uuid,
  ADD COLUMN IF NOT EXISTS siigo_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS siigo_voided jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.invoices
   SET siigo_error_kind = CASE WHEN siigo_id IS NOT NULL OR siigo_number IS NOT NULL THEN 'creado_diferencia' ELSE 'sin_crear' END
 WHERE siigo_status = 'error' AND siigo_error_kind IS NULL;

CREATE OR REPLACE FUNCTION public.block_delete_siigo_invoice()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.siigo_id IS NOT NULL OR OLD.siigo_number IS NOT NULL THEN
    RAISE EXCEPTION 'Este documento existe en Siigo como %. Anúlelo en Siigo y márquelo como anulado antes de eliminarlo.', COALESCE(OLD.siigo_number, OLD.siigo_id);
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS invoices_block_delete_siigo ON public.invoices;
CREATE TRIGGER invoices_block_delete_siigo BEFORE DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.block_delete_siigo_invoice();