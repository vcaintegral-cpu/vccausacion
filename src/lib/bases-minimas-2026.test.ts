// Verifica la transcripción de Tabla_Retencion_Fuente_2026_Octubre.pdf contra la
// columna "Base mínima en pesos" y "Tarifa" del documento, fila por fila.
import { describe, expect, it } from "vitest";

import {
  CONCEPTOS_2026,
  TABLA_2026,
  TABLA_2026_SUSPENSION_572,
  UVT_2026,
} from "./bases-minimas-2026";
import { baseMinimaDe, uvtAPesos } from "./precedente-tributario";

// Columna "Base mínima en pesos" del PDF, en el mismo orden (50 filas).
const PESOS_PDF = [
  524000, 524000, 0, 3666000, 524000, 524000, 3666000, 0, 0, 0, 0, 524000, 523740000, 524000,
  105000, 105000, 524000, 524000, 105000, 524000, 524000, 105000, 105000, 105000, 105000, 105000,
  105000, 524000, 0, 524000, 524000, 0, 0, 0, 0, 0, 0, 524000, 524000, 2514000, 262000, 105000,
  524000, 0, 0, 0, 0, 0, 0, 0,
];
// Columna "Tarifa" del PDF, mismo orden.
const TARIFAS_PDF = [
  2.5, 3.5, 1.5, 1.5, 2.5, 3.5, 0.5, 0.1, 1, 1, 2.5, 1, 2.5, 2.5, 4, 6, 4, 3.5, 1, 3.5, 3.5, 1, 1,
  2, 2, 3.5, 3.5, 2, 4, 3.5, 3.5, 11, 11, 10, 3.5, 7, 4, 2.5, 3.5, 20, 3, 15, 15, 20, 20, 15, 1, 5,
  1, 33,
];

describe("Tabla de retención 2026 (octubre)", () => {
  it("UVT 2026 = $52.374", () => {
    expect(UVT_2026).toBe(52374);
    expect(TABLA_2026.uvt).toBe(52374);
  });

  it("las 50 filas dan exactamente la base en pesos del documento (redondeo a mil)", () => {
    expect(CONCEPTOS_2026).toHaveLength(50);
    expect(CONCEPTOS_2026.map((c) => uvtAPesos(c.base_uvt, UVT_2026))).toEqual(PESOS_PDF);
  });

  it("las tarifas coinciden con el documento", () => {
    expect(CONCEPTOS_2026.map((c) => c.tarifa_declarante ?? c.tarifa_no_declarante)).toEqual(
      TARIFAS_PDF,
    );
  });

  it("identificadores únicos", () => {
    expect(new Set(CONCEPTOS_2026.map((c) => c.id)).size).toBe(50);
  });
});

describe("vigencia por fechas", () => {
  const tablas = [TABLA_2026, TABLA_2026_SUSPENSION_572];
  const compras = {
    id: "rf",
    kind: "retefuente",
    name: "Compras 2,5%",
    rate: 2.5,
    retention_concept: "compras_generales_declarantes",
  };
  const honorarios = { ...compras, retention_concept: "honorarios_personas_juridicas" };

  it("octubre 2026: compras 10 UVT = $524.000", () => {
    expect(baseMinimaDe(compras, "2026-10-15", tablas)?.valor).toBe(524000);
  });
  it("8 de mayo a 30 de junio 2026: compras 27 UVT = $1.414.000 (bases anteriores)", () => {
    expect(baseMinimaDe(compras, "2026-05-08", tablas)?.valor).toBe(1414000);
    expect(baseMinimaDe(compras, "2026-06-30", tablas)?.valor).toBe(1414000);
    expect(baseMinimaDe(compras, "2026-05-07", tablas)?.valor).toBe(524000);
    expect(baseMinimaDe(compras, "2026-07-01", tablas)?.valor).toBe(524000);
  });
  it("en la excepción, los conceptos que no cambian siguen la tabla general", () => {
    expect(baseMinimaDe(honorarios, "2026-06-10", tablas)?.valor).toBe(0);
  });
  it("servicios 2 UVT = $105.000; en la excepción 4 UVT = $209.000", () => {
    const serv = { ...compras, retention_concept: "servicios_generales_declarantes" };
    expect(baseMinimaDe(serv, "2026-10-01", tablas)?.valor).toBe(105000);
    expect(baseMinimaDe(serv, "2026-06-01", tablas)?.valor).toBe(209000);
  });
  it("sin tabla para el año no inventa base", () => {
    expect(baseMinimaDe(compras, "2027-01-15", tablas)).toBeNull();
  });
});
