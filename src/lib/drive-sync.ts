// Reglas puras del importador desde Google Drive (sin red ni base de datos).
//
// Estructura esperada de la carpeta de la empresa (ej. LED LIGHTS):
//   <raíz>/2026/10. OCTUBRE/FACTURAS/<PROVEEDOR>/<archivo>.pdf
// El nombre del PDF puede traer el pago ya hecho como prefijo:
//   "Corriente16 - fv0900047217....pdf"   → pagado desde la cuenta corriente el día 16
//   "Efectivo+Corriente01 - ....pdf"      → pagado con efectivo y cuenta corriente el día 01
// Sin prefijo, la factura aún no tiene pago registrado.

export const MESES = [
  "ENERO",
  "FEBRERO",
  "MARZO",
  "ABRIL",
  "MAYO",
  "JUNIO",
  "JULIO",
  "AGOSTO",
  "SEPTIEMBRE",
  "OCTUBRE",
  "NOVIEMBRE",
  "DICIEMBRE",
] as const;

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const normalizar = (s: string) => sinTildes(s).toUpperCase().replace(/\s+/g, " ").trim();

/** Mes (1-12) de una carpeta como "10. OCTUBRE", "6. JUNIO", "SETIEMBRE"; null si no es una carpeta de mes. */
export function mesDeCarpeta(nombre: string): number | null {
  const n = normalizar(nombre);
  const conNumero = /^(\d{1,2})\s*[.\-_)]?\s*([A-Z]+)?/.exec(n);
  if (conNumero) {
    const num = Number(conNumero[1]);
    const palabra = conNumero[2];
    if (num >= 1 && num <= 12) {
      if (!palabra) return num;
      const porNombre = mesPorNombre(palabra);
      // Si el número y el nombre se contradicen, no se adivina.
      return porNombre === null || porNombre === num ? num : null;
    }
    return null;
  }
  return mesPorNombre(n);
}

function mesPorNombre(palabra: string): number | null {
  const p = palabra === "SETIEMBRE" ? "SEPTIEMBRE" : palabra;
  const idx = MESES.findIndex((m) => m === p);
  return idx >= 0 ? idx + 1 : null;
}

/** true si la carpeta es exactamente un año ("2026"). */
export function esCarpetaAnio(nombre: string, anio: number): boolean {
  return normalizar(nombre) === String(anio);
}

/** true para la carpeta de facturas de compra del mes ("FACTURAS", "Facturas "). */
export function esCarpetaFacturas(nombre: string): boolean {
  return normalizar(nombre) === "FACTURAS";
}

export type Periodo = { anio: number; mes: number };

/**
 * Periodos a revisar en una ejecución: el mes actual y el anterior, porque
 * las facturas de un mes siguen llegando durante los primeros días del siguiente.
 * La fecha se evalúa en hora de Colombia (UTC-5, sin horario de verano).
 */
export function periodosARevisar(ahora: Date): Periodo[] {
  const col = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
  const anio = col.getUTCFullYear();
  const mes = col.getUTCMonth() + 1;
  const anterior = mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
  return [{ anio, mes }, anterior];
}

export function etiquetaPeriodo(p: Periodo): string {
  return `${MESES[p.mes - 1]} ${p.anio}`;
}

export type MedioPagoDrive = "corriente" | "ahorros" | "efectivo" | "davivienda" | "bold" | "wompi";

const MEDIOS: Record<string, MedioPagoDrive> = {
  CORRIENTE: "corriente",
  CTE: "corriente",
  AHORROS: "ahorros",
  EFECTIVO: "efectivo",
  CAJA: "efectivo",
  DAVIVIENDA: "davivienda",
  BOLD: "bold",
  WOMPI: "wompi",
};

export type PistaPago = { medios: MedioPagoDrive[]; dia: number | null };

/**
 * Lee el prefijo de pago del nombre del archivo ("Corriente16 - ...").
 * Devuelve null si el archivo no trae prefijo (factura sin pago registrado)
 * o si el prefijo no es reconocible; nunca adivina un medio.
 */
export function pistaDePago(nombreArchivo: string): PistaPago | null {
  const m = /^\s*([A-Za-zÁÉÍÓÚáéíóú]+(?:\s*\+\s*[A-Za-zÁÉÍÓÚáéíóú]+)*)\s*(\d{1,2})?\s+-\s+/.exec(
    nombreArchivo,
  );
  if (!m) return null;
  const medios: MedioPagoDrive[] = [];
  for (const parte of m[1]!.split("+")) {
    const medio = MEDIOS[normalizar(parte)];
    if (!medio) return null;
    if (!medios.includes(medio)) medios.push(medio);
  }
  const dia = m[2] ? Number(m[2]) : null;
  if (dia !== null && (dia < 1 || dia > 31)) return null;
  return { medios, dia };
}

/** Solo se importan PDF: los XML/ZIP/imágenes de la carpeta se ignoran. */
export function esPdf(nombre: string, mimeType: string | null | undefined): boolean {
  return mimeType === "application/pdf" || /\.pdf$/i.test(nombre);
}

/** Nombre seguro para Storage, igual criterio que la carga de ZIP. */
export function nombreSeguro(nombre: string): string {
  return nombre.replace(/[^\w.-]/g, "_");
}

/** Extrae el ID de carpeta de un enlace de Drive o lo devuelve tal cual si ya es un ID. */
export function idDeCarpetaDrive(enlaceOId: string): string | null {
  const v = enlaceOId.trim();
  const porRuta = /\/folders\/([\w-]{10,})/.exec(v);
  if (porRuta) return porRuta[1]!;
  const porParametro = /[?&]id=([\w-]{10,})/.exec(v);
  if (porParametro) return porParametro[1]!;
  return /^[\w-]{10,}$/.test(v) ? v : null;
}
