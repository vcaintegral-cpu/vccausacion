import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Plus, RefreshCw, Search, Upload, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  pucRebuildHierarchy,
  siigoImportCostCenters,
  siigoImportProviders,
  siigoImportPuc,
  siigoImportTaxes,
} from "@/lib/siigo.functions";
import { downloadSheet, num, pick, readSheet, readSheetIndexed } from "@/lib/spreadsheet";
import { compareCodes, parsePucSheet, type PucRowError } from "@/lib/puc-import";
import { analyzeHistory, isSiigoAuxiliary, type HistoryAnalysis } from "@/lib/history-import";
import { fetchAllKeys, runReliableImport, sameImportValues, type ImportDetail, type ImportIssue } from "@/lib/import-system";
import { ImportDetailPanel } from "@/components/import-detail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";


type Source = "manual" | "excel" | "siigo";

const fmt = (n: number) => n.toLocaleString("es-CO");

type PucImportSummary = {
  archivo: string;
  encontrados: number;
  validos: number;
  importados: number;
  nuevas: number;
  actualizadas: number;
  duplicados: number;
  errores: PucRowError[];
  fallos: string[];
  totalDb: number;
  primeraExcel: string | null;
  ultimaExcel: string | null;
  primeraDb: string | null;
  ultimaDb: string | null;
  faltantes: string[];
  movimiento: number | null;
  completo: boolean;
  intentados: number;
};

/** Cuenta y lista TODAS las cuentas guardadas de la empresa (COUNT + paginación completa). */
async function verificarPuc(companyId: string) {
  const { count, error: cErr } = await supabase
    .from("puc_accounts")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId);
  if (cErr) throw new Error(cErr.message);
  const all: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("puc_accounts")
      .select("code")
      .eq("company_id", companyId)
      .order("code")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    chunk.forEach((r) => all.push(String(r.code)));
    if (chunk.length < 1000) break;
  }
  const ordenados = [...all].sort(compareCodes);
  return {
    total: count ?? all.length,
    all,
    codes: new Set(all),
    first: ordenados[0] ?? null,
    last: ordenados[ordenados.length - 1] ?? null,
  };
}

function ImportSummary({
  resumen,
  onClose,
  onErrores,
}: {
  resumen: PucImportSummary;
  onClose: () => void;
  onErrores: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide">Resumen de importación</h3>
          <p className="text-xs text-muted-foreground">Archivo: {resumen.archivo}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="size-4" /></Button>
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <p>Registros encontrados: <strong>{fmt(resumen.encontrados)}</strong></p>
        <p>Registros válidos: <strong>{fmt(resumen.validos)}</strong></p>
        <p>Registros importados: <strong>{fmt(resumen.importados)}</strong></p>
        <p>Cuentas nuevas: <strong>{fmt(resumen.nuevas)}</strong></p>
        <p>Cuentas actualizadas: <strong>{fmt(resumen.actualizadas)}</strong></p>
        <p>Duplicados evitados: <strong>{fmt(resumen.duplicados)}</strong></p>
        <p>Registros con error: <strong>{fmt(resumen.errores.length)}</strong></p>
        <p>Total en la base de datos: <strong>{fmt(resumen.totalDb)}</strong></p>
        <p>Cuentas de movimiento: <strong>{resumen.movimiento === null ? "—" : fmt(resumen.movimiento)}</strong></p>
        <p>Primera cuenta (Excel): <strong>{resumen.primeraExcel ?? "-"}</strong></p>
        <p>Última cuenta (Excel): <strong>{resumen.ultimaExcel ?? "-"}</strong></p>
        <p>Última cuenta guardada: <strong>{resumen.ultimaDb ?? "-"}</strong></p>
      </div>
      <p className={`text-sm font-semibold ${resumen.completo ? "text-emerald-600" : "text-destructive"}`}>
        {resumen.completo
          ? "PUC IMPORTADO CORRECTAMENTE."
          : `EL PUC NO SE IMPORTÓ COMPLETAMENTE. Excel: ${fmt(resumen.validos)} · Guardadas: ${fmt(resumen.importados)} · Faltantes: ${fmt(resumen.faltantes.length)}.`}
      </p>
      {resumen.fallos.length > 0 ? (
        <ul className="space-y-1 text-xs text-destructive">
          {resumen.fallos.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      ) : null}
      {resumen.faltantes.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Cuentas faltantes (primeras 20): {resumen.faltantes.slice(0, 20).join(", ")}
        </p>
      ) : null}
      {resumen.errores.length > 0 ? (
        <div className="space-y-2">
          <div className="max-h-40 space-y-1 overflow-auto text-xs text-muted-foreground">
            {resumen.errores.slice(0, 50).map((e, i) => (
              <p key={i}>
                Fila {e.rowNumber}: {e.code ? `Código ${e.code}. ` : ""}{e.problema} {e.accion}
              </p>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={onErrores}>
            <Download className="size-4" /> Descargar reporte de errores
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SourceTag({ source }: { source?: string | null }) {
  const label = source === "siigo" ? "Siigo" : source === "excel" ? "Excel" : "Manual";
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{label}</span>
  );
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function FileButton({ label, onFile, busy }: { label: string; onFile: (file: File) => void; busy?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <Button variant="outline" disabled={busy} onClick={() => ref.current?.click()}>
        <Upload className="size-4" /> {label}
      </Button>
    </>
  );
}

const PAGE = 1000;

/** Lee TODAS las filas de la tabla paginando (PostgREST devuelve máximo 1000 por consulta). */
async function fetchAllRows(
  table: "puc_accounts" | "cost_centers" | "tax_rates",
  companyId: string,
  order: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .eq("company_id", companyId)
      .order(order)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as Record<string, unknown>[];
    out.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return out;
}

function useTable(table: "puc_accounts" | "cost_centers" | "tax_rates", companyId: string, order: string) {
  return useQuery({
    queryKey: [table, companyId, "datos-contables"],
    queryFn: () => fetchAllRows(table, companyId, order),
  });
}

/* ------------------------------ Terceros ------------------------------ */

export function ProvidersToolbar({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["providers"] });

  async function sincronizar() {
    setBusy("siigo");
    try {
      const res = await siigoImportProviders({ data: { companyId } });
      toast.success(`Terceros importados desde Siigo: ${res.imported}.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible sincronizar terceros.");
    } finally {
      setBusy(null);
    }
  }

  async function importar(file: File) {
    setBusy("excel");
    try {
      const sheet = await readSheet(file);
      const parsed = sheet.map((r, index) => ({
          rowNumber: index + 2,
          company_id: companyId,
          nit: pick(r, "nit", "identificacion", "documento", "cedula", "id").replace(/[\s.]/g, ""),
          name: pick(r, "razon social", "nombre", "tercero", "proveedor", "name") || "Sin nombre",
          address: pick(r, "direccion", "address") || null,
          city: pick(r, "ciudad", "city") || null,
          phone: pick(r, "telefono", "celular", "phone") || null,
          email: pick(r, "correo", "email") || null,
          default_expense_account: pick(r, "cuenta gasto", "cuenta", "default_expense_account") || null,
          default_payable_account: pick(r, "cuenta por pagar", "default_payable_account") || null,
        }));
      const invalidIssues: ImportIssue[] = parsed.filter((r) => !r.nit).map((r) => ({ row: r.rowNumber, key: "", message: "NIT vacío; registro rechazado." }));
      const valid = parsed.filter((r) => r.nit);
      if (valid.length === 0) throw new Error("No se encontraron terceros (columnas esperadas: NIT, Razón social).");
      const uniqueMap = new Map(valid.map((r) => [r.nit, r]));
      const unicos = [...uniqueMap.values()];
      const duplicates = valid.length - unicos.length;
      if (!window.confirm(`Se encontraron ${fmt(sheet.length)} terceros en el archivo. Se procesarán ${fmt(unicos.length)} válidos en lotes de 500 sin eliminar información existente. ¿Continuar?`)) return;
      const existing = new Map<string, (typeof unicos)[number]>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from("providers").select("*").eq("company_id", companyId).order("nit").range(from, from + PAGE - 1);
        if (error) throw error;
        (data ?? []).forEach((row) => existing.set(row.nit, { ...row, rowNumber: 0 } as (typeof unicos)[number]));
        if ((data ?? []).length < PAGE) break;
      }
      const { data: auth } = await supabase.auth.getUser();
      const result = await runReliableImport({
        module: "Terceros", fileName: file.name, user: auth.user?.email ?? null, found: sheet.length, rows: unicos,
        invalidIssues, duplicateCount: duplicates, keyOf: (row) => row.nit, rowNumberOf: (row) => row.rowNumber,
        existingByKey: existing,
        equals: sameImportValues(["name", "address", "city", "phone", "email", "default_expense_account", "default_payable_account"]),
        saveBatch: async (rows) => {
          const payload = rows.map(({ rowNumber: _rowNumber, ...row }) => row);
          const { error } = await supabase.from("providers").upsert(payload, { onConflict: "company_id,nit", ignoreDuplicates: false });
          return { error };
        },
        verifyKeys: () => fetchAllKeys(async (from, to) => {
          const { data, error } = await supabase.from("providers").select("nit").eq("company_id", companyId).order("nit").range(from, to);
          if (error) return { keys: [], error: error.message };
          return { keys: (data ?? []).map((row) => row.nit) };
        }),
        onProgress: (p) => setProgreso(`Importando terceros… Lote ${p.batch} de ${p.batches} · Registros ${fmt(p.from)} - ${fmt(p.to)} de ${fmt(p.total)}`),
      });
      setDetail(result);
      if (result.status === "COMPLETADA") toast.success("IMPORTACIÓN COMPLETADA");
      else if (result.status === "COMPLETADA CON ERRORES") toast.warning("Importación completada con errores. Revisa el detalle.");
      else toast.error(`Importación incompleta: se encontraron ${fmt(result.found)} registros y se verificaron ${fmt(result.saved)}.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible importar el archivo.");
    } finally {
      setBusy(null);
      setProgreso(null);
    }
  }

  async function exportar() {
    const { data, error } = await supabase.from("providers").select("*").eq("company_id", companyId).order("name");
    if (error) { toast.error(error.message); return; }
    downloadSheet(
      (data ?? []).map((r) => ({
        NIT: String(r.nit ?? ""),
        "Razon social": String(r.name ?? ""),
        Ciudad: String(r.city ?? ""),
        Direccion: String(r.address ?? ""),
        Telefono: String(r.phone ?? ""),
        Correo: String(r.email ?? ""),
        "Cuenta gasto": String(r.default_expense_account ?? ""),
        "Cuenta por pagar": String(r.default_payable_account ?? ""),
      })),
      "terceros.xlsx",
      "Terceros",
    );
  }

  return (
    <div className="space-y-3">
    <Toolbar>
      <Button onClick={sincronizar} disabled={busy !== null}>
        <RefreshCw className={`size-4 ${busy === "siigo" ? "animate-spin" : ""}`} /> Sincronizar desde Siigo
      </Button>
      <FileButton label="Importar Excel" onFile={importar} busy={busy !== null} />
      <Button variant="outline" onClick={exportar} disabled={busy !== null}>
        <Download className="size-4" /> Exportar Excel
      </Button>
    </Toolbar>
    {progreso ? <p className="rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">{progreso}</p> : null}
    <ImportDetailPanel detail={detail} />
    </div>
  );
}

/* ------------------------------- PUC ------------------------------- */

export function PucPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { data: rows } = useTable("puc_accounts", companyId, "code");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "", nature: "debito" });
  const [edit, setEdit] = useState<Record<string, { code: string; name: string; nature: string }>>({});
  const [resumen, setResumen] = useState<PucImportSummary | null>(null);
  const [progreso, setProgreso] = useState<string | null>(null);
  const [buscar, setBuscar] = useState("");
  const [pagina, setPagina] = useState(1);
  const porPagina = 100;

  const refresh = () => qc.invalidateQueries({ queryKey: ["puc_accounts"] });

  // Total real en la base de datos (COUNT), independiente de lo que se muestre en pantalla.
  const { data: totalDb } = useQuery({
    queryKey: ["puc_accounts", companyId, "count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("puc_accounts")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const filtradas = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    const all = (rows ?? []) as Record<string, unknown>[];
    if (!q) return all;
    return all.filter(
      (r) =>
        String(r['code'] ?? "").toLowerCase().includes(q) || String(r['name'] ?? "").toLowerCase().includes(q),
    );
  }, [rows, buscar]);
  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / porPagina));
  const paginaActual = Math.min(pagina, totalPaginas);
  const visibles = filtradas.slice((paginaActual - 1) * porPagina, paginaActual * porPagina);
  const codigosDb = useMemo(
    () => (rows ?? []).map((r) => String(r['code'] ?? "")).sort(compareCodes),
    [rows],
  );

  async function sincronizar() {
    setBusy("siigo");
    try {
      const res = await siigoImportPuc({ data: { companyId } });
      toast.success(`Se importaron ${res.imported} cuenta(s) desde Siigo.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible sincronizar con Siigo.");
    } finally {
      setBusy(null);
    }
  }

  async function importar(file: File) {
    setBusy("excel");
    setResumen(null);
    try {
      const sheet = await readSheetIndexed(file);
      const parsed = parsePucSheet(sheet, companyId);
      if (parsed.valid.length === 0)
        throw new Error(
          `No se encontraron cuentas válidas en el archivo (filas leídas: ${parsed.rowsRead}; columnas detectadas: ${parsed.columns.join(", ") || "ninguna"}).`,
        );

      const ok = window.confirm(
        `Registros encontrados en el Excel: ${fmt(parsed.rowsRead)}\n` +
          `Registros válidos para importar: ${fmt(parsed.valid.length)}\n` +
          `Registros con errores: ${fmt(parsed.errors.length)}\n` +
          `Primera cuenta: ${parsed.firstCode ?? "-"} · Última cuenta: ${parsed.lastCode ?? "-"}\n\n` +
          `Columnas detectadas: ${parsed.columns.join(", ")}\n\n` +
          `Las cuentas existentes se actualizarán cuando corresponda y las demás se conservarán. ¿Continuar?`,
      );
      if (!ok) return;

      // Cuentas ya existentes: para diferenciar nuevas de actualizadas.
      const existentes = new Set<string>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("puc_accounts")
          .select("code")
          .eq("company_id", companyId)
          .order("code")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`No fue posible leer el PUC actual: ${error.message}`);
        (data ?? []).forEach((r) => existentes.add(String(r.code)));
        if ((data ?? []).length < PAGE) break;
      }
      const nuevas = parsed.valid.filter((r) => !existentes.has(r.code)).length;
      const actualizadas = parsed.valid.length - nuevas;

      // Importación por lotes: espera cada lote y reporta el que falle.
      const LOTE = 500;
      const totalLotes = Math.ceil(parsed.valid.length / LOTE);
      const fallos: string[] = [];
      let guardadosIntento = 0;
      for (let i = 0; i < totalLotes; i++) {
        const lote = parsed.valid.slice(i * LOTE, (i + 1) * LOTE);
        setProgreso(`Importando lote ${i + 1} de ${totalLotes}…`);
        const { error } = await supabase
          .from("puc_accounts")
          .upsert(lote, { onConflict: "company_id,code", ignoreDuplicates: false });
        if (error) {
          fallos.push(
            `Lote ${i + 1} de ${totalLotes} presentó un error: ${error.message}` +
              (error.details ? ` — ${error.details}` : "") +
              (error.hint ? ` (${error.hint})` : ""),
          );
        } else {
          guardadosIntento += lote.length;
        }
      }

      // Validación posterior obligatoria: contar en la base de datos.
      setProgreso("Verificando cuentas guardadas…");
      const verif = await verificarPuc(companyId);

      // Reconstruye la jerarquía con TODAS las cuentas ya cargadas.
      setProgreso("Construyendo jerarquía de cuentas…");
      let movimiento: number | null = null;
      try {
        const jer = await pucRebuildHierarchy({ data: { companyId } });
        movimiento = jer.movimiento;
      } catch (e) {
        fallos.push(e instanceof Error ? e.message : "No fue posible construir la jerarquía.");
      }

      const guardadasDelArchivo = parsed.valid.filter((r) => verif.codes.has(r.code)).length;
      const faltantes = parsed.valid.filter((r) => !verif.codes.has(r.code)).map((r) => r.code);
      const completo = faltantes.length === 0;

      setResumen({
        archivo: file.name,
        encontrados: parsed.rowsRead,
        validos: parsed.valid.length,
        importados: guardadasDelArchivo,
        nuevas,
        actualizadas,
        duplicados: parsed.duplicates,
        errores: parsed.errors,
        fallos,
        totalDb: verif.total,
        primeraExcel: parsed.firstCode,
        ultimaExcel: parsed.lastCode,
        primeraDb: verif.first,
        ultimaDb: verif.last,
        faltantes,
        movimiento,
        completo,
        intentados: guardadosIntento,
      });

      if (completo) toast.success("PUC importado correctamente.");
      else toast.error("El PUC no se importó completamente. Revisa el resumen de importación.");

      await refresh();
      await qc.invalidateQueries({ queryKey: ["puc_accounts", companyId, "count"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible importar el archivo.");
    } finally {
      setProgreso(null);
      setBusy(null);
    }
  }

  async function verificarIntegridad() {
    setBusy("verificar");
    try {
      const verif = await verificarPuc(companyId);
      const duplicados = verif.all.length - verif.codes.size;
      toast.message("Integridad del PUC", {
        description: `Total en la base de datos: ${fmt(verif.total)} · Cuentas únicas: ${fmt(verif.codes.size)} · Duplicadas: ${fmt(duplicados)} · Primera: ${verif.first ?? "-"} · Última: ${verif.last ?? "-"}`,
      });
      setResumen((prev) => (prev ? { ...prev, totalDb: verif.total, primeraDb: verif.first, ultimaDb: verif.last } : prev));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible verificar el PUC.");
    } finally {
      setBusy(null);
    }
  }

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code) return;
    const { error } = await supabase.from("puc_accounts").upsert(
      { company_id: companyId, code: form.code.trim(), name: form.name || "Sin nombre", nature: form.nature, active: true, source: "manual" },
      { onConflict: "company_id,code" },
    );
    if (error) { toast.error(error.message); return; }
    setForm({ code: "", name: "", nature: "debito" });
    toast.success("Cuenta creada.");
    await refresh();
  }

  async function guardar(id: string) {
    const values = edit[id];
    if (!values) return;
    const { error } = await supabase
      .from("puc_accounts")
      .update({ code: values.code, name: values.name, nature: values.nature, source: "manual" })
      .eq("id", id);
    if (error) { toast.error(error.message); return; }
    setEdit((prev) => { const next = { ...prev }; delete next[id]; return next; });
    toast.success("Cuenta actualizada.");
    await refresh();
  }

  async function alternar(id: string, active: boolean) {
    const { error } = await supabase.from("puc_accounts").update({ active }).eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  function exportar() {
    downloadSheet(
      (rows ?? []).map((r) => ({
        Codigo: String(r['code'] ?? ""),
        Nombre: String(r['name'] ?? ""),
        Naturaleza: String(r['nature'] ?? ""),
        Activa: r['active'] === false ? "No" : "Si",
        Origen: String(r['source'] ?? "manual"),
      })),
      "puc.xlsx",
      "PUC",
    );
  }

  function descargarErrores() {
    if (!resumen) return;
    downloadSheet(
      resumen.errores.map((e) => ({
        Fila: e.rowNumber,
        Codigo: e.code,
        Problema: e.problema,
        Accion: e.accion,
      })),
      "errores-puc.xlsx",
      "Errores",
    );
  }

  return (
    <div className="space-y-4">
      <Toolbar>
        <Button onClick={sincronizar} disabled={busy !== null}>
          <RefreshCw className={`size-4 ${busy === "siigo" ? "animate-spin" : ""}`} /> Sincronizar desde Siigo
        </Button>
        <FileButton label="Importar Excel" onFile={importar} busy={busy !== null} />
        <Button variant="outline" onClick={verificarIntegridad} disabled={busy !== null}>
          <Search className="size-4" /> Verificar integridad del PUC
        </Button>
        <Button variant="outline" onClick={exportar}>
          <Download className="size-4" /> Exportar Excel
        </Button>
        <span className="ml-auto rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          Total de cuentas de esta empresa: <strong className="text-foreground">{fmt(totalDb ?? 0)}</strong>
          {codigosDb.length > 0 ? ` · Última: ${codigosDb[codigosDb.length - 1]}` : ""}
        </span>
      </Toolbar>

      {progreso ? (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">{progreso}</p>
      ) : null}

      {resumen ? <ImportSummary resumen={resumen} onClose={() => setResumen(null)} onErrores={descargarErrores} /> : null}

      <form onSubmit={crear} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="w-40 space-y-1.5">
          <Label className="text-xs">Código</Label>
          <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </div>
        <div className="w-72 space-y-1.5">
          <Label className="text-xs">Nombre</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="w-40 space-y-1.5">
          <Label className="text-xs">Naturaleza</Label>
          <Input value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} />
        </div>
        <Button type="submit"><Plus className="size-4" /> Crear cuenta</Button>
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={buscar}
          onChange={(e) => { setBuscar(e.target.value); setPagina(1); }}
          placeholder="Buscar por código o nombre…"
          className="w-72"
        />
        <span className="text-xs text-muted-foreground">
          Mostrando {fmt(visibles.length)} de {fmt(filtradas.length)} cuenta(s) · Página {paginaActual} de {totalPaginas}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={paginaActual <= 1} onClick={() => setPagina(paginaActual - 1)}>
            Anterior
          </Button>
          <Button variant="outline" size="sm" disabled={paginaActual >= totalPaginas} onClick={() => setPagina(paginaActual + 1)}>
            Siguiente
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Código</th>
              <th className="px-4 py-2 font-medium">Nombre</th>
              <th className="px-4 py-2 font-medium">Naturaleza</th>
              <th className="px-4 py-2 font-medium">Origen</th>
              <th className="px-4 py-2 font-medium">Activa</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibles.map((r) => {
              const id = String(r['id']);
              const draft = edit[id];
              return (
                <tr key={id} className={r['active'] === false ? "opacity-60" : ""}>
                  <td className="px-4 py-2">
                    {draft ? <Input value={draft.code} onChange={(e) => setEdit({ ...edit, [id]: { ...draft, code: e.target.value } })} /> : String(r['code'])}
                  </td>
                  <td className="px-4 py-2">
                    {draft ? <Input value={draft.name} onChange={(e) => setEdit({ ...edit, [id]: { ...draft, name: e.target.value } })} /> : String(r['name'])}
                  </td>
                  <td className="px-4 py-2">
                    {draft ? <Input value={draft.nature} onChange={(e) => setEdit({ ...edit, [id]: { ...draft, nature: e.target.value } })} /> : String(r['nature'])}
                  </td>
                  <td className="px-4 py-2"><SourceTag source={r['source'] as string} /></td>
                  <td className="px-4 py-2">
                    <Switch checked={r['active'] !== false} onCheckedChange={(v) => alternar(id, v)} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    {draft ? (
                      <Button size="sm" onClick={() => guardar(id)}>Guardar</Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEdit({ ...edit, [id]: { code: String(r['code']), name: String(r['name']), nature: String(r['nature']) } })}
                      >
                        Editar
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visibles.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">Sin cuentas registradas.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------- Centros de costo --------------------------- */

export function CostCentersPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { data: rows } = useTable("cost_centers", companyId, "code");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "" });
  const [progreso, setProgreso] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["cost_centers"] });

  async function sincronizar() {
    setBusy("siigo");
    try {
      const res = await siigoImportCostCenters({ data: { companyId } });
      toast.success(`Centros importados: ${res.imported}. Conservados por prioridad manual: ${res.skipped}.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible sincronizar centros de costo.");
    } finally {
      setBusy(null);
    }
  }

  async function importar(file: File) {
    setBusy("excel");
    try {
      const sheet = await readSheet(file);
      const parsed = sheet.map((r, index) => ({
          rowNumber: index + 2,
          company_id: companyId,
          code: pick(r, "codigo", "centro de costo", "code").replace(/\s+/g, ""),
          name: pick(r, "nombre", "descripcion", "name") || "Sin nombre",
          source: "excel" satisfies Source,
        }));
      const invalidIssues: ImportIssue[] = parsed.filter((r) => !r.code).map((r) => ({ row: r.rowNumber, key: "", message: "Código vacío; registro rechazado." }));
      const valid = parsed.filter((r) => r.code);
      if (valid.length === 0) throw new Error("No se encontraron centros de costo (columnas esperadas: Código, Nombre).");
      const unicos = Array.from(new Map(valid.map((r) => [r.code, r])).values());
      if (!window.confirm(`Se encontraron ${fmt(sheet.length)} centros de costo. Se procesarán todos en lotes de 500 sin eliminar información existente. ¿Continuar?`)) return;
      const existing = new Map((rows ?? []).map((row) => [String(row['code']), { ...row, rowNumber: 0 }]));
      const { data: auth } = await supabase.auth.getUser();
      const result = await runReliableImport({
        module: "Centros de costo", fileName: file.name, user: auth.user?.email ?? null, found: sheet.length,
        rows: unicos, invalidIssues, duplicateCount: valid.length - unicos.length, keyOf: (row) => row.code,
        rowNumberOf: (row) => row.rowNumber, existingByKey: existing,
        saveBatch: async (batch) => {
          const payload = batch.map(({ rowNumber: _rowNumber, ...row }) => row);
          const { error } = await supabase.from("cost_centers").upsert(payload, { onConflict: "company_id,code", ignoreDuplicates: false });
          return { error };
        },
        verifyKeys: () => fetchAllKeys(async (from, to) => {
          const { data, error } = await supabase.from("cost_centers").select("code").eq("company_id", companyId).order("code").range(from, to);
          if (error) return { keys: [], error: error.message };
          return { keys: (data ?? []).map((row) => row.code) };
        }),
        onProgress: (p) => setProgreso(`Importando centros de costo… Lote ${p.batch} de ${p.batches} · Registros ${p.from}–${p.to} de ${p.total}`),
      });
      setDetail(result);
      if (result.status === "COMPLETADA") toast.success("IMPORTACIÓN COMPLETADA");
      else if (result.status === "COMPLETADA CON ERRORES") toast.warning("Importación completada con errores. Revisa el detalle.");
      else toast.error("La importación quedó incompleta. Revisa el detalle.");
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
    const { error } = await supabase
      .from("cost_centers")
      .upsert({ company_id: companyId, code: form.code.trim(), name: form.name || "Sin nombre", source: "manual" }, { onConflict: "company_id,code" });
    if (error) { toast.error(error.message); return; }
    setForm({ code: "", name: "" });
    toast.success("Centro de costo creado.");
    await refresh();
  }

  return (
    <div className="space-y-4">
      <Toolbar>
        <Button onClick={sincronizar} disabled={busy !== null}>
          <RefreshCw className={`size-4 ${busy === "siigo" ? "animate-spin" : ""}`} /> Sincronizar desde Siigo
        </Button>
        <FileButton label="Importar Excel" onFile={importar} busy={busy !== null} />
      </Toolbar>
      {progreso ? <p className="rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">{progreso}</p> : null}
      <ImportDetailPanel detail={detail} />

      <form onSubmit={crear} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="w-40 space-y-1.5">
          <Label className="text-xs">Código</Label>
          <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </div>
        <div className="w-72 space-y-1.5">
          <Label className="text-xs">Nombre</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <Button type="submit"><Plus className="size-4" /> Crear</Button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-4 py-2 font-medium">Código</th><th className="px-4 py-2 font-medium">Nombre</th><th className="px-4 py-2 font-medium">Origen</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(rows ?? []).map((r) => (
              <tr key={String(r['id'])}>
                <td className="px-4 py-2">{String(r['code'])}</td>
                <td className="px-4 py-2">{String(r['name'])}</td>
                <td className="px-4 py-2"><SourceTag source={r['source'] as string} /></td>
              </tr>
            ))}
            {(rows ?? []).length === 0 && (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-sm text-muted-foreground">Sin centros de costo.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------ Impuestos ------------------------------ */

export function TaxesPanel({ companyId }: { companyId: string }) {
  return <TaxesPanelInner companyId={companyId} />;
}

/** Celda editable: al hacer clic permite escribir o elegir la cuenta del PUC. */
function AccountCell({
  value,
  options,
  onSave,
}: {
  value: string;
  options: { code: string; name: string }[];
  onSave: (code: string) => void | Promise<void>;
}) {
  const [editando, setEditando] = useState(false);
  const [draft, setDraft] = useState(value);
  const listId = `puc-${Math.abs(hashCode(value + options.length))}`;

  if (!editando) {
    const cuenta = options.find((o) => o.code === value);
    return (
      <button
        type="button"
        className="rounded px-2 py-1 text-left underline-offset-2 hover:bg-muted hover:underline"
        onClick={() => { setDraft(value); setEditando(true); }}
        title="Clic para asignar la cuenta contable"
      >
        {value ? `${value}${cuenta ? ` · ${cuenta.name}` : ""}` : "Asignar cuenta"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        list={listId}
        className="w-56"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { void onSave(draft); setEditando(false); }
          if (e.key === "Escape") setEditando(false);
        }}
        onBlur={() => { void onSave(draft); setEditando(false); }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.code} value={o.code}>{o.name}</option>
        ))}
      </datalist>
    </div>
  );
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function TaxesPanelInner({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { data: rows } = useTable("tax_rates", companyId, "kind");
  const { data: cuentas } = useTable("puc_accounts", companyId, "code");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ kind: "iva", name: "", rate: "", min_base: "", account_code: "" });
  const [progreso, setProgreso] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["tax_rates"] });

  async function guardarCuenta(id: string, code: string) {
    const { error } = await supabase
      .from("tax_rates")
      .update({ account_code: code.trim() || null })
      .eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Cuenta contable actualizada.");
    await refresh();
  }

  async function sincronizar() {
    setBusy("siigo");
    try {
      const res = await siigoImportTaxes({ data: { companyId } });
      toast.success(`Impuestos importados: ${res.imported}. Conservados por prioridad manual: ${res.skipped}.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible sincronizar impuestos.");
    } finally {
      setBusy(null);
    }
  }

  async function importar(file: File) {
    setBusy("excel");
    try {
      const sheet = await readSheet(file);
      const parsed = sheet.map((r, index) => ({
          rowNumber: index + 2,
          company_id: companyId,
          kind: (pick(r, "tipo", "clase", "kind") || "iva").toLowerCase(),
          name: pick(r, "nombre", "impuesto", "name"),
          rate: num(pick(r, "tarifa", "porcentaje", "rate", "%")),
          min_base: num(pick(r, "base minima", "base", "min base")),
          account_code: pick(r, "cuenta", "codigo cuenta", "account") || null,
          active: true,
          source: "excel" satisfies Source,
        }));
      const invalidIssues: ImportIssue[] = parsed.filter((r) => !r.name).map((r) => ({ row: r.rowNumber, key: "", message: "Nombre vacío; registro rechazado." }));
      const valid = parsed.filter((r) => r.name);
      if (valid.length === 0) throw new Error("No se encontraron impuestos (columnas esperadas: Tipo, Nombre, Tarifa).");
      const unicos = Array.from(new Map(valid.map((r) => [`${r.kind}|${r.name}`, r])).values());
      if (!window.confirm(`Se encontraron ${fmt(sheet.length)} impuestos o retenciones. Se procesarán todos en lotes de 500 sin eliminar información existente. ¿Continuar?`)) return;
      const existing = new Map((rows ?? []).map((row) => [`${String(row['kind'])}|${String(row['name'])}`, { ...row, rowNumber: 0 }]));
      const { data: auth } = await supabase.auth.getUser();
      const result = await runReliableImport({
        module: "Retenciones", fileName: file.name, user: auth.user?.email ?? null, found: sheet.length,
        rows: unicos, invalidIssues, duplicateCount: valid.length - unicos.length,
        keyOf: (row) => `${row.kind}|${row.name}`, rowNumberOf: (row) => row.rowNumber, existingByKey: existing,
        saveBatch: async (batch) => {
          const payload = batch.map(({ rowNumber: _rowNumber, ...row }) => row);
          const { error } = await supabase.from("tax_rates").upsert(payload, { onConflict: "company_id,kind,name", ignoreDuplicates: false });
          return { error };
        },
        verifyKeys: () => fetchAllKeys(async (from, to) => {
          const { data, error } = await supabase.from("tax_rates").select("kind,name").eq("company_id", companyId).order("kind").order("name").range(from, to);
          if (error) return { keys: [], error: error.message };
          return { keys: (data ?? []).map((row) => `${row.kind}|${row.name}`) };
        }),
        onProgress: (p) => setProgreso(`Importando retenciones… Lote ${p.batch} de ${p.batches} · Registros ${p.from}–${p.to} de ${p.total}`),
      });
      setDetail(result);
      if (result.status === "COMPLETADA") toast.success("IMPORTACIÓN COMPLETADA");
      else if (result.status === "COMPLETADA CON ERRORES") toast.warning("Importación completada con errores. Revisa el detalle.");
      else toast.error("La importación quedó incompleta. Revisa el detalle.");
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
    if (!form.name) return;
    const { error } = await supabase.from("tax_rates").upsert(
      {
        company_id: companyId,
        kind: form.kind || "iva",
        name: form.name,
        rate: Number(form.rate || 0),
        min_base: Number(form.min_base || 0),
        account_code: form.account_code || null,
        active: true,
        source: "manual",
      },
      { onConflict: "company_id,kind,name" },
    );
    if (error) { toast.error(error.message); return; }
    setForm({ kind: "iva", name: "", rate: "", min_base: "", account_code: "" });
    toast.success("Impuesto creado.");
    await refresh();
  }

  return (
    <div className="space-y-4">
      <Toolbar>
        <Button onClick={sincronizar} disabled={busy !== null}>
          <RefreshCw className={`size-4 ${busy === "siigo" ? "animate-spin" : ""}`} /> Sincronizar desde Siigo
        </Button>
        <FileButton label="Importar Excel" onFile={importar} busy={busy !== null} />
      </Toolbar>
      {progreso ? <p className="rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">{progreso}</p> : null}
      <ImportDetailPanel detail={detail} />

      <form onSubmit={crear} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="w-32 space-y-1.5"><Label className="text-xs">Tipo</Label><Input value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} /></div>
        <div className="w-60 space-y-1.5"><Label className="text-xs">Nombre</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="w-28 space-y-1.5"><Label className="text-xs">Tarifa %</Label><Input type="number" step="any" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></div>
        <div className="w-36 space-y-1.5"><Label className="text-xs">Base mínima</Label><Input type="number" step="any" value={form.min_base} onChange={(e) => setForm({ ...form, min_base: e.target.value })} /></div>
        <div className="w-40 space-y-1.5"><Label className="text-xs">Cuenta</Label><Input value={form.account_code} onChange={(e) => setForm({ ...form, account_code: e.target.value })} /></div>
        <Button type="submit"><Plus className="size-4" /> Crear</Button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Tipo</th><th className="px-4 py-2 font-medium">Nombre</th>
              <th className="px-4 py-2 font-medium">Tarifa</th><th className="px-4 py-2 font-medium">Cuenta</th>
              <th className="px-4 py-2 font-medium">Origen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(rows ?? []).map((r) => (
              <tr key={String(r['id'])}>
                <td className="px-4 py-2">{String(r['kind'])}</td>
                <td className="px-4 py-2">{String(r['name'])}</td>
                <td className="px-4 py-2">{String(r['rate'])}%</td>
                <td className="px-4 py-2">
                  <AccountCell
                    value={(r['account_code'] as string | null) ?? ""}
                    options={(cuentas ?? []) as { code: string; name: string }[]}
                    onSave={(code: string) => guardarCuenta(String(r['id']), code)}
                  />
                </td>
                <td className="px-4 py-2"><SourceTag source={r['source'] as string} /></td>
              </tr>
            ))}
            {(rows ?? []).length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">Sin impuestos.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------- Historial contable --------------------------- */

export function HistoryPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<HistoryAnalysis | null>(null);
  const [progreso, setProgreso] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);

  const { data: learned } = useQuery({
    queryKey: ["learning_rules", companyId, "excel"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("learning_rules")
        .select("*")
        .eq("company_id", companyId)
        .eq("source", "excel")
        .order("times_used", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
  });

  async function importar(file: File) {
    setBusy(true);
    try {
      const sheet = await readSheet(file);
      if (!isSiigoAuxiliary(sheet)) {
        const keys = Object.keys(sheet[0] ?? {});
        const generico = ["cuenta", "codigo cuenta", "cuenta contable", "nit", "identificacion"].some((k) =>
          keys.some((x) => x.includes(k)),
        );
        if (!generico) {
          throw new Error(
            "El archivo no corresponde al reporte 'Movimiento auxiliar de cuenta contable por tercero' de Siigo. Verifica que exportaste el reporte correcto.",
          );
        }
      }
      const result = analyzeHistory(sheet);
      if (result.rules.length === 0) {
        throw new Error("No se detectaron movimientos contables. Verifica que el archivo tenga columnas de cuenta, tercero y concepto.");
      }
      const payload = result.rules.map((r) => ({
        company_id: companyId,
        provider_nit: r.provider_nit,
        provider_name: r.provider_name,
        concept: r.concept,
        account_code: r.account_code,
        account_name: r.account_name,
        cost_center: r.cost_center,
        iva: r.iva,
        retentions: r.retentions,
        taxes: r.taxes,
        times_used: r.times_used,
        last_used_at: r.last_used_at,
        item_type: "gasto",
        active: true,
        source: "excel",
      }));
      const keyOf = (r: (typeof payload)[number]) => `${r.provider_nit ?? "-"}|${(r.concept ?? "").toLowerCase()}|${r.account_code}`;
      const existingKeys = await fetchAllKeys(async (from, to) => {
        const { data, error } = await supabase.from("learning_rules").select("provider_nit,concept,account_code").eq("company_id", companyId).eq("source", "excel").range(from, to);
        if (error) return { keys: [], error: error.message };
        return { keys: (data ?? []).map((r) => `${r.provider_nit ?? "-"}|${(r.concept ?? "").toLowerCase()}|${r.account_code}`) };
      });
      const existing = new Map(payload.filter((r) => existingKeys.has(keyOf(r))).map((r) => [keyOf(r), r]));
      const { data: auth } = await supabase.auth.getUser();
      const importResult = await runReliableImport({
        module: "Historial contable", fileName: file.name, user: auth.user?.email ?? null,
        found: result.rowsRead, rows: payload, duplicateCount: 0, keyOf, existingByKey: existing,
        saveBatch: async (rows) => {
          // Sin restricción única compuesta, se actualizan coincidencias y se insertan únicamente reglas nuevas.
          let firstError: { message: string; details?: string | null; hint?: string | null } | null = null;
          for (const row of rows) {
            const { data: current, error: readError } = await supabase.from("learning_rules").select("id").eq("company_id", companyId).eq("source", "excel").eq("account_code", row.account_code).eq("provider_nit", row.provider_nit ?? "").eq("concept", row.concept ?? "").maybeSingle();
            if (readError) { firstError = readError; continue; }
            const { error } = current
              ? await supabase.from("learning_rules").update(row).eq("id", current.id)
              : await supabase.from("learning_rules").insert(row);
            if (error && !firstError) firstError = error;
          }
          return { error: firstError };
        },
        verifyKeys: () => fetchAllKeys(async (from, to) => {
          const { data, error } = await supabase.from("learning_rules").select("provider_nit,concept,account_code").eq("company_id", companyId).eq("source", "excel").range(from, to);
          if (error) return { keys: [], error: error.message };
          return { keys: (data ?? []).map((r) => `${r.provider_nit ?? "-"}|${(r.concept ?? "").toLowerCase()}|${r.account_code}`) };
        }),
        onProgress: (p) => setProgreso(`Importando historial contable… Lote ${p.batch} de ${p.batches} · Registros ${fmt(p.from)} - ${fmt(p.to)} de ${fmt(p.total)}`),
      });
      // Los movimientos se leen y procesan todos; las filas almacenadas son reglas consolidadas por proveedor/concepto/cuenta.
      importResult.found = result.rowsRead;
      importResult.processed = result.rowsRead;
      importResult.invalid = result.rowsSkipped;
      setDetail(importResult);
      setAnalysis(result);
      if (importResult.status === "COMPLETADA") toast.success("IMPORTACIÓN COMPLETADA");
      else if (importResult.status === "COMPLETADA CON ERRORES") toast.warning("Importación completada con errores. Revisa el detalle.");
      else toast.error("La importación del historial quedó incompleta. Revisa el detalle.");
      await qc.invalidateQueries({ queryKey: ["learning_rules"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible analizar el historial.");
    } finally {
      setBusy(false);
      setProgreso(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Importar historial contable de Siigo</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Sube el archivo exportado desde Siigo con el reporte "Movimiento auxiliar de cuenta contable por tercero"
          (Informes contables), en formato .xlsx, para el rango de fechas que quieras usar para entrenar la IA.
        </p>
        <div className="mt-3">
          <FileButton label={busy ? "Analizando…" : "Importar Excel"} onFile={importar} busy={busy} />
        </div>
        {progreso ? <p className="mt-3 rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">{progreso}</p> : null}
        <div className="mt-3"><ImportDetailPanel detail={detail} /></div>
        {analysis && (
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
            <p>Filas leídas: <strong>{analysis.rowsRead}</strong></p>
            <p>Movimientos procesados: <strong>{analysis.rowsUsed}</strong></p>
            <p>Omitidos: <strong>{analysis.rowsSkipped}</strong></p>
            <p>Terceros aprendidos: <strong>{analysis.providers}</strong></p>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">NIT</th><th className="px-4 py-2 font-medium">Tercero</th>
              <th className="px-4 py-2 font-medium">Concepto</th><th className="px-4 py-2 font-medium">Cuenta</th>
              <th className="px-4 py-2 font-medium">C. costo</th><th className="px-4 py-2 font-medium">Retenciones</th>
              <th className="px-4 py-2 font-medium">Usos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(learned ?? []).map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">{r.provider_nit ?? "—"}</td>
                <td className="px-4 py-2">{r.provider_name ?? "—"}</td>
                <td className="px-4 py-2 max-w-[18rem] truncate">{r.concept ?? "—"}</td>
                <td className="px-4 py-2">{r.account_code}</td>
                <td className="px-4 py-2">{r.cost_center ?? "—"}</td>
                <td className="px-4 py-2">{r.retentions ?? "—"}</td>
                <td className="px-4 py-2">{r.times_used}</td>
              </tr>
            ))}
            {(learned ?? []).length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">Aún no hay conocimiento importado desde Excel.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
