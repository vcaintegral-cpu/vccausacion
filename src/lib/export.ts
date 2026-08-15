import * as XLSX from "xlsx";
import type { JournalLine } from "./accounting";
import { roundCOP } from "@/lib/money";

export type ExportInvoice = {
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
  download(new Blob([out], { type: "application/octet-stream" }), `${baseName(inv)}.xlsx`);
}

export function exportCsv(inv: ExportInvoice, journal: JournalLine[]) {
  const rows = journalRows(inv, journal);
  const headers = Object.keys(rows[0] ?? {});
  const body = rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(";"));
  const csv = "\uFEFF" + [headers.join(";"), ...body].join("\r\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${baseName(inv)}.csv`);
}

export function exportTxt(inv: ExportInvoice, journal: JournalLine[]) {
  const rows = journalRows(inv, journal);
  const txt = rows.map((r) => Object.values(r).join("|")).join("\r\n");
  download(new Blob([txt], { type: "text/plain;charset=utf-8" }), `${baseName(inv)}.txt`);
}