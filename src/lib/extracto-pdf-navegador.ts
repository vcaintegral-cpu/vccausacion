// Texto de un extracto PDF en el navegador (pdfjs), con su posición, para el lector puro
// de extracto-pdf.ts. Solo PDF con texto digital (los extractos descargados del banco).
import type { ItemPdf } from "@/lib/extracto-pdf";

export async function itemsDePdf(bytes: ArrayBuffer | Uint8Array): Promise<ItemPdf[]> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tarea = pdfjs.getDocument({ data: data.slice() });
  const pdf = await tarea.promise;
  const items: ItemPdf[] = [];
  try {
    for (let p = 1; p <= Math.min(pdf.numPages, 60); p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items as Array<{ str?: string; transform?: number[] }>) {
        if (typeof it.str !== "string" || !it.transform) continue;
        items.push({
          pagina: p,
          x: Math.round(it.transform[4]!),
          y: Math.round(it.transform[5]!),
          texto: it.str,
        });
      }
      page.cleanup();
    }
  } finally {
    await tarea.destroy();
  }
  if (!items.some((i) => i.texto.trim()))
    throw new Error(
      "El PDF no tiene texto (parece escaneado): descarga el extracto digital del banco.",
    );
  return items;
}
