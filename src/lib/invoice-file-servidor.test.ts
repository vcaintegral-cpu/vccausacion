import { describe, expect, it, vi } from "vitest";

import { MAX_PDF_SERVIDOR_BYTES, prepararArchivoServidor } from "./invoice-file-servidor";
import { extractInvoiceWithAi } from "./extract.server";

const archivo = (partes: BlobPart[], nombre: string, tipo: string) =>
  new File(partes, nombre, { type: tipo });

describe("lectura de archivos de factura en el servidor", () => {
  it("el XML se lee como texto", async () => {
    const r = await prepararArchivoServidor(archivo(["<Invoice/>"], "f.xml", "text/xml"));
    expect(r).toEqual({ text: "<Invoice/>" });
  });

  it("el PDF viaja completo en base64", async () => {
    const r = await prepararArchivoServidor(
      archivo(["%PDF-1.7 contenido"], "f.pdf", "application/pdf"),
    );
    expect(Buffer.from(r.pdfBase64 ?? "", "base64").toString()).toBe("%PDF-1.7 contenido");
  });

  it("rechaza un PDF inválido o demasiado grande", async () => {
    await expect(
      prepararArchivoServidor(archivo(["no es pdf"], "f.pdf", "application/pdf")),
    ).rejects.toThrow(/PDF válido/);
    const grande = new Uint8Array(MAX_PDF_SERVIDOR_BYTES + 10);
    grande.set(new TextEncoder().encode("%PDF-"));
    await expect(
      prepararArchivoServidor(archivo([grande], "g.pdf", "application/pdf")),
    ).rejects.toThrow(/demasiado grande/);
  });

  it("la petición a la IA lleva el PDF como archivo", async () => {
    let cuerpo = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        cuerpo = init.body;
        const evento = JSON.stringify({
          type: "response.completed",
          response: { output_text: JSON.stringify({ lines: [] }) },
        });
        return new Response(`data: ${evento}\n\n`, { status: 200 });
      }),
    );
    await extractInvoiceWithAi(
      { fileName: "F 1.pdf", mimeType: "application/pdf", pdfBase64: "QUJD" },
      "k",
    );
    const contenido = JSON.parse(cuerpo).input[0].content as Array<Record<string, string>>;
    expect(contenido.find((c) => c["type"] === "input_file")).toMatchObject({
      filename: "F_1.pdf",
      file_data: "data:application/pdf;base64,QUJD",
    });
    vi.unstubAllGlobals();
  });
});
