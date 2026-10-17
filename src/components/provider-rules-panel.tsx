// Panel editable de "Reglas por proveedor" (Administración).
// Cada regla define la contabilidad automática de un proveedor: cuenta de gasto,
// tratamiento y cuenta del IVA, cuenta del INC, retención (cuenta, tarifa, base)
// y cuenta por pagar. Soporta importación y exportación en Excel.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Plus, Search, Trash2, Upload } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadSheet, num, pick, readSheet } from "@/lib/spreadsheet";
import { clearProviderRulesCache, isValidExpenseAccount, type ProviderRule } from "@/lib/provider-rules";

const TRATAMIENTOS = [
  { value: "descontable", label: "Descontable" },
  { value: "asumido", label: "Asumido" },
  { value: "capitalizado", label: "Capitalizado" },
  { value: "na", label: "N/A" },
] as const;

const BASES = [
  { value: "Subtotal", label: "Subtotal" },
  { value: "AIU", label: "AIU" },
] as const;

type Draft = Partial<ProviderRule> & { company_id: string };

const vacia = (companyId: string): Draft => ({
  company_id: companyId,
  provider_nit: "",
  provider_name: "",
  keyword: "(todas)",
  expense_account: "",
  iva_treatment: "descontable",
  iva_account: "",
  inc_account: "",
  retention_account: "",
  retention_rate: null,
  retention_base: null,
  payable_account: "",
  active: true,
});

export function ProviderRulesPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [buscar, setBuscar] = useState("");
  const [nueva, setNueva] = useState<Draft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: rows } = useQuery({
    queryKey: ["provider_rules", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("provider_rules")
        .select("*")
        .eq("company_id", companyId)
        .order("provider_nit")
        .order("keyword");
      if (error) throw error;
      return (data ?? []) as unknown as ProviderRule[];
    },
  });

  const refresh = async () => {
    clearProviderRulesCache(companyId);
    await qc.invalidateQueries({ queryKey: ["provider_rules", companyId] });
  };

  async function actualizar(id: string, patch: Record<string, unknown>) {
    const { error } = await supabase.from("provider_rules").update(patch as never).eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await refresh();
  }

  async function eliminar(id: string) {
    const { error } = await supabase.from("provider_rules").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Regla eliminada.");
    await refresh();
  }

  async function guardarNueva() {
    if (!nueva) return;
    const nit = (nueva.provider_nit ?? "").trim();
    if (!nit) {
      toast.error("El NIT del proveedor es obligatorio.");
      return;
    }
    const gasto = (nueva.expense_account ?? "").trim();
    if (gasto && !isValidExpenseAccount(gasto)) {
      toast.error("La cuenta de gasto solo puede empezar por 5, 6, 7, 15, 16 o 17.");
      return;
    }
    const { error } = await supabase.from("provider_rules").insert({
      company_id: companyId,
      provider_nit: nit,
      provider_name: (nueva.provider_name ?? "").trim() || null,
      keyword: (nueva.keyword ?? "").trim() || "(todas)",
      expense_account: gasto || null,
      iva_treatment: nueva.iva_treatment ?? "descontable",
      iva_account: (nueva.iva_account ?? "").trim() || null,
      inc_account: (nueva.inc_account ?? "").trim() || null,
      retention_account: (nueva.retention_account ?? "").trim() || null,
      retention_rate: nueva.retention_rate ?? null,
      retention_base: nueva.retention_base ?? null,
      payable_account: (nueva.payable_account ?? "").trim() || null,
      source: "manual",
      active: true,
    } as never);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Regla creada.");
    setNueva(null);
    await refresh();
  }

  function exportar() {
    const datos = (rows ?? []).map((r) => ({
      NIT: r.provider_nit,
      Proveedor: r.provider_name ?? "",
      "Palabra clave": r.keyword,
      "Cta gasto": r.expense_account ?? "",
      "Trat. IVA": r.iva_treatment,
      "Cta IVA": r.iva_account ?? "",
      "Cta INC": r.inc_account ?? "",
      "Cta retención": r.retention_account ?? "",
      "Tarifa %": r.retention_rate ?? "",
      Base: r.retention_base ?? "",
      "Cta CxP": r.payable_account ?? "",
      Activa: r.active ? "Sí" : "No",
    }));
    downloadSheet(datos, "reglas-por-proveedor.xlsx", "Reglas");
  }

  async function importar(file: File) {
    try {
      const filas = await readSheet(file);
      if (filas.length === 0) {
        toast.error("El archivo no tiene filas de datos.");
        return;
      }
      let ok = 0;
      const errores: string[] = [];
      for (const f of filas) {
        const nit = pick(f, "NIT", "Nit proveedor", "Identificación").replace(/\D/g, "");
        if (!nit) continue;
        const gasto = pick(f, "Cta gasto", "Cuenta gasto", "Cuenta de gasto").trim();
        if (gasto && !isValidExpenseAccount(gasto)) {
          errores.push(`NIT ${nit}: cuenta de gasto ${gasto} no válida.`);
          continue;
        }
        const trat = pick(f, "Trat. IVA", "Tratamiento IVA").toLowerCase();
        const tarifa = pick(f, "Tarifa %", "Tarifa");
        const { error } = await supabase.from("provider_rules").upsert(
          {
            company_id: companyId,
            provider_nit: nit,
            provider_name: pick(f, "Proveedor", "Razón social") || null,
            keyword: pick(f, "Palabra clave", "Keyword") || "(todas)",
            expense_account: gasto || null,
            iva_treatment: (["descontable", "asumido", "capitalizado", "na", "n/a"].includes(trat)
              ? trat === "n/a"
                ? "na"
                : trat
              : "descontable") as string,
            iva_account: pick(f, "Cta IVA", "Cuenta IVA") || null,
            inc_account: pick(f, "Cta INC", "Cuenta INC") || null,
            retention_account: pick(f, "Cta retención", "Cuenta retención") || null,
            retention_rate: tarifa ? num(tarifa) : null,
            retention_base: pick(f, "Base") || null,
            payable_account: pick(f, "Cta CxP", "Cuenta por pagar", "CxP") || null,
            source: "importada",
            active: true,
          } as never,
          { onConflict: "company_id,provider_nit,keyword" },
        );
        if (error) errores.push(`NIT ${nit}: ${error.message}`);
        else ok += 1;
      }
      toast.success(`${ok} regla(s) importadas.${errores.length ? ` ${errores.length} con error.` : ""}`);
      if (errores.length) console.warn("[Reglas proveedor] Errores de importación:", errores);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible leer el archivo.");
    }
  }

  const filtradas = (rows ?? []).filter((r) => {
    const q = buscar.trim().toLowerCase();
    if (!q) return true;
    return (
      r.provider_nit.includes(q) ||
      (r.provider_name ?? "").toLowerCase().includes(q) ||
      r.keyword.toLowerCase().includes(q) ||
      (r.expense_account ?? "").includes(q)
    );
  });

  const celdaCuenta = (r: ProviderRule, campo: "expense_account" | "iva_account" | "inc_account" | "retention_account" | "payable_account") => (
    <Input
      className="h-8 w-28 font-mono text-xs"
      defaultValue={r[campo] ?? ""}
      placeholder="—"
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v === (r[campo] ?? "")) return;
        if (campo === "expense_account" && v && !isValidExpenseAccount(v)) {
          toast.error("La cuenta de gasto solo puede empezar por 5, 6, 7, 15, 16 o 17.");
          e.target.value = r[campo] ?? "";
          return;
        }
        void actualizar(r.id, { [campo]: v || null });
      }}
    />
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Reglas contables por proveedor: cuenta de gasto, tratamiento del IVA, INC, retención y cuenta por pagar.
        La palabra clave se busca contenida en la descripción de la línea; <strong>(todas)</strong> aplica a todo el proveedor.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar por NIT, proveedor o cuenta…" className="pl-9" />
        </div>
        <Button variant="outline" size="sm" onClick={() => setNueva(vacia(companyId))}>
          <Plus className="mr-1 size-4" /> Nueva regla
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          <Upload className="mr-1 size-4" /> Importar Excel
        </Button>
        <Button variant="outline" size="sm" onClick={exportar} disabled={(rows ?? []).length === 0}>
          <Download className="mr-1 size-4" /> Exportar Excel
        </Button>
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
        <span className="text-xs text-muted-foreground">
          {filtradas.length} de {(rows ?? []).length} regla(s)
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">NIT</th>
              <th className="px-3 py-2 font-medium">Proveedor</th>
              <th className="px-3 py-2 font-medium">Palabra clave</th>
              <th className="px-3 py-2 font-medium">Cta gasto</th>
              <th className="px-3 py-2 font-medium">Trat. IVA</th>
              <th className="px-3 py-2 font-medium">Cta IVA</th>
              <th className="px-3 py-2 font-medium">Cta INC</th>
              <th className="px-3 py-2 font-medium">Cta retención</th>
              <th className="px-3 py-2 font-medium">Tarifa %</th>
              <th className="px-3 py-2 font-medium">Base</th>
              <th className="px-3 py-2 font-medium">Cta CxP</th>
              <th className="px-3 py-2 font-medium">Activa</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {nueva && (
              <tr className="bg-primary/5">
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-28 font-mono text-xs"
                    value={nueva.provider_nit ?? ""}
                    onChange={(e) => setNueva({ ...nueva, provider_nit: e.target.value })}
                    placeholder="NIT"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-44 text-xs"
                    value={nueva.provider_name ?? ""}
                    onChange={(e) => setNueva({ ...nueva, provider_name: e.target.value })}
                    placeholder="Razón social"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-24 text-xs"
                    value={nueva.keyword ?? ""}
                    onChange={(e) => setNueva({ ...nueva, keyword: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-28 font-mono text-xs"
                    value={nueva.expense_account ?? ""}
                    onChange={(e) => setNueva({ ...nueva, expense_account: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Select
                    value={nueva.iva_treatment ?? "descontable"}
                    onValueChange={(v) => setNueva({ ...nueva, iva_treatment: v as Draft["iva_treatment"] })}
                  >
                    <SelectTrigger className="h-8 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRATAMIENTOS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-28 font-mono text-xs"
                    value={nueva.iva_account ?? ""}
                    onChange={(e) => setNueva({ ...nueva, iva_account: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-28 font-mono text-xs"
                    value={nueva.inc_account ?? ""}
                    onChange={(e) => setNueva({ ...nueva, inc_account: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-28 font-mono text-xs"
                    value={nueva.retention_account ?? ""}
                    onChange={(e) => setNueva({ ...nueva, retention_account: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-16 text-xs"
                    value={nueva.retention_rate ?? ""}
                    onChange={(e) => setNueva({ ...nueva, retention_rate: e.target.value ? Number(e.target.value) : null })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Select
                    value={nueva.retention_base ?? ""}
                    onValueChange={(v) => setNueva({ ...nueva, retention_base: v as Draft["retention_base"] })}
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {BASES.map((b) => (
                        <SelectItem key={b.value} value={b.value}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-28 font-mono text-xs"
                    value={nueva.payable_account ?? ""}
                    onChange={(e) => setNueva({ ...nueva, payable_account: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <Button size="sm" className="h-8" onClick={() => void guardarNueva()}>
                      Guardar
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setNueva(null)}>
                      Cancelar
                    </Button>
                  </div>
                </td>
              </tr>
            )}
            {filtradas.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-mono text-xs">{r.provider_nit}</td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-44 text-xs"
                    defaultValue={r.provider_name ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (r.provider_name ?? "")) void actualizar(r.id, { provider_name: v || null });
                    }}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-24 text-xs"
                    defaultValue={r.keyword}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || "(todas)";
                      if (v !== r.keyword) void actualizar(r.id, { keyword: v });
                    }}
                  />
                </td>
                <td className="px-3 py-2">{celdaCuenta(r, "expense_account")}</td>
                <td className="px-3 py-2">
                  <Select value={r.iva_treatment} onValueChange={(v) => void actualizar(r.id, { iva_treatment: v })}>
                    <SelectTrigger className="h-8 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRATAMIENTOS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-2">{celdaCuenta(r, "iva_account")}</td>
                <td className="px-3 py-2">{celdaCuenta(r, "inc_account")}</td>
                <td className="px-3 py-2">{celdaCuenta(r, "retention_account")}</td>
                <td className="px-3 py-2">
                  <Input
                    className="h-8 w-16 text-xs"
                    defaultValue={r.retention_rate ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== String(r.retention_rate ?? ""))
                        void actualizar(r.id, { retention_rate: v ? Number(v) : null });
                    }}
                  />
                </td>
                <td className="px-3 py-2">
                  <Select
                    value={r.retention_base ?? ""}
                    onValueChange={(v) => void actualizar(r.id, { retention_base: v || null })}
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {BASES.map((b) => (
                        <SelectItem key={b.value} value={b.value}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-2">{celdaCuenta(r, "payable_account")}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`pr-active-${r.id}`}
                      checked={r.active}
                      onCheckedChange={(checked) => void actualizar(r.id, { active: checked })}
                    />
                    <Label htmlFor={`pr-active-${r.id}`} className="sr-only">
                      Activa
                    </Label>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Button variant="ghost" size="sm" className="h-8 text-destructive" onClick={() => void eliminar(r.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {filtradas.length === 0 && !nueva && (
              <tr>
                <td colSpan={13} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {buscar ? "Sin resultados para la búsqueda." : "Sin reglas registradas. Crea una o impórtalas desde Excel."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
