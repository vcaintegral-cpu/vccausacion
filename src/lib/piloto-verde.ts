// Semáforo del piloto automático: ¿un borrador puede aprobarse y enviarse a Siigo SIN preguntar?
// Es estricto a propósito: ante cualquier duda queda «por revisar» y se le informa a la usuaria.
import { alertasBorrador, type Alerta } from "@/lib/draft-review";

/** Alertas informativas que no impiden el envío automático (el mes de trabajo ya fija el periodo). */
const ALERTAS_ACEPTADAS = [/periodo anterior/i];

export type EntradaVerde = {
  /** Alertas del borrador (las mismas que ve la usuaria en Borradores). */
  alertas: Alerta[];
  /** ¿La tarea de la carga masiva quedó completada y sin «necesita revisión»? */
  tareaSinRevision: boolean;
  /** Motivo guardado por el recálculo cuando la tarea necesita revisión (para decir POR QUÉ). */
  motivoRevision?: string | null;
  /** Confianza de la decisión de cuenta de cada renglón (ALTA/MEDIA/BAJA). */
  confianzas: Array<string | null | undefined>;
  total: number;
  tope: number;
};

/** Motivos por los que NO es verde (lista vacía = verde). */
export function motivosNoVerde(e: EntradaVerde): string[] {
  const m: string[] = [];
  if (!e.tareaSinRevision)
    m.push(
      e.motivoRevision
        ? `Necesita revisión: ${e.motivoRevision.slice(0, 700)}`
        : "El motor la marcó para revisión.",
    );
  for (const a of e.alertas) {
    if (a.level === "error") m.push(a.message);
    else if (a.level === "warn" && !ALERTAS_ACEPTADAS.some((r) => r.test(a.message)))
      m.push(a.message);
  }
  const dudosas = e.confianzas.filter((c) => c && String(c).toUpperCase() !== "ALTA").length;
  if (dudosas > 0)
    m.push(`${dudosas} renglón(es) con cuenta de confianza media o baja: valide la cuenta.`);
  if (!(e.total > 0)) m.push("Valor total inválido.");
  else if (e.total > e.tope)
    m.push(
      `Supera el tope de aprobación automática (${Math.round(e.tope).toLocaleString("es-CO")}).`,
    );
  return [...new Set(m)];
}

export { alertasBorrador };

// ---------------------------------------------------------------------------
// Egresos / recibos de pago (RP)
// ---------------------------------------------------------------------------
export type EntradaVerdeEgreso = {
  estado: string;
  siigoId: string | null;
  /** Propuesta guardada del egreso (tipo, facturas, forma de pago, ajustes…). */
  propuesta: {
    tipo?: string;
    listo?: boolean;
    motivos?: string[];
    items?: unknown[];
    paymentTypeId?: string | null;
    grupo?: string | null;
    ajuste?: unknown;
    anticipo?: unknown;
    lineas?: unknown[] | null;
  } | null;
  motivos: string[];
  valor: number;
  tope: number;
};

/**
 * Motivos por los que un pago NO se envía solo a Siigo (lista vacía = verde). Solo es verde el pago de
 * facturas completo, de una forma de pago conocida, sin ajustes, anticipos ni líneas adicionales; todo lo
 * demás (abonos, anticipos, pagos detallados, gastos bancarios) lo decide la usuaria.
 */
export function motivosNoVerdeEgreso(e: EntradaVerdeEgreso): string[] {
  const m: string[] = [];
  const p = e.propuesta;
  if (e.siigoId) m.push("Ya está en Siigo.");
  if (!["listo", "aprobado"].includes(e.estado))
    m.push(e.motivos[0] ?? "La propuesta no está completa: revísela en Egresos.");
  if (!p) return [...m, "Sin propuesta."];
  if (p.listo !== true) m.push(p.motivos?.[0] ?? e.motivos[0] ?? "La propuesta no está completa.");
  if (p.tipo !== "pago_facturas")
    m.push(
      `Solo se envían solos los pagos de facturas completos; este es de tipo «${p.tipo ?? "desconocido"}».`,
    );
  if (p.grupo) m.push("Gasto bancario: va en el RP único del banco del mes.");
  if (p.ajuste || p.anticipo || (p.lineas?.length ?? 0) > 0)
    m.push("Tiene ajuste al peso, anticipo o líneas adicionales: revíselo.");
  if (!p.items?.length) m.push("No hay facturas a las que aplicar el pago.");
  if (!p.paymentTypeId) m.push("Falta la forma de pago de Siigo.");
  if (!(e.valor > 0)) m.push("Valor inválido.");
  else if (e.valor > e.tope)
    m.push(
      `Supera el tope de aprobación automática (${Math.round(e.tope).toLocaleString("es-CO")}).`,
    );
  return [...new Set(m)];
}
