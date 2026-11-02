// Lectura del precedente tributario desde la base (sesión del usuario, RLS por empresa).
import { supabase } from "@/integrations/supabase/client";
import {
  construirPrecedentes,
  type AsientoSincronizado,
  type FacturaSincronizada,
  type ImpuestoConfigurado,
  type LineaSincronizada,
  type MovimientoHistorico,
  type PrecedentesEmpresa,
  type TablaBases,
} from "@/lib/precedente-tributario";

const PAGINA = 1000;
const VIGENCIA_MS = 5 * 60 * 1000;

async function todas<T>(
  consulta: (
    desde: number,
    hasta: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
) {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await consulta(desde, desde + PAGINA - 1);
    if (error) throw new Error(error.message);
    const pagina = (data ?? []) as T[];
    out.push(...pagina);
    if (pagina.length < PAGINA) break;
  }
  return out;
}

const cache = new Map<string, { hasta: number; promesa: Promise<PrecedentesEmpresa> }>();

/** Olvida el precedente cargado (tras sincronizar con Siigo o confirmar una condición). */
export function invalidarPrecedentes(companyId?: string) {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * Precedente de todos los proveedores de la empresa: documentos con identidad en
 * Siigo (facturas y documentos soporte), su IVA por renglón, sus cuentas de
 * impuestos y el auxiliar histórico importado de Siigo.
 */
export function cargarPrecedentes(
  companyId: string,
  taxes: ImpuestoConfigurado[],
): Promise<PrecedentesEmpresa> {
  const previo = cache.get(companyId);
  if (previo && previo.hasta > Date.now()) return previo.promesa;
  const promesa = (async () => {
    const [facturas, lineas, asientos, historico] = await Promise.all([
      todas<FacturaSincronizada>((d, h) =>
        supabase
          .from("invoices")
          .select("id, provider_nit, issue_date, subtotal, iva, retefuente, reteiva, reteica")
          .eq("company_id", companyId)
          .or(
            "siigo_status.eq.sincronizada,status.eq.sincronizada,status.eq.historico,siigo_id.not.is.null,siigo_number.not.is.null",
          )
          .order("id")
          .range(d, h),
      ),
      todas<LineaSincronizada>((d, h) =>
        supabase
          .from("invoice_lines")
          .select("invoice_id, iva, iva_tax_id")
          .eq("company_id", companyId)
          .not("iva_tax_id", "is", null)
          .order("id")
          .range(d, h),
      ),
      todas<AsientoSincronizado>((d, h) =>
        supabase
          .from("journal_lines")
          .select("invoice_id, account_code, debit, credit")
          .eq("company_id", companyId)
          .or(
            "account_code.like.2408%,account_code.like.2365%,account_code.like.2367%,account_code.like.2368%",
          )
          .order("id")
          .range(d, h),
      ),
      todas<MovimientoHistorico>((d, h) =>
        supabase
          .from("accounting_history")
          .select("provider_nit, account_code, debit, credit, period")
          .eq("company_id", companyId)
          .not("provider_nit", "is", null)
          .or(
            "account_code.like.2408%,account_code.like.2365%,account_code.like.2367%,account_code.like.2368%",
          )
          .order("id")
          .range(d, h),
      ).catch(() => [] as MovimientoHistorico[]),
    ]);
    // Solo renglones y asientos de documentos sincronizados.
    const ids = new Set(facturas.map((f) => f.id));
    return construirPrecedentes({
      facturas,
      lineas: lineas.filter((l) => ids.has(l.invoice_id)),
      asientos: asientos.filter((a) => ids.has(a.invoice_id)),
      historico,
      taxes,
    });
  })();
  cache.set(companyId, { hasta: Date.now() + VIGENCIA_MS, promesa });
  promesa.catch(() => cache.delete(companyId));
  return promesa;
}

let tablasCache: { hasta: number; promesa: Promise<TablaBases[]> } | null = null;

/** Olvida las bases mínimas cargadas (tras editarlas). */
export function invalidarTablasBases() {
  tablasCache = null;
}

/** Tablas de bases mínimas (globales), con caché de 5 minutos. Si la tabla aún no existe, lista vacía. */
export function cargarTablasBases(): Promise<TablaBases[]> {
  if (tablasCache && tablasCache.hasta > Date.now()) return tablasCache.promesa;
  const promesa = (async () => {
    const { data, error } = await supabase
      .from("retention_base_tables" as never)
      .select("year, uvt, concepts")
      .order("year", { ascending: false });
    if (error) return [];
    return ((data ?? []) as unknown as TablaBases[]).map((t) => ({
      year: Number(t.year),
      uvt: Number(t.uvt),
      concepts: Array.isArray(t.concepts) ? t.concepts : [],
    }));
  })();
  tablasCache = { hasta: Date.now() + VIGENCIA_MS, promesa };
  return promesa;
}
