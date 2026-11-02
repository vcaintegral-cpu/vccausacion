import { describe, expect, it, vi } from "vitest";

// Solo se prueban funciones puras: la base de datos y la cola de cargas no se usan.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/bulk-runner", () => ({ invalidateBulkDeps: () => undefined }));

const { leerTablaBases, numero, sugerirConcepto } = await import("./bases-minimas-panel");
const { bloquesDesdeDecision } = await import("./condicion-tributaria-panel");
const { emptyRetBlocks } = await import("@/lib/retenciones-multi");
const { CONCEPTOS_2026 } = await import("@/lib/bases-minimas-2026");

describe("numero", () => {
  it("lee formatos colombianos y anglosajones", () => {
    expect(numero("52.374")).toBe(52374);
    expect(numero("$ 1.234.567,50")).toBe(1234567.5);
    expect(numero("1,234,567.50")).toBe(1234567.5);
    expect(numero("2,5%")).toBe(2.5);
    expect(numero(4)).toBe(4);
    expect(numero("")).toBe(0);
  });
});

describe("leerTablaBases", () => {
  it("lee concepto, base en UVT y tarifas con encabezados en cualquier fila", () => {
    const filas = [
      ["TABLA DE RETENCIÓN EN LA FUENTE"],
      [],
      ["Concepto", "Base UVT", "Base pesos", "Tarifa declarante", "Tarifa no declarante"],
      ["Compras generales", 10, 500000, "2,5%", "3,5%"],
      ["Servicios generales", 2, 100000, 4, 6],
      ["Honorarios", 0, 0, 11, 10],
      ["", "", "", "", ""],
    ];
    expect(leerTablaBases(filas, 50000)).toEqual([
      {
        id: "compras_generales",
        concepto: "Compras generales",
        base_uvt: 10,
        tarifa_declarante: 2.5,
        tarifa_no_declarante: 3.5,
        notas: null,
      },
      {
        id: "servicios_generales",
        concepto: "Servicios generales",
        base_uvt: 2,
        tarifa_declarante: 4,
        tarifa_no_declarante: 6,
        notas: null,
      },
      {
        id: "honorarios",
        concepto: "Honorarios",
        base_uvt: 0,
        tarifa_declarante: 11,
        tarifa_no_declarante: 10,
        notas: null,
      },
    ]);
  });

  it("si solo trae la base en pesos la convierte a UVT con la UVT del año", () => {
    const filas = [
      ["Concepto", "Base mínima en pesos", "Tarifa %"],
      ["Arrendamiento de bienes inmuebles", "500.000", "3,5"],
    ];
    expect(leerTablaBases(filas, 50000)[0]).toMatchObject({ base_uvt: 10, tarifa_declarante: 3.5 });
  });

  it("conceptos repetidos reciben identificadores distintos", () => {
    const filas = [
      ["Concepto", "UVT"],
      ["Servicios", 2],
      ["Servicios", 4],
    ];
    expect(leerTablaBases(filas, 1).map((c) => c.id)).toEqual(["servicios", "servicios_2"]);
  });

  it("sin columna Concepto avisa", () => {
    expect(() => leerTablaBases([["A", "B"]], 1)).toThrow('No encontré una columna "Concepto"');
  });
});

describe("sugerirConcepto con la tabla real 2026", () => {
  // Nombres típicos de retenciones sincronizadas desde Siigo.
  const casos: Array<[string, number, string | null]> = [
    ["Retención en la fuente compras 2,5%", 2.5, "compras_generales_declarantes"],
    ["Retefuente compras no declarantes 3,5%", 3.5, "compras_generales_no_declarantes"],
    ["Retefuente servicios 4%", 4, "servicios_generales_declarantes"],
    ["Retefuente servicios no declarantes 6%", 6, "servicios_generales_no_declarantes"],
    ["Retención honorarios 11%", 11, null], // personas jurídicas y naturales >3.300 UVT: 11 % en ambos, no adivina
    ["Honorarios no declarantes 10%", 10, "honorarios_no_declarantes"],
    ["Retención transporte de carga 1%", 1, "transporte_carga"],
    ["Arrendamiento bienes muebles 4%", 4, "arrendamiento_muebles"],
    ["Retención combustibles 0,1%", 0.1, "combustibles"],
    ["Licenciamiento software 3,5%", 3.5, "licenciamiento_software"],
    ["Retención vigilancia y aseo 2%", 2, "vigilancia_aseo_aiu"],
    ["Retención otros 1%", 1, null],
  ];
  for (const [nombre, tarifa, esperado] of casos) {
    it(`${nombre} → ${esperado ?? "sin sugerencia"}`, () => {
      expect(sugerirConcepto({ name: nombre, rate: tarifa }, CONCEPTOS_2026)).toBe(esperado);
    });
  }
});

describe("bloquesDesdeDecision", () => {
  it("aplica la retención sugerida y apaga las exentas sin tocar las demás", () => {
    const blocks = emptyRetBlocks();
    blocks.reteica = { ...blocks.reteica, apply: true, amount: 966, base: 100000, rate: 0.966 };
    blocks.reteiva = { ...blocks.reteiva, apply: true, amount: 2850, base: 19000, rate: 15 };
    const tax = {
      id: "rf",
      kind: "retefuente",
      name: "Compras 2,5%",
      rate: 2.5,
      account_code: "23654001",
    };
    const next = bloquesDesdeDecision(
      blocks,
      {
        aplicar: [{ kind: "retefuente", tax, base: 100000, amount: 2500, origen: "x" }],
        avisos: [],
        confirmar: null,
      },
      { sinRetencion: { reteiva: { motivo: "gran_contribuyente" } } },
      [{ code: "23654001", name: "Retención compras", active: true, is_movement: true }],
    );
    expect(next.retefuente).toMatchObject({
      apply: true,
      taxId: "rf",
      base: 100000,
      rate: 2.5,
      amount: 2500,
      account_code: "23654001",
    });
    expect(next.reteiva).toMatchObject({ apply: false, amount: 0 });
    expect(next.reteica).toEqual(blocks.reteica);
  });
});
