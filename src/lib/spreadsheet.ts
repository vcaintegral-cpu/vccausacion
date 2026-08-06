import * as XLSX from "xlsx";

export type SheetRow = Record<string, string>;

const normKey = (s: string) =>
  s
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Lee la primera hoja de un Excel/CSV y devuelve filas con encabezados normalizados. */
export async function readSheet(file: File): Promise<SheetRow[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });
  const first = wb.SheetNames[0];
  if (!first) return [];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[first]!, { defval: "" });
  return raw.map((r) => {
    const out: SheetRow = {};
    for (const [k, v] of Object.entries(r)) out[normKey(k)] = String(v ?? "").trim();
    return out;
  });
}

/** Devuelve el primer valor no vacío entre varios encabezados posibles. */
export function pick(row: SheetRow, ...names: string[]): string {
  for (const n of names) {
    const key = normKey(n);
    const exact = row[key];
    if (exact) return exact;
  }
  for (const n of names) {
    const key = normKey(n);
    const found = Object.entries(row).find(([k, v]) => v && k.includes(key));
    if (found) return found[1];
  }
  return "";
}

export function num(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function downloadSheet(rows: Record<string, string | number>[], filename: string, sheetName = "Datos") {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([out], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}