import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Download, Eye, FileSpreadsheet, FileText, Pencil, Send, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useBulkProgress } from "@/lib/bulk-runner";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { cop, fecha } from "@/lib/format";
import { exportCsv, exportTxt, exportXlsx } from "@/lib/export";
import { ESTADO_LABEL, estadoUnico } from "@/lib/invoice-duplicates";
import { downloadInvoiceFile } from "@/lib/invoice-pdf";
import { InvoicePdfViewer } from "@/components/invoice-pdf-viewer";
import type { JournalLine } from "@/lib/accounting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/facturas")({
  head: () => ({
    meta: [
      { title: "Historial de facturas causadas" },
      { name: "description", content: "Consulta, aprueba y exporta a Contai los comprobantes contables de tus facturas de compra." },
      { property: "og:title", content: "Historial de facturas causadas" },
      { property: "og:description", content: "Consulta, aprueba y exporta comprobantes contables." },
    ],
  }),
  component: Facturas,
});

type Inv = {
  id: string;
  prefix: string | null;
  number: string | null;
  issue_date: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  cost_center: string | null;
  notes: string | null;
  subtotal: number;
  iva: number;
  retefuente: number;
  reteiva: number;
  reteica: number;
  total: number;
  status: string;
  siigo_status: string;
  siigo_id: string | null;
  siigo_number: string | null;
  siigo_synced_at: string | null;
  siigo_last_attempt_at: string | null;
  siigo_error?: string | null;
  file_path: string | null;
  file_name: string | null;
};

const SIIGO_LABEL: Record<string, string> = {
  pendiente: "Pendiente de enviar",
  sincronizando: "Sincronizando",
  sincronizada: "Sincronizada",
  error: "Error",
};

const SIIGO_CLASS: Record<string, string> = {
  pendiente: "bg-muted text-muted-foreground",
  sincronizando: "bg-secondary text-secondary-foreground",
  sincronizada: "bg-primary/10 text-primary",
  error: "bg-destructive/10 text-destructive",
};

function Facturas() {
  const companyId = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();
  const [q, setQ] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [detalle, setDetalle] = useState<Inv | null>(null);
  const [pdfDoc, setPdfDoc] = useState<Inv | null>(null);
  const [estado, setEstado] = useState<"todas" | "borrador" | "aprobado" | "causada" | "sincronizando" | "sincronizada" | "error_siigo" | "error">(
    "sincronizada",
  );

  // Mientras hay una carga en segundo plano, el historial se refresca solo:
  // las facturas aparecen como borrador ("lista para revisar") al terminar cada PDF.
  const bulk = useBulkProgress();

  const { data: invoices } = useQuery({
    queryKey: ["invoices", companyId],
    enabled: !!companyId,
    refetchInterval: bulk.running ? 5000 : false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "id, prefix, number, issue_date, provider_nit, provider_name, cost_center, notes, subtotal, iva, retefuente, reteiva, reteica, total, status, siigo_status, siigo_id, siigo_number, siigo_synced_at, siigo_last_attempt_at, siigo_error, file_path, file_name",
        )
        .eq("company_id", companyId!)
        .order("issue_date", { ascending: false });
      if (error) throw error;
      return data as Inv[];
    },
  });

  const { data: journal } = useQuery({
    queryKey: ["journal", detalle?.id],
    enabled: !!detalle,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("journal_lines")
        .select("account_code, account_name, debit, credit, cost_center")
        .eq("invoice_id", detalle!.id)
        .order("position");
      if (error) throw error;
      return data as JournalLine[];
    },
  });

  const abrir = (r: Inv) => {
    const e = estadoUnico(r);
    if (e === "borrador" || e === "error") navigate({ to: "/causar", search: { id: r.id } });
    else setDetalle(r);
  };

  async function exportar(inv: Inv, kind: "xlsx" | "csv" | "txt") {
    const { data, error } = await supabase
      .from("journal_lines")
      .select("account_code, account_name, debit, credit, cost_center")
      .eq("invoice_id", inv.id)
      .order("position");
    if (error || !data?.length) { toast.error("Este comprobante no tiene movimientos."); return; }
    const fn = kind === "xlsx" ? exportXlsx : kind === "csv" ? exportCsv : exportTxt;
    fn(inv, data as JournalLine[]);
  }

  async function descargarPdf(inv: Inv) {
    try {
      await downloadInvoiceFile(inv);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF no disponible");
    }
  }

  async function aprobar(inv: Inv) {
    // Al aprobar (o re-aprobar tras corregir un error) queda pendiente de envío a Siigo.
    const { error } = await supabase
      .from("invoices")
      .update({ status: "aprobado", siigo_status: "pendiente", siigo_error: null })
      .eq("id", inv.id)
      .neq("siigo_status", "sincronizada");
    if (error) { toast.error(error.message); return; }
    toast.success("Comprobante aprobado.");
    await queryClient.invalidateQueries({ queryKey: ["invoices", companyId] });
  }

  async function eliminar(inv: Inv) {
    await supabase.from("journal_lines").delete().eq("invoice_id", inv.id);
    await supabase.from("invoice_lines").delete().eq("invoice_id", inv.id);
    const { error } = await supabase.from("invoices").delete().eq("id", inv.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Factura eliminada.");
    await queryClient.invalidateQueries({ queryKey: ["invoices", companyId] });
  }

  if (!loadingCompanies && (companies ?? []).length === 0) return <EmptyCompany />;

  const rows = (invoices ?? []).filter((r) => {
    const text = `${r.prefix ?? ""}${r.number ?? ""} ${r.provider_name ?? ""} ${r.provider_nit ?? ""}`.toLowerCase();
    if (q && !text.includes(q.toLowerCase())) return false;
    if (desde && (r.issue_date ?? "") < desde) return false;
    if (hasta && (r.issue_date ?? "") > hasta) return false;
    if (estado !== "todas" && estadoUnico(r) !== estado) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Historial</h1>
          <p className="mt-1 text-sm text-muted-foreground">{rows.length} comprobante(s). Exporta a Contai en Excel, CSV o TXT.</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/causar" search={{ id: undefined }}>Causar factura</Link>
        </Button>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-[2fr_1fr_1fr_1fr]">
        <Input placeholder="Buscar por número, proveedor o NIT" value={q} onChange={(e) => setQ(e.target.value)} />
        <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={estado}
          onChange={(e) => setEstado(e.target.value as typeof estado)}
        >
          <option value="sincronizada">Histórico (sincronizadas)</option>
          <option value="todas">Todos</option>
          <option value="borrador">Borradores</option>
          <option value="aprobado">Aprobados</option>
          <option value="causada">Causadas</option>
          <option value="sincronizando">Sincronizando</option>
          <option value="error_siigo">Error Siigo</option>
          <option value="error">Error de causación</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Factura</th>
              <th className="px-4 py-2 font-medium">Proveedor</th>
              <th className="px-4 py-2 font-medium">Fecha</th>
              <th className="px-4 py-2 text-right font-medium">Base</th>
              <th className="px-4 py-2 text-right font-medium">IVA</th>
              <th className="px-4 py-2 text-right font-medium">Retenciones</th>
              <th className="px-4 py-2 text-right font-medium">Total</th>
              <th className="px-4 py-2 font-medium">Estado</th>
              <th className="px-4 py-2 font-medium">Estado Siigo</th>
              <th className="px-4 py-2 font-medium">Consecutivo Siigo</th>
              <th className="px-4 py-2 text-right font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="cursor-pointer px-4 py-2 font-mono text-xs" onClick={() => abrir(r)}>
                  {[r.prefix, r.number].filter(Boolean).join("-") || "—"}
                </td>
                <td className="cursor-pointer px-4 py-2" onClick={() => abrir(r)}>
                  {r.provider_name ?? "—"}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{fecha(r.issue_date)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{cop(r.subtotal)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{cop(r.iva)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">
                  {cop(Number(r.retefuente) + Number(r.reteiva) + Number(r.reteica))}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{cop(r.total)}</td>
                <td className="px-4 py-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${SIIGO_CLASS[estadoUnico(r) === "sincronizada" ? "sincronizada" : estadoUnico(r) === "error" || estadoUnico(r) === "error_siigo" ? "error" : estadoUnico(r) === "borrador" ? "pendiente" : "sincronizando"]}`}>
                    {ESTADO_LABEL[estadoUnico(r)]}
                  </span>
                  {estadoUnico(r) === "error_siigo" && r.siigo_error && (
                    <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-destructive" title={r.siigo_error}>
                      {r.siigo_error}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${SIIGO_CLASS[r.siigo_status] ?? "bg-muted text-muted-foreground"}`}>
                    {SIIGO_LABEL[r.siigo_status] ?? r.siigo_status}
                  </span>
                  {r.siigo_status === "sincronizada" && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {r.siigo_number ? `N° ${r.siigo_number} · ` : ""}
                      {fecha(r.siigo_synced_at?.slice(0, 10) ?? null)}
                    </div>
                  )}
                  {r.siigo_status === "error" && r.siigo_last_attempt_at && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">Último intento {fecha(r.siigo_last_attempt_at.slice(0, 10))}</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.siigo_number || r.siigo_id ? (
                    <span className="font-mono text-xs">{r.siigo_number ?? r.siigo_id}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Pendiente</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {estadoUnico(r) === "borrador" && (
                    <Button asChild variant="ghost" size="icon" title="Continuar borrador">
                      <Link to="/causar" search={{ id: r.id }}>
                        <Pencil className="size-4" />
                      </Link>
                    </Button>
                  )}
                  {(estadoUnico(r) === "error" || estadoUnico(r) === "error_siigo") && (
                    <Button asChild variant="ghost" size="icon" title="Revisar y corregir">
                      <Link to="/causar" search={{ id: r.id }}>
                        <Pencil className="size-4" />
                      </Link>
                    </Button>
                  )}
                  {estadoUnico(r) === "aprobado" && (
                    <Button asChild variant="ghost" size="icon" title="Revisar y causar en Siigo">
                      <Link to="/revisar" search={{ id: r.id }}>
                        <Send className="size-4" />
                      </Link>
                    </Button>
                  )}
                  {estadoUnico(r) === "sincronizada" && (
                    <Button variant="ghost" size="icon" title="Ver documento" onClick={() => setDetalle(r)}>
                      <FileText className="size-4" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" title="Excel" onClick={() => exportar(r, "xlsx")}>
                    <FileSpreadsheet className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title={r.file_path ? "Ver PDF original" : "PDF no disponible"}
                    disabled={!r.file_path}
                    onClick={() => setPdfDoc(r)}
                  >
                    <Eye className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title={r.file_path ? "Descargar PDF original" : "PDF no disponible"}
                    disabled={!r.file_path}
                    onClick={() => descargarPdf(r)}
                  >
                    <Download className="size-4" />
                  </Button>
                  {estadoUnico(r) === "borrador" && (
                    <Button variant="ghost" size="icon" title="Aprobar" onClick={() => aprobar(r)}>
                      <CheckCircle2 className="size-4" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" title="Eliminar" onClick={() => eliminar(r)}>
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No hay facturas que coincidan con el filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <InvoicePdfViewer factura={pdfDoc} onOpenChange={(o) => !o && setPdfDoc(null)} />

      <Dialog open={!!detalle} onOpenChange={(o) => !o && setDetalle(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Comprobante {[detalle?.prefix, detalle?.number].filter(Boolean).join("-")} · {detalle?.provider_name}
            </DialogTitle>
          </DialogHeader>
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Cuenta</th>
                <th className="px-3 py-2 font-medium">Nombre</th>
                <th className="px-3 py-2 text-right font-medium">Débito</th>
                <th className="px-3 py-2 text-right font-medium">Crédito</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(journal ?? []).map((j, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 font-mono text-xs">{j.account_code}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{j.account_name}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{j.debit ? cop(j.debit) : ""}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{j.credit ? cop(j.credit) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {detalle && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => exportar(detalle, "xlsx")}>
                <FileSpreadsheet className="size-4" /> Excel
              </Button>
              <Button size="sm" variant="outline" onClick={() => exportar(detalle, "csv")}>
                <Download className="size-4" /> CSV
              </Button>
              <Button size="sm" variant="outline" onClick={() => exportar(detalle, "txt")}>
                <FileText className="size-4" /> TXT
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
