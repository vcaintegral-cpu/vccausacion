// Analiza un historial contable exportado desde Siigo (Excel) y construye la
// base de conocimiento de la IA: cuenta por proveedor, por concepto, centro de
// costo, impuestos, retenciones, frecuencia de uso y última cuenta utilizada.
import { num, pick, type SheetRow } from "@/lib/spreadsheet";

export type LearnedRule = {
  provider_nit: string | null;
  provider_name: string | null;
  concept: string | null;
  account_code: string;
  account_name: string | null;
  cost_center: string | null;
  iva: number;
  retentions: string | null;
  taxes: string | null;
  times_used: number;
  last_used_at: string | null;
};

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

function parseDate(value: string): string | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(value);
  if (iso) return new Date(`${iso[0]}T00:00:00Z`).toISOString();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(value);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y!.length === 2 ? `20${y}` : y;
    return new Date(`${year}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}T00:00:00Z`).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

type Bucket = {
  provider_nit: string | null;
  provider_name: string | null;
  concept: string | null;
  accounts: Map<string, { name: string | null; count: number; last: string | null }>;
  costCenters: Map<string, number>;
  ivaTotal: number;
  ivaCount: number;
  retentions: Map<string, number>;
  count: number;
  last: string | null;
};

export type HistoryAnalysis = {
  rowsRead: number;
  rowsUsed: number;
  rowsSkipped: number;
  providers: number;
  rules: LearnedRule[];
  /** "siigo-auxiliar" cuando se detecta el reporte "Movimiento auxiliar de cuenta contable por tercero". */
  format: "siigo-auxiliar" | "generico";
};

/** Detecta el reporte de Siigo "Movimiento auxiliar de cuenta contable por tercero". */
export function isSiigoAuxiliary(rows: SheetRow[]): boolean {
  const first = rows[0];
  if (!first) return false;
  const keys = Object.keys(first);
  const has = (k: string) => keys.some((x) => x === k);
  return has("comprobante") && has("codigo contable") && has("identificacion");
}

/** Convierte el detalle en un concepto reutilizable: sin números variables ni el nombre del tercero. */
function normalizeConcept(text: string, providerName: string | null): string | null {
  let out = (text ?? "").trim();
  if (!out) return null;
  if (providerName) {
    const parts = providerName.split(/\s+/).filter((p) => p.length > 2);
    for (const p of parts) {
      out = out.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
    }
  }
  out = out
    .replace(/\d+([.,]\d+)?/g, " ")
    .replace(/\b(dias?|dia|horas?|no\.?|nro\.?|num\.?)\b/gi, " ")
    .replace(/[-_/|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[\s\-–]+|[\s\-–]+$/g, "");
  return out ? out : null;
}

/** Parser del reporte auxiliar de Siigo: una fila es movimiento si "Comprobante" no está vacío. */
function siigoRowsToGeneric(rows: SheetRow[]): { rows: SheetRow[]; skipped: number } {
  const out: SheetRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const comprobante = (row["comprobante"] ?? "").trim();
    if (!comprobante) continue; // separadores jerárquicos y filas vacías
    const code = (row["codigo contable"] ?? "").replace(/\s+/g, "");
    const nit = (row["identificacion"] ?? "").trim();
    if (!code || !nit) {
      skipped += 1;
      continue;
    }
    const providerName = (row["nombre tercero"] ?? "").trim() || null;
    const raw = (row["descripcion"] ?? "").trim() || (row["detalle"] ?? "").trim();
    out.push({
      cuenta: code,
      "nombre cuenta": (row["cuenta contable"] ?? "").trim(),
      nit,
      "razon social": providerName ?? "",
      concepto: normalizeConcept(raw, providerName) ?? "",
      "centro de costo": (row["centro de costo"] ?? "").trim(),
      fecha: (row["fecha elaboracion"] ?? "").trim(),
    });
  }
  return { rows: out, skipped };
}

export function analyzeHistory(rows: SheetRow[]): HistoryAnalysis {
  const siigo = isSiigoAuxiliary(rows);
  const totalRead = rows.length;
  let rowsSkipped = 0;
  if (siigo) {
    const parsed = siigoRowsToGeneric(rows);
    rows = parsed.rows;
    rowsSkipped = parsed.skipped;
  }
  const buckets = new Map<string, Bucket>();
  let used = 0;

  for (const row of rows) {
    const account = pick(row, "cuenta", "codigo cuenta", "cuenta contable", "codigo contable", "account");
    const code = account.replace(/\s+/g, "");
    if (!code || !/^\d/.test(code)) continue;

    const nit = pick(row, "nit", "identificacion", "documento tercero", "tercero", "cedula").replace(/[^0-9]/g, "") || null;
    const providerName = pick(row, "razon social", "nombre tercero", "proveedor", "tercero nombre", "nombre") || null;
    const concept = pick(row, "concepto", "descripcion", "detalle", "observaciones", "comentario") || null;
    const accountName = pick(row, "nombre cuenta", "descripcion cuenta", "nombre de la cuenta") || null;
    const costCenter = pick(row, "centro de costo", "centro costo", "cc") || null;
    const iva = num(pick(row, "iva", "impuesto iva", "valor iva"));
    const date = parseDate(pick(row, "fecha", "fecha elaboracion", "fecha documento"));

    const retentions: string[] = [];
    for (const label of ["retefuente", "reteiva", "reteica", "retencion", "reteica municipal"]) {
      const value = num(pick(row, label));
      if (value > 0) retentions.push(`${label}:${value}`);
    }

    const key = `${nit ?? "-"}|${norm(concept ?? "")}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        provider_nit: nit,
        provider_name: providerName,
        concept,
        accounts: new Map(),
        costCenters: new Map(),
        ivaTotal: 0,
        ivaCount: 0,
        retentions: new Map(),
        count: 0,
        last: null,
      };
      buckets.set(key, bucket);
    }

    const acc = bucket.accounts.get(code) ?? { name: accountName, count: 0, last: null };
    acc.count += 1;
    acc.name = acc.name ?? accountName;
    if (date && (!acc.last || date > acc.last)) acc.last = date;
    bucket.accounts.set(code, acc);

    if (costCenter) bucket.costCenters.set(costCenter, (bucket.costCenters.get(costCenter) ?? 0) + 1);
    if (iva > 0) {
      bucket.ivaTotal += iva;
      bucket.ivaCount += 1;
    }
    for (const r of retentions) {
      const name = r.split(":")[0]!;
      bucket.retentions.set(name, (bucket.retentions.get(name) ?? 0) + 1);
    }
    bucket.count += 1;
    bucket.provider_name = bucket.provider_name ?? providerName;
    if (date && (!bucket.last || date > bucket.last)) bucket.last = date;
    used += 1;
  }

  const rules: LearnedRule[] = [];
  for (const bucket of buckets.values()) {
    // Última cuenta utilizada; si no hay fechas, la más frecuente.
    const entries = [...bucket.accounts.entries()];
    const best = entries.sort((a, b) => {
      const la = a[1].last ?? "";
      const lb = b[1].last ?? "";
      if (la !== lb) return lb.localeCompare(la);
      return b[1].count - a[1].count;
    })[0];
    if (!best) continue;
    const cc = [...bucket.costCenters.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const rets = [...bucket.retentions.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    rules.push({
      provider_nit: bucket.provider_nit,
      provider_name: bucket.provider_name,
      concept: bucket.concept,
      account_code: best[0],
      account_name: best[1].name,
      cost_center: cc,
      iva: bucket.ivaCount > 0 ? Math.round((bucket.ivaTotal / bucket.ivaCount) * 100) / 100 : 0,
      retentions: rets.length > 0 ? rets.join(",") : null,
      taxes: bucket.ivaCount > 0 ? "iva" : null,
      times_used: bucket.count,
      last_used_at: bucket.last,
    });
  }

  rules.sort((a, b) => b.times_used - a.times_used);
  return {
    rowsRead: totalRead,
    rowsUsed: used,
    rowsSkipped,
    providers: new Set(rules.map((r) => r.provider_nit ?? "-")).size,
    rules,
    format: siigo ? "siigo-auxiliar" : "generico",
  };
}