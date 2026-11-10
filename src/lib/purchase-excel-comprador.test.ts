// Excel RECIBIDOS de LED LIGHTS (octubre 2026): 3 filas con el NIT del comprador vacío
// (FE3673, RR8524, FE243122) hacían rechazar el archivo completo.
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { mismoNitEmpresa, parsePurchaseWorkbook } from "./purchase-excel";

function libro(compradores: Array<string | undefined>) {
  const w = XLSX.utils.book_new();
  const h = [
    "TIPO DOC EMITIDO",
    "NUMERO FACTURA COMPLETO",
    "CUFE",
    "NIT COMPRADOR",
    "NIT EMISOR",
    "PREFIJO",
    "NUMERO DE FACTURA",
    "SUBTOTAL FACTURA",
    "IVA",
    "TOTAL FACTURA",
  ];
  XLSX.utils.book_append_sheet(
    w,
    XLSX.utils.aoa_to_sheet([
      ["t"],
      ["r"],
      h,
      ...compradores.map((c, i) => [
        "Factura electrónica",
        `FE${i}`,
        `c${i}`,
        c ?? "",
        "901856592",
        "FE",
        String(i),
        100,
        19,
        119,
      ]),
    ]),
    "DOCUMENTOS",
  );
  XLSX.utils.book_append_sheet(
    w,
    XLSX.utils.aoa_to_sheet([
      ["t"],
      ["r"],
      [
        "TIPO DOC EMITIDO",
        "NUMERO FACTURA COMPLETO",
        "CUFE",
        "CANTIDAD",
        "SUBTOTAL DE LA FACTURA",
        "IVA",
      ],
      ...compradores.map((_, i) => ["Factura electrónica", `FE${i}`, `c${i}`, 1, 100, 19]),
    ]),
    "DETALLE DE FACTURA",
  );
  return XLSX.write(w, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("Excel RECIBIDOS: NIT del comprador", () => {
  it("una fila con comprador vacío no rechaza el archivo: toma el NIT de la empresa y lo anota", () => {
    const docs = parsePurchaseWorkbook(libro(["900470166", undefined, "900470166"]), "900470166");
    expect(docs).toHaveLength(3);
    expect(docs[1]!.header.buyer_nit).toBe("900470166");
    expect(docs[1]!.header.notes).toContain("NIT del comprador vacío en el reporte RECIBIDOS");
    expect(docs[0]!.header.notes).not.toContain("vacío");
  });
  it("acepta el NIT de la empresa con o sin dígito de verificación", () => {
    for (const nit of ["900470166", "900470166-4", "9004701664", "900.470.166-4"]) {
      expect(parsePurchaseWorkbook(libro(["900470166"]), nit)).toHaveLength(1);
    }
    expect(mismoNitEmpresa("9004701664", "900470166")).toBe(true);
    expect(mismoNitEmpresa("9004701665", "900470166")).toBe(false);
    expect(mismoNitEmpresa("", "900470166")).toBe(false);
  });
  it("un comprador presente y distinto sigue rechazando el archivo (protege de cargar ENVIADOS)", () => {
    expect(() => parsePurchaseWorkbook(libro(["900470166", "811000001"]), "900470166")).toThrow(
      "Fila 5: comprador diferente a la empresa activa",
    );
  });
});
