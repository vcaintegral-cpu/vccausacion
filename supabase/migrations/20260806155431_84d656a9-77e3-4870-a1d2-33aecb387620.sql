
ALTER TABLE public.company_members DROP CONSTRAINT company_members_company_id_fkey, ADD CONSTRAINT company_members_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.accounting_rules DROP CONSTRAINT accounting_rules_company_id_fkey, ADD CONSTRAINT accounting_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.ai_settings DROP CONSTRAINT ai_settings_company_id_fkey, ADD CONSTRAINT ai_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.cost_centers DROP CONSTRAINT cost_centers_company_id_fkey, ADD CONSTRAINT cost_centers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_lines DROP CONSTRAINT invoice_lines_company_id_fkey, ADD CONSTRAINT invoice_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_lines DROP CONSTRAINT invoice_lines_invoice_id_fkey, ADD CONSTRAINT invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;
ALTER TABLE public.invoices DROP CONSTRAINT invoices_company_id_fkey, ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.journal_lines DROP CONSTRAINT journal_lines_company_id_fkey, ADD CONSTRAINT journal_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.journal_lines DROP CONSTRAINT journal_lines_invoice_id_fkey, ADD CONSTRAINT journal_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;
ALTER TABLE public.learning_events DROP CONSTRAINT learning_events_company_id_fkey, ADD CONSTRAINT learning_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.learning_rules DROP CONSTRAINT learning_rules_company_id_fkey, ADD CONSTRAINT learning_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.product_categories DROP CONSTRAINT product_categories_company_id_fkey, ADD CONSTRAINT product_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.products DROP CONSTRAINT products_company_id_fkey, ADD CONSTRAINT products_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.providers DROP CONSTRAINT providers_company_id_fkey, ADD CONSTRAINT providers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.puc_accounts DROP CONSTRAINT puc_accounts_company_id_fkey, ADD CONSTRAINT puc_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.tax_rates DROP CONSTRAINT tax_rates_company_id_fkey, ADD CONSTRAINT tax_rates_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
