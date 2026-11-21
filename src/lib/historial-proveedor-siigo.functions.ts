// Compras anteriores de un proveedor en Siigo (todas las empresas con Siigo conectado).
// Solo lee: no guarda nada. El usuario decide si aplica la retención encontrada.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  mismoProveedor,
  resumirComprasProveedor,
  type CompraSiigo,
  type ImpuestoLocal,
  type ResumenProveedorSiigo,
} from "@/lib/historial-proveedor-siigo";

export type HistorialProveedorSiigo = {
  escaneadas: number;
  completo: boolean;
  encontradas: number;
  revisadas: number;
  resumen: ResumenProveedorSiigo;
};

const MAX_PAGINAS = 30;
const MAX_DETALLE = 8;
const PRESUPUESTO_MS = 40_000;

export const consultarHistorialProveedorSiigo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; nit: string; meses?: number }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    if (!/\d{5,}/.test(String(input?.nit ?? ""))) throw new Error("NIT del proveedor requerido");
    return { companyId: input.companyId, nit: String(input.nit), meses: Math.min(Math.max(Number(input.meses) || 12, 1), 36) };
  })
  .handler(async ({ data, context }): Promise<HistorialProveedorSiigo> => {
    const db = context.supabase;
    // La empresa debe ser visible para el usuario (RLS).
    const { data: emp, error: empErr } = await db.from("companies").select("id").eq("id", data.companyId).maybeSingle();
    if (empErr || !emp) throw new Error("Empresa no encontrada.");
    const { data: tax } = await db
      .from("tax_rates")
      .select("id, kind, name, rate, siigo_id")
      .eq("company_id", data.companyId)
      .in("kind", ["retefuente", "reteiva", "reteica"]);
    const impuestos = ((tax ?? []) as Array<{ id: string; kind: string; name: string; rate: number; siigo_id: string | null }>).map(
      (t): ImpuestoLocal => ({ id: t.id, kind: t.kind, name: t.name, rate: Number(t.rate), siigo_id: t.siigo_id }),
    );
    const { siigoGet, siigoUseCompany } = await import("./siigo.server");
    await siigoUseCompany(data.companyId);
    const desde = new Date();
    desde.setUTCMonth(desde.getUTCMonth() - data.meses);
    const inicio = Date.now();
    const encontradas: CompraSiigo[] = [];
    let escaneadas = 0;
    let completo = false;
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina += 1) {
      if (Date.now() - inicio > PRESUPUESTO_MS) break;
      // El listado de compras de Siigo filtra por fecha de CREACIÓN (created_start).
      const r = await siigoGet<{ results?: Array<CompraSiigo & { id?: string }> } | Array<CompraSiigo & { id?: string }>>(
        `/v1/purchases?created_start=${desde.toISOString().slice(0, 10)}&page=${pagina}&page_size=100`,
      );
      const lista = Array.isArray(r) ? r : (r.results ?? []);
      escaneadas += lista.length;
      encontradas.push(...lista.filter((c) => mismoProveedor(c.supplier?.identification, data.nit)));
      if (lista.length < 100) {
        completo = true;
        break;
      }
    }
    // Las más recientes, con su detalle (el listado puede no traer las retenciones).
    const recientes = [...encontradas]
      .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
      .slice(0, MAX_DETALLE) as Array<CompraSiigo & { id?: string }>;
    const detalles: CompraSiigo[] = [];
    for (const c of recientes) {
      if (!c.id) {
        detalles.push(c);
        continue;
      }
      try {
        detalles.push(await siigoGet<CompraSiigo>(`/v1/purchases/${encodeURIComponent(c.id)}`));
      } catch {
        detalles.push(c);
      }
    }
    return {
      escaneadas,
      completo,
      encontradas: encontradas.length,
      revisadas: detalles.length,
      resumen: resumirComprasProveedor(detalles, data.nit, impuestos),
    };
  });
