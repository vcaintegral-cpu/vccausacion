// Cuenta contable por proveedor: aplicar UNA cuenta (y, si se quiere, la clasificación) a todas las facturas
// del proveedor sin abrirlas una por una. Reglas:
//  - Solo facturas de ESE proveedor (empresa + NIT normalizado, nunca por nombre).
//  - Solo se modifican borradores sin comprobante ni Siigo; las aprobadas, causadas, sincronizadas o históricas
//    NO se tocan y se advierten antes (para cambiarlas hay que devolverlas a borrador / revertir la causación).
//  - No cambia NIT, valores, impuestos, fechas ni centro de costo: solo la cuenta (y clasificación) de los renglones.
//  - Deja historial en cada factura (raw_extraction.historial_cambios) y, si se pide, la regla del proveedor.
//  - Después de escribir, RELEE la base y verifica factura por factura que la cuenta quedó guardada.
import { supabase } from "@/lib/db-contextual";
import { asignarCuentaGasto } from "@/lib/asignar-cuenta-gasto";
import type { BulkConfig } from "@/lib/bulk-invoices";

export const nitNormalizado = (nit?: string | null) =>
  String(nit ?? "").trim().split("-")[0]!.replace(/\D/g, "");

export type FacturaProveedor = {
  id: string;
  label: string;
  status: string;
  modificable: boolean;
  motivo: string | null;
};

type FilaFactura = {
  id: string;
  prefix: string | null;
  number: string | null;
  status: string | null;
  siigo_status: string | null;
  siigo_id: string | null;
  voucher_number: string | null;
};

const ESTADO_TEXTO: Record<string, string> = {
  aprobado: "aprobada",
  causada: "causada (tiene comprobante)",
  sincronizando: "en envío a Siigo",
  sincronizada: "sincronizada con Siigo",
  historico: "en el histórico",
};

/** ¿Se puede cambiar la cuenta? Solo borradores/errores sin comprobante ni documento en Siigo. */
export function clasificarFactura(f: FilaFactura): FacturaProveedor {
  const label = [f.prefix, f.number].filter(Boolean).join("-") || "Sin número";
  const status = String(f.status ?? "");
  let motivo: string | null = null;
  if (f.siigo_id || f.siigo_status === "sincronizada") motivo = "ya está en Siigo";
  else if (f.voucher_number) motivo = "ya tiene comprobante contable";
  else if (status !== "borrador" && status !== "error")
    motivo = `está ${ESTADO_TEXTO[status] ?? status}`;
  return { id: f.id, label, status, modificable: motivo === null, motivo };
}

/** Todas las facturas de compra del proveedor en la empresa, con la marca de si se pueden modificar. */
export async function listarFacturasDelProveedor(
  companyId: string,
  nit: string,
): Promise<FacturaProveedor[]> {
  const base = nitNormalizado(nit);
  if (!base) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select("id, prefix, number, status, siigo_status, siigo_id, voucher_number, provider_nit")
    .eq("company_id", companyId)
    .eq("doc_kind", "compra")
    .like("provider_nit", `${base}%`)
    .limit(2000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Array<FilaFactura & { provider_nit: string | null }>)
    .filter((f) => nitNormalizado(f.provider_nit) === base)
    .map(clasificarFactura);
}

/** Verificación pura: ¿todas las facturas quedaron con la cuenta en todos sus renglones? */
export function verificarLineas(
  lineas: Array<{ invoice_id: string; account_code: string | null }>,
  ids: string[],
  code: string,
): { verificadas: string[]; fallidas: Array<{ id: string; motivo: string }> } {
  const porFactura = new Map<string, string[]>();
  for (const l of lineas) {
    const arr = porFactura.get(l.invoice_id) ?? [];
    arr.push(String(l.account_code ?? "").trim());
    porFactura.set(l.invoice_id, arr);
  }
  const verificadas: string[] = [];
  const fallidas: Array<{ id: string; motivo: string }> = [];
  for (const id of ids) {
    const cuentas = porFactura.get(id);
    if (!cuentas || cuentas.length === 0) {
      fallidas.push({ id, motivo: "la factura no tiene renglones guardados" });
      continue;
    }
    const otras = [...new Set(cuentas.filter((c) => c !== code))];
    if (otras.length) fallidas.push({ id, motivo: `quedaron renglones con otra cuenta (${otras.map((c) => c || "sin cuenta").join(", ")})` });
    else verificadas.push(id);
  }
  return { verificadas, fallidas };
}

export type ResultadoProveedor = {
  actualizadas: number;
  omitidas: FacturaProveedor[];
  verificadas: number;
  fallidas: Array<{ id: string; label: string; motivo: string }>;
  reglaGuardada: boolean;
};

export async function aplicarCuentaAlProveedor(params: {
  companyId: string;
  nit: string;
  nombre: string | null;
  facturas: FacturaProveedor[];
  cuenta: { code: string; name: string | null };
  tipo?: "producto" | "gasto";
  recordarRegla: boolean;
  usuario: string | null;
  config: BulkConfig;
  inventario: boolean;
  onAvance?: (hechas: number, total: number) => void;
}): Promise<ResultadoProveedor> {
  const objetivo = params.facturas.filter((f) => f.modificable);
  const omitidas = params.facturas.filter((f) => !f.modificable);
  const etiqueta = new Map(params.facturas.map((f) => [f.id, f.label]));
  const fallidas: ResultadoProveedor["fallidas"] = [];
  let hechas = 0;
  const nota = `Cuenta ${params.cuenta.code} aplicada a todas las facturas del proveedor desde Borradores.`;
  for (let i = 0; i < objetivo.length; i += 4) {
    await Promise.all(
      objetivo.slice(i, i + 4).map(async (f) => {
        try {
          const r = await asignarCuentaGasto(f.id, params.cuenta, params.config, {
            inventario: params.inventario,
            todos: true,
            ...(params.tipo ? { tipo: params.tipo } : {}),
            historial: { usuario: params.usuario, nota },
          });
          if (!r.ok) fallidas.push({ id: f.id, label: f.label, motivo: r.message });
        } catch (e) {
          fallidas.push({ id: f.id, label: f.label, motivo: e instanceof Error ? e.message : "error inesperado" });
        } finally {
          hechas += 1;
          params.onAvance?.(hechas, objetivo.length);
        }
      }),
    );
  }
  // Verificación real: se relee la base (no se confía en el mensaje de cada operación).
  const idsOk = objetivo.map((f) => f.id).filter((id) => !fallidas.some((x) => x.id === id));
  let verificadas = 0;
  if (idsOk.length) {
    const lineas: Array<{ invoice_id: string; account_code: string | null }> = [];
    for (let i = 0; i < idsOk.length; i += 100) {
      const { data, error } = await supabase
        .from("invoice_lines")
        .select("invoice_id, account_code")
        .in("invoice_id", idsOk.slice(i, i + 100));
      if (error) throw new Error(`No se pudo verificar lo guardado: ${error.message}`);
      lineas.push(...((data ?? []) as Array<{ invoice_id: string; account_code: string | null }>));
    }
    const v = verificarLineas(lineas, idsOk, params.cuenta.code);
    verificadas = v.verificadas.length;
    for (const f of v.fallidas) fallidas.push({ ...f, label: etiqueta.get(f.id) ?? f.id });
  }
  let reglaGuardada = false;
  if (params.recordarRegla && verificadas > 0) reglaGuardada = await guardarReglaProveedor(params);
  return { actualizadas: objetivo.length - fallidas.length, omitidas, verificadas, fallidas, reglaGuardada };
}

/** Deja la cuenta como regla del proveedor («(todas)») para sus próximas facturas. */
async function guardarReglaProveedor(p: {
  companyId: string;
  nit: string;
  nombre: string | null;
  cuenta: { code: string; name: string | null };
  usuario: string | null;
}): Promise<boolean> {
  const { data: existente } = await supabase
    .from("provider_rules")
    .select("id")
    .eq("company_id", p.companyId)
    .eq("provider_nit", p.nit)
    .eq("keyword", "(todas)")
    .maybeSingle();
  const campos = {
    expense_account: p.cuenta.code,
    expense_account_name: p.cuenta.name,
    active: true,
    source: "manual",
  };
  const r = existente?.id
    ? await supabase.from("provider_rules").update(campos as never).eq("id", existente.id)
    : await supabase.from("provider_rules").insert({
        company_id: p.companyId,
        provider_nit: p.nit,
        provider_name: p.nombre,
        keyword: "(todas)",
        iva_treatment: "descontable",
        created_by: p.usuario,
        ...campos,
      } as never);
  return !r.error;
}
