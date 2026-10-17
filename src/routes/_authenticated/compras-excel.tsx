import { createFileRoute } from '@tanstack/react-router';
import { useActiveCompany } from '@/lib/active-company';
import { PurchaseExcelImporter } from '@/components/purchase-excel-importer';
export const Route=createFileRoute('/_authenticated/compras-excel')({
 head:()=>({meta:[{title:'Compras desde RECIBIDOS Excel | ContaSync'},{name:'description',content:'Revisión y causación de compras desde el reporte RECIBIDOS del Procesador XML FE, sin IA.'},{property:'og:title',content:'Compras desde RECIBIDOS Excel | ContaSync'},{property:'og:description',content:'Importa documentos, compara retenciones y confirma asientos de compra.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),
 component:Page,
});
function Page(){const companyId=useActiveCompany();return <div className="space-y-5"><h1 className="text-xl font-semibold">Compras desde Excel RECIBIDOS</h1>{companyId?<PurchaseExcelImporter key={companyId} companyId={companyId}/>:<p className="text-sm text-muted-foreground">Selecciona una empresa activa.</p>}</div>;}
