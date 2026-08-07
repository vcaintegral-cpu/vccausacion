ALTER TABLE public.products ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.product_categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS products_category_id_idx ON public.products(category_id);
UPDATE public.products p
SET category_id = c.id
FROM public.product_categories c
WHERE p.category_id IS NULL
  AND p.company_id = c.company_id
  AND p.category IS NOT NULL
  AND lower(btrim(p.category)) = lower(btrim(c.name))
  AND lower(btrim(p.kind)) = lower(btrim(c.kind));
UPDATE public.products p
SET category_id = c.id
FROM public.product_categories c
WHERE p.category_id IS NULL
  AND p.company_id = c.company_id
  AND p.category IS NOT NULL
  AND lower(btrim(p.category)) = lower(btrim(c.name));