import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CostCentersPanel, HistoryPanel, ProvidersToolbar, PucPanel, TaxesPanel } from "@/components/accounting-data";
import { ProductsPanel } from "@/components/products-panel";
import { ProductCategoriesPanel } from "@/components/product-categories-panel";
import { PaymentTypesPanel } from "@/components/payment-types-panel";
import { ProviderRulesPanel } from "@/components/provider-rules-panel";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { title: "Administración contable: PUC, impuestos y reglas" },
      { name: "description", content: "Configura el PUC, terceros, reglas de causación, tarifas de retención y centros de costo por empresa." },
      { property: "og:title", content: "Administración contable" },
      { property: "og:description", content: "PUC, terceros, reglas, retenciones y centros de costo." },
    ],
  }),
  component: Admin,
});

type Table = "puc_accounts" | "providers" | "accounting_rules" | "tax_rates" | "cost_centers";

type FieldDef = { key: string; label: string; type?: "text" | "number"; width?: string };

const PAGE = 1000;

function useRows(table: Table, companyId: string | null, order: string) {
  return useQuery({
    queryKey: [table, companyId],
    enabled: !!companyId,
    queryFn: async () => {
      // PostgREST devuelve máximo 1000 filas por consulta: se pagina hasta traer todo.
      const out: Record<string, unknown>[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from(table)
          .select("*")
          .eq("company_id", companyId!)
          .order(order)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const chunk = (data ?? []) as Record<string, unknown>[];
        out.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      return out;
    },
  });
}

const fmtNum = (value: number) => value.toLocaleString("es-CO");

function Section({
  table,
  companyId,
  order,
  fields,
  defaults,
  noun = "registro(s)",
}: {
  table: Table;
  companyId: string;
  order: string;
  fields: FieldDef[];
  defaults?: Record<string, unknown>;
  noun?: string;
}) {
  const queryClient = useQueryClient();
  const { data: rows } = useRows(table, companyId, order);
  const [form, setForm] = useState<Record<string, string>>({});
  const [buscar, setBuscar] = useState("");
  const [pagina, setPagina] = useState(1);
  const porPagina = 100;

  const filtradas = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    const all = rows ?? [];
    if (!q) return all;
    return all.filter((r) => fields.some((f) => String(r[f.key] ?? "").toLowerCase().includes(q)));
  }, [rows, buscar, fields]);
  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / porPagina));
  const paginaActual = Math.min(pagina, totalPaginas);
  const visibles = filtradas.slice((paginaActual - 1) * porPagina, paginaActual * porPagina);

  async function agregar(e: React.FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { company_id: companyId, ...defaults };
    for (const f of fields) {
      const v = form[f.key] ?? "";
      payload[f.key] = f.type === "number" ? Number(v || 0) : v;
    }
    const { error } = await supabase.from(table).insert(payload as never);
    if (error) { toast.error(error.message); return; }
    setForm({});
    toast.success("Registro agregado.");
    await queryClient.invalidateQueries({ queryKey: [table, companyId] });
  }

  async function eliminar(id: string) {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await queryClient.invalidateQueries({ queryKey: [table, companyId] });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={agregar} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        {fields.map((f) => (
          <div key={f.key} className={`space-y-1.5 ${f.width ?? "w-44"}`}>
            <Label className="text-xs">{f.label}</Label>
            <Input
              type={f.type === "number" ? "number" : "text"}
              step="any"
              value={form[f.key] ?? ""}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          </div>
        ))}
        <Button type="submit">
          <Plus className="size-4" /> Agregar
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={buscar}
          onChange={(e) => { setBuscar(e.target.value); setPagina(1); }}
          placeholder="Buscar…"
          className="w-72"
        />
        <span className="text-xs text-muted-foreground">
          Mostrando {fmtNum(visibles.length)} de {fmtNum(filtradas.length)} {noun} · Página {paginaActual} de {totalPaginas}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={paginaActual <= 1} onClick={() => setPagina(paginaActual - 1)}>Anterior</Button>
          <Button variant="outline" size="sm" disabled={paginaActual >= totalPaginas} onClick={() => setPagina(paginaActual + 1)}>Siguiente</Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {fields.map((f) => (
                <th key={f.key} className="px-4 py-2 font-medium">
                  {f.label}
                </th>
              ))}
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibles.map((r) => (
              <tr key={String(r['id'])}>
                {fields.map((f) => (
                  <td key={f.key} className="px-4 py-2">
                    {String(r[f.key] ?? "—")}
                  </td>
                ))}
                <td className="px-4 py-2 text-right">
                  <Button variant="ghost" size="icon" onClick={() => eliminar(String(r['id']))}>
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {visibles.length === 0 && (
              <tr>
                <td colSpan={fields.length + 1} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {buscar ? "Sin resultados para la búsqueda." : "Sin registros."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Admin() {
  const companyId = useActiveCompany();
  const { data: companies, isLoading } = useCompanies();

  if (!isLoading && (companies ?? []).length === 0) return <EmptyCompany />;
  if (!companyId) return <p className="text-sm text-muted-foreground">Selecciona una empresa activa.</p>;

  const wrap = (node: ReactNode) => <div className="mt-4">{node}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Administración</h1>
        <p className="mt-1 text-sm text-muted-foreground">Parámetros contables de la empresa activa.</p>
      </div>

      <Tabs defaultValue="puc">
        <TabsList>
          <TabsTrigger value="puc">PUC</TabsTrigger>
          <TabsTrigger value="terceros">Terceros</TabsTrigger>
          <TabsTrigger value="productos">Productos y servicios</TabsTrigger>
          <TabsTrigger value="categorias">Categorías</TabsTrigger>
          <TabsTrigger value="formas-pago">Formas de pago</TabsTrigger>
          <TabsTrigger value="reglas">Reglas</TabsTrigger>
          <TabsTrigger value="reglas-proveedor">Reglas por proveedor</TabsTrigger>
          <TabsTrigger value="impuestos">Retenciones</TabsTrigger>
          <TabsTrigger value="centros">Centros de costo</TabsTrigger>
          <TabsTrigger value="historial">Historial contable</TabsTrigger>
        </TabsList>

        <TabsContent value="puc">
          {wrap(<PucPanel companyId={companyId} />)}
        </TabsContent>

        <TabsContent value="terceros">
          {wrap(
            <div className="space-y-4">
              <ProvidersToolbar companyId={companyId} />
              <Section
              table="providers"
              companyId={companyId}
              order="name"
              noun="tercero(s)"
              fields={[
                { key: "nit", label: "NIT" },
                { key: "name", label: "Razón social", width: "w-72" },
                { key: "city", label: "Ciudad" },
                { key: "default_expense_account", label: "Cuenta gasto" },
                { key: "default_payable_account", label: "Cuenta por pagar" },
              ]}
              />
            </div>,
          )}
        </TabsContent>

        <TabsContent value="productos">
          {wrap(<ProductsPanel companyId={companyId} />)}
        </TabsContent>

        <TabsContent value="categorias">
          {wrap(<ProductCategoriesPanel companyId={companyId} />)}
        </TabsContent>

        <TabsContent value="formas-pago">
          {wrap(<PaymentTypesPanel companyId={companyId} />)}
        </TabsContent>

        <TabsContent value="reglas-proveedor">
          {wrap(<ProviderRulesPanel companyId={companyId} />)}
        </TabsContent>

        <TabsContent value="reglas">
          {wrap(
            <Section
              table="accounting_rules"
              companyId={companyId}
              order="priority"
              defaults={{ source: "manual" }}
              fields={[
                { key: "match_type", label: "Tipo (keyword/nit)" },
                { key: "match_value", label: "Valor" },
                { key: "account_code", label: "Cuenta" },
                { key: "account_name", label: "Nombre cuenta", width: "w-60" },
                { key: "priority", label: "Prioridad", type: "number", width: "w-28" },
              ]}
            />,
          )}
        </TabsContent>

        <TabsContent value="impuestos">
          {wrap(<TaxesPanel companyId={companyId} />)}
        </TabsContent>

        <TabsContent value="centros">
          {wrap(<CostCentersPanel companyId={companyId} />)}
        </TabsContent>

        <TabsContent value="historial">
          {wrap(<HistoryPanel companyId={companyId} />)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
