// Preparación de archivos de factura en el SERVIDOR (piloto automático): sin pdfjs ni canvas.
// El XML se lee como texto, las imágenes pasan tal cual y el PDF viaja completo a la IA como archivo.
import type { PreparedInvoiceFile } from "@/lib/invoice-file";

/** Un PDF más grande que esto no se envía a la IA desde el servidor (se deja para la aplicación). */
export const MAX_PDF_SERVIDOR_BYTES = 12 * 1024 * 1024;

export async function prepararArchivoServidor(file: File): Promise<PreparedInvoiceFile> {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (file.type.includes("xml") || extension === "xml") return { text: await file.text() };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === "application/pdf" || extension === "pdf") {
    if (bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
      throw new Error("ERROR_PDF_INVALIDO: el archivo no contiene un PDF válido.");
    if (bytes.length > MAX_PDF_SERVIDOR_BYTES)
      throw new Error(
        "ERROR_PDF_INVALIDO: el PDF es demasiado grande para leerlo de noche; cárguelo desde la aplicación.",
      );
    return { pdfBase64: Buffer.from(bytes).toString("base64") };
  }
  const mime = file.type || "image/jpeg";
  return { dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` };
}
