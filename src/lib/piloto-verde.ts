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
  /** Confianza de la decisión de cuenta de cada renglón (ALTA/MEDIA/BAJA). */
  confianzas: Array<string | null | undefined>;
  total: number;
  tope: number;
};

/** Motivos por los que NO es verde (lista vacía = verde). */
export function motivosNoVerde(e: EntradaVerde): string[] {
  const m: string[] = [];
  if (!e.tareaSinRevision) m.push("El motor la marcó para revisión.");
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
