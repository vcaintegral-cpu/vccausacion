export const IMPORT_BATCH_SIZE = 500;

export type ImportIssue = {
  row: number | null;
  key: string;
  message: string;
  batch?: number;
};

export type ImportStatus = "COMPLETADA" | "COMPLETADA CON ERRORES" | "INCOMPLETA" | "FALLIDA";

export type ImportProgress = {
  batch: number;
  batches: number;
  from: number;
  to: number;
  total: number;
  processed: number;
};

export type ImportDetail = {
  module: string;
  fileName: string;
  importedAt: string;
  user: string;
  found: number;
  valid: number;
  invalid: number;
  processed: number;
  saved: number;
  rejected: number;
  duplicates: number;
  errors: number;
  newRows: number;
  updated: number;
  unchanged: number;
  batches: number;
  batchesProcessed: number;
  missing: number;
  status: ImportStatus;
  issues: ImportIssue[];
};

type ReliableImportOptions<T> = {
  module: string;
  fileName: string;
  user?: string | null;
  found: number;
  rows: T[];
  invalidIssues?: ImportIssue[];
  duplicateCount?: number;
  keyOf: (row: T) => string;
  rowNumberOf?: (row: T, index: number) => number | null;
  existingByKey?: Map<string, T>;
  equals?: (current: T, incoming: T) => boolean;
  saveBatch: (rows: T[]) => Promise<{ error: { message: string; details?: string | null; hint?: string | null } | null }>;
  verifyKeys: () => Promise<Set<string>>;
  onProgress?: (progress: ImportProgress) => void;
};

function errorText(error: { message: string; details?: string | null; hint?: string | null }) {
  return [error.message, error.details, error.hint].filter(Boolean).join(" — ");
}

/**
 * Ejecutor único para importaciones. Recorre todos los registros en lotes de 500,
 * aísla filas defectuosas sin detener lotes posteriores y verifica las llaves en la base.
 */
export async function runReliableImport<T>(options: ReliableImportOptions<T>): Promise<ImportDetail> {
  const invalidIssues = options.invalidIssues ?? [];
  const duplicateCount = options.duplicateCount ?? 0;
  const issues: ImportIssue[] = [...invalidIssues];
  let attempted = 0;
  let batchesProcessed = 0;
  const total = options.rows.length;

  const newRows = options.existingByKey
    ? options.rows.filter((row) => !options.existingByKey?.has(options.keyOf(row))).length
    : total;
  const unchanged = options.existingByKey && options.equals
    ? options.rows.filter((row) => {
        const current = options.existingByKey?.get(options.keyOf(row));
        return current ? options.equals?.(current, row) === true : false;
      }).length
    : 0;
  const updated = Math.max(0, total - newRows - unchanged);
  const rowsToSave = options.existingByKey && options.equals
    ? options.rows.filter((row) => {
        const current = options.existingByKey?.get(options.keyOf(row));
        return !current || options.equals?.(current, row) !== true;
      })
    : options.rows;
  const batches = Math.ceil(rowsToSave.length / IMPORT_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
    const fromIndex = batchIndex * IMPORT_BATCH_SIZE;
    const batch = rowsToSave.slice(fromIndex, fromIndex + IMPORT_BATCH_SIZE);
    options.onProgress?.({
      batch: batchIndex + 1,
      batches,
      from: fromIndex + 1,
      to: fromIndex + batch.length,
      total: rowsToSave.length,
      processed: attempted,
    });
    const result = await options.saveBatch(batch);
    if (!result.error) {
      attempted += batch.length;
    } else {
      // Un error de lote no oculta cuáles filas fallaron: se reintenta una por una.
      for (let rowIndex = 0; rowIndex < batch.length; rowIndex += 1) {
        const row = batch[rowIndex];
        if (!row) continue;
        const single = await options.saveBatch([row]);
        attempted += 1;
        if (single.error) {
          issues.push({
            row: options.rowNumberOf?.(row, fromIndex + rowIndex) ?? fromIndex + rowIndex + 1,
            key: options.keyOf(row),
            message: errorText(single.error),
            batch: batchIndex + 1,
          });
        }
      }
    }
    batchesProcessed += 1;
  }

  const storedKeys = await options.verifyKeys();
  const missingKeys = options.rows.map(options.keyOf).filter((key) => !storedKeys.has(key));
  for (const key of missingKeys) {
    if (!issues.some((issue) => issue.key === key)) {
      issues.push({ row: null, key, message: "El registro no apareció en la verificación posterior de la base de datos." });
    }
  }

  const saved = options.rows.length - missingKeys.length;
  const processed = total + invalid + duplicateCount;
  const invalid = invalidIssues.length;
  const saveErrors = issues.filter((issue) => !invalidIssues.includes(issue)).length;
  let status: ImportStatus;
  const rejected = invalid + missingKeys.length;
  const reconciled = options.found === saved + rejected + duplicateCount;
  if (total > 0 && saved === 0) status = "FALLIDA";
  else if (!reconciled || missingKeys.length > 0) status = "INCOMPLETA";
  else if (invalid > 0 || duplicateCount > 0 || saveErrors > 0) status = "COMPLETADA CON ERRORES";
  else status = "COMPLETADA";

  return {
    module: options.module,
    fileName: options.fileName,
    importedAt: new Date().toISOString(),
    user: options.user?.trim() || "Usuario autenticado",
    found: options.found,
    valid: total,
    invalid,
    processed,
    saved,
    rejected,
    duplicates: duplicateCount,
    errors: saveErrors,
    newRows,
    updated,
    unchanged,
    batches,
    batchesProcessed,
    missing: missingKeys.length,
    status,
    issues,
  };
}

export async function fetchAllKeys(
  fetchPage: (from: number, to: number) => Promise<{ keys: string[]; error?: string }>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error);
    result.keys.forEach((key) => keys.add(key));
    if (result.keys.length < pageSize) break;
  }
  return keys;
}

export function sameImportValues<T extends object>(fields: (keyof T)[]) {
  return (current: T, incoming: T) => fields.every((field) => (current[field] ?? null) === (incoming[field] ?? null));
}