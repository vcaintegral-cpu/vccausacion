export type PreparedInvoiceFile = {
  dataUrl?: string;
  images?: Array<{ dataUrl: string; mimeType: string }>;
  text?: string;
};

const MAX_PDF_PAGES = 8;
const MAX_RENDER_WIDTH = 1800;

export async function prepareInvoiceFile(file: File): Promise<PreparedInvoiceFile> {
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

  const loadingTask = pdfjs.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const images: Array<{ dataUrl: string; mimeType: string }> = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const initialViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, MAX_RENDER_WIDTH / initialViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("No fue posible preparar las páginas del PDF.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    images.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.9), mimeType: "image/jpeg" });
    page.cleanup();
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