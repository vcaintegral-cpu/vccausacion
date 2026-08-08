// Análisis del Excel del PUC: lee TODAS las filas, valida y reporta errores por fila.
import { pick, type SheetRow } from "@/lib/spreadsheet";

export type PucRow = {
  company_id: string;
  code: string;
  name: string;
  nature: string;
  active: boolean;
  source: "excel";
};

export type PucRowError = { rowNumber: number; code: string; problema: string; accion: string };

export type PucParseResult = {
  rowsRead: number;
  valid: PucRow[];
  duplicates: number;
  errors: PucRowError[];
  columns: string[];
  firstCode: string | null;
  lastCode: string | null;
};

/** Convierte las filas del Excel en cuentas del PUC. El código se conserva como TEXTO. */
export function parsePucSheet(
  sheet: { row: SheetRow; rowNumber: number }[],
  companyId: string,
): PucParseResult {
  const valid: PucRow[] = [];
  const errors: PucRowError[] = [];
  const seen = new Map<string, number>();
  let duplicates = 0;

  for (const { row, rowNumber } of sheet) {
    const code = pick(row, "codigo cuenta", "codigo", "cuenta", "code", "cuenta contable", "codigo contable")
      .replace(/\s+/g, "");
    const name = pick(
      row,
      "nombre cuenta",
      "nombre de la cuenta",
      "nombre",
      "descripcion cuenta",
      "descripcion",
      "detalle",
      "concepto",
      "name",
      "description",
    ).trim();

    if (!code) {
      // Fila sin código: puede ser un separador; solo se reporta si tiene nombre.
      if (name) {
        errors.push({ rowNumber, code: "", problema: "Código de cuenta vacío.", accion: "Cuenta no importada." });
      }
      continue;
    }
    if (!/^[0-9]+$/.test(code)) {
      errors.push({ rowNumber, code, problema: "El código contiene caracteres no numéricos.", accion: "Cuenta no importada." });
      continue;
    }
    if (!name) {
      errors.push({ rowNumber, code, problema: "Nombre de cuenta vacío.", accion: "Cuenta no importada." });
      continue;
    }
    const prev = seen.get(code);
    if (prev !== undefined) {
      duplicates += 1;
      errors.push({
        rowNumber,
        code,
        problema: `Código repetido (ya aparece en la fila ${prev}).`,
        accion: "Duplicado evitado: se conserva la primera fila.",
      });
      continue;
    }
    seen.set(code, rowNumber);
    valid.push({
      company_id: companyId,
      code,
      name,
      nature: /cr/i.test(pick(row, "naturaleza", "movimiento", "nature")) ? "credito" : "debito",
      active: !/^(no|inactiva|inactivo|false|0)$/i.test(pick(row, "activa", "activo", "estado", "active")),
      source: "excel",
    });
  }

  const ordenados = [...valid].map((v) => v.code).sort(compareCodes);
  return {
    rowsRead: sheet.length,
    valid,
    duplicates,
    errors,
    columns: sheet[0] ? Object.keys(sheet[0].row) : [],
    firstCode: ordenados[0] ?? null,
    lastCode: ordenados[ordenados.length - 1] ?? null,
  };
}

/** Orden textual estable de códigos contables (nunca se convierten a número). */
export function compareCodes(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: false });
}
