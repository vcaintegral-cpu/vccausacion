export type PreparedInvoiceFile = {
  dataUrl?: string;
  images?: Array<{ dataUrl: string; mimeType: string }>;
  text?: string;
};

const MAX_PDF_PAGES = 8;
const MAX_RENDER_WIDTH = 1400;
/** Mínimo de caracteres de la capa de texto para considerar que el PDF es digital (sin OCR). */
const MIN_DIGITAL_TEXT = 350;

export class InvoicePdfPasswordError extends Error {
  readonly incorrect: boolean;

  constructor(incorrect = false) {
    super(incorrect ? "La contraseña del PDF es incorrecta." : "Este PDF está protegido con contraseña.");
    this.name = "InvoicePdfPasswordError";
    this.incorrect = incorrect;
  }
}

/** Deja respirar a la interfaz entre tareas pesadas para que la página no se congele. */
const respirar = () => new Promise<void>((r) => setTimeout(r, 0));

// La lectura de un PDF (texto o render) es trabajo pesado del navegador: se hace
// de a una a la vez aunque el lote procese varias facturas en paralelo. Así la
// aplicación sigue respondiendo y no aparece "La página no responde".
let turno: Promise<unknown> = Promise.resolve();
function enTurno<T>(tarea: () => Promise<T>): Promise<T> {
  const siguiente = turno.then(tarea, tarea);
  turno = siguiente.catch(() => undefined);
  return siguiente;
}

/** Convierte el lienzo a JPEG sin bloquear el hilo principal cuando el navegador lo permite. */
async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  if ("convertToBlob" in canvas) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("No fue posible preparar las páginas del PDF."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
  }
  return (canvas as HTMLCanvasElement).toDataURL("image/jpeg", 0.72);
}

export function prepareInvoiceFile(file: File, password?: string): Promise<PreparedInvoiceFile> {
  return enTurno(() => prepararArchivo(file, password));
}

async function prepararArchivo(file: File, password?: string): Promise<PreparedInvoiceFile> {

  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const isXml = file.type.includes("xml") || extension === "xml";
  if (isXml) return { text: await file.text() };

  const isPdf = file.type === "application/pdf" || extension === "pdf";
  if (!isPdf) return { dataUrl: await readAsDataUrl(file) };

  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("El archivo seleccionado no contiene un PDF válido.");
  }

  const loadingTask = pdfjs.getDocument({ data: bytes, ...(password ? { password } : {}) });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy();
    const detail = error as { name?: string; code?: number; message?: string };
    const isPasswordError = detail.name === "PasswordException" || /password/i.test(detail.message ?? "");
    if (isPasswordError) throw new InvoicePdfPasswordError(detail.code === 2);
    throw error;
  }
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);

  // 1) Si el PDF ya trae texto digital, se lee directamente: no se renderiza ni se usa OCR/visión.
  let digital = "";
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      digital += `${content.items
        .map((i) => (typeof (i as { str?: string }).str === "string" ? (i as { str: string }).str : ""))
        .join(" ")}\n`;
      page.cleanup();
      await respirar();
    }
  } catch {
    digital = "";
  }
  if (digital.replace(/\s+/g, " ").trim().length >= MIN_DIGITAL_TEXT) {
    await loadingTask.destroy();
    return { text: digital.replace(/[ \t]+/g, " ").trim() };
  }

  // 2) PDF escaneado: se renderizan las páginas para que la IA las lea como imagen.
  const images: Array<{ dataUrl: string; mimeType: string }> = [];
  const puedeOffscreen = typeof OffscreenCanvas !== "undefined";

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const initialViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.6, MAX_RENDER_WIDTH / initialViewport.width);
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas: HTMLCanvasElement | OffscreenCanvas = puedeOffscreen
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D | null;
    if (!context) throw new Error("No fue posible preparar las páginas del PDF.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context, viewport }).promise;
    images.push({ dataUrl: await canvasToJpeg(canvas), mimeType: "image/jpeg" });
    page.cleanup();
    if (!puedeOffscreen) (canvas as HTMLCanvasElement).width = 0;
    await respirar();
  }


  await loadingTask.destroy();
  if (images.length === 0) throw new Error("El PDF no contiene páginas que se puedan leer.");
  return { images };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No fue posible leer el archivo seleccionado."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}