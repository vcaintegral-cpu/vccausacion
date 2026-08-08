import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, Eye } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { fecha } from "@/lib/format";
import { ESTADO_LABEL, estadoUnico } from "@/lib/invoice-duplicates";
import { downloadInvoiceFile } from "@/lib/invoice-pdf";
import { InvoicePdfViewer } from "@/components/invoice-pdf-viewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/documentos")({
  head: () => ({
    meta: [
      { title: "Documentos · Archivo de facturas originales" },
      { name: "description", content: "Consulta y descarga los PDF originales de las facturas de compra por empresa, año, mes y estado." },
      { property: "og:title", content: "Documentos · Archivo de facturas originales" },
      { property: "og:description", content: "Archivo documental de facturas de compra con sus PDF originales." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Documentos,
});

type Doc = {
  id: string;
  company_id: string;
  prefix: string | null;
  number: string | null;
  issue_date: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  cufe: string | null;
  status: string;
  siigo_status: string;
  siigo_id: string | null;
  siigo_number: string | null;
  file_path: string | null;
  file_name: string | null;
};

const MESES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

function tipoDocumento(d: Doc) {
  return d.cufe ? "Factura electrónica" : "Factura de compra";
}

function Documentos() {
  const companyId = useActiveCompany();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();
  const [empresa, setEmpresa] = useState<string>("activa");
  const [anio, setAnio] = useState("todos");
  const [mes, setMes] = useState("todos");
  const [tipo, setTipo] = useState("todos");
  const [estado, setEstado] = useState("todos");
  const [numero, setNumero] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [nit, setNit] = useState("");
  const [pdfDoc, setPdfDoc] = useState<Doc | null>(null);

  // La consulta siempre se hace por empresa (company_id), nunca solo por número de factura.
  const empresaId = empresa === "activa" ? companyId : empresa;

  const { data: docs } = useQuery({
    queryKey: ["documentos", empresaId],
    enabled: !!empresaId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "id, company_id, prefix, number, issue_date, provider_nit, provider_name, cufe, status, siigo_status, siigo_id, siigo_number, file_path, file_name",
        )
        .eq("company_id", empresaId!)
        .order("issue_date", { ascending: false });
      if (error) throw error;
      return data as Doc[];
    },
  });

  const anios = useMemo(
    () => Array.from(new Set((docs ?? []).map((d) => d.issue_date?.slice(0, 4)).filter(Boolean) as string[])).sort().reverse(),
    [docs],
  );

  async function descargar(d: Doc) {
    try {
      await downloadInvoiceFile(d);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF no disponible");
    }
  }

  if (!loadingCompanies && (companies ?? []).length === 0) return <EmptyCompany />;

  const rows = (docs ?? []).filter((d) => {
    if (anio !== "todos" && d.issue_date?.slice(0, 4) !== anio) return false;
    if (mes !== "todos" && d.issue_date?.slice(5, 7) !== mes) return false;
    if (tipo !== "todos" && tipoDocumento(d) !== tipo) return false;
    if (estado !== "todos" && estadoUnico(d) !== estado) return false;
    if (numero && !`${d.prefix ?? ""}${d.number ?? ""}`.toLowerCase().includes(numero.toLowerCase())) return false;
    if (proveedor && !(d.provider_name ?? "").toLowerCase().includes(proveedor.toLowerCase())) return false;
    if (nit && !(d.provider_nit ?? "").includes(nit)) return false;
    return true;
  });

  const nombreEmpresa = (id: string) => (companies ?? []).find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Documentos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Archivo documental: {rows.length} factura(s) con su PDF original. Se consulta el mismo archivo del Historial.
        </p>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4">
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
          <option value="activa">Empresa activa</option>
          {(companies ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={anio} onChange={(e) => setAnio(e.target.value)}>
          <option value="todos">Todos los años</option>
          {anios.map((a) => (<option key={a} value={a}>{a}</option>))}
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={mes} onChange={(e) => setMes(e.target.value)}>
          <option value="todos">Todos los meses</option>
          {MESES.map((m) => (<option key={m} value={m}>{m}</option>))}
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={tipo} onChange={(e) => setTipo(e.target.value)}>
          <option value="todos">Todo tipo de documento</option>
          <option value="Factura electrónica">Factura electrónica</option>
          <option value="Factura de compra">Factura de compra</option>
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={estado} onChange={(e) => setEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="borrador">Borradores</option>
          <option value="aprobado">Aprobados</option>
          <option value="sincronizada">Sincronizadas</option>
          <option value="error">Con error</option>
        </select>
        <Input placeholder="Número de factura" value={numero} onChange={(e) => setNumero(e.target.value)} />
        <Input placeholder="Proveedor" value={proveedor} onChange={(e) => setProveedor(e.target.value)} />
        <Input placeholder="NIT proveedor" value={nit} onChange={(e) => setNit(e.target.value)} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Empresa</th>
              <th className="px-4 py-2 font-medium">Año</th>
              <th className="px-4 py-2 font-medium">Mes</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Factura proveedor</th>
              <th className="px-4 py-2 font-medium">Proveedor</th>
              <th className="px-4 py-2 font-medium">NIT</th>
              <th className="px-4 py-2 font-medium">Fecha</th>
              <th className="px-4 py-2 font-medium">Estado</th>
              <th className="px-4 py-2 font-medium">Consecutivo Siigo</th>
              <th className="px-4 py-2 text-right font-medium">Documento</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((d) => (
              <tr key={d.id} className="hover:bg-muted/30">
                <td className="px-4 py-2">{nombreEmpresa(d.company_id)}</td>
                <td className="px-4 py-2 text-muted-foreground">{d.issue_date?.slice(0, 4) ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">{d.issue_date?.slice(5, 7) ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">{tipoDocumento(d)}</td>
                <td className="px-4 py-2 font-mono text-xs">{[d.prefix, d.number].filter(Boolean).join("-") || "—"}</td>
                <td className="px-4 py-2">{d.provider_name ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">{d.provider_nit ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">{fecha(d.issue_date)}</td>
                <td className="px-4 py-2">{ESTADO_LABEL[estadoUnico(d)]}</td>
                <td className="px-4 py-2">
                  {d.siigo_number || d.siigo_id ? (
                    <span className="font-mono text-xs">{d.siigo_number ?? d.siigo_id}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Pendiente</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {d.file_path ? (
                    <>
                      <Button variant="ghost" size="icon" title="Ver PDF original" onClick={() => setPdfDoc(d)}>
                        <Eye className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Descargar PDF original" onClick={() => descargar(d)}>
                        <Download className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">PDF no disponible</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No hay documentos que coincidan con el filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <InvoicePdfViewer factura={pdfDoc} onOpenChange={(o) => !o && setPdfDoc(null)} />
    </div>
  );
}
