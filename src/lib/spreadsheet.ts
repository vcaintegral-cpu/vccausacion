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

const HEADER_HINTS = [
  "codigo", "cuenta", "code", "nombre", "descripcion", "name", "naturaleza",
  "centro", "impuesto", "tarifa", "nit", "proveedor", "fecha",
];

/** Lee la primera hoja de un Excel/CSV y devuelve filas con encabezados normalizados.
 *  Detecta automáticamente la fila de encabezados (ignora títulos/filas vacías arriba). */
export async function readSheet(file: File): Promise<SheetRow[]> {
  return (await readSheetIndexed(file)).map((r) => r.row);
}

/** Igual que readSheet, pero conserva el número de fila real del Excel (1-based). */
export async function readSheetIndexed(file: File): Promise<{ row: SheetRow; rowNumber: number }[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });
  const first = wb.SheetNames[0];
  if (!first) return [];
  // raw: false => los códigos contables llegan como texto formateado (conserva ceros a la izquierda).
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first]!, {
    header: 1,
    defval: "",
    blankrows: true,
    raw: false,
  });
  if (matrix.length === 0) return [];

  // Busca en las primeras 15 filas la que contenga más encabezados reconocibles.
  let headerIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const cells = (matrix[i] ?? []).map((c) => normKey(String(c ?? "")));
    const filled = cells.filter(Boolean).length;
    if (filled < 2) continue;
    const score = cells.filter((c) => HEADER_HINTS.some((h) => c.includes(h))).length * 10 + filled;
    if (score > bestScore) {
      bestScore = score;
      headerIdx = i;
    }
  }

  const headers = (matrix[headerIdx] ?? []).map((c, i) => normKey(String(c ?? "")) || `col ${i + 1}`);
  const rows: { row: SheetRow; rowNumber: number }[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    const out: SheetRow = {};
    let any = false;
    headers.forEach((h, c) => {
      const v = String(cells[c] ?? "").trim();
      if (v) any = true;
      if (!out[h]) out[h] = v;
    });
    if (any) rows.push({ row: out, rowNumber: i + 1 });
  }
  return rows;
}

/** Devuelve el primer valor no vacío entre varios encabezados posibles. */
export type SheetMatrix = {
  /** Valores tal como se ven en Excel (texto formateado, sin transformar). */
  text: string[][];
  /** Valores crudos de la celda (números sin redondear, fechas, etc.). */
  raw: unknown[][];
};

/** Lee la primera hoja SIN normalizar nada: matriz completa de celdas, texto y valor crudo. */
export async function readSheetMatrix(file: File): Promise<SheetMatrix> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: false });
  const first = wb.SheetNames[0];
  if (!first) return { text: [], raw: [] };
  const sheet = wb.Sheets[first]!;
  const text = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", blankrows: true, raw: false });
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", blankrows: true, raw: true });
  return {
    text: text.map((row) => row.map((cell) => (cell == null ? "" : String(cell)))),
    raw,
  };
}

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