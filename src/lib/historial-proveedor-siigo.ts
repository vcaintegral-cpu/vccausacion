// Compras anteriores de un proveedor leídas de Siigo: qué retenciones se le practicaron.
// Función pura (sin red): recibe las compras que entrega la API de Siigo y las impuestos de la empresa.
import type { RetencionKind } from "@/lib/retenciones";

type ImpuestoSiigo = { id?: number | string | null; name?: string | null; type?: string | null; percentage?: number | null; value?: number | null };
export type CompraSiigo = {
  name?: string | null;
  date?: string | null;
  supplier?: { identification?: string | number | null } | null;
  retentions?: ImpuestoSiigo[] | null;
  items?: Array<{ taxes?: ImpuestoSiigo[] | null }> | null;
};
export type ImpuestoLocal = { id: string; kind: string; name: string; rate: number; siigo_id: string | null };

export type RetencionHistorica = {
  /** Impuesto de la empresa que corresponde (por su id en Siigo), si se pudo identificar. */
  taxId: string | null;
  nombre: string;
  kind: RetencionKind;
  tarifa: number | null;
  veces: number;
};
export type ResumenProveedorSiigo = {
  compras: number;
  conRetencion: number;
  retenciones: RetencionHistorica[];
  ultimaFecha: string | null;
};

const soloDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
/** NIT sin dígito de verificación: 9 dígitos de empresa; las personas naturales (cédula) se comparan completas. */
export function mismoProveedor(identificacion: unknown, nit: string): boolean {
  const a = soloDigitos(identificacion);
  const b = soloDigitos(nit);
  if (!a || !b) return false;
  return a === b || (a.length === b.length + 1 && a.startsWith(b)) || (b.length === a.length + 1 && b.startsWith(a));
}

function tipoRetencion(t: ImpuestoSiigo, local: ImpuestoLocal | undefined): RetencionKind | null {
  const texto = `${local?.kind ?? ""} ${t.type ?? ""} ${t.name ?? ""}`;
  if (/rete\s*-?\s*iva|reteiva/i.test(texto)) return "reteiva";
  if (/rete\s*-?\s*ica|reteica/i.test(texto)) return "reteica";
  if (local && /^(retefuente|reteiva|reteica)$/.test(local.kind)) return local.kind as RetencionKind;
  if (/rete|retenci/i.test(texto)) return "retefuente";
  return null;
}

/** Resume las retenciones practicadas al proveedor en sus compras de Siigo. */
export function resumirComprasProveedor(compras: CompraSiigo[], nit: string, impuestos: ImpuestoLocal[]): ResumenProveedorSiigo {
  const porSiigo = new Map(impuestos.filter((t) => t.siigo_id).map((t) => [String(t.siigo_id), t]));
  const propias = compras.filter((c) => mismoProveedor(c.supplier?.identification, nit));
  const cuenta = new Map<string, RetencionHistorica>();
  let conRetencion = 0;
  let ultima: string | null = null;
  for (const c of propias) {
    const fecha = c.date ? String(c.date).slice(0, 10) : null;
    if (fecha && (!ultima || fecha > ultima)) ultima = fecha;
    const todas = [...(c.retentions ?? []), ...(c.items ?? []).flatMap((i) => i.taxes ?? [])];
    let tuvo = false;
    const vistos = new Set<string>();
    for (const t of todas) {
      const local = t.id != null ? porSiigo.get(String(t.id)) : undefined;
      const kind = tipoRetencion(t, local);
      if (!kind || !(Number(t.value ?? 1) > 0)) continue;
      const clave = `${kind}|${t.id ?? t.name ?? ""}`;
      if (vistos.has(clave)) continue; // la misma retención en varios renglones cuenta una vez por compra
      vistos.add(clave);
      tuvo = true;
      const previo = cuenta.get(clave);
      if (previo) previo.veces += 1;
      else
        cuenta.set(clave, {
          taxId: local?.id ?? null,
          nombre: local?.name ?? t.name ?? `Retención Siigo ${t.id ?? ""}`.trim(),
          kind,
          tarifa: local ? Number(local.rate) : t.percentage != null ? Number(t.percentage) : null,
          veces: 1,
        });
    }
    if (tuvo) conRetencion += 1;
  }
  return {
    compras: propias.length,
    conRetencion,
    retenciones: [...cuenta.values()].sort((a, b) => b.veces - a.veces),
    ultimaFecha: ultima,
  };
}

/** Texto corto para mostrar el resultado al usuario. */
export function textoResumen(r: ResumenProveedorSiigo): string {
  if (r.compras === 0) return "No se encontraron compras de este proveedor en Siigo en el periodo revisado.";
  const sin = r.compras - r.conRetencion;
  const base = `${r.compras} compra(s) en Siigo${r.ultimaFecha ? ` (la última, ${r.ultimaFecha})` : ""}: ${r.conRetencion} con retención y ${sin} sin retención.`;
  if (!r.retenciones.length) return base;
  return `${base} Retenciones: ${r.retenciones.map((x) => `${x.nombre}${x.tarifa != null ? ` ${x.tarifa}%` : ""} (${x.veces})`).join(" · ")}.`;
}
