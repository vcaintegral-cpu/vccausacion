// CUENTA DE COBRO NUMERADA (documentos soporte)
// Genera el PDF "Cuenta de cobro N° DSEB-x" después de crear el documento soporte en Siigo.
// Si la cuenta de cobro original vino en PDF, se agrega una franja superior con el número;
// si no, se crea un PDF nuevo con los datos de la empresa, el vendedor y los valores.
// Solo servidor: pdf-lib es JS puro y funciona en el runtime del servidor.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type CuentaCobroData = {
  dseb: string; // ej.: "DSEB-1153"
  fechaOperacion: string; // dd/mm/aaaa
  empresa: { nombre: string; nit: string; direccion: string; ciudad: string; telefono: string };
  vendedor: { nombre: string; identificacion: string; direccion?: string | null; ciudad?: string | null; telefono?: string | null };
  descripcion: string;
  valor: number;
  retencion: number;
  neto: number;
};

const cop = (n: number) => `$ ${n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function fuentes(doc: PDFDocument) {
  return { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
}

// Franja superior sobre el PDF original de la cuenta de cobro.
export async function estamparCuentaCobro(original: Uint8Array, d: CuentaCobroData): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { ignoreEncryption: true });
  const { regular, bold } = await fuentes(doc);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  const alto = 34;
  page.drawRectangle({ x: 0, y: height - alto, width, height: alto, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: 0, y: height - alto }, end: { x: width, y: height - alto }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
  const texto = `Cuenta de cobro N° ${d.dseb}  –  Documento soporte ${d.dseb}  –  Fecha ${d.fechaOperacion}`;
  page.drawText(texto, { x: 24, y: height - 22, size: 11, font: bold, color: rgb(0.1, 0.1, 0.1) });
  void regular;
  return doc.save();
}

// PDF nuevo cuando la cuenta de cobro no vino en PDF (ej.: cargada por Excel).
export async function generarCuentaCobro(d: CuentaCobroData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const { regular, bold } = await fuentes(doc);
  const page = doc.addPage([612, 792]); // carta
  let y = 740;
  const linea = (texto: string, opts?: { bold?: boolean; size?: number; gap?: number }) => {
    page.drawText(texto, { x: 56, y, size: opts?.size ?? 11, font: opts?.bold ? bold : regular, color: rgb(0.1, 0.1, 0.1) });
    y -= opts?.gap ?? 16;
  };

  linea(d.empresa.nombre, { bold: true, size: 14, gap: 20 });
  linea(`NIT ${d.empresa.nit}`, { gap: 14 });
  linea(`${d.empresa.direccion} · ${d.empresa.ciudad} · Tel. ${d.empresa.telefono}`, { size: 10, gap: 26 });

  linea(`CUENTA DE COBRO N° ${d.dseb}`, { bold: true, size: 13, gap: 18 });
  linea(`Documento soporte N° ${d.dseb} · Fecha de la operación: ${d.fechaOperacion}`, { size: 10, gap: 26 });

  linea("Se cobra a:", { bold: true, gap: 14 });
  linea(`${d.vendedor.nombre} · ${d.vendedor.identificacion}`, { gap: 14 });
  const contacto = [d.vendedor.direccion, d.vendedor.ciudad, d.vendedor.telefono].filter(Boolean).join(" · ");
  if (contacto) linea(contacto, { size: 10, gap: 14 });
  y -= 12;

  linea("Por el siguiente concepto:", { bold: true, gap: 14 });
  // Descripción con ajuste de línea sencillo.
  const palabras = d.descripcion.split(/\s+/);
  let actual = "";
  for (const p of palabras) {
    if ((actual + " " + p).trim().length > 95) { linea(actual.trim(), { size: 10, gap: 13 }); actual = p; } else actual += " " + p;
  }
  if (actual.trim()) linea(actual.trim(), { size: 10, gap: 13 });
  y -= 14;

  linea(`Valor: ${cop(d.valor)}`, { gap: 15 });
  linea(`Retención en la fuente: ${cop(d.retencion)}`, { gap: 15 });
  linea(`Neto a pagar: ${cop(d.neto)}`, { bold: true, gap: 15 });

  return doc.save();
}

// Punto único: estampa el PDF original si existe; si no, genera uno nuevo.
export async function cuentaCobroPdf(original: Uint8Array | null, d: CuentaCobroData): Promise<Uint8Array> {
  if (original?.length) {
    try { return await estamparCuentaCobro(original, d); } catch { /* si el original está dañado, se genera uno nuevo */ }
  }
  return generarCuentaCobro(d);
}
