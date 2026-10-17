import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Save, Trash2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AccountCombobox } from '@/components/account-combobox';
import { fetchCompanyPuc } from '@/lib/puc-data';
import { emptyPurchaseSettings, type PurchaseSettings } from '@/lib/purchase-excel';

export function usePurchaseSettings(companyId:string) {
 return useQuery({queryKey:['purchase-settings',companyId],queryFn:async()=>{const {data,error}=await supabase.from('purchase_import_settings').select('config').eq('company_id',companyId).maybeSingle();if(error)throw error;return {...emptyPurchaseSettings(),...(data?.config as unknown as Partial<PurchaseSettings>??{})};}});
}
const ACCOUNT_FIELDS = [['ivaAccount','IVA descontable'],['payableAccount','Proveedores'],['expensesPayableAccount','Costos y gastos por pagar'],['cashAccount','Caja / banco por defecto'],['advanceAccount','Anticipos / caja'],['reteivaAccount','ReteIVA por pagar'],['roundingIncomeAccount','Ajuste al peso — ingreso'],['roundingExpenseAccount','Ajuste al peso — gasto']] as const;
export function PurchaseSettingsPanel({companyId}:{companyId:string}) {
 const query=usePurchaseSettings(companyId);const qc=useQueryClient();const [form,setForm]=useState<PurchaseSettings>(emptyPurchaseSettings);const [saving,setSaving]=useState(false);
 const puc=useQuery({queryKey:['purchase-puc',companyId],queryFn:()=>fetchCompanyPuc(companyId)});
 useEffect(()=>{if(query.data)setForm(query.data);},[query.data]);
 const set=<K extends keyof PurchaseSettings>(k:K,v:PurchaseSettings[K])=>setForm(p=>({...p,[k]:v}));
 async function save(){setSaving(true);try{const {error}=await supabase.from('purchase_import_settings').upsert({company_id:companyId,config:form as unknown as Json,updated_at:new Date().toISOString()});if(error)throw error;await qc.invalidateQueries({queryKey:['purchase-settings',companyId]});toast.success('Parámetros de compras guardados.');}catch(e){toast.error(e instanceof Error?e.message:'No se guardaron los parámetros.');}finally{setSaving(false);}}
 return <div className="space-y-6">
  <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Compras desde RECIBIDOS</h2><Button onClick={()=>void save()} disabled={saving}><Save className="size-4"/>Guardar parámetros</Button></div>
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
   {([['purchaseVoucher','Comprobante de compras'],['creditVoucher','Comprobante de nota crédito'],['equivalentVoucher','Comprobante equivalente']] as const).map(([key,label])=><div className="space-y-2" key={key}><Label htmlFor={key}>{label}</Label><Input id={key} value={form[key]} onChange={e=>set(key,e.target.value)}/></div>)}
   <div className="space-y-2"><Label htmlFor="purchase-year">Año UVT</Label><Input id="purchase-year" type="number" value={form.year} onChange={e=>set('year',Number(e.target.value))}/></div>
   <div className="space-y-2"><Label htmlFor="purchase-uvt">Valor UVT (COP)</Label><Input id="purchase-uvt" type="number" step="any" min="0" value={form.uvt} onChange={e=>set('uvt',Number(e.target.value))}/></div>
   <div className="space-y-2"><Label>Tratamiento del IVA</Label><Select value={form.ivaTreatment} onValueChange={v=>set('ivaTreatment',v==='gasto'?'gasto':'descontable')}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="descontable">IVA descontable</SelectItem><SelectItem value="gasto">Mayor valor del gasto</SelectItem></SelectContent></Select></div>
   {ACCOUNT_FIELDS.map(([key,label])=><div className="space-y-2" key={key}><Label>{label}</Label><AccountCombobox accounts={puc.data??[]} value={form[key]} onChange={code=>set(key,code)}/></div>)}
   <div className="space-y-2"><Label htmlFor="purchase-reteiva">ReteIVA (%)</Label><Input id="purchase-reteiva" type="number" step="any" min="0" value={form.reteivaRate} onChange={e=>set('reteivaRate',Number(e.target.value))}/></div>
  </div>
  <section className="space-y-3 border-t border-border pt-5"><div className="flex items-center justify-between"><h3 className="font-semibold">Retención en la fuente</h3><Button size="sm" variant="outline" onClick={()=>set('retentionRules',[...form.retentionRules,{concept:'',minUVT:0,declarantRate:0,nonDeclarantRate:0,account:''}])}><Plus className="size-4"/>Concepto</Button></div>
   <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Concepto','Base mínima UVT','Declarante %','No declarante %','Cuenta',''].map((h,i)=><th className="p-2 text-left" key={i}>{h}</th>)}</tr></thead><tbody>{form.retentionRules.map((r,i)=><tr key={i}>{(['concept','minUVT','declarantRate','nonDeclarantRate'] as const).map(k=><td className="min-w-32 p-2" key={k}><Input aria-label={`${k} ${i+1}`} type={k==='concept'?'text':'number'} step="any" min="0" value={r[k]} onChange={e=>set('retentionRules',form.retentionRules.map((x,j)=>i===j?{...x,[k]:k==='concept'?e.target.value:Number(e.target.value)}:x))}/></td>)}<td className="min-w-60 p-2"><AccountCombobox accounts={puc.data??[]} value={r.account} onChange={account=>set('retentionRules',form.retentionRules.map((x,j)=>i===j?{...x,account}:x))}/></td><td><Button variant="ghost" size="icon" aria-label="Eliminar concepto" onClick={()=>set('retentionRules',form.retentionRules.filter((_,j)=>i!==j))}><Trash2 className="size-4"/></Button></td></tr>)}</tbody></table></div>
  </section>
  <section className="space-y-3 border-t border-border pt-5"><div className="flex items-center justify-between"><h3 className="font-semibold">ReteICA por municipio y actividad</h3><Button size="sm" variant="outline" onClick={()=>set('icaRules',[...form.icaRules,{municipality:'',activity:'',perThousand:0,account:''}])}><Plus className="size-4"/>Tarifa</Button></div>
   {form.icaRules.map((r,i)=><div className="grid gap-3 sm:grid-cols-5" key={i}><Input aria-label={`Municipio ${i+1}`} placeholder="Municipio" value={r.municipality} onChange={e=>set('icaRules',form.icaRules.map((x,j)=>i===j?{...x,municipality:e.target.value}:x))}/><Input aria-label={`Actividad ${i+1}`} placeholder="Actividad" value={r.activity} onChange={e=>set('icaRules',form.icaRules.map((x,j)=>i===j?{...x,activity:e.target.value}:x))}/><Input aria-label={`Tarifa por mil ${i+1}`} type="number" step="any" min="0" value={r.perThousand} onChange={e=>set('icaRules',form.icaRules.map((x,j)=>i===j?{...x,perThousand:Number(e.target.value)}:x))}/><AccountCombobox accounts={puc.data??[]} value={r.account} onChange={account=>set('icaRules',form.icaRules.map((x,j)=>i===j?{...x,account}:x))}/><Button size="icon" variant="ghost" aria-label="Eliminar tarifa ICA" onClick={()=>set('icaRules',form.icaRules.filter((_,j)=>i!==j))}><Trash2 className="size-4"/></Button></div>)}
  </section>
  <section className="space-y-3 border-t border-border pt-5"><div className="flex items-center justify-between"><h3 className="font-semibold">Cuentas por medio de pago</h3><Button size="sm" variant="outline" onClick={()=>set('paymentAccounts',[...form.paymentAccounts,{method:'',account:''}])}><Plus className="size-4"/>Medio</Button></div>{form.paymentAccounts.map((r,i)=><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" key={i}><Input aria-label={`Medio de pago ${i+1}`} value={r.method} onChange={e=>set('paymentAccounts',form.paymentAccounts.map((x,j)=>i===j?{...x,method:e.target.value}:x))}/><AccountCombobox accounts={puc.data??[]} value={r.account} onChange={account=>set('paymentAccounts',form.paymentAccounts.map((x,j)=>i===j?{...x,account}:x))}/><Button size="icon" variant="ghost" aria-label="Eliminar medio" onClick={()=>set('paymentAccounts',form.paymentAccounts.filter((_,j)=>i!==j))}><Trash2 className="size-4"/></Button></div>)}</section>
 </div>;
}
