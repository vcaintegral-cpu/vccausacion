import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
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

function useRows(table: Table, companyId: string | null, order: string) {
  return useQuery({
    queryKey: [table, companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase.from(table).select("*").eq("company_id", companyId!).order(order);
      if (error) throw error;
      return data as Record<string, unknown>[];
    },
  });
}

function Section({
  table,
  companyId,
  order,
  fields,
  defaults,
}: {
  table: Table;
  companyId: string;
  order: string;
  fields: FieldDef[];
  defaults?: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const { data: rows } = useRows(table, companyId, order);
  const [form, setForm] = useState<Record<string, string>>({});

  async function agregar(e: React.FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { company_id: companyId, ...defaults };
    for (const f of fields) {
      const v = form[f.key] ?? "";
      payload[f.key] = f.type === "number" ? Number(v || 0) : v;
    }
    const { error } = await supabase.from(table).insert(payload as never);
    if (error) return toast.error(error.message);
    setForm({});
    toast.success("Registro agregado.");
    await queryClient.invalidateQueries({ queryKey: [table, companyId] });
  }

  async function eliminar(id: string) {
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) return toast.error(error.message);
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
            {(rows ?? []).map((r) => (
              <tr key={String(r.id)}>
                {fields.map((f) => (
                  <td key={f.key} className="px-4 py-2">
                    {String(r[f.key] ?? "—")}
                  </td>
                ))}
                <td className="px-4 py-2 text-right">
                  <Button variant="ghost" size="icon" onClick={() => eliminar(String(r.id))}>
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {(rows ?? []).length === 0 && (
              <tr>
                <td colSpan={fields.length + 1} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Sin registros.
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
          <TabsTrigger value="reglas">Reglas</TabsTrigger>
          <TabsTrigger value="impuestos">Retenciones</TabsTrigger>
          <TabsTrigger value="centros">Centros de costo</TabsTrigger>
        </TabsList>

        <TabsContent value="puc">
          {wrap(
            <Section
              table="puc_accounts"
              companyId={companyId}
              order="code"
              defaults={{ nature: "debito" }}
              fields={[
                { key: "code", label: "Código" },
                { key: "name", label: "Nombre", width: "w-72" },
                { key: "nature", label: "Naturaleza" },
              ]}
            />,
          )}
        </TabsContent>

        <TabsContent value="terceros">
          {wrap(
            <Section
              table="providers"
              companyId={companyId}
              order="name"
              fields={[
                { key: "nit", label: "NIT" },
                { key: "name", label: "Razón social", width: "w-72" },
                { key: "city", label: "Ciudad" },
                { key: "default_expense_account", label: "Cuenta gasto" },
                { key: "default_payable_account", label: "Cuenta por pagar" },
              ]}
            />,
          )}
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
          {wrap(
            <Section
              table="tax_rates"
              companyId={companyId}
              order="kind"
              defaults={{ active: true }}
              fields={[
                { key: "kind", label: "Tipo" },
                { key: "name", label: "Nombre", width: "w-60" },
                { key: "rate", label: "Tarifa %", type: "number", width: "w-28" },
                { key: "min_base", label: "Base mínima", type: "number" },
                { key: "account_code", label: "Cuenta" },
              ]}
            />,
          )}
        </TabsContent>

        <TabsContent value="centros">
          {wrap(
            <Section
              table="cost_centers"
              companyId={companyId}
              order="code"
              fields={[
                { key: "code", label: "Código" },
                { key: "name", label: "Nombre", width: "w-72" },
              ]}
            />,
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
