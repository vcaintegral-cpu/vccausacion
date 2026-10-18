// Documentos soporte (DS): lógica pura, sin IA ni red.
// El Excel y el PDF terminan en la MISMA estructura ExtractedInvoice de compras y
// pasan por la misma función de causación (saveExtractedInvoice).
import type { ExtractedInvoice } from "@/lib/extract.functions";

export const DS_TEMPLATE_COLUMNS = [
  "FECHA", "TIPO DOC VENDEDOR", "NIT/CC VENDEDOR", "NOMBRE VENDEDOR", "DIRECCION", "CIUDAD", "CORREO", "TELEFONO",
  "NUMERO CUENTA COBRO", "DESCRIPCION", "CANTIDAD", "VALOR UNITARIO", "VALOR TOTAL", "CENTRO DE COSTO", "FORMA DE PAGO",
] as const;

/** Prefijo con el que se guarda el número de la cuenta de cobro (duplicados: NIT + prefijo + número). */
export const DS_PREFIX = "CC";

export type VendorIdType = "13" | "31" | "22" | "41";
export const VENDOR_ID_LABEL: Record<VendorIdType, string> = { "13": "Cédula", "31": "NIT", "22": "Cédula de extranjería", "41": "Pasaporte" };

/** Tipo de documento del vendedor → código Siigo. */
export function siigoIdType(raw: string | null | undefined): VendorIdType | null {
  const v = String(raw ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  if (!v) return null;
  if (["13", "cc", "cedula", "ceduladeciudadania", "cedulaciudadania"].includes(v)) return "13";
  if (["31", "nit"].includes(v)) return "31";
  if (["22", "ce", "cedulaextranjeria", "ceduladeextranjeria"].includes(v)) return "22";
  if (["41", "pasaporte", "pa", "pp", "passport"].includes(v)) return "41";
  return null;
}

/** Dígito de verificación DIAN para NIT. */
export function nitDV(nit: string): string {
  const d = String(nit).replace(/\D/g, "");
  const w = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let sum = 0;
  for (let i = 0; i < d.length; i += 1) sum += Number(d[d.length - 1 - i]) * w[i]!;
  const r = sum % 11;
  return String(r > 1 ? 11 - r : r);
}

/** Persona natural: nombres y apellidos como los exige Siigo ([nombres, apellidos]). */
export function splitPersonName(full: string): { firstNames: string; lastNames: string } {
  const t = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (t.length <= 1) return { firstNames: t[0] ?? "", lastNames: t[0] ?? "" };
  if (t.length === 2) return { firstNames: t[0]!, lastNames: t[1]! };
  if (t.length === 3) return { firstNames: t[0]!, lastNames: t.slice(1).join(" ") };
  return { firstNames: t.slice(0, t.length - 2).join(" "), lastNames: t.slice(-2).join(" ") };
}

/** Importe en centavos enteros. Acepta formato colombiano (1.234.567,89) y el de Excel (1,234,567.89). */
export function moneyCents(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  let s = String(raw ?? "").replace(/[^0-9,.-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const neg = s.startsWith("-");
  s = s.replace(/-/g, "");
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  let intPart = s, dec = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const sep = lastDot > lastComma ? "." : ",";
    const i = s.lastIndexOf(sep);
    intPart = s.slice(0, i); dec = s.slice(i + 1);
  } else {
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
    if (sep) {
      const parts = s.split(sep);
      const tail = parts[parts.length - 1]!;
      // Separador único seguido de 3 dígitos (o varios grupos) = miles; si no, decimales.
      if (parts.length > 2 || tail.length === 3) { intPart = parts.join(""); dec = ""; }
      else { intPart = parts.slice(0, -1).join(""); dec = tail; }
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  const cents = Number(intPart || "0") * 100 + Number((dec + "00").slice(0, 2));
  return Number.isFinite(cents) ? (neg ? -cents : cents) : null;
}

/** Fecha del Excel a YYYY-MM-DD (dd/mm/aaaa, aaaa-mm-dd o serial de Excel). */
export function parseDate(raw: string): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  if (/^\d{5}$/.test(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

export type SupportLine = { description: string; quantityCents: number; unitCents: number; totalCents: number };
export type SupportDoc = {
  key: string;
  rowNumbers: number[];
  date: string | null;
  idType: VendorIdType | null;
  idNumber: string;
  name: string;
  address: string; city: string; email: string; phone: string;
  number: string;
  costCenter: string | null;
  paymentForm: string | null;
  lines: SupportLine[];
  totalCents: number;
};
export type RowError = { row: number; message: string };

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const get = (row: Record<string, string>, col: string) => String(row[norm(col)] ?? "").trim();
/** NIT/CC y número de cuenta de cobro: SIEMPRE texto, sin notación científica ni decimales de Excel. */
const asText = (v: string) => v.replace(/\.0+$/, "").replace(/\s+/g, "").trim();

export function dsKey(idNumber: string, number: string) {
  return `${idNumber.replace(/\D/g, "")}|${number.trim().toUpperCase()}`;
}

/** Agrupa filas por NIT/CC + NUMERO CUENTA COBRO y valida el formato fila por fila. */
export function parseSupportRows(rows: Array<{ row: Record<string, string>; rowNumber: number }>): { docs: SupportDoc[]; errors: RowError[] } {
  const errors: RowError[] = [];
  const map = new Map<string, SupportDoc>();
  for (const { row, rowNumber } of rows) {
    const idNumber = asText(get(row, "NIT/CC VENDEDOR")).replace(/[^0-9A-Za-z]/g, "");
    const number = asText(get(row, "NUMERO CUENTA COBRO"));
    const description = get(row, "DESCRIPCION");
    const qty = moneyCents(get(row, "CANTIDAD") || "1");
    const unit = moneyCents(get(row, "VALOR UNITARIO"));
    const total = moneyCents(get(row, "VALOR TOTAL"));
    const rowErr: string[] = [];
    if (!idNumber) rowErr.push("falta NIT/CC VENDEDOR");
    if (!number) rowErr.push("falta NUMERO CUENTA COBRO");
    if (!description) rowErr.push("falta DESCRIPCION");
    if (total == null || total <= 0) rowErr.push("VALOR TOTAL inválido");
    if (qty == null || qty <= 0) rowErr.push("CANTIDAD inválida");
    const date = parseDate(get(row, "FECHA"));
    if (!date) rowErr.push("FECHA inválida (use dd/mm/aaaa)");
    const rawType = get(row, "TIPO DOC VENDEDOR");
    const idType = siigoIdType(rawType);
    if (rawType && !idType) rowErr.push(`TIPO DOC VENDEDOR "${rawType}" no reconocido (CC, NIT, CE o Pasaporte)`);
    // Cantidad × valor unitario debe dar el valor total de la línea (exacto al centavo).
    if (unit != null && qty != null && total != null && unit > 0 && Math.round((qty * unit) / 100) !== total)
      rowErr.push("CANTIDAD × VALOR UNITARIO no coincide con VALOR TOTAL");
    if (rowErr.length) { errors.push({ row: rowNumber, message: rowErr.join("; ") }); continue; }
    const key = dsKey(idNumber, number);
    let doc = map.get(key);
    if (!doc) {
      doc = {
        key, rowNumbers: [], date, idType, idNumber, name: get(row, "NOMBRE VENDEDOR"),
        address: get(row, "DIRECCION"), city: get(row, "CIUDAD"), email: get(row, "CORREO"), phone: get(row, "TELEFONO"),
        number, costCenter: get(row, "CENTRO DE COSTO") || null, paymentForm: get(row, "FORMA DE PAGO") || null, lines: [], totalCents: 0,
      };
      map.set(key, doc);
    }
    doc.rowNumbers.push(rowNumber);
    const unitCents = unit && unit > 0 ? unit : Math.round((total! * 100) / qty!);
    doc.lines.push({ description, quantityCents: qty!, unitCents, totalCents: total! });
    doc.totalCents += total!;
  }
  return { docs: [...map.values()], errors };
}

export type CompanyParams = { address?: string | null; city?: string | null; department?: string | null; country?: string | null; phone?: string | null; email?: string | null };
export type FilledField = "address" | "city" | "phone" | "email";
export const FILLED_LABEL: Record<FilledField, string> = { address: "Dirección", city: "Ciudad", phone: "Teléfono", email: "Correo" };

/** Completa SOLO datos de contacto faltantes con los de la empresa. Identidad nunca se completa. */
export function fillVendorFromCompany<T extends { address?: string | null; city?: string | null; phone?: string | null; email?: string | null }>(v: T, p: CompanyParams): { vendor: T; filled: FilledField[] } {
  const filled: FilledField[] = [];
  const out = { ...v };
  for (const f of ["address", "city", "phone", "email"] as const) {
    if (!String(out[f] ?? "").trim() && String(p[f] ?? "").trim()) { (out as Record<string, unknown>)[f] = p[f]; filled.push(f); }
  }
  return { vendor: out, filled };
}

/** Identificación, tipo y nombre son obligatorios: sin ellos el documento queda Incompleto. */
export function missingIdentity(v: { idNumber?: string | null; idType?: string | null; name?: string | null }): string[] {
  const m: string[] = [];
  if (!String(v.idNumber ?? "").replace(/\D/g, "")) m.push("identificación");
  if (!v.idType) m.push("tipo de documento");
  if (!String(v.name ?? "").trim()) m.push("nombre");
  return m;
}

/** Siigo exige el consecutivo del soporte del proveedor con 11 enteros. */
export function supplierReceiptNumber(number: string | null | undefined): string {
  const d = String(number ?? "").replace(/\D/g, "").slice(-11);
  return (d || "1").padStart(11, "0");
}

/**
 * Ventana de fechas de Siigo para documentos soporte (configurable):
 * la ventana de N días INCLUYE el último día del mes, así que
 * fecha_minima = referencia − (N − 1) días. Con N = 10 en septiembre: desde el 21/09.
 * Referencia: último día del mes del documento (por defecto) o hoy.
 * La fecha enviada nunca supera el último día del mes del documento ni hoy.
 * acceptedMin: fecha mínima que Siigo ya aceptó para ese mes (aprendida en lotes); si existe, se usa directamente.
 */
export function dsSendDate(issueDate: string, today: string, windowDays: number, ref: "fin_mes" | "hoy", acceptedMin?: string | null): { sendDate: string; changed: boolean; lastDay: string; min: string } {
  const [y, m] = issueDate.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  const refDate = ref === "hoy" ? today : lastDay;
  let min = new Date(Date.parse(`${refDate}T00:00:00Z`) - (windowDays - 1) * 86400000).toISOString().slice(0, 10);
  if (acceptedMin && acceptedMin > min && acceptedMin <= lastDay) min = acceptedMin;
  let send = issueDate >= min ? issueDate : min;
  if (send > lastDay) send = lastDay;
  if (send > today) send = today;
  return { sendDate: send, changed: send !== issueDate, lastDay, min };
}

/** Suma días a una fecha ISO (aaaa-mm-dd). */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Estado de transmisión DIAN reportado por Siigo (stamp.status) → etiqueta visible. */
export function dianLabel(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (/accept|valid/.test(s)) return "Validado DIAN";
  if (/reject/.test(s)) return "Rechazado DIAN";
  if (/sent|enviado|process/.test(s)) return "Enviado a la DIAN";
  return DIAN_PENDIENTE;
}

export const DIAN_PENDIENTE = "Sincronizado en Siigo – pendiente envío DIAN (lo envía el usuario desde Siigo)";

/** true si Siigo reporta que el documento ya salió hacia la DIAN (enviado, validado o rechazado). */
export function dianTransmitted(status: string | null | undefined): boolean {
  return dianLabel(status) !== DIAN_PENDIENTE;
}

/** Días transcurridos desde la fecha de elaboración (envío) para el envío a la DIAN: n de 6. */
export function diasParaDian(sentDate: string | null | undefined, today: string): number | null {
  if (!sentDate) return null;
  return Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${sentDate}T00:00:00Z`)) / 86400000));
}

/** Vencimiento de una resolución: fecha de aprobación + meses de vigencia. */
export function resolutionExpiry(approvalDate: string, validityMonths: number): string {
  const [y, m, d] = approvalDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + validityMonths, d!)).toISOString().slice(0, 10);
}

/** Persona natural: Cédula, CE o Pasaporte; o NIT con menos de 9 dígitos. */
export function isNaturalPerson(idType: string | null | undefined, idNumber: string): boolean {
  if (idType && idType !== "31") return true;
  return idType === "31" ? false : idNumber.replace(/\D/g, "").length < 9;
}

/** Adaptador Excel DS → la misma estructura que entrega la IA para compras. */
export function supportDocToExtracted(doc: SupportDoc, company: { nit: string | null; name: string }): ExtractedInvoice {
  const total = doc.totalCents / 100;
  return {
    prefix: DS_PREFIX,
    number: doc.number,
    issue_date: doc.date,
    due_date: doc.date,
    provider_nit: doc.idNumber.replace(/\D/g, "") || doc.idNumber,
    provider_name: doc.name || null,
    provider_address: doc.address || null,
    provider_city: doc.city || null,
    provider_phone: doc.phone || null,
    provider_email: doc.email || null,
    buyer_nit: company.nit,
    buyer_name: company.name,
    cufe: null,
    payment_form: doc.paymentForm,
    payment_method: null,
    currency: "COP",
    cost_center: doc.costCenter,
    notes: "Documento soporte",
    subtotal: total,
    discount: 0,
    iva: 0,
    impoconsumo: 0,
    retefuente: 0,
    reteiva: 0,
    reteica: 0,
    total,
    lines: doc.lines.map((l) => ({
      code: null,
      description: l.description,
      quantity: l.quantityCents / 100,
      unit_value: l.unitCents / 100,
      discount: 0,
      iva: 0,
      retention: 0,
      impoconsumo: 0,
      total: l.totalCents / 100,
    })),
  } as ExtractedInvoice;
}

/**
 * Consecutivo asignado por Siigo al documento soporte. El número sale de `number`
 * (o de los dígitos finales de `name`, ej.: "DS-3-1153"); el prefijo es el de la
 * resolución DIAN activa (ej.: DSEB) o, si no hay, el nombre del comprobante en Siigo.
 */
export function dsConsecutive(doc: { name?: unknown; number?: unknown } | null | undefined, resolutionPrefix: string | null): { prefix: string | null; number: number | null; full: string | null } {
  const name = String(doc?.name ?? "").trim();
  const raw = doc?.number != null && String(doc.number).trim() !== "" ? String(doc.number) : (/(\d+)\s*$/.exec(name)?.[1] ?? "");
  const number = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  if (number == null) return { prefix: null, number: null, full: null };
  const prefix = (resolutionPrefix ?? "").trim().toUpperCase() || name.replace(/[-\s]*\d+\s*$/, "").trim() || "DS";
  return { prefix, number, full: `${prefix}-${number}` };
}
