// CAPA 1 · Historial contable ORIGINAL.
// Lee el Excel tal cual: no agrupa, no recalcula, no redondea, no reinterpreta
// cuentas ni fechas. Cada fila del archivo se guarda con su número de fila real
// y la totalidad de sus columnas en `original_row_data`.
import { readSheetMatrix } from "@/lib/spreadsheet";

export type RawHistoryRow = {
  excel_row: number;
  account_code: string | null;
  account_name: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  branch: string | null;
  voucher: string | null;
  sequence: string | null;
  entry_date_text: string | null;
  description: string | null;
  detail: string | null;
  cost_center: string | null;
  debit: number | null;
  credit: number | null;
  debit_text: string | null;
  credit_text: string | null;
  original_row_data: Record<string, string>;
};

export type RawHistoryFile = {
  fileName: string;
  headers: string[];
  headerRow: number;
  period: string | null;
  rows: RawHistoryRow[];
  /** Filas de agrupación del reporte (títulos "Cuenta contable:" / "Nombre del tercero:"). */
  groupRows: number;
  /** Filas totalmente vacías. */
  emptyRows: number;
  totalRows: number;
  issues: { row: number; message: string }[];
};

const norm = (s: string) =>
  s.toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const HEADER_KEYS: Record<keyof Omit<RawHistoryRow, "excel_row" | "original_row_data" | "debit" | "credit">, string[]> = {
  account_code: ["codigo contable", "codigo cuenta", "cuenta", "codigo"],
  account_name: ["cuenta contable", "nombre cuenta", "descripcion cuenta"],
  provider_nit: ["identificacion", "nit", "documento tercero"],
  provider_name: ["nombre tercero", "razon social", "tercero"],
  branch: ["sucursal"],
  voucher: ["comprobante", "documento", "numero comprobante"],
  sequence: ["secuencia", "consecutivo"],
  entry_date_text: ["fecha elaboracion", "fecha"],
  description: ["descripcion"],
  detail: ["detalle", "observaciones"],
  cost_center: ["centro de costo", "centro costo"],
  debit_text: ["debito", "debe"],
  credit_text: ["credito", "haber"],
};

function findIndex(headers: string[], names: string[]): number {
  const normalized = headers.map(norm);
  for (const name of names) {
    const idx = normalized.indexOf(norm(name));
    if (idx >= 0) return idx;
  }
  for (const name of names) {
    const idx = normalized.findIndex((h) => h.includes(norm(name)));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Convierte a número SIN redondear ni truncar. Devuelve null cuando la celda está vacía. */
function exactNumber(raw: unknown, text: string): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const value = (text ?? "").trim();
  if (!value) return null;
  const negative = /^\(.*\)$/.test(value);
  let cleaned = value.replace(/[()\s$]/g, "");
  // Separador decimal: el último símbolo que aparezca con 1-2 decimales.
  if (/,\d{1,2}$/.test(cleaned)) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  else cleaned = cleaned.replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

const blank = (value: string) => (value.trim() === "" ? null : value);

/** Lee el archivo completo conservando los datos originales de cada fila. */
export async function readRawHistory(file: File): Promise<RawHistoryFile> {
  const matrix = await readSheetMatrix(file);
  const text = matrix.text;
  if (text.length === 0) throw new Error("El archivo está vacío.");

  // Fila de encabezados: la que reconoce MÁS columnas del reporte. Los informes de
  // Siigo traen líneas de agrupación ("Código contable: 1105…") que antes se
  // confundían con el encabezado y dejaban una sola columna, perdiendo el nombre
  // de la cuenta, el tercero y los valores.
  const allNames = Object.values(HEADER_KEYS).flat().map(norm);
  let headerRow = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(text.length, 40); i += 1) {
    const cells = (text[i] ?? []).map(norm).filter((c) => c !== "");
    if (cells.length < 3) continue;
    let score = 0;
    for (const group of Object.values(HEADER_KEYS)) {
      const names = group.map(norm);
      if (cells.some((c) => names.some((n) => c === n || c.includes(n)))) score += 1;
    }
    // Penaliza filas de datos: celdas que no parecen títulos.
    const titles = cells.filter((c) => allNames.some((n) => c === n || c.includes(n))).length;
    if (score > bestScore && titles >= 3) {
      bestScore = score;
      headerRow = i;
    }
  }
  if (headerRow < 0) {
    throw new Error(
      "No se encontró la fila de encabezados. Verifica que sea el reporte 'Movimiento auxiliar de cuenta contable por tercero'.",
    );
  }

  const width = Math.max(...text.map((r) => r?.length ?? 0), (text[headerRow] ?? []).length);
  const headers = Array.from({ length: width }, (_, i) => {
    const value = (text[headerRow]?.[i] ?? "").trim();
    return value ? value : `Columna ${i + 1}`;
  });
  const idx = Object.fromEntries(
    Object.entries(HEADER_KEYS).map(([field, names]) => [field, findIndex(headers, names)]),
  ) as Record<keyof typeof HEADER_KEYS, number>;

  // Periodo del reporte (líneas superiores del encabezado del informe).
  let period: string | null = null;
  for (let i = 0; i < headerRow; i += 1) {
    const value = (text[i]?.[0] ?? "").trim();
    if (/^(de|del)\s/i.test(value)) period = value;
  }

  const rows: RawHistoryRow[] = [];
  const issues: { row: number; message: string }[] = [];
  let groupRows = 0;
  let emptyRows = 0;

  for (let i = headerRow + 1; i < text.length; i += 1) {
    const cells = text[i] ?? [];
    const rawCells = matrix.raw[i] ?? [];
    const excelRow = i + 1;
    const filled = cells.some((c) => (c ?? "").trim() !== "");
    if (!filled) {
      emptyRows += 1;
      continue;
    }
    const codeCell = (cells[idx.account_code >= 0 ? idx.account_code : 0] ?? "").trim();
    if (!/^\d[\d.]*$/.test(codeCell)) {
      // Filas de agrupación del informe ("Cuenta contable: …", "Nombre del tercero: …").
      groupRows += 1;
      continue;
    }

    const cell = (field: keyof typeof HEADER_KEYS) => {
      const c = idx[field];
      return c >= 0 ? String(cells[c] ?? "") : "";
    };

    const original: Record<string, string> = {};
    headers.forEach((header, column) => {
      original[header] = String(cells[column] ?? "");
    });

    const debitText = cell("debit_text");
    const creditText = cell("credit_text");
    const row: RawHistoryRow = {
      excel_row: excelRow,
      account_code: blank(codeCell),
      account_name: blank(cell("account_name")),
      provider_nit: blank(cell("provider_nit")),
      provider_name: blank(cell("provider_name")),
      branch: blank(cell("branch")),
      voucher: blank(cell("voucher")),
      sequence: blank(cell("sequence")),
      entry_date_text: blank(cell("entry_date_text")),
      description: blank(cell("description")),
      detail: blank(cell("detail")),
      cost_center: blank(cell("cost_center")),
      debit: exactNumber(idx.debit_text >= 0 ? rawCells[idx.debit_text] : "", debitText),
      credit: exactNumber(idx.credit_text >= 0 ? rawCells[idx.credit_text] : "", creditText),
      debit_text: blank(debitText),
      credit_text: blank(creditText),
      original_row_data: original,
    };

    // Validar NO significa modificar: se informa la novedad y el dato se conserva igual.
    if (!row.account_code) issues.push({ row: excelRow, message: "La fila no tiene código de cuenta contable." });
    if (!row.entry_date_text && row.voucher) issues.push({ row: excelRow, message: "Movimiento sin fecha de elaboración." });
    if (row.debit === null && row.credit === null && row.voucher) {
      issues.push({ row: excelRow, message: "Movimiento sin débito ni crédito." });
    }

    rows.push(row);
  }

  return {
    fileName: file.name,
    headers,
    headerRow: headerRow + 1,
    period,
    rows,
    groupRows,
    emptyRows,
    totalRows: text.length,
    issues,
  };
}

export type HistoryDiff = {
  excel_row: number;
  field: string;
  excel: string;
  app: string;
};

export type HistoryValidation = {
  excelRows: number;
  dbRows: number;
  matching: number;
  different: number;
  missing: number[];
  diffs: HistoryDiff[];
};

const COMPARE: { field: keyof RawHistoryRow; label: string }[] = [
  { field: "entry_date_text", label: "Fecha" },
  { field: "voucher", label: "Comprobante" },
  { field: "sequence", label: "Secuencia" },
  { field: "account_code", label: "Cuenta" },
  { field: "account_name", label: "Nombre cuenta" },
  { field: "provider_nit", label: "NIT" },
  { field: "provider_name", label: "Tercero" },
  { field: "description", label: "Descripción" },
  { field: "detail", label: "Detalle" },
  { field: "cost_center", label: "Centro de costo" },
  { field: "debit", label: "Débito" },
  { field: "credit", label: "Crédito" },
];

const show = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : String(value));

/** Compara fila a fila el Excel contra lo almacenado. No corrige nada: solo reporta. */
export function compareHistory(excelRows: RawHistoryRow[], stored: Record<string, unknown>[]): HistoryValidation {
  const byRow = new Map<number, Record<string, unknown>>();
  for (const row of stored) byRow.set(Number(row['excel_row']), row);
  const diffs: HistoryDiff[] = [];
  const missing: number[] = [];
  let matching = 0;
  const withDiff = new Set<number>();

  for (const row of excelRows) {
    const db = byRow.get(row.excel_row);
    if (!db) {
      missing.push(row.excel_row);
      continue;
    }
    let ok = true;
    for (const { field, label } of COMPARE) {
      const excelValue = row[field];
      const dbValue = db[field];
      const same =
        typeof excelValue === "number" || typeof dbValue === "number"
          ? Number(excelValue ?? 0) === Number(dbValue ?? 0)
          : String(excelValue ?? "") === String(dbValue ?? "");
      if (!same) {
        ok = false;
        diffs.push({ excel_row: row.excel_row, field: label, excel: show(excelValue), app: show(dbValue) });
      }
    }
    if (ok) matching += 1;
    else withDiff.add(row.excel_row);
  }

  return {
    excelRows: excelRows.length,
    dbRows: stored.length,
    matching,
    different: withDiff.size,
    missing,
    diffs,
  };
}