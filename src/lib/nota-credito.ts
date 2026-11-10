// Notas crédito de compra: la herramienta NUNCA las causa ni las envía a Siigo.
//
// La API de Siigo solo crea notas crédito sobre facturas de VENTA (/v1/credit-notes);
// las de compra se registran manualmente en Siigo, con el comprobante de notas crédito,
// sobre la factura de compra ya causada. Este módulo reconoce la nota (Excel RECIBIDOS,
// lectura del PDF/XML o borrador ya guardado), ubica la factura afectada y arma el aviso
// que se muestra en pantalla. Alcance: todas las empresas.
import { cop } from "@/lib/format";

/** Inicio fijo del aviso: permite reconocerlo en cualquier pantalla o registro. */
export const AVISO_NOTA_CREDITO = "NOTA CRÉDITO — REGISTRO MANUAL EN SIIGO.";

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** true si el mensaje (error de una tarea, de un envío, etc.) es el aviso de nota crédito. */
export function esAvisoNotaCredito(mensaje: string | null | undefined): boolean {
  if (!mensaje) return false;
  return /NOTA CREDITO\s+[—-]\s+REGISTRO MANUAL EN SIIGO|NOTA_CREDITO_REVISION_MANUAL/i.test(
    sinTildes(mensaje),
  );
}

export type FacturaReferida = { prefijo: string; numero: string };

/**
 * Factura afectada escrita en la nota ("SE APLICA A FACTURA CFA 109836 - CAMBIO DE REFERENCIA",
 * "Factura referencia: FE-1234", "afecta la factura No. CFA109836"). Sin una mención clara, null.
 */
export function facturaReferidaEnTexto(texto: string | null | undefined): FacturaReferida | null {
  if (!texto) return null;
  const t = sinTildes(texto).toUpperCase();
  const patrones = [
    /(?:APLICA\s+A|AFECTA(?:DA)?|REFERENCIA(?:DA)?|SOBRE|ANULA|CORRIGE|DEVOLUCION\s+(?:DE|A))\s*(?:LA\s+)?(?:FACTURA|FACT\.?|FV|FE)(?:\s+(?:DE\s+VENTA|ELECTRONICA))?\s*(?:NUMERO|NUM\.?|NRO\.?|N[O°º]\.?|#|:)?\s*([A-Z]{0,6})\s*[-\s]?\s*(\d{1,15})\b/,
    /FACTURA\s+(?:DE\s+)?REFERENCIA\s*(?:NUMERO|NRO\.?|N[O°º]\.?|#|:)?\s*([A-Z]{0,6})\s*[-\s]?\s*(\d{1,15})\b/,
    /DOCUMENTO\s+(?:DE\s+)?REFERENCIA\s*(?:NUMERO|NRO\.?|N[O°º]\.?|#|:)?\s*([A-Z]{0,6})\s*[-\s]?\s*(\d{1,15})\b/,
  ];
  for (const re of patrones) {
    const m = re.exec(t);
    if (m) return { prefijo: m[1] ?? "", numero: (m[2] ?? "").replace(/^0+(?=\d)/, "") };
  }
  return null;
}

export const etiquetaFactura = (f: FacturaReferida) => `${f.prefijo}${f.prefijo ? " " : ""}${f.numero}`;

/**
 * Reconoce una nota crédito leída de un PDF/XML (o ya guardada como borrador):
 * - la IA la clasificó como nota crédito (document_type);
 * - el XML es un CreditNote UBL de la DIAN;
 * - el encabezado del documento dice "Nota crédito electrónica";
 * - el archivo tiene el nombre DIAN de nota crédito ("nc" + NIT de 10 dígitos);
 * - el total viene negativo.
 */
export function pareceNotaCredito(params: {
  documentType?: string | null | undefined;
  texto?: string | null | undefined;
  archivo?: string | null | undefined;
  total?: number | null | undefined;
  tipoDocumento?: string | null | undefined;
}): boolean {
  const tipo = sinTildes(`${params.documentType ?? ""} ${params.tipoDocumento ?? ""}`).toLowerCase();
  if (/nota\s*(de\s*)?credito|credit[\s_-]*note|nota_credito/.test(tipo)) return true;
  const texto = params.texto ?? "";
  if (/<(?:\w+:)?CreditNote[\s>]|CreditNoteTypeCode/.test(texto)) return true;
  // Solo el encabezado: las facturas pueden mencionar las notas crédito en su letra pequeña.
  if (/NOTA\s+(?:DE\s+)?CREDITO\s+ELECTRONICA/i.test(sinTildes(texto.slice(0, 2500)))) return true;
  if (/^nc\d{10}/i.test((params.archivo ?? "").replace(/^.*[\\/]/, "").replace(/^[^-]*\s-\s/, "")))
    return true;
  return typeof params.total === "number" && params.total < 0;
}

/** Nota crédito reconocida en un borrador ya guardado (antes de enviar a Siigo). */
export function notaCreditoGuardada(inv: {
  raw_extraction?: unknown;
  total?: number | null;
  file_name?: string | null;
}): boolean {
  const raw = (inv.raw_extraction ?? {}) as {
    ia?: { document_type?: string | null } | null;
    tipo_documento?: string | null;
    texto?: string | null;
    archivo?: string | null;
  };
  return pareceNotaCredito({
    documentType: raw.ia?.document_type ?? null,
    tipoDocumento: raw.tipo_documento ?? null,
    texto: raw.texto ?? null,
    archivo: raw.archivo ?? inv.file_name ?? null,
    total: typeof inv.total === "number" ? inv.total : null,
  });
}

/** Lo que se sabe de la factura afectada en la herramienta. */
export type EstadoFacturaAfectada =
  | { tipo: "sin_referencia" }
  | { tipo: "no_registrada"; factura: FacturaReferida }
  | { tipo: "pendiente_siigo"; factura: FacturaReferida }
  | { tipo: "en_siigo"; factura: FacturaReferida; siigo: string | null };

export function mensajeNotaCredito(p: {
  numero: string | null | undefined;
  proveedor: string | null | undefined;
  nit: string | null | undefined;
  total: number | null | undefined;
  estado: EstadoFacturaAfectada;
}): string {
  const nota = p.numero?.trim() || "sin número";
  const quien = [p.proveedor?.trim(), p.nit ? `NIT ${p.nit}` : ""].filter(Boolean).join(", ");
  const valor = typeof p.total === "number" && p.total !== 0 ? ` por ${cop(Math.abs(p.total))}` : "";
  const partes = [
    AVISO_NOTA_CREDITO,
    `La nota crédito ${nota}${quien ? ` (${quien})` : ""}${valor} no se causa ni se envía a Siigo desde la herramienta.`,
  ];
  const e = p.estado;
  if (e.tipo === "sin_referencia") {
    partes.push(
      "La nota no indica la factura afectada: búsquela en el PDF o XML de la nota y regístrela manualmente en Siigo con el comprobante de notas crédito sobre esa factura de compra.",
    );
  } else {
    const f = etiquetaFactura(e.factura);
    partes.push(`Regístrela manualmente en Siigo con el comprobante de notas crédito sobre la factura ${f}.`);
    if (e.tipo === "en_siigo")
      partes.push(`La factura ${f} ya está causada en Siigo${e.siigo ? ` (${e.siigo})` : ""}.`);
    else if (e.tipo === "pendiente_siigo")
      partes.push(`La factura ${f} está en la herramienta pero aún no se ha causado en Siigo: cáusela primero.`);
    else
      partes.push(
        `La factura ${f} no está registrada en la herramienta: verifique que esté causada en Siigo antes de aplicar la nota.`,
      );
  }
  return partes.join(" ");
}

type FilaFactura = {
  prefix: string | null;
  number: string | null;
  provider_nit: string | null;
  siigo_id: string | null;
  siigo_number: string | null;
  siigo_status: string | null;
  status: string | null;
};

const alfanum = (s: string | null | undefined) => sinTildes(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const soloNit = (s: string | null | undefined) => (s ?? "").split("-")[0]!.replace(/\D/g, "");

/** Elige, entre las facturas del proveedor con ese número, la que corresponde a la referencia. */
export function estadoDeFactura(
  factura: FacturaReferida | null,
  nit: string | null | undefined,
  filas: FilaFactura[],
): EstadoFacturaAfectada {
  if (!factura) return { tipo: "sin_referencia" };
  const numero = factura.numero.replace(/^0+(?=\d)/, "");
  const prefijo = alfanum(factura.prefijo);
  const nitBase = soloNit(nit);
  const candidatas = filas.filter((f) => {
    if (nitBase && soloNit(f.provider_nit) !== nitBase) return false;
    if (alfanum(f.number).replace(/^0+(?=\d)/, "") !== numero) return false;
    return !prefijo || !alfanum(f.prefix) || alfanum(f.prefix) === prefijo;
  });
  const enSiigo = candidatas.find(
    (f) =>
      f.siigo_id || f.siigo_number || f.siigo_status === "sincronizada" || f.status === "sincronizada" || f.status === "historico",
  );
  if (enSiigo) return { tipo: "en_siigo", factura, siigo: enSiigo.siigo_number ?? null };
  if (candidatas.length) return { tipo: "pendiente_siigo", factura };
  return { tipo: "no_registrada", factura };
}

type ConsultaFacturas = {
  from: (tabla: "invoices") => {
    select: (cols: string) => {
      eq: (c: string, v: string) => {
        eq: (c: string, v: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

/** Consulta en la herramienta el estado de la factura afectada (sin tocar Siigo). */
export async function estadoFacturaAfectada(
  cliente: unknown,
  companyId: string,
  nit: string | null | undefined,
  factura: FacturaReferida | null,
): Promise<EstadoFacturaAfectada> {
  if (!factura) return { tipo: "sin_referencia" };
  try {
    const { data, error } = await (cliente as ConsultaFacturas)
      .from("invoices")
      .select("prefix, number, provider_nit, siigo_id, siigo_number, siigo_status, status")
      .eq("company_id", companyId)
      .eq("number", factura.numero);
    if (error) throw new Error(error.message);
    return estadoDeFactura(factura, nit, (data ?? []) as FilaFactura[]);
  } catch {
    // Si la consulta falla, el aviso se muestra igual, sin el estado de la factura.
    return { tipo: "no_registrada", factura };
  }
}

/**
 * Factura afectada de una nota crédito del Excel RECIBIDOS: primero una columna de
 * referencia (si el Procesador la trae: "FACTURA REFERENCIA", "NUMERO REFERENCIA"...),
 * luego el texto de la columna NOTA ("SE APLICA A FACTURA CFA 109836").
 */
export function facturaReferidaEnExcel(fila: Record<string, string | number>): FacturaReferida | null {
  for (const [col, valor] of Object.entries(fila)) {
    const c = sinTildes(col).toUpperCase();
    if (!/REFERENCIA|FACTURA AFECTADA|DOCUMENTO AFECTADO/.test(c) || /TIPO DE OPERACION/.test(c)) continue;
    const f = facturaReferidaEnValor(String(valor ?? ""));
    if (f) return f;
  }
  return facturaReferidaEnTexto(String(fila["NOTA"] ?? ""));
}

/** Número de factura escrito solo ("CFA 109836", "CFA-109836", "FE0001234"); si no, null. */
export function facturaReferidaEnValor(valor: string | null | undefined): FacturaReferida | null {
  const m = /^([A-Z]{0,6})0*(\d{1,15})$/.exec(alfanum(valor));
  return m ? { prefijo: m[1] ?? "", numero: m[2]! } : null;
}
