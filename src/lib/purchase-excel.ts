import * as XLSX from 'xlsx';
import type { JournalLine } from './accounting';
import { resolveOperationalAccount, type PucAccount } from './puc-hierarchy';

export type RetKind = 'retefuente' | 'reteiva' | 'reteica';
export type RetRule = { concept: string; minUVT: number; declarantRate: number; nonDeclarantRate: number; account: string };
export type IcaRule = { municipality: string; activity: string; perThousand: number; account: string };
export type PurchaseSettings = {
  year: number; uvt: number; purchaseVoucher: string; creditVoucher: string; equivalentVoucher: string;
  ivaTreatment: 'descontable' | 'gasto'; ivaAccount: string; payableAccount: string; expensesPayableAccount: string;
  cashAccount: string; advanceAccount: string; roundingIncomeAccount: string; roundingExpenseAccount: string;
  reteivaRate: number; reteivaAccount: string; retentionRules: RetRule[]; icaRules: IcaRule[];
  paymentAccounts: { method: string; account: string }[];
};
export const emptyPurchaseSettings = (): PurchaseSettings => ({ year: new Date().getFullYear(), uvt: 0, purchaseVoucher: '', creditVoucher: '', equivalentVoucher: '', ivaTreatment: 'descontable', ivaAccount: '', payableAccount: '', expensesPayableAccount: '', cashAccount: '', advanceAccount: '', roundingIncomeAccount: '', roundingExpenseAccount: '', reteivaRate: 0, reteivaAccount: '', retentionRules: [], icaRules: [], paymentAccounts: [] });
export type ProviderTaxProfile = { selfWithholder?: boolean; largeTaxpayer?: boolean; nonSubject?: boolean; declarant?: boolean | null; regime?: string; concept?: string; municipality?: string; activity?: string; dv?: string };
export type PurchaseHeader = {
 prefix: string; number: string; issue_date: string; due_date: string; provider_nit: string; provider_name: string;
 provider_address: string; provider_city: string; provider_phone: string; provider_email: string; buyer_nit: string; buyer_name: string;
 cufe: string; payment_form: string; payment_method: string; currency: string; notes: string; subtotal: number; discount: number;
 iva: number; impoconsumo: number; total: number; advances: number; surcharge: number; retefuente: number; reteiva: number; reteica: number;
};
export type PurchaseLine = { description: string; code: string; quantity: number; unit_value: number; subtotal: number; discount: number; surcharge: number; iva: number; ivaBase: number; ivaRate: number; impoconsumo: number; total: number };
export type PurchaseDocument = { rowNumber: number; kind: 'purchase' | 'equivalent' | 'credit_note'; type: string; header: PurchaseHeader; lines: PurchaseLine[]; naturalPerson: boolean; period: string; rawHeader: Record<string, string | number>; rawLines: Record<string, string | number>[] };
export type PurchaseChoices = { accounts: string[]; lineCostCenters?: string[] | undefined; costCenter: string; payableAccount: string; affectedInvoiceId: string; retentionSource: Partial<Record<RetKind, 'xml' | 'calculated' | undefined>>; aiuBase?: number | undefined; aiuReviewed?: boolean | undefined };
export const normalizeText = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export const normalizeNit = (s: unknown) => String(s ?? '').split('-')[0]?.replace(/\D/g, '') ?? '';
export function nitDV(nit: string) {
 const weights = [71,67,59,53,47,43,41,37,29,23,19,17,13,7,3];
 const digits = normalizeNit(nit).padStart(15,'0');
 const rem = [...digits].reduce((s,d,i)=>s+Number(d)*(weights[i] ?? 0),0)%11;
 return String(rem < 2 ? rem : 11-rem);
}
const cents = (n: number) => Math.round((n + Number.EPSILON)*100)/100;
const abs = (v: unknown) => { if (typeof v === 'number') return Math.abs(v); const s=String(v ?? '').trim(); if (!s) return 0; const cleaned=s.includes(',')?s.replace(/\./g,'').replace(',','.'):s; const n=Number(cleaned.replace(/[^\d.\-]/g,'')); if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido: ${s}`); return Math.abs(n); };
const date = (v: unknown) => { if (typeof v==='number') {const d=XLSX.SSF.parse_date_code(v);return d?`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`:'';} const s=String(v??'').trim(); if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10); const m=s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/);return m?`${m[3]}-${m[2]}-${m[1]}`:''; };
type Row = Record<string,string|number>;
function sheetRows(wb: XLSX.WorkBook, name: string) {
 const sheet=wb.Sheets[name]; if(!sheet)throw new Error(`Falta la hoja ${name}.`);
 const matrix=XLSX.utils.sheet_to_json<(string|number)[]>(sheet,{header:1,raw:true,defval:'',blankrows:true});
 const headers=(matrix[2]??[]).map(v=>String(v).trim());
 for(const field of ['TIPO DOC EMITIDO','NUMERO FACTURA COMPLETO','CUFE'])if(!headers.includes(field))throw new Error(`${name}: falta ${field} en la fila 3.`);
 return matrix.slice(3).map((values,i)=>({rowNumber:i+4,row:Object.fromEntries(headers.map((h,j)=>[h,values[j]??''])) as Row})).filter(x=>String(x.row['TIPO DOC EMITIDO']??'').trim());
}
export function parsePurchaseWorkbook(buffer: ArrayBuffer, companyNit: string): PurchaseDocument[] {
 const wb=XLSX.read(buffer,{type:'array',cellDates:false});
 const docs=sheetRows(wb,'DOCUMENTOS');const details=sheetRows(wb,'DETALLE DE FACTURA');
 const sheet=wb.Sheets['DOCUMENTOS'];const periodText=sheet?String(sheet['B2']?.v??''):'';
 const match=periodText.match(/(\d{2})-(\d{2})-(\d{4})/);const period=match?`${match[3]}-${match[2]}`:'';
 const join=(r:Row)=>`${String(r['NUMERO FACTURA COMPLETO']).trim()}|${String(r['CUFE']).trim().toLowerCase()}`;
 const index=new Map<string,Row[]>();for(const {row} of details){const k=join(row);index.set(k,[...(index.get(k)??[]),row]);}
 const seen=new Set<string>();
 return docs.map(({row:r,rowNumber})=>{
  const t=(key:string)=>String(r[key]??'').trim();const n=(key:string)=>abs(r[key]);const type=t('TIPO DOC EMITIDO');
  const kind=normalizeText(type)==='60'?'equivalent':normalizeText(type)==='nota de credito electronica'?'credit_note':normalizeText(type)==='factura electronica'?'purchase':null;
  if(!kind)throw new Error(`Fila ${rowNumber}: tipo de documento no soportado (${type}).`);
  if(normalizeNit(t('NIT COMPRADOR'))!==normalizeNit(companyNit))throw new Error(`Fila ${rowNumber}: comprador diferente a la empresa activa. Use el reporte RECIBIDOS, no ENVIADOS.`);
  if(seen.has(join(r)))throw new Error(`Fila ${rowNumber}: documento duplicado dentro del Excel.`);seen.add(join(r));
  const rawLines=index.get(join(r))??[];
  const lines=rawLines.map(l=>{const quantity=abs(l['CANTIDAD'])||1;const subtotal=abs(l['SUBTOTAL DE LA FACTURA']);const discount=abs(l['DESCUENTO']);const iva=abs(l['IVA']);const impoconsumo=abs(l['INC']);const surcharge=abs(l['RECARGO']);return {description:String(l['DESCRIPCION']??''),code:String(l['CODIGO']??''),quantity,unit_value:subtotal/quantity,subtotal,discount,surcharge,iva,ivaBase:abs(l['BASE IVA']),ivaRate:abs(l['% IVA']),impoconsumo,total:cents(subtotal-discount+surcharge+iva+impoconsumo)};});
  return {rowNumber,kind,type,period,naturalPerson:normalizeText(t('TIPO CONTRIBUYENTE EMISOR')).includes('natural'),rawHeader:r,rawLines,lines,header:{prefix:t('PREFIJO'),number:t('NUMERO DE FACTURA'),issue_date:date(r['FECHA DE FACTURA']),due_date:date(r['FECHA DE VENCIMIENTO']),provider_nit:normalizeNit(t('NIT EMISOR')),provider_name:t('RAZON SOCIAL EMISOR'),provider_address:t('DIRECCION EMISOR'),provider_city:t('CIUDAD EMISOR'),provider_phone:t('TELEFONO EMISOR'),provider_email:t('CORREO EMISOR'),buyer_nit:normalizeNit(t('NIT COMPRADOR')),buyer_name:t('NOMBRE COMPRADOR'),cufe:t('CUFE'),payment_form:t('FORMA DE PAGO'),payment_method:t('MEDIO DE PAGO'),currency:t('MONEDA')||'COP',notes:[t('NOTA'),normalizeText(t('TIPO DE OPERACION'))==='mandatos'?'Mandato':''].filter(Boolean).join('\n'),subtotal:n('SUBTOTAL FACTURA'),discount:n('DESCUENTO GLOBAL'),iva:n('IVA'),impoconsumo:n('INC'),total:n('TOTAL FACTURA'),advances:n('ANTICIPOS'),surcharge:n('RECARGO GLOBAL'),retefuente:n('RETE RENTA'),reteiva:n('RETE IVA'),reteica:n('RETE ICA')}};
 });
}
export function documentAlerts(doc: PurchaseDocument) {
 const errors:string[]=[];const warnings:string[]=[];const h=doc.header;
 if(!h.number||!h.provider_nit||!h.issue_date||!h.cufe)errors.push('Falta número, NIT, fecha o CUFE.');
 if(!doc.lines.length)errors.push('Sin detalle de factura.');
 if(Math.abs(cents(doc.lines.reduce((s,l)=>s+l.subtotal,0)-h.subtotal))>0.01)errors.push('La suma del detalle no coincide con SUBTOTAL FACTURA.');
 const difference=cents(h.total-(h.subtotal+h.iva+h.impoconsumo-h.discount+h.surcharge));
 if(Math.abs(difference)>1)errors.push('No cuadra con el XML');
 if(h.total<=0||h.advances>h.total)errors.push('Total o anticipos inválidos.');
 if(Math.abs(cents(doc.lines.reduce((s,l)=>s+l.iva,0)-h.iva))>0.01)errors.push('El IVA del detalle no coincide con el XML.');
 if(Math.abs(cents(doc.lines.reduce((s,l)=>s+l.impoconsumo,0)-h.impoconsumo))>0.01)errors.push('El INC del detalle no coincide con el XML.');
 const aiu=doc.lines.some(l=>/\b(administracion|utilidad|imprevistos|aiu)\b/.test(normalizeText(l.description))) || (h.iva>0&&h.iva<cents(doc.lines.reduce((s,l)=>s+(l.iva>0?l.subtotal:0),0)*0.19)-1);
 if(aiu)warnings.push('Revisar base AIU');
 const months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
 const month=Number(doc.period.split('-')[1]);if(month&&doc.lines.some(l=>months.slice(0,month-1).some(m=>normalizeText(l.description).includes(m))))warnings.push('Posible gasto de periodo anterior');
 return {errors,warnings,difference,aiu};
}
export function suggestHistoryAccount(description:string,nit:string,history:{provider_nit?:string|null;concept?:string|null;account_code:string;weight?:number}[],puc:PucAccount[]) {
 const valid=history.filter(h=>/^(1[456]|[567])/.test(h.account_code)&&resolveOperationalAccount(puc,h.account_code).valid);
 const same=valid.filter(h=>normalizeNit(h.provider_nit)===normalizeNit(nit));
 const words=normalizeText(description).split(/\W+/).filter(w=>w.length>3);
 const pool=same.length?same:valid.filter(h=>words.some(w=>normalizeText(h.concept).includes(w)));
 const counts=new Map<string,number>();for(const h of pool)counts.set(h.account_code,(counts.get(h.account_code)??0)+(h.weight??1));
 const code=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];return code?resolveOperationalAccount(puc,code).operationalAccount??'':'';
}
export function calculatePurchase(doc:PurchaseDocument,settings:PurchaseSettings,profile:ProviderTaxProfile,choices:PurchaseChoices,puc:PucAccount[],usesCostCenters:boolean) {
 const {errors:sourceErrors,warnings,difference,aiu}=documentAlerts(doc);const errors=[...sourceErrors];const h=doc.header;
 const retentions={retefuente:0,reteiva:0,reteica:0};const calculated={...retentions};const accounts={retefuente:'',reteiva:settings.reteivaAccount,reteica:''};
 if(!Number.isFinite(settings.reteivaRate)||settings.reteivaRate<0||settings.reteivaRate>100)errors.push('Tarifa de reteIVA inválida.');
 const rule=settings.retentionRules.find(r=>normalizeText(r.concept)===normalizeText(profile.concept)&&!!profile.concept);
 const ica=settings.icaRules.find(r=>normalizeText(r.municipality)===normalizeText(profile.municipality)&&normalizeText(r.activity)===normalizeText(profile.activity));
 if(rule){accounts.retefuente=rule.account;if([rule.minUVT,rule.declarantRate,rule.nonDeclarantRate].some(n=>!Number.isFinite(n)||n<0)||rule.declarantRate>100||rule.nonDeclarantRate>100)errors.push('Tabla de retención inválida.');}
 if(ica){accounts.reteica=ica.account;if(!Number.isFinite(ica.perThousand)||ica.perThousand<0||ica.perThousand>1000)errors.push('Tarifa de reteICA inválida.');}
 if(doc.naturalPerson&&typeof profile.declarant!=='boolean')errors.push('Definir si es declarante');
 if(aiu&&(!choices.aiuReviewed||choices.aiuBase===undefined||!Number.isFinite(choices.aiuBase)||choices.aiuBase<0||choices.aiuBase>h.subtotal))errors.push('Revisar base AIU');
 const base=aiu?(choices.aiuBase??0):h.subtotal;
 if(!profile.nonSubject){
  if(!profile.selfWithholder){
   if(!rule)errors.push('Configure el concepto y la tabla de retención en la fuente.');
   else {accounts.retefuente=rule.account;if(settings.uvt<=0)errors.push('Configure el valor de la UVT del año.');if(settings.year!==Number(h.issue_date.slice(0,4)))errors.push('La UVT configurada no corresponde al año de la factura.');if(h.subtotal<rule.minUVT*settings.uvt)warnings.push('Bajo base mínima');else calculated.retefuente=Math.round(base*(profile.declarant===false?rule.nonDeclarantRate:rule.declarantRate)/100);}
  }
  if(!profile.largeTaxpayer)calculated.reteiva=Math.round(h.iva*settings.reteivaRate/100);
  if(!profile.selfWithholder){if(!ica)errors.push('Configure municipio, actividad y tarifa de reteICA.');else {accounts.reteica=ica.account;calculated.reteica=Math.round(base*ica.perThousand/1000);}}
 }
 const kinds:RetKind[]=['retefuente','reteiva','reteica'];
 for(const kind of kinds){if(Math.abs(calculated[kind]-h[kind])>0.005&&!choices.retentionSource[kind])errors.push(`Retención difiere del XML: ${kind}`);retentions[kind]=choices.retentionSource[kind]==='xml'?Math.round(h[kind]):calculated[kind];}
 const journal:JournalLine[]=[];
 function add(code:string,value:number,credit=false,costCenter='') {if(value===0)return;const resolution=resolveOperationalAccount(puc,code);if(!resolution.valid||!resolution.operationalAccount)errors.push(code?`Cuenta ${code}: seleccione una auxiliar operativa.`:'Pendiente de cuenta');const op=resolution.operationalAccount??code;const account=resolution.operational;const center=usesCostCenters?costCenter:null;if(usesCostCenters&&account?.requires_cost_center&&!center)errors.push('Esta cuenta requiere centro de costo.');const amount=Math.round(value);const debit=credit?0:amount;const cr=credit?amount:0;const existing=journal.find(l=>l.account_code===op&&l.cost_center===center&&((l.credit>0)===credit));if(existing){existing.debit+=debit;existing.credit+=cr;}else journal.push({account_code:op,account_name:account?.name??null,debit,credit:cr,cost_center:center});}
 const netLineSum=doc.lines.reduce((s,l)=>s+l.subtotal-l.discount+l.surcharge,0);
 for(const [i,l] of doc.lines.entries()){const ratio=netLineSum?(l.subtotal-l.discount+l.surcharge)/netLineSum:0;add(choices.accounts[i]??'',l.subtotal-l.discount+l.surcharge+l.impoconsumo+(settings.ivaTreatment==='gasto'?l.iva:0)+(h.surcharge-h.discount)*ratio,false,choices.lineCostCenters?.[i]??choices.costCenter);}
 if(settings.ivaTreatment==='descontable')add(settings.ivaAccount,h.iva,false,choices.costCenter);
 for(const kind of kinds)add(accounts[kind],retentions[kind],true,choices.costCenter);
 const retained=kinds.reduce((s,k)=>s+retentions[k],0);const payable=Math.round(h.total)-retained-Math.round(h.advances);
 if(payable<0)errors.push('Retenciones y anticipos exceden el total.');
 const cash=normalizeText(h.payment_form).includes('contado');const paymentAccount=settings.paymentAccounts.find(p=>normalizeText(p.method)===normalizeText(h.payment_method))?.account??settings.cashAccount;
 add(cash?paymentAccount:choices.payableAccount||settings.payableAccount||settings.expensesPayableAccount,payable,true,choices.costCenter);
 add(settings.advanceAccount,h.advances,true,choices.costCenter);
 const balance=journal.reduce((s,l)=>s+l.debit-l.credit,0);
 if(balance!==0){if(Math.abs(difference)<=1&&Math.abs(balance)<=doc.lines.length+1){add(balance>0?settings.roundingIncomeAccount:settings.roundingExpenseAccount,Math.abs(balance),balance>0,choices.costCenter);}else errors.push('No cuadra con el XML');}
 if(journal.reduce((s,l)=>s+l.debit-l.credit,0)!==0)errors.push('El asiento no está cuadrado al peso.');
 const voucher=doc.kind==='credit_note'?settings.creditVoucher:doc.kind==='equivalent'?settings.equivalentVoucher:settings.purchaseVoucher;
 if(!voucher)errors.push('Configure el comprobante para este tipo de documento.');
 if(doc.kind==='credit_note'){if(!choices.affectedInvoiceId)errors.push('Seleccione la factura afectada del mismo proveedor.');for(const l of journal){const debit=l.debit;l.debit=l.credit;l.credit=debit;}}
 return {journal,calculated,retentions,payable,errors:[...new Set(errors)],warnings:[...new Set(warnings)],voucher};
}
