import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Plus, RefreshCw, Trash2, Upload } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { siigoImportProducts } from "@/lib/siigo.functions";
import { normalizeCategoryName } from "@/lib/product-account";
import { downloadSheet, pick, readSheet } from "@/lib/spreadsheet";
import { AccountCombobox } from "@/components/account-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const PRODUCT_KINDS = ["producto", "servicio", "gasto", "activo"] as const;

/** Lee TODAS las filas por páginas de 1.000 (PostgREST limita cada consulta). */
async function leerTodo<T>(
  build: () => ReturnType<ReturnType<typeof supabase.from>["select"]>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let desde = 0; ; desde += PAGE) {
    const { data, error } = await build().range(desde, desde + PAGE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as T[];
    out.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return out;
}

function normKind(value: string) {
  const v = (value ?? "").toLowerCase();
  if (v.startsWith("serv")) return "servicio";
  if (v.startsWith("act") || v.includes("fijo")) return "activo";
  if (v.startsWith("gas")) return "gasto";
  return "producto";
}

export function ProductsPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [form, setForm] = useState({ code: "", name: "", kind: "producto", category: "", account_code: "", account_name: "" });

  const { data: rows } = useQuery({
    queryKey: ["products", companyId],
    queryFn: async () =>
      leerTodo<Tables<"products">>(() =>
        supabase.from("products").select("*").eq("company_id", companyId).order("code") as never,
      ),
  });
  const { data: cuentas } = useQuery({
    queryKey: ["puc_accounts", companyId, "productos"],
    queryFn: async () =>
      leerTodo<{ code: string; name: string }>(() =>
        supabase.from("puc_accounts").select("code, name").eq("company_id", companyId).order("code") as never,
      ),
  });
  const { data: categorias } = useQuery({
    queryKey: ["product_categories", companyId, "productos-panel"],
    queryFn: async () => {
      const { data } = await supabase
        .from("product_categories")
        .select("id, name, kind")
        .eq("company_id", companyId)
        .range(0, 19999);
      return (data ?? []) as { id: string; name: string; kind: string }[];
    },
  });

  const normTxt = (s?: string | null) => normalizeCategoryName(s);

  /** Reparación: vincula productos sin category_id con su categoría por nombre (misma empresa). */
  async function repararVinculos() {
    setBusy("reparar");
    try {
      const { data: cats } = await supabase
        .from("product_categories")
        .select("id, name, kind")
        .eq("company_id", companyId)
        .range(0, 19999);
      const { data: prods } = await supabase
        .from("products")
        .select("id, category, category_id, kind")
        .eq("company_id", companyId)
        .is("category_id", null)
        .range(0, 19999);
      const lista = cats ?? [];
      let corregidos = 0;
      let sinCategoria = 0;
      let ambiguos = 0;
      for (const p of prods ?? []) {
        const clave = normTxt(p.category);
        if (!clave) { sinCategoria++; continue; }
        const iguales = lista.filter((c) => normTxt(c.name) === clave);
        const elegido = iguales.find((c) => normTxt(c.kind) === normTxt(p.kind)) ?? (iguales.length === 1 ? iguales[0] : undefined);
        if (!elegido) {
          if (iguales.length > 1) { ambiguos++; console.warn("[Productos] Categoría ambigua:", p.category); }
          else sinCategoria++;
          continue;
        }
        const { error } = await supabase.from("products").update({ category_id: elegido.id }).eq("id", p.id);
        if (!error) corregidos++;
      }
      toast.success(
        `Productos revisados: ${(prods ?? []).length}. Corregidos: ${corregidos}. Sin categoría encontrada: ${sinCategoria}${ambiguos ? `. Ambiguos: ${ambiguos}` : ""}.`,
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible reparar los vínculos.");
    } finally {
      setBusy(null);
    }
  }

  /** Devuelve el id de la categoría; la crea si no existe para no perder el vínculo. */
  async function categoriaId(name?: string | null, kind = "producto"): Promise<string | null> {
    const nombre = (name ?? "").trim();
    if (!nombre) return null;
    const existente =
      (categorias ?? []).find((c) => normTxt(c.name) === normTxt(nombre) && normTxt(c.kind) === normTxt(kind)) ??
      (categorias ?? []).find((c) => normTxt(c.name) === normTxt(nombre));
    if (existente) return existente.id;
    const { data, error } = await supabase
      .from("product_categories")
      .upsert({ company_id: companyId, name: nombre, kind, active: true, source: "auto" }, { onConflict: "company_id,kind,name" })
      .select("id, name, kind")
      .maybeSingle();
    if (error || !data) return null;
    await qc.invalidateQueries({ queryKey: ["product_categories"] });
    return data.id;
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ["products"] });

  const visibles = useMemo(() => {
    const q = filtro.toLowerCase().trim();
    if (!q) return rows ?? [];
    return (rows ?? []).filter((r) =>
      [r.code, r.name, r.category, r.account_code].some((v) => String(v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, filtro]);

  async function sincronizar() {
    setBusy("siigo");
    try {
      const res = await siigoImportProducts({ data: { companyId } });
      toast.success(
        `Productos consultados: ${res.consultados} · Nuevos: ${res.nuevos} · Actualizados: ${res.actualizados} · Activos: ${res.activos} · Inactivos: ${res.inactivos} · Errores: ${res.errores.length}`,
      );
      if (res.errores.length > 0) toast.error(res.errores[0] ?? "Error al sincronizar productos.");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible sincronizar productos desde Siigo.");
    } finally {
      setBusy(null);
    }
  }

  async function importar(file: File) {
    setBusy("excel");
    try {
      const sheet = await readSheet(file);
      const parsed = sheet
        .map((r) => {
          const account_code = pick(r, "cuenta", "cuenta contable", "codigo cuenta", "puc", "account").replace(/\s+/g, "");
          return {
            company_id: companyId,
            code: pick(r, "codigo", "codigo producto", "code", "referencia").replace(/\s+/g, ""),
            name: pick(r, "nombre", "producto", "servicio", "descripcion", "detalle", "name") || "Sin nombre",
            kind: normKind(pick(r, "tipo", "clase", "type")),
            category: pick(r, "categoria", "grupo", "linea", "category") || null,
            account_code: account_code || null,
            account_name: pick(r, "nombre cuenta", "nombre de la cuenta", "account name") || null,
            active: true,
            source: "excel",
          };
        })
        .filter((r) => r.code);
      if (parsed.length === 0)
        throw new Error("No se encontraron productos (columnas esperadas: Código, Nombre, Tipo, Categoría, Cuenta).");
      const base = Array.from(new Map(parsed.map((r) => [r.code, r])).values()).map((r) => ({
        ...r,
        account_name: r.account_name ?? (cuentas ?? []).find((c) => c.code === r.account_code)?.name ?? null,
      }));
      // Se resuelve (o crea) la categoría para guardar el vínculo por identificador, no solo el nombre.
      const mapaCat = new Map<string, string | null>();
      for (const r of base) {
        const clave = `${normTxt(r.category)}|${normTxt(r.kind)}`;
        if (!r.category || mapaCat.has(clave)) continue;
        mapaCat.set(clave, await categoriaId(r.category, r.kind));
      }
      const unicos = base.map((r) => ({
        ...r,
        category_id: r.category ? (mapaCat.get(`${normTxt(r.category)}|${normTxt(r.kind)}`) ?? null) : null,
      }));
      if (!window.confirm(`Se reemplazará el catálogo actual por ${unicos.length} producto(s)/servicio(s) del archivo. ¿Continuar?`)) return;
      const { error: delErr } = await supabase.from("products").delete().eq("company_id", companyId);
      if (delErr) throw new Error(`No fue posible reemplazar el catálogo actual: ${delErr.message}`);
      // Lotes de MÁXIMO 500: se continúa automáticamente hasta procesar TODOS los registros.
      const LOTE = 500;
      const totalLotes = Math.ceil(unicos.length / LOTE);
      let procesados = 0;
      for (let i = 0; i < totalLotes; i++) {
        const lote = unicos.slice(i * LOTE, (i + 1) * LOTE);
        setProgreso(`Importando lote ${i + 1} de ${totalLotes} (${procesados + 1}–${procesados + lote.length} de ${unicos.length})…`);
        const { error } = await supabase.from("products").upsert(lote, { onConflict: "company_id,code" });
        if (error)
          throw new Error(
            `Lote ${i + 1} de ${totalLotes} (registros ${procesados + 1}–${procesados + lote.length}): ${error.message}${error.details ? ` — ${error.details}` : ""}`,
          );
        procesados += lote.length;
      }
      setProgreso("Verificando registros guardados…");
      const { count } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId);
      if ((count ?? 0) < unicos.length) {
        toast.warning(
          `Se procesaron ${procesados} de ${unicos.length} registros en ${totalLotes} lote(s), pero la base tiene ${count ?? 0}. Revise el archivo por códigos repetidos.`,
        );
      } else {
        toast.success(
          `Importación completada: ${procesados} de ${unicos.length} registros en ${totalLotes} lote(s) de máximo ${LOTE}. Guardados en la base: ${count ?? 0}.`,
        );
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible importar el archivo.");
    } finally {
      setBusy(null);
      setProgreso(null);
    }
  }

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code) return;
    const category_id = await categoriaId(form.category, form.kind);
    const { error } = await supabase.from("products").upsert(
      {
        company_id: companyId,
        code: form.code.trim(),
        name: form.name || "Sin nombre",
        kind: form.kind,
        category: form.category || null,
        category_id,
        account_code: form.account_code || null,
        account_name: form.account_name || null,
        active: true,
        source: "manual",
      },
      { onConflict: "company_id,code" },
    );
    if (error) { toast.error(error.message); return; }
    setForm({ code: "", name: "", kind: "producto", category: "", account_code: "", account_name: "" });
    toast.success("Producto o servicio guardado.");
    await refresh();
  }

  type ProductPatch = {
    kind?: string;
    category?: string | null;
    category_id?: string | null;
    account_code?: string | null;
    account_name?: string | null;
  };

  async function actualizar(id: string, patch: ProductPatch) {
    const { error } = await supabase.from("products").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  async function eliminar(id: string) {
    const { error } = await supabase.from("products").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  function exportar() {
    downloadSheet(
      (rows ?? []).map((r) => ({
        Codigo: r.code,
        Nombre: r.name,
        Tipo: r.kind,
        Categoria: r.category ?? "",
        Cuenta: r.account_code ?? "",
        "Nombre cuenta": r.account_name ?? "",
        Origen: r.source,
      })),
      "productos-servicios.xlsx",
      "Productos",
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={sincronizar} disabled={busy !== null}>
          <RefreshCw className={`size-4 ${busy === "siigo" ? "animate-spin" : ""}`} /> Sincronizar desde Siigo
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
        <Button variant="outline" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" /> Importar producto o servicio
        </Button>
        <Button variant="outline" onClick={exportar}>
          <Download className="size-4" /> Exportar Excel
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => void repararVinculos()}>
          <RefreshCw className={`size-4 ${busy === "reparar" ? "animate-spin" : ""}`} /> Reparar categorías
        </Button>
        <Input className="ml-auto w-64" placeholder="Buscar…" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
      </div>
      {progreso ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{progreso}</p>
      ) : null}

      <form onSubmit={crear} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="w-36 space-y-1.5">
          <Label className="text-xs">Código</Label>
          <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </div>
        <div className="w-64 space-y-1.5">
          <Label className="text-xs">Nombre</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="w-40 space-y-1.5">
          <Label className="text-xs">Tipo</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          >
            {PRODUCT_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div className="w-44 space-y-1.5">
          <Label className="text-xs">Categoría</Label>
          <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
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
              <th className="px-4 py-2 font-medium">Código</th>
              <th className="px-4 py-2 font-medium">Nombre</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Categoría</th>
              <th className="px-4 py-2 font-medium">Cuenta contable</th>
              <th className="px-4 py-2 font-medium">Origen</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibles.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 font-mono text-xs">{r.code}</td>
                <td className="px-4 py-2">{r.name}</td>
                <td className="px-4 py-2">
                  <select
                    className="h-8 rounded-md border border-input bg-background px-1 text-xs"
                    value={r.kind}
                    onChange={(e) => void actualizar(r.id, { kind: e.target.value })}
                  >
                    {PRODUCT_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">
                  <Input
                    className="h-8 w-40"
                    defaultValue={r.category ?? ""}
                    onBlur={(e) => {
                      const valor = e.target.value;
                      if (valor === (r.category ?? "")) return;
                      void (async () => {
                        const category_id = await categoriaId(valor, r.kind);
                        await actualizar(r.id, { category: valor || null, category_id });
                      })();
                    }}
                  />
                </td>
                <td className="px-4 py-2 w-64">
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
            {visibles.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Sin productos o servicios registrados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
