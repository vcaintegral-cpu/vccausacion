import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  downloadInvoiceFile,
  fetchInvoicePdfBytes,
  invoicePdfFileName,
  openInvoiceFile,
  PDF_NO_DISPONIBLE,
  type InvoiceFileRef,
} from "@/lib/invoice-pdf";

type Props = {
  factura: (InvoiceFileRef & { provider_name?: string | null }) | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * Visor interno de PDF. Descarga el binario desde Storage (bucket privado) y lo
 * renderiza con pdf.js dentro de la aplicación: nunca navega a la URL de Storage.
 */
export function InvoicePdfViewer({ factura, onOpenChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<{ numPages: number; getPage: (n: number) => Promise<any>; destroy: () => Promise<void> } | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const [pagina, setPagina] = useState(1);
  const [paginas, setPaginas] = useState(0);
  const [zoom, setZoom] = useState(1.2);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);

  const abierto = !!factura;
  const path = factura?.file_path ?? null;

  useEffect(() => {
    if (!abierto) return;
    setPagina(1);
    setZoom(1.2);
  }, [abierto, path]);

  useEffect(() => {
    if (!abierto || !factura) return;
    let cancelado = false;

    (async () => {
      setCargando(true);
      setError(null);
      try {
        if (!factura.file_path) throw new Error(PDF_NO_DISPONIBLE);
        const bytes = await fetchInvoicePdfBytes(factura);
        bytesRef.current = bytes;
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        if (cancelado) {
          await pdf.destroy();
          return;
        }
        docRef.current = pdf as never;
        setPaginas(pdf.numPages);
        setPagina(1);
      } catch (e) {
        if (!cancelado) setError(e instanceof Error ? e.message : "No fue posible visualizar el PDF.");
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();

    return () => {
      cancelado = true;
      const pdf = docRef.current;
      docRef.current = null;
      void pdf?.destroy();
    };
  }, [abierto, path, intento, factura]);

  // Render de la página activa
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const pdf = docRef.current;
      const canvas = canvasRef.current;
      if (!pdf || !canvas || paginas === 0) return;
      try {
        const page = await pdf.getPage(Math.min(Math.max(pagina, 1), pdf.numPages));
        if (cancelado) return;
        const viewport = page.getViewport({ scale: zoom });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        page.cleanup();
      } catch {
        if (!cancelado) setError("No fue posible visualizar el PDF.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [pagina, zoom, paginas, intento]);

  const descargar = useCallback(async () => {
    if (!factura) return;
    try {
      await downloadInvoiceFile(factura, bytesRef.current ?? undefined);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : PDF_NO_DISPONIBLE);
    }
  }, [factura]);

  return (
    <Dialog open={abierto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            {invoicePdfFileName(factura ?? { file_path: null, file_name: null })}
            {factura?.provider_name ? ` · ${factura.provider_name}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-y border-border py-2">
          <Button variant="outline" size="icon" disabled={pagina <= 1 || !!error} onClick={() => setPagina((p) => p - 1)} title="Página anterior">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm text-muted-foreground">Página {paginas ? pagina : 0} de {paginas}</span>
          <Button variant="outline" size="icon" disabled={pagina >= paginas || !!error} onClick={() => setPagina((p) => p + 1)} title="Página siguiente">
            <ChevronRight className="size-4" />
          </Button>
          <span className="mx-2 h-5 w-px bg-border" />
          <Button variant="outline" size="icon" disabled={zoom <= 0.5} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(2)))} title="Alejar">
            <ZoomOut className="size-4" />
          </Button>
          <span className="text-sm tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Button variant="outline" size="icon" disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)))} title="Acercar">
            <ZoomIn className="size-4" />
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={descargar}>
              <Download className="size-4" /> Descargar PDF
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => factura && openInvoiceFile(factura).catch((e) => toast.error(e instanceof Error ? e.message : PDF_NO_DISPONIBLE))}
            >
              <ExternalLink className="size-4" /> Nueva pestaña
            </Button>
          </div>
        </div>

        <div className="max-h-[65vh] overflow-auto rounded-md bg-muted/40 p-3">
          {cargando && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Cargando documento…
            </div>
          )}
          {!cargando && error && (
            <div className="space-y-3 py-12 text-center">
              <p className="text-sm font-medium">
                {error === PDF_NO_DISPONIBLE ? PDF_NO_DISPONIBLE : "No fue posible visualizar el PDF."}
              </p>
              {error !== PDF_NO_DISPONIBLE && (
                <p className="text-sm text-muted-foreground">Puede intentar nuevamente o descargar el archivo.</p>
              )}
              <div className="flex justify-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setIntento((i) => i + 1)}>Reintentar</Button>
                <Button size="sm" onClick={descargar}>Descargar PDF</Button>
              </div>
            </div>
          )}
          <div className={cargando || error ? "hidden" : "flex justify-center"}>
            <canvas ref={canvasRef} className="max-w-full shadow-sm" />
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cerrar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}