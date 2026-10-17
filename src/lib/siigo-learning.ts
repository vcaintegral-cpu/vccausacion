// Importador de aprendizaje desde el auxiliar contable de Siigo (Excel).
// Lee el reporte exportado de Siigo (encabezados en la fila 8), toma solo los
// comprobantes de compra (FC-1) y soporte de adquisiciones (DS-3) —ignora RP,
// RC, FV, CC, NC, ND y TD— y aprende por NIT de proveedor la cuenta de gasto,
// la cuenta del IVA, la retención y la cuenta por pagar más frecuentes.
// Las reglas aprendidas se guardan en provider_rules con source "siigo"
// (prioridad P3/P4: el historial y las reglas manuales/aprendidas P1 ganan).
import { supabase } from "@/integrations/supabase/client";
import { readSheetMatrix, num } from "@/lib/spreadsheet";
import { isValidExpenseAccount } from "@/lib/provider-rules";

/** Fila (1-based) donde están los encabezados en el auxiliar de Siigo. */
const HEADER_ROW = 8;

/** Tipos de comprobante que representan compras. */
const TIPOS_COMPRA = new Set(["FC-1", "DS-3"]);

export type SiigoLearningResult = {
  documentos: number;
  proveedores: number;
  reglasCreadas: number;
  reglasActualizadas: number;
  errores: string[];
};

type Movimiento = {
  tipo: string;
  nit: string;
  proveedor: string;
  cuenta: string;
  debito: number;
  credito: number;
};

function normHeader(v: string): string {
  return v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function colIndex(headers: string[], ...names: string[]): number {
  const norm = headers.map(normHeader);
  for (const n of names) {
    const target = normHeader(n);
    const i = norm.findIndex((h) => h === target);
    if (i >= 0) return i;
  }
  for (const n of names) {
    const target = normHeader(n);
    const i = norm.findIndex((h) => h.includes(target));
    if (i >= 0) return i;
  }
  return -1;
}

/** Lee la matriz del Excel y devuelve los movimientos contables de compra. */
export function parseSiigoAuxiliar(text: string[][], raw: unknown[][]): Movimiento[] {
  const headerIdx = HEADER_ROW - 1;
  if (text.length <= headerIdx) return [];
  const headers = text[headerIdx] ?? [];
  const iTipo = colIndex(headers, "Tipo de comprobante", "Comprobante", "Tipo");
  const iNit = colIndex(headers, "Identificación", "NIT", "Identificacion");
  const iProveedor = colIndex(headers, "Tercero", "Proveedor", "Nombre tercero");
  const iCuenta = colIndex(headers, "Cuenta contable", "Cuenta", "Codigo contable");
  const iDebito = colIndex(headers, "Débito", "Debito");
  const iCredito = colIndex(headers, "Crédito", "Credito");
  if (iTipo < 0 || iCuenta < 0 || (iDebito < 0 && iCredito < 0)) return [];

  const out: Movimiento[] = [];
  for (let i = headerIdx + 1; i < text.length; i += 1) {
    const row = text[i] ?? [];
    const rawRow = raw[i] ?? [];
    const tipo = String(row[iTipo] ?? "").trim().toUpperCase();
    if (!TIPOS_COMPRA.has(tipo)) continue;
    const cuenta = String(row[iCuenta] ?? "").trim().split(" ")[0] ?? "";
    if (!cuenta) continue;
    const celda = (idx: number): string => {
      if (idx < 0) return "";
      const r = rawRow[idx];
      if (typeof r === "number") return String(r);
      return String(row[idx] ?? "");
    };
    out.push({
      tipo,
      nit: String(row[iNit] ?? "").replace(/\D/g, ""),
      proveedor: String(row[iProveedor] ?? "").trim(),
      cuenta,
      debito: num(celda(iDebito)),
      credito: num(celda(iCredito)),
    });
  }
  return out;
}

function masFrecuente(valores: string[]): string | null {
  const conteo = new Map<string, number>();
  for (const v of valores) if (v) conteo.set(v, (conteo.get(v) ?? 0) + 1);
  let best: string | null = null;
  let max = 0;
  for (const [v, n] of conteo) {
    if (n > max) {
      max = n;
      best = v;
    }
  }
  return best;
}

/**
 * Aprende reglas por proveedor desde el auxiliar de Siigo:
 * - gasto: cuenta de débito 5/6/7/15/16/17 más frecuente del NIT;
 * - IVA: cuenta 2408 más frecuente (tratamiento descontable);
 * - retención: cuenta 2365/2367/2368 más frecuente;
 * - CxP: cuenta 22/23 más frecuente (crédito).
 * No pisa reglas existentes con source "manual" o "aprendida": solo crea las
 * que faltan o actualiza las que ya venían de Siigo.
 */
export async function aprenderDesdeSiigo(companyId: string, file: File): Promise<SiigoLearningResult> {
  const { text, raw } = await readSheetMatrix(file);
  const movimientos = parseSiigoAuxiliar(text, raw);
  const result: SiigoLearningResult = { documentos: 0, proveedores: 0, reglasCreadas: 0, reglasActualizadas: 0, errores: [] };
  if (movimientos.length === 0) {
    result.errores.push("No se encontraron movimientos de compra (FC-1/DS-3) en el archivo. Verifica que sea el auxiliar de Siigo con encabezados en la fila 8.");
    return result;
  }

  const porNit = new Map<string, Movimiento[]>();
  for (const m of movimientos) {
    if (!m.nit) continue;
    const lista = porNit.get(m.nit) ?? [];
    lista.push(m);
    porNit.set(m.nit, lista);
  }
  result.proveedores = porNit.size;
  result.documentos = movimientos.length;

  const { data: existentes } = await supabase
    .from("provider_rules")
    .select("id, provider_nit, keyword, source")
    .eq("company_id", companyId);
  const porClave = new Map<string, { id: string; source: string }>();
  for (const r of existentes ?? []) {
    porClave.set(`${r.provider_nit}|${r.keyword}`, { id: r.id, source: String(r.source) });
  }

  for (const [nit, movs] of porNit) {
    const proveedor = movs.find((m) => m.proveedor)?.proveedor ?? null;
    const gasto = masFrecuente(movs.filter((m) => m.debito > 0 && isValidExpenseAccount(m.cuenta)).map((m) => m.cuenta));
    const iva = masFrecuente(movs.filter((m) => m.cuenta.startsWith("2408")).map((m) => m.cuenta));
    const retencion = masFrecuente(
      movs.filter((m) => ["2365", "2367", "2368"].some((p) => m.cuenta.startsWith(p))).map((m) => m.cuenta),
    );
    const cxp = masFrecuente(
      movs.filter((m) => m.credito > 0 && (m.cuenta.startsWith("22") || m.cuenta.startsWith("23"))).map((m) => m.cuenta),
    );
    if (!gasto && !iva && !retencion && !cxp) continue;

    const clave = `${nit}|(todas)`;
    const existente = porClave.get(clave);
    if (existente && existente.source !== "siigo") continue; // no pisar reglas manuales/aprendidas

    const payload = {
      company_id: companyId,
      provider_nit: nit,
      provider_name: proveedor,
      keyword: "(todas)",
      expense_account: gasto,
      iva_treatment: iva ? "descontable" : "na",
      iva_account: iva,
      retention_account: retencion,
      payable_account: cxp,
      source: "siigo",
      active: true,
    };
    const { error } = existente
      ? await supabase.from("provider_rules").update(payload as never).eq("id", existente.id)
      : await supabase.from("provider_rules").insert(payload as never);
    if (error) {
      result.errores.push(`NIT ${nit}: ${error.message}`);
    } else if (existente) {
      result.reglasActualizadas += 1;
    } else {
      result.reglasCreadas += 1;
    }
  }
  return result;
}
