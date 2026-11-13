// PILOTO AUTOMÁTICO — lógica pura (empresas con la función «piloto_automatico»).
// Trabaja de noche: desde la hora de inicio (hora de Colombia) hasta las 7 a. m. avanza, en
// orden, los pasos del día; cada llamada del programador hace un paso y guarda en la
// «memoria» (piloto_ejecuciones) lo hecho. Lo que no puede decidir solo lo pregunta por correo
// (piloto_decisiones) y sigue con lo demás. Al terminar la noche envía el reporte.

export type PasoId =
  | "drive"
  | "borradores"
  | "siigo_compras"
  | "egresos"
  | "gastos_bancarios"
  | "conciliacion"
  | "reporte";

export const PASOS: Array<{ id: PasoId; nombre: string }> = [
  { id: "drive", nombre: "Carpetas de Drive (facturas y egresos)" },
  { id: "borradores", nombre: "Borradores de compras (lectura, precedente y causación)" },
  { id: "siigo_compras", nombre: "Aprobar y enviar a Siigo las compras en verde" },
  { id: "egresos", nombre: "Egresos: pagos del mes, CxP de Siigo y recibos de pago" },
  { id: "gastos_bancarios", nombre: "Gastos bancarios del día (RP único al cierre del mes)" },
  { id: "conciliacion", nombre: "Conciliación: movimiento de Siigo, cruce y memoria del día" },
  { id: "reporte", nombre: "Reporte de la noche" },
];

export type EstadoPaso = "hecho" | "pendiente" | "omitido" | "error";

export type PasoRegistro = {
  id: PasoId;
  estado: EstadoPaso;
  inicio: string;
  fin: string | null;
  /** Resumen legible de lo hecho («3 facturas nuevas en la cola»). */
  detalle: string;
  /** Cifras del paso (para el reporte y la memoria). */
  cifras?: Record<string, number>;
  /** Intentos fallidos (se reintenta en la siguiente llamada hasta 3 veces). */
  intentos?: number;
};

const COLOMBIA_MS = -5 * 3600 * 1000;

/** Fecha y hora de Colombia (UTC−5, sin horario de verano). */
export function horaColombia(ahora: Date): { fecha: string; hora: number } {
  const d = new Date(ahora.getTime() + COLOMBIA_MS);
  return { fecha: d.toISOString().slice(0, 10), hora: d.getUTCHours() };
}

/**
 * Noche de trabajo a la que pertenece un momento: desde la hora de inicio hasta las 7 a. m.
 * del día siguiente (la noche lleva la fecha del día en que empezó). Fuera de esa ventana, null.
 */
export function nocheDe(ahora: Date, horaInicio: number, horaFin = 7): string | null {
  const { fecha, hora } = horaColombia(ahora);
  if (hora >= horaInicio) return fecha;
  if (hora < horaFin) {
    const d = new Date(`${fecha}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Siguiente paso por hacer (o null si la noche terminó). Un paso con error se reintenta 3 veces. */
export function siguientePaso(pasos: PasoRegistro[]): PasoId | null {
  for (const p of PASOS) {
    const r = pasos.find((x) => x.id === p.id);
    if (!r) return p.id;
    if (r.estado === "pendiente") return p.id;
    if (r.estado === "error" && (r.intentos ?? 1) < 3) return p.id;
  }
  return null;
}

/** Guarda el resultado de un paso en la lista (reemplaza el anterior del mismo paso). */
export function registrarPaso(pasos: PasoRegistro[], r: PasoRegistro): PasoRegistro[] {
  const previo = pasos.find((x) => x.id === r.id);
  const intentos = r.estado === "error" ? (previo?.intentos ?? 0) + 1 : previo?.intentos;
  return [
    ...pasos.filter((x) => x.id !== r.id),
    { ...r, ...(intentos != null ? { intentos } : {}) },
  ].sort((a, b) => PASOS.findIndex((p) => p.id === a.id) - PASOS.findIndex((p) => p.id === b.id));
}

export type OpcionDecision = { id: string; etiqueta: string };

export type DecisionCorreo = {
  titulo: string;
  pregunta: string;
  opciones: OpcionDecision[];
  token: string;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Enlace firmado para responder una decisión desde el correo (un toque). */
export const enlaceRespuesta = (base: string, token: string, opcion: string) =>
  `${base.replace(/\/$/, "")}/api/piloto/decision?t=${encodeURIComponent(token)}&o=${encodeURIComponent(opcion)}`;

/** Correo con las preguntas pendientes: cada opción es un botón que responde con un toque. */
export function correoDecisionesHtml(p: {
  empresa: string;
  base: string;
  decisiones: DecisionCorreo[];
}): { asunto: string; html: string } {
  const bloques = p.decisiones
    .map(
      (d) => `
    <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0">
      <div style="font-weight:600">${esc(d.titulo)}</div>
      <div style="margin:6px 0 10px">${esc(d.pregunta)}</div>
      ${d.opciones
        .map(
          (o) =>
            `<a href="${esc(enlaceRespuesta(p.base, d.token, o.id))}" style="display:inline-block;margin:0 6px 6px 0;padding:8px 12px;border-radius:6px;background:#1e3a5f;color:#fff;text-decoration:none">${esc(o.etiqueta)}</a>`,
        )
        .join("")}
    </div>`,
    )
    .join("");
  return {
    asunto: `${p.empresa}: ${p.decisiones.length} pregunta(s) del piloto automático`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
      <p>El piloto automático de <b>${esc(p.empresa)}</b> necesita su respuesta. Toque una opción; el proceso sigue con lo demás mientras tanto.</p>
      ${bloques}
      <p style="color:#666;font-size:12px">También puede responder o dar una instrucción adicional en la aplicación: Piloto automático → Bandeja de decisiones (${esc(p.base.replace(/\/$/, ""))}/piloto).</p>
    </div>`,
  };
}

/** Reporte de la noche: pasos, cifras y preguntas pendientes. */
export function reporteHtml(p: {
  empresa: string;
  noche: string;
  pasos: PasoRegistro[];
  pendientes: number;
  base: string;
}): { asunto: string; html: string } {
  const icono: Record<EstadoPaso, string> = {
    hecho: "✔",
    pendiente: "…",
    omitido: "—",
    error: "✖",
  };
  const filas = PASOS.filter((x) => x.id !== "reporte")
    .map((x) => {
      const r = p.pasos.find((y) => y.id === x.id);
      return `<tr><td style="padding:4px 8px">${r ? icono[r.estado] : "—"}</td><td style="padding:4px 8px">${esc(x.nombre)}</td><td style="padding:4px 8px;color:#444">${esc(r?.detalle ?? "No se ejecutó")}</td></tr>`;
    })
    .join("");
  const errores = p.pasos.filter((x) => x.estado === "error").length;
  return {
    asunto: `${p.empresa}: reporte del piloto automático (noche del ${p.noche})${errores ? ` — ${errores} con error` : ""}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
      <p>Reporte del piloto automático de <b>${esc(p.empresa)}</b>, noche del ${esc(p.noche)}.</p>
      <table style="border-collapse:collapse;border:1px solid #ddd">${filas}</table>
      <p>${p.pendientes ? `Quedan <b>${p.pendientes}</b> pregunta(s) esperando su respuesta.` : "No quedan preguntas pendientes."}</p>
      <p style="color:#666;font-size:12px">Detalle y memoria de cada noche en ${esc(p.base.replace(/\/$/, ""))}/piloto</p>
    </div>`,
  };
}
