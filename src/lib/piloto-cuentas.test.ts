import { describe, expect, it } from "vitest";
import { reconocerCuenta, sugerirCuentas } from "./piloto-cuentas.server";

const cuentas = [
  { code: "51955101", name: "Elementos de aseo y cafetería" },
  { code: "51952501", name: "Útiles, papelería y fotocopias" },
  { code: "51951501", name: "Gastos de viaje" },
  { code: "5195", name: "Diversos" },
];
const valida = (c: string) => c.length === 8;

describe("sugerirCuentas", () => {
  const historial = [
    { concept: "Papel higiénico y toallas", account_code: "51955101", weight: 4 },
    { concept: "Resma de papel carta", account_code: "51952501", weight: 9 },
    { concept: "Tiquetes aéreos", account_code: "51951501", weight: 2 },
  ];
  const puede = (c: string) => {
    const x = cuentas.find((a) => a.code === c && valida(a.code));
    return x ? { codigo: x.code, nombre: x.name } : null;
  };
  it("propone las cuentas con conceptos parecidos, la más fuerte primero", () => {
    const r = sugerirCuentas(["Resma de papel oficio"], historial, puede);
    expect(r[0]?.codigo).toBe("51952501");
  });
  it("sin coincidencias no inventa sugerencias", () => {
    expect(sugerirCuentas(["Servicio de grúa"], historial, puede)).toEqual([]);
  });
});

describe("reconocerCuenta", () => {
  it("reconoce un código exacto de una cuenta válida", () => {
    expect(reconocerCuenta("51955101", cuentas, valida)?.name).toContain("aseo");
    expect(reconocerCuenta("5195", cuentas, valida)).toBeNull(); // cuenta padre ambigua: no es de movimiento
  });
  it("reconoce el nombre aunque venga sin tildes o con otras palabras", () => {
    expect(reconocerCuenta("papeleria", cuentas, valida)?.code).toBe("51952501");
    expect(reconocerCuenta("gastos de viaje", cuentas, valida)?.code).toBe("51951501");
  });
  it("no adivina si no coincide", () => {
    expect(reconocerCuenta("combustible", cuentas, valida)).toBeNull();
    expect(reconocerCuenta("", cuentas, valida)).toBeNull();
  });
});

describe("interpretarCondicionEscrita", () => {
  const imp = [
    { id: "a", name: "Compras 2.5%", rate: 2.5 },
    { id: "b", name: "Servicios 4%", rate: 4 },
    { id: "c", name: "Servicios 6%", rate: 6 },
    { id: "d", name: "Honorarios 10%", rate: 10 },
  ];
  it("«no se le retiene…» queda como sin retención con su motivo y detalle", async () => {
    const { interpretarCondicionEscrita } = await import("./piloto-cuentas.server");
    expect(
      interpretarCondicionEscrita("No se le retiene porque es régimen especial", imp),
    ).toMatchObject({ tipo: "sin", motivo: "regimen_especial" });
    expect(interpretarCondicionEscrita("no aplica retención, base menor", imp)).toMatchObject({
      tipo: "sin",
      motivo: "otro",
    });
  });
  it("busca el impuesto por nombre y tarifa, solo si es único", async () => {
    const { interpretarCondicionEscrita } = await import("./piloto-cuentas.server");
    expect(interpretarCondicionEscrita("retener servicios 4%", imp)).toMatchObject({
      tipo: "con",
      impuestoId: "b",
    });
    expect(interpretarCondicionEscrita("honorarios", imp)).toMatchObject({ impuestoId: "d" });
    expect(interpretarCondicionEscrita("2,5", imp)).toMatchObject({ impuestoId: "a" });
    expect(interpretarCondicionEscrita("servicios", imp)).toBeNull(); // ambiguo
    expect(interpretarCondicionEscrita("", imp)).toBeNull();
  });
});
