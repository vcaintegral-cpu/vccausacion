import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { libroConciliacionFirma, nombreArchivo } from "./conciliacion-reporte";
import { leerConciliacionAnterior } from "./lectores-extracto";

// Datos ficticios.
const datos = {
  empresa: { nombre: "EMPRESA EJEMPLO S.A.S.", nit: "900.000.000-1" },
  etiqueta: "CORRIENTE",
  cuentaContable: "11100501",
  cuentaNumero: "00000001234",
  esCaja: false,
  periodo: "2026-10",
  saldoLibrosInicial: 1000000,
  saldoLibrosFinal: 1200000,
  saldoExtractoInicial: 1050000,
  saldoExtractoFinal: 1100000,
  extracto: [
    { id: "b1", fecha: "2026-10-05", descripcion: "PAGO A PROVE X", valor: -150000 },
    { id: "b2", fecha: "2026-10-06", descripcion: "IMPTO GOBIERNO 4X1000", valor: -600 },
  ],
  libros: [
    {
      id: "l1",
      fecha: "2026-10-10",
      comprobante: "RC-1-9",
      tercero: null,
      descripcion: null,
      valor: 200000,
    },
  ],
  partidas: [
    {
      tipo: "banco_sin_libros" as const,
      fecha: "2026-08-19",
      descripcion: "CONSIGNACION SIN IDENTIFICAR",
      comprobante: null,
      tercero: null,
      valor: 50000,
      nota: "Por identificar",
    },
    {
      tipo: "banco_sin_libros" as const,
      fecha: "2026-10-05",
      descripcion: "PAGO A PROVE X",
      comprobante: null,
      tercero: null,
      valor: -150000,
    },
    {
      tipo: "libros_sin_banco" as const,
      fecha: "2026-10-30",
      descripcion: "CLIENTE — recibo de caja",
      comprobante: "RC-1-9",
      tercero: null,
      valor: 0,
    },
    {
      tipo: "libros_sin_banco" as const,
      fecha: "2026-10-30",
      descripcion: "CLIENTE — recibo de caja",
      comprobante: "RC-1-10",
      tercero: null,
      valor: 0.001,
    },
  ],
};
// Libros 1.200.000 + D (50.000 − 150.000) − E 0 = 1.100.000 = extracto.

describe("conciliación en el formato de la firma", () => {
  it("dos hojas, resumen por fórmula, cuadra y se vuelve a leer como conciliación anterior", () => {
    const wb = libroConciliacionFirma(datos);
    expect(wb.SheetNames).toEqual(["Reporte Conciliación", "CONCILIACION OCTUBRE"]);
    const rep = wb.Sheets["Reporte Conciliación"]!;
    expect(rep["J9"]).toMatchObject({ f: "'CONCILIACION OCTUBRE'!D4", v: 1200000 });
    expect(rep["J12"]).toMatchObject({ f: "J9+J10-J11", v: 1100000 });
    expect(rep["J14"]).toMatchObject({ v: 0 });
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    const r = leerConciliacionAnterior(
      bytes,
      "",
      [{ etiqueta: "CORRIENTE", cuentaContable: "11100501" }],
      false,
    );
    expect(
      r.porCuenta.get("CORRIENTE")!.map((p) => [p.tipo, p.fecha, p.valor, p.nota ?? null]),
    ).toEqual([
      ["banco_sin_libros", "2026-08-19", 50000, "Por identificar"],
      ["banco_sin_libros", "2026-10-05", -150000, "Elaborar el recibo de pago (RP) en Siigo."],
    ]);
    expect(r.saldos.get("CORRIENTE")).toEqual({ libros: 1200000, extracto: 1100000 });
    expect(nombreArchivo(datos)).toBe("CONCILIACION_CORRIENTE_1234_al_31_DE_OCTUBRE_2026.xlsx");
  });
});
