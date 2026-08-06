import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileUp, ListChecks, Receipt, TrendingUp, Wallet } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { cop, fecha } from "@/lib/format";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/panel")({
  head: () => ({
    meta: [
      { title: "Panel de causación — Facturas de compra" },
      { name: "description", content: "Indicadores de facturas causadas, impuestos y retenciones por empresa." },
      { property: "og:title", content: "Panel de causación" },
      { property: "og:description", content: "Indicadores de facturas causadas, impuestos y retenciones." },
    ],
  }),
  component: Panel,
});

function Panel() {
  const companyId = useActiveCompany();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();

  const { data: invoices } = useQuery({
    queryKey: ["panel-invoices", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("id, prefix, number, provider_name, issue_date, total, iva, retefuente, reteiva, reteica, status")
        .eq("company_id", companyId!)
        .order("issue_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
  });

  if (!loadingCompanies && (companies ?? []).length === 0) return <EmptyCompany />;

  const rows = invoices ?? [];
  const mes = new Date().toISOString().slice(0, 7);
  const delMes = rows.filter((r) => (r.issue_date ?? "").startsWith(mes));
  const suma = (list: typeof rows, key: "total" | "iva" | "retefuente" | "reteiva" | "reteica") =>
    list.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
  const borradores = rows.filter((r) => r.status === "borrador").length;
  const retenciones = suma(delMes, "retefuente") + suma(delMes, "reteiva") + suma(delMes, "reteica");

  const cards = [
    { label: "Facturas del mes", value: String(delMes.length), icon: Receipt, hint: `${rows.length} en total` },
    { label: "Valor causado (mes)", value: cop(suma(delMes, "total")), icon: TrendingUp, hint: "Incluye impuestos" },
    { label: "IVA del costo (mes)", value: cop(suma(delMes, "iva")), icon: Wallet, hint: "Cuenta 621008" },
    { label: "Retenciones (mes)", value: cop(retenciones), icon: ListChecks, hint: "Fuente · IVA · ICA" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Panel</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Resumen de causación de la empresa activa. {borradores > 0 ? `${borradores} comprobante(s) en borrador.` : "Sin borradores pendientes."}
          </p>
        </div>
        <Button asChild>
          <Link to="/causar">
            <FileUp className="size-4" /> Causar factura
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</p>
              <c.icon className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-2 font-mono text-xl font-semibold tabular-nums">{c.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Últimas facturas</h2>
          <Link to="/facturas" className="text-xs text-primary hover:underline">
            Ver historial
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            Todavía no hay facturas causadas para esta empresa.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-2 font-medium">Factura</th>
                <th className="px-5 py-2 font-medium">Proveedor</th>
                <th className="px-5 py-2 font-medium">Fecha</th>
                <th className="px-5 py-2 text-right font-medium">Total</th>
                <th className="px-5 py-2 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.slice(0, 8).map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-2 font-mono text-xs">{[r.prefix, r.number].filter(Boolean).join("-") || "—"}</td>
                  <td className="px-5 py-2">{r.provider_name ?? "—"}</td>
                  <td className="px-5 py-2 text-muted-foreground">{fecha(r.issue_date)}</td>
                  <td className="px-5 py-2 text-right font-mono tabular-nums">{cop(r.total)}</td>
                  <td className="px-5 py-2 text-xs capitalize text-muted-foreground">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}