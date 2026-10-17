import * as XLSX from "xlsx";
import type { JournalLine } from "./accounting";
import { roundCOP } from "@/lib/money";
import { toCents, sumCents } from "@/lib/money";
import { validateStoredJournal, sourceFromRaw } from "@/lib/source-values";

export type ExportInvoice = {
  source_override?: import("@/lib/source-values").SourceValues | null;
  raw_extraction?: unknown;
  subtotal?: number;
  iva?: number;
  impoconsumo?: number;
  discount?: number;
  total?: number;
  prefix?: string | null;
  number?: string | null;
  issue_date?: string | null;
  provider_nit?: string | null;
  provider_name?: string | null;
  cost_center?: string | null;
  notes?: string | null;
};

type Row = Record<string, string | number>;

export function journalRows(inv: ExportInvoice, journal: JournalLine[]): Row[] {
  const errors = validateStoredJournal(inv, journal);
  if (errors[0]) throw new Error(errors.join("\n"));
  return journal.map((l, i) => ({
    Comprobante: `${inv.prefix ?? ""}${inv.number ?? ""}`,
    Fecha: inv.issue_date ?? "",
    Secuencia: i + 1,
    Cuenta: l.account_code,
    Descripcion: l.account_name ?? "",
    Tercero: inv.provider_nit ?? "",
    RazonSocial: inv.provider_name ?? "",
    CentroCosto: l.cost_center ?? inv.cost_center ?? "",
    Debito: roundCOP(l.debit),
    Credito: roundCOP(l.credit),
    Detalle: inv.notes ?? "",
  }));
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const baseName = (inv: ExportInvoice) => `contai_${(inv.prefix ?? "") + (inv.number ?? "sin-numero")}`;

export function exportXlsx(inv: ExportInvoice, journal: JournalLine[]) {
  const ws = XLSX.utils.json_to_sheet(journalRows(inv, journal));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Comprobante");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const read = XLSX.read(out, { type: "array" });
  const sheet = read.Sheets["Comprobante"];
  if (!sheet) throw new Error("El archivo generado no contiene el comprobante.");
  validateExportRows(journal, XLSX.utils.sheet_to_json<Row>(sheet));
  download(new Blob([out], { type: "application/octet-stream" }), `${baseName(inv)}.xlsx`);
}

export function exportCsv(inv: ExportInvoice, journal: JournalLine[]) {
  const rows = journalRows(inv, journal);
  const headers = Object.keys(rows[0] ?? {});
  const body = rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(";"));
  const csv = "\uFEFF" + [headers.join(";"), ...body].join("\r\n");
  validateExportRows(journal, parseDelimitedExport(csv.slice(1), ";", true));
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${baseName(inv)}.csv`);
}

export function exportTxt(inv: ExportInvoice, journal: JournalLine[]) {
  const rows = journalRows(inv, journal);
  const txt = rows.map((r) => Object.values(r).join("|")).join("\r\n");
  validateExportRows(journal, parseDelimitedExport(txt, "|", false));
  download(new Blob([txt], { type: "text/plain;charset=utf-8" }), `${baseName(inv)}.txt`);
}

function parseDelimitedExport(text: string, delimiter: string, header: boolean): Row[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && ch === delimiter) { row.push(cell); cell = ""; }
    else if (!quoted && (ch === "\n" || ch === "\r")) { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.slice(header ? 1 : 0).map(r => ({ Cuenta: r[3] ?? "", Debito: r[8] ?? "", Credito: r[9] ?? "" }));
}
export function validateExportRows(journal: JournalLine[], rows: Row[]) {
  if (journal.length !== rows.length || rows.some((r, i) => r["Cuenta"] !== journal[i]?.account_code || toCents(r["Debito"]) !== toCents(journal[i]?.debit) || toCents(r["Credito"]) !== toCents(journal[i]?.credit)))
    throw new Error("Diferencia en el archivo exportado: cuenta, débito o crédito distinto del asiento aprobado.");
  if (sumCents(rows.map(r => r["Debito"])) !== sumCents(rows.map(r => r["Credito"]))) throw new Error("El comprobante exportado no está cuadrado.");
}

export function exportReconciliation(invoices: (ExportInvoice & { id: string; siigo_trace?: unknown })[], journals: (JournalLine & { invoice_id: string })[]) {
  const rows: Row[] = [];
  for (const inv of invoices) {
    const source = inv.source_override ?? sourceFromRaw(inv.raw_extraction);
    const journal = journals.filter(j => j.invoice_id === inv.id);
    const trace = inv.siigo_trace as { valores?: Record<string, number>; siigo_verificacion?: { total?: number }; siigo_request?: unknown } | null;
    for (const field of ["subtotal", "iva", "impoconsumo", "total"] as const) {
      const original = source?.[field]; const stored = toCents(inv[field]);
      const exported = field === "total" ? trace?.siigo_verificacion?.total : trace?.valores?.[field];
      rows.push({ Documento: `${inv.prefix ?? ""}${inv.number ?? ""}`, Fuente: source?.source ?? "Sin origen", Campo: field, Origen: original === undefined ? "No disponible" : original / 100, Borrador: stored / 100, Exportado: exported ?? "No enviado", Diferencia: original === undefined ? "No disponible" : (stored - original) / 100, Estado: original === undefined ? "Sin origen" : stored === original && (exported === undefined || toCents(exported) === original) ? "OK" : "Diferencia" });
    }
    for (const field of ["debit", "credit"] as const) rows.push({ Documento: `${inv.prefix ?? ""}${inv.number ?? ""}`, Campo: field === "debit" ? "Débitos del asiento" : "Créditos del asiento", Asiento: sumCents(journal.map(j => j[field])) / 100, Diferencia: (sumCents(journal.map(j => j.debit)) - sumCents(journal.map(j => j.credit))) / 100, Estado: validateStoredJournal(inv, journal).length ? "Diferencia" : "OK" });
  }
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Conciliación");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  download(new Blob([out], { type: "application/octet-stream" }), "conciliacion_fuente.xlsx");
}