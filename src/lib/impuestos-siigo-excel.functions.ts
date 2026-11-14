// Importación del reporte de impuestos de Siigo en Excel (función «impuestos_excel_siigo»).
// El archivo se lee en el navegador (valores crudos de «Hoja1») y se vuelve a interpretar y
// validar aquí, contra el catálogo de cuentas de la empresa, antes de guardar nada.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  compararImportacion,
  leerImpuestosSiigo,
  registrosParaGuardar,
  validarImpuestos,
  type CuentaCatalogo,
  type FilaComparacion,
  type Hallazgo,
  type ImpuestoExcel,
} from "@/lib/impuestos-siigo-excel";

type Db = import("@supabase/supabase-js").SupabaseClient;
type Entrada = { companyId: string; hoja: string; matriz: unknown[][] };

const validarEntrada = (input: Entrada) => {
  if (!input?.companyId) throw new Error("companyId requerido");
  if (!Array.isArray(input.matriz) || input.matriz.length === 0)
    throw new Error("El archivo está vacío.");
  if (input.matriz.length > 2000)
    throw new Error("El archivo tiene demasiadas filas para ser el reporte de impuestos.");
  // Solo valores simples de celda (texto, número, vacío).
  const celdasOk = input.matriz.every(
    (f) =>
      Array.isArray(f) &&
      f.every(
        (v) =>
          v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean",
      ),
  );
  if (!celdasOk) throw new Error("Formato de archivo no válido.");
  return input;
};

async function verificarEmpresa(db: Db, companyId: string) {
  const { data, error } = await db.from("companies").select("nit").eq("id", companyId).single();
  if (error || !data) throw new Error("Empresa no encontrada.");
  const { funcionActiva } = await import("@/empresas/registro");
  if (!funcionActiva((data as { nit: string | null }).nit, "impuestos_excel_siigo"))
    throw new Error(
      "La importación del Excel de impuestos de Siigo no está habilitada para esta empresa.",
    );
}

async function catalogo(db: Db, companyId: string): Promise<CuentaCatalogo[]> {
  const out: CuentaCatalogo[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("puc_accounts")
      .select("code, name, active, is_movement, has_children")
      .eq("company_id", companyId)
      .order("code")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as CuentaCatalogo[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

export type RevisionImpuestos = {
  hoja: string;
  filaEncabezado: number;
  impuestos: ImpuestoExcel[];
  hallazgos: Hallazgo[];
  cuentasCatalogo: number;
};

async function revisar(db: Db, data: Entrada): Promise<RevisionImpuestos> {
  await verificarEmpresa(db, data.companyId);
  const lectura = leerImpuestosSiigo(data.matriz, data.hoja);
  if (!lectura.impuestos.length)
    throw new Error("El archivo no trae impuestos debajo de los encabezados.");
  const cat = await catalogo(db, data.companyId);
  if (!cat.length)
    throw new Error(
      "La empresa no tiene catálogo de cuentas. Sincronice primero las cuentas contables desde Siigo para validar el archivo.",
    );
  return {
    ...lectura,
    hallazgos: validarImpuestos(lectura.impuestos, cat),
    cuentasCatalogo: cat.length,
  };
}

/** Lee y valida el archivo sin guardar nada. */
export const impuestosExcelRevisar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validarEntrada)
  .handler(async ({ data, context }) => revisar(context.supabase as unknown as Db, data));

export type ResultadoImportacion = RevisionImpuestos & {
  comparacion: FilaComparacion[];
  aprobada: boolean;
  guardados: number;
  /** Impuestos del archivo que aún no tienen el identificador de Siigo (sincronizar). */
  sinIdSiigo: string[];
};

/**
 * Guarda los impuestos SOLO si no hay errores y, si hay advertencias, la usuaria confirmó que
 * las validó. Después lee lo guardado y compara cada cuenta con el archivo.
 */
export const impuestosExcelImportar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: Entrada & { confirmoAdvertencias: boolean }) => validarEntrada(input) && input,
  )
  .handler(async ({ data, context }): Promise<ResultadoImportacion> => {
    const db = context.supabase as unknown as Db;
    const rev = await revisar(db, data);
    const errores = rev.hallazgos.filter((h) => h.nivel === "error");
    if (errores.length)
      throw new Error(
        `No se importó nada: el archivo tiene ${errores.length} error(es) que debe corregir en Siigo o en el catálogo. Revise el detalle.`,
      );
    if (rev.hallazgos.some((h) => h.nivel === "advertencia") && !data.confirmoAdvertencias)
      throw new Error("Hay inconsistencias para validar: confírmelas antes de importar.");

    const registros = registrosParaGuardar(data.companyId, rev.impuestos);
    const { error } = await db
      .from("tax_rates")
      .upsert(registros, { onConflict: "company_id,kind,name" });
    if (error) throw new Error(error.message);

    const { data: guardados, error: e2 } = await db
      .from("tax_rates")
      .select(
        "kind, name, siigo_id, account_code, account_sales, account_sales_return, account_purchase_return",
      )
      .eq("company_id", data.companyId)
      .eq("source", "excel_siigo");
    if (e2) throw new Error(e2.message);
    const filas = (guardados ?? []) as Array<Record<string, unknown>>;
    const comparacion = compararImportacion(rev.impuestos, filas, rev.hallazgos);
    const clave = (k: unknown, n: unknown) => `${String(k)}|${String(n)}`;
    const conId = new Set(
      filas.filter((f) => f["siigo_id"]).map((f) => clave(f["kind"], f["name"])),
    );
    return {
      ...rev,
      comparacion,
      aprobada: comparacion.every((c) => c.coincide),
      guardados: registros.length,
      sinIdSiigo: registros
        .filter((r) => !conId.has(clave(r.kind, r.name)))
        .map((r) => `${r.excel_code} ${r.name}`),
    };
  });
