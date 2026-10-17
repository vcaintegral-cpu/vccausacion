import { describe, expect, it } from "vitest";
import {
  ajusteAlPeso,
  applyProviderRuleToLines,
  esLineaAIU,
  headerRule,
  isValidExpenseAccount,
  ivaDetalleDesdeRegla,
  matchProviderRule,
  retencionDesdeRegla,
  type ProviderRule,
} from "@/lib/provider-rules";
import type { Line } from "@/lib/accounting";

const regla = (over: Partial<ProviderRule>): ProviderRule => ({
  id: "r1",
  company_id: "c1",
  provider_nit: "900092385",
  provider_name: "UNE EPM",
  keyword: "(todas)",
  expense_account: "51353503",
  expense_account_name: null,
  iva_treatment: "descontable",
  iva_account: "24081013",
  inc_account: null,
  retention_account: null,
  retention_rate: null,
  retention_base: null,
  payable_account: "22050501",
  source: "inicial",
  times_used: 0,
  last_used_at: null,
  active: true,
  ...over,
});

const linea = (over: Partial<Line>): Line => ({
  description: "Servicio",
  quantity: 1,
  unit_value: 100000,
  discount: 0,
  iva: 19000,
  retention: 0,
  impoconsumo: 0,
  total: 100000,
  ...over,
});

describe("isValidExpenseAccount", () => {
  it("acepta grupos 5, 6, 7, 15, 16 y 17", () => {
    for (const c of ["51101001", "61359501", "71959501", "15160501", "1610", "1705"]) {
      expect(isValidExpenseAccount(c)).toBe(true);
    }
  });
  it("rechaza 11, 13, 22, 23 y 24", () => {
    for (const c of ["11200502", "13300501", "22050501", "23352502", "24081013"]) {
      expect(isValidExpenseAccount(c)).toBe(false);
    }
  });
});

describe("matchProviderRule", () => {
  const rules = [
    regla({ id: "todas", keyword: "(todas)", expense_account: "51353503" }),
    regla({ id: "mora", keyword: "MORA", expense_account: "53052002" }),
  ];
  it("la palabra clave específica tiene prioridad sobre (todas)", () => {
    expect(matchProviderRule(rules, "900092385", "Intereses de mora junio")?.id).toBe("mora");
  });
  it("sin coincidencia usa la regla (todas)", () => {
    expect(matchProviderRule(rules, "900092385", "Servicio de internet")?.id).toBe("todas");
  });
  it("ignora mayúsculas y tildes", () => {
    expect(matchProviderRule(rules, "900092385", "MÓRA factura")?.id).toBe("mora");
  });
  it("otro NIT no tiene regla", () => {
    expect(matchProviderRule(rules, "800153993", "MORA")).toBeNull();
  });
});

describe("applyProviderRuleToLines", () => {
  it("asigna la cuenta de la regla a líneas sin cuenta", () => {
    const { lines } = applyProviderRuleToLines([linea({})], [regla({})], "900092385");
    expect(lines[0]!.account_code).toBe("51353503");
  });
  it("descarta una cuenta de gasto inválida y deja la línea sin cuenta", () => {
    const { lines } = applyProviderRuleToLines(
      [linea({})],
      [regla({ expense_account: "22050501" })],
      "900092385",
    );
    expect(lines[0]!.account_code).toBeUndefined();
  });
  it("no pisa una cuenta ya asignada", () => {
    const { lines } = applyProviderRuleToLines([linea({ account_code: "51101001" })], [regla({})], "900092385");
    expect(lines[0]!.account_code).toBe("51101001");
  });
});

describe("retencionDesdeRegla", () => {
  const atila = regla({
    provider_nit: "811016618",
    retention_account: "23652502",
    retention_rate: 2,
    retention_base: "AIU",
  });
  it("base Subtotal: suma de las líneas sin IVA", () => {
    const r = retencionDesdeRegla(regla({ retention_account: "23651501", retention_rate: 11, retention_base: "Subtotal" }), [
      linea({ unit_value: 100000 }),
      linea({ unit_value: 50000 }),
    ]);
    expect(r?.base).toBe(150000);
    expect(r?.amount).toBe(16500);
  });
  it("base AIU: solo líneas con ADMINISTRACION, UTILIDAD, IMPREVISTOS o AIU", () => {
    expect(esLineaAIU("ADMINISTRACION Y UTILIDAD")).toBe(true);
    expect(esLineaAIU("Vigilancia AIU")).toBe(true);
    expect(esLineaAIU("Servicio de aseo")).toBe(false);
    const r = retencionDesdeRegla(atila, [
      linea({ description: "ADMINISTRACION, UTILIDAD E IMPREVISTOS", unit_value: 80000 }),
      linea({ description: "Vigilancia", unit_value: 20000 }),
    ]);
    expect(r?.base).toBe(80000);
    expect(r?.amount).toBe(1600);
  });
  it("sin valor positivo no hay retención", () => {
    expect(retencionDesdeRegla(atila, [linea({ description: "Vigilancia" })])).toBeNull();
  });
});

describe("ivaDetalleDesdeRegla", () => {
  it("descontable: cuenta de la regla", () => {
    expect(ivaDetalleDesdeRegla(regla({}), [linea({})], 19000)).toEqual([
      { account_code: "24081013", account_name: "IVA", amount: 19000 },
    ]);
  });
  it("asumido: 51157001", () => {
    const d = ivaDetalleDesdeRegla(regla({ iva_treatment: "asumido", iva_account: null }), [linea({})], 19000);
    expect(d?.[0]?.account_code).toBe("51157001");
  });
  it("capitalizado: el IVA se suma a la cuenta de la línea", () => {
    const d = ivaDetalleDesdeRegla(
      regla({ iva_treatment: "capitalizado", iva_account: "15160501" }),
      [linea({ account_code: "15160501" })],
      19000,
    );
    expect(d).toEqual([{ account_code: "15160501", account_name: "IVA capitalizado", amount: 19000 }]);
  });
  it("N/A: sin línea de IVA", () => {
    expect(ivaDetalleDesdeRegla(regla({ iva_treatment: "na" }), [linea({})], 19000)).toEqual([]);
  });
});

describe("ajusteAlPeso", () => {
  it("diferencia de centavos va a 42958101 al crédito si sobran débitos", () => {
    const a = ajusteAlPeso(100000.5, 100000);
    expect(a.linea?.account_code).toBe("42958101");
    expect(a.linea?.credit).toBe(0.5);
    expect(a.descuadre).toBe(0);
  });
  it("diferencia de centavos va al débito si sobran créditos", () => {
    const a = ajusteAlPeso(100000, 100000.75);
    expect(a.linea?.debit).toBe(0.75);
  });
  it("diferencia mayor a $1 es descuadre", () => {
    expect(ajusteAlPeso(100000, 98000).descuadre).toBe(2000);
  });
  it("cuadrado no genera línea", () => {
    expect(ajusteAlPeso(100000, 100000).linea).toBeNull();
  });
});

describe("headerRule", () => {
  it("prefiere la regla (todas) del proveedor", () => {
    const rules = [
      regla({ id: "mora", keyword: "MORA", times_used: 9 }),
      regla({ id: "todas", keyword: "(todas)", times_used: 1 }),
    ];
    expect(headerRule(rules, "900092385")?.id).toBe("todas");
  });
});
