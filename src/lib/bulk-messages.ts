// Traducción de errores técnicos del flujo masivo a mensajes comprensibles.
// No cambia la lógica: la información técnica se conserva intacta y se muestra
// aparte, en "Ver detalles técnicos".
import { errorCode } from "@/lib/bulk-diagnostics";
import type { BulkItem } from "@/lib/bulk-upload-store";

const TEXTOS: Record<string, string> = {
  STORAGE_NOT_FOUND: "No fue posible encontrar el archivo guardado. Vuelva a cargar la factura.",
  STORAGE_DOWNLOAD_ERROR: "No fue posible recuperar el documento. Puede intentar nuevamente.",
  STORAGE_UPLOAD_ERROR: "El documento no se pudo guardar. Puede intentar nuevamente.",
  EMPTY_FILE: "El archivo está vacío y no contiene una factura.",
  PDF_INVALID: "El archivo no es un PDF válido.",
  PDF_PASSWORD: "El PDF está protegido con contraseña y no se puede leer.",
  PDF_READ_ERROR: "No fue posible leer el documento. Puede intentar nuevamente.",
  DUPLICATE: "Esta factura ya fue procesada anteriormente: no se volverá a causar.",
  BUYER_MISMATCH: "La factura no corresponde al NIT de la empresa activa.",
  AI_EXTRACT_ERROR: "No fue posible extraer los datos de la factura. Puede intentar nuevamente.",
  UNKNOWN_ERROR: "Factura no procesada. Puede intentar nuevamente.",
};

/** Código técnico interno (se conserva para diagnóstico). */
export function codigoTecnico(item: BulkItem): string {
  return errorCode(item.stage ?? "", item.error_message ?? item.user_message ?? "");
}

/** Mensaje comprensible para el usuario final. */
export function mensajeAmigable(item: BulkItem): string {
  if (item.status === "duplicate") return TEXTOS.DUPLICATE!;
  if (item.status === "requires_review") return "La factura se leyó pero necesita revisión manual antes de causarla.";
  if (item.status !== "error") return "";
  return TEXTOS[codigoTecnico(item)] ?? TEXTOS.UNKNOWN_ERROR!;
}
