import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { CheckCircle2, Download } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany } from "@/components/app-shell";
import { cop, fecha } from "@/lib/format";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/pendientes-siigo")({
  head: () => ({
    meta: [
      { title: "Pendientes en Siigo · Ajustes y anticipos" },
      { name: "description", content: "Ajustes al peso pendientes por pagar y anticipos por cruzar en Siigo." },
      { property: "og:title", content: "Pendientes en Siigo" },
      { property: "og:description", content: "Ajustes al peso y anticipos por cruzar en Siigo." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Pendientes,
});

type Row = {
  id: string; kind: string; amount: number; account_code: string | null; provider_nit: string | null;
  provider_name: string | null; invoice_label: string | null; siigo_number: string | null; status: string; created_at: string;
};

function Pendientes() {
  const companyId = useActiveCompany();
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ["siigo-pending", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("siigo_pending_settlements").select("*").eq("company_id", companyId!).order("created_at", { ascending: false });
      if (error) throw error;
      return data as Row[];
    },
  });
  if (!companyId) return <EmptyCompany />;

  const marcar = async (r: Row) => {
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("siigo_pending_settlements").update({ status: "registrado", resolved_at: new Date().toISOString(), resolved_by: u.user?.id ?? null }).eq("id", r.id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["siigo-pending", companyId] });
  };

  const exportar = (kind: string, titulo: string, rows: Row[]) => {
    const hoja = rows.map((r) => kind === "ajuste_peso"
      ? { Proveedor: r.provider_name ?? "", NIT: r.provider_nit ?? "", Factura: r.invoice_label ?? "", "Factura Siigo": r.siigo_number ?? "", "Diferencia": Number(r.amount), Cuenta: r.account_code ?? "42958101", Estado: r.status }
      : { Proveedor: r.provider_name ?? "", NIT: r.provider_nit ?? "", Factura: r.invoice_label ?? "", "Factura Siigo": r.siigo_number ?? "", "Valor anticipo": Number(r.amount), Estado: r.status });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(hoja), titulo.slice(0, 31));
    XLSX.writeFile(wb, `${kind === "ajuste_peso" ? "ajustes_al_peso" : "anticipos"}_pendientes.xlsx`);
  };

  const secciones = [
    { kind: "ajuste_peso", titulo: "Ajustes al peso pendientes por pagar", ayuda: "Regístrelos en el egreso contra 42958101 Ajuste al peso.", valor: "Diferencia" },
    { kind: "anticipo", titulo: "Anticipos por cruzar en Siigo", ayuda: "Cruce el anticipo contra la factura ya creada en Siigo.", valor: "Valor anticipo" },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Pendientes en Siigo</h1>
      {secciones.map((s) => {
        const rows = data.filter((r) => r.kind === s.kind);
        return (
          <section key={s.kind} className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{s.titulo}</h2>
                <p className="text-sm text-muted-foreground">{s.ayuda}</p>
              </div>
              <Button variant="outline" size="sm" disabled={!rows.length} onClick={() => exportar(s.kind, s.titulo, rows)}>
                <Download className="mr-2 h-4 w-4" /> Exportar a Excel
              </Button>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2">Proveedor</th><th className="p-2">NIT</th><th className="p-2">Factura</th>
                    <th className="p-2">Factura Siigo</th><th className="p-2 text-right">{s.valor}</th><th className="p-2">Fecha</th><th className="p-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">Sin pendientes.</td></tr>}
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2">{r.provider_name}</td>
                      <td className="p-2 font-mono">{r.provider_nit}</td>
                      <td className="p-2">{r.invoice_label}</td>
                      <td className="p-2 font-mono">{r.siigo_number}</td>
                      <td className="p-2 text-right">{cop(Number(r.amount))}</td>
                      <td className="p-2">{fecha(r.created_at)}</td>
                      <td className="p-2">
                        {r.status === "registrado" ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground"><CheckCircle2 className="h-4 w-4" /> Registrado</span>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => marcar(r)}>Marcar registrado</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
