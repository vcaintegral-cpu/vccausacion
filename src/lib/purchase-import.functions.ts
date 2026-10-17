import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { calculatePurchase, emptyPurchaseSettings, type PurchaseDocument, type PurchaseSettings, type ProviderTaxProfile } from './purchase-excel';
import type { Json } from '@/integrations/supabase/types';

export const confirmPurchaseImport = createServerFn({ method: 'POST' })
 .middleware([requireSupabaseAuth])
 .inputValidator(z.object({ itemId: z.string().uuid(), choices: z.object({accounts:z.array(z.string()),lineCostCenters:z.array(z.string()).optional(),costCenter:z.string(),payableAccount:z.string(),affectedInvoiceId:z.string(),retentionSource:z.object({retefuente:z.enum(['xml','calculated']).optional(),reteiva:z.enum(['xml','calculated']).optional(),reteica:z.enum(['xml','calculated']).optional()}),aiuBase:z.number().nonnegative().optional(),aiuReviewed:z.boolean().optional()}) }))
 .handler(async ({ data, context }) => {
  const db=context.supabase;
  const {data:item,error}=await db.from('purchase_import_items').select('*').eq('id',data.itemId).single();
  if(error||!item)throw new Error('Documento no encontrado.');
  if(item.invoice_id)return {invoiceId:item.invoice_id};
  const [config,puc,company,provider,centers]=await Promise.all([
   db.from('purchase_import_settings').select('config').eq('company_id',item.company_id).maybeSingle(),
   db.from('puc_accounts').select('*').eq('company_id',item.company_id).order('code').range(0,999),
   db.from('companies').select('uses_cost_centers').eq('id',item.company_id).single(),
   db.from('providers').select('purchase_tax_profile').eq('company_id',item.company_id).eq('nit',(item.document as unknown as PurchaseDocument).header.provider_nit).maybeSingle(),
   db.from('cost_centers').select('code').eq('company_id',item.company_id),
  ]);
  for(const result of [config,puc,company,provider,centers])if(result.error)throw new Error(result.error.message);
  const doc=item.document as unknown as PurchaseDocument;
  const settings={...emptyPurchaseSettings(),...(config.data?.config as unknown as Partial<PurchaseSettings>??{})};
  // Page through the full company PUC; the API's default limit is not the catalogue size.
  const accounts=[...(puc.data??[])];for(let from=1000;accounts.length>=from;from+=1000){const page=await db.from('puc_accounts').select('*').eq('company_id',item.company_id).order('code').range(from,from+999);if(page.error)throw new Error(page.error.message);accounts.push(...(page.data??[]));if((page.data??[]).length<1000)break;}
  const calculation=calculatePurchase(doc,settings,(provider.data?.purchase_tax_profile??{}) as ProviderTaxProfile,data.choices,accounts,company.data?.uses_cost_centers===true);
  if(company.data?.uses_cost_centers===true&&calculation.journal.some(l=>l.cost_center&&!centers.data?.some(c=>c.code===l.cost_center)))throw new Error('Seleccione un centro de costo válido de la empresa.');
  if(calculation.errors.length)throw new Error(calculation.errors.join('\n'));
  const {supabaseAdmin}=await import('@/integrations/supabase/client.server');
  // Privileged write only after user-scoped reads and recomputation; SQL rechecks membership and locks the item.
  const saved=await supabaseAdmin.rpc('confirm_excel_purchase_validated',{_item_id:item.id,_actor:context.userId,_choices:data.choices as unknown as Json,_journal:calculation.journal as unknown as Json,_retentions:calculation.retentions as unknown as Json});
  if(saved.error)throw new Error(saved.error.message);
  return {invoiceId:saved.data};
 });
