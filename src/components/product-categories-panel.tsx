import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Plus, Trash2, Upload } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { downloadSheet, pick, readSheet } from "@/lib/spreadsheet";
import { AccountCombobox } from "@/components/account-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const CATEGORY_KINDS = ["producto", "servicio", "gasto", "activo"] as const;

function normKind(value: string) {
  const v = (value ?? "").toLowerCase();
  if (v.startsWith("serv")) return "servicio";
  if (v.startsWith("act") || v.includes("fijo")) return "activo";
  if (v.startsWith("gas")) return "gasto";
  return "producto";
}

type CategoryPatch = { kind?: string; account_code?: string | null; account_name?: string | null };

export function ProductCategoriesPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "producto", account_code: "", account_name: "" });

  const { data: rows } = useQuery({
    queryKey: ["product_categories", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("*")
        .eq("company_id", companyId)
        .order("kind")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: cuentas } = useQuery({
    queryKey: ["puc_accounts", companyId, "categorias"],
    queryFn: async () => {
      const { data } = await supabase.from("puc_accounts").select("code, name").eq("company_id", companyId).order("code");
      return (data ?? []) as { code: string; name: string }[];
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["product_categories"] });

  async function importar(file: File) {
    setBusy(true);
    try {
      const sheet = await readSheet(file);
      const parsed = sheet
        .map((r) => ({
          company_id: companyId,
          name: pick(r, "categoria", "categoría", "grupo", "linea", "nombre", "category"),
          kind: normKind(pick(r, "tipo", "clase", "type")),
          account_code: pick(r, "cuenta", "cuenta contable", "codigo cuenta", "puc", "account").replace(/\s+/g, "") || null,
          account_name: pick(r, "nombre cuenta", "nombre de la cuenta", "account name") || null,
          active: true,
          source: "excel",
        }))
        .filter((r) => r.name);
      if (parsed.length === 0)
        throw new Error("No se encontraron categorías (columnas esperadas: Categoría, Tipo, Cuenta).");
      const unicos = Array.from(new Map(parsed.map((r) => [`${r.kind}|${r.name.toLowerCase()}`, r])).values()).map((r) => ({
        ...r,
        account_name: r.account_name ?? (cuentas ?? []).find((c) => c.code === r.account_code)?.name ?? null,
      }));
      if (!window.confirm(`Se reemplazarán las categorías actuales por ${unicos.length} del archivo. ¿Continuar?`)) return;
      const { error: delErr } = await supabase.from("product_categories").delete().eq("company_id", companyId);
      if (delErr) throw new Error(`No fue posible reemplazar las categorías actuales: ${delErr.message}`);
      for (let i = 0; i < unicos.length; i += 500) {
        const { error } = await supabase
          .from("product_categories")
          .upsert(unicos.slice(i, i + 500), { onConflict: "company_id,kind,name" });
        if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ""}`);
      }
      toast.success(`Categorías cargadas: ${unicos.length}.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible importar el archivo.");
    } finally {
      setBusy(false);
    }
  }

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const { error } = await supabase.from("product_categories").upsert(
      {
        company_id: companyId,
        name: form.name.trim(),
        kind: form.kind,
        account_code: form.account_code || null,
        account_name: form.account_name || null,
        active: true,
        source: "manual",
      },
      { onConflict: "company_id,kind,name" },
    );
    if (error) { toast.error(error.message); return; }
    setForm({ name: "", kind: "producto", account_code: "", account_name: "" });
    toast.success("Categoría guardada.");
    await refresh();
  }

  async function actualizar(id: string, patch: CategoryPatch) {
    const { error } = await supabase.from("product_categories").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  async function eliminar(id: string) {
    const { error } = await supabase.from("product_categories").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  function exportar() {
    downloadSheet(
      (rows ?? []).map((r) => ({
        Categoria: r.name,
        Tipo: r.kind,
        Cuenta: r.account_code ?? "",
        "Nombre cuenta": r.account_name ?? "",
        Origen: r.source,
      })),
      "categorias-producto-servicio.xlsx",
      "Categorias",
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Cada categoría de producto o servicio queda enlazada a una cuenta contable. Si un producto no tiene cuenta propia,
        la causación toma la cuenta de su categoría.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importar(f);
            e.target.value = "";
          }}
        />
        <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" /> Importar categorías
        </Button>
        <Button variant="outline" onClick={exportar}>
          <Download className="size-4" /> Exportar Excel
        </Button>
      </div>

      <form onSubmit={crear} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="w-64 space-y-1.5">
          <Label className="text-xs">Categoría</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="w-40 space-y-1.5">
          <Label className="text-xs">Tipo</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          >
            {CATEGORY_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div className="w-64 space-y-1.5">
          <Label className="text-xs">Cuenta contable</Label>
          <AccountCombobox
            accounts={cuentas ?? []}
            value={form.account_code}
            onChange={(code, name) => setForm({ ...form, account_code: code, account_name: name ?? "" })}
          />
        </div>
        <Button type="submit"><Plus className="size-4" /> Guardar</Button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Categoría</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Cuenta contable</th>
              <th className="px-4 py-2 font-medium">Origen</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(rows ?? []).map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">{r.name}</td>
                <td className="px-4 py-2">
                  <select
                    className="h-8 rounded-md border border-input bg-background px-1 text-xs"
                    value={r.kind}
                    onChange={(e) => void actualizar(r.id, { kind: e.target.value })}
                  >
                    {CATEGORY_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </td>
                <td className="w-64 px-4 py-2">
                  <AccountCombobox
                    accounts={cuentas ?? []}
                    value={r.account_code ?? ""}
                    onChange={(code, name) => void actualizar(r.id, { account_code: code || null, account_name: name })}
                  />
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {r.source === "siigo" ? "Siigo" : r.source === "excel" ? "Excel" : "Manual"}
                </td>
                <td className="px-4 py-2 text-right">
                  <Button variant="ghost" size="icon" onClick={() => void eliminar(r.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {(rows ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Sin categorías registradas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}