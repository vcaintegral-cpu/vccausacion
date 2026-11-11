import { describe, expect, it } from "vitest";

import { buildJournal, type Line, type Retenciones } from "./accounting";
import { excelDocToExtracted } from "./excel-invoice-adapter";
import type { PurchaseDocument } from "./purchase-excel";
import { alignJournalToSource, captureSource, sourceErrors, validateStoredJournal } from "./source-values";

const sinRet: Retenciones = { retefuente: 0, reteiva: 0, reteica: 0, autorretencion: 0, detalle: [] };
const linea = (p: Partial<Line>): Line => ({
  description: "x",
  quantity: 1,
  unit_value: 0,
  discount: 0,
  iva: 0,
  retention: 0,
  impoconsumo: 0,
  total: 0,
  ...p,
});

// Restaurante: 2 platos (100.000 + 50.000), INC 8 % solo en el total (12.000) y recargo
// (servicio) de 15.000 en el resumen: total 177.000.
const factura = {
  prefix: "R",
  number: "1",
  issue_date: "2026-10-10",
  due_date: null,
  provider_nit: "900000001",
  provider_name: "RESTAURANTE EJEMPLO",
  provider_address: null,
  provider_city: null,
  provider_phone: null,
  provider_email: null,
  buyer_nit: "900000000",
  buyer_name: "EMPRESA",
  cufe: "c",
  payment_form: null,
  payment_method: null,
  currency: "COP",
  cost_center: null,
  notes: null,
  subtotal: 150000,
  discount: 0,
  surcharge: 15000,
  iva: 0,
  impoconsumo: 12000,
  retefuente: 0,
  reteiva: 0,
  reteica: 0,
  total: 177000,
  lines: [
    { code: null, description: "Almuerzo", quantity: 1, unit_value: 100000, discount: 0, iva: 0, retention: 0, impoconsumo: 0, total: 100000, subtotal: 100000 },
    { code: null, description: "Bebidas", quantity: 1, unit_value: 50000, discount: 0, iva: 0, retention: 0, impoconsumo: 0, total: 50000, subtotal: 50000 },
  ],
};

describe("INC solo en el total y recargo global del documento", () => {
  const fuente = captureSource(factura, "pdf");

  it("el INC sin discriminar por renglón ya no es «diferencia con la fuente»", () => {
    expect(sourceErrors(fuente)).toEqual([]);
    // Pero un INC por renglón que no suma el total sigue siendo error.
    const malo = { ...fuente, lines: fuente.lines.map((l, i) => (i === 0 ? { ...l, impoconsumo: 500000 } : l)) };
    expect(sourceErrors(malo)).toEqual(["Diferencia con la fuente: suma de INC de las líneas."]);
  });

  const lineas = [
    linea({ subtotal: 100000, account_code: "51953001", account_name: "Restaurante" }),
    linea({ subtotal: 50000, account_code: "51953001", account_name: "Restaurante" }),
  ];

  it("el recargo se suma a la cuenta del ítem principal y el asiento cuadra y valida", () => {
    const asiento = alignJournalToSource(
      buildJournal({ lines: lineas, iva: 0, impoconsumo: 12000, retenciones: sinRet, impoconsumoAccount: { code: "51159501" }, recargo: 15000 }),
      fuente,
      0,
    );
    expect(asiento.filter((l) => l.debit > 0).map((l) => [l.account_code, l.debit])).toEqual([
      ["51953001", 165000],
      ["51159501", 12000],
    ]);
    expect(asiento.find((l) => l.credit > 0)?.credit).toBe(177000);
    expect(validateStoredJournal({ raw_extraction: { valores_origen: fuente }, subtotal: 150000, iva: 0, impoconsumo: 12000, total: 177000, discount: 0 }, asiento)).toEqual([]);
  });

  it("con impoconsumo al gasto (LED LIGHTS), INC y recargo van a la cuenta del ítem", () => {
    const asiento = alignJournalToSource(
      buildJournal({ lines: lineas, iva: 0, impoconsumo: 12000, retenciones: sinRet, impoconsumoAlGasto: true, recargo: 15000 }),
      fuente,
      0,
    );
    expect(asiento.filter((l) => l.debit > 0).map((l) => [l.account_code, l.debit])).toEqual([["51953001", 177000]]);
    expect(validateStoredJournal({ raw_extraction: { valores_origen: fuente }, subtotal: 150000, iva: 0, impoconsumo: 12000, total: 177000, discount: 0 }, asiento)).toEqual([]);
  });

  it("sin recargo en el asiento, la validación lo detecta", () => {
    const asiento = alignJournalToSource(
      buildJournal({ lines: lineas, iva: 0, impoconsumo: 12000, retenciones: sinRet, impoconsumoAccount: { code: "51159501" } }),
      fuente,
      0,
    );
    expect(validateStoredJournal({ raw_extraction: { valores_origen: fuente }, subtotal: 150000, iva: 0, impoconsumo: 12000, total: 177000, discount: 0 }, asiento).length).toBeGreaterThan(0);
  });
});

describe("Excel RECIBIDOS: recargo de los renglones", () => {
  const doc = (recargoGlobal: number, recargoRenglon: number, total: number): PurchaseDocument =>
    ({
      rowNumber: 4,
      kind: "purchase",
      type: "Factura electrónica",
      period: "2026-10",
      naturalPerson: false,
      rawHeader: {},
      rawLines: [],
      header: {
        prefix: "A", number: "1", issue_date: "2026-10-01", due_date: "", provider_nit: "900000001", provider_name: "P",
        provider_address: "", provider_city: "", provider_phone: "", provider_email: "", buyer_nit: "900000000", buyer_name: "E",
        cufe: "x", payment_form: "", payment_method: "", currency: "COP", notes: "", subtotal: 100000, discount: 0,
        iva: 19000, impoconsumo: 0, total, advances: 0, surcharge: recargoGlobal, retefuente: 0, reteiva: 0, reteica: 0,
      },
      lines: [{ description: "Item", code: "", quantity: 1, unit_value: 100000, subtotal: 100000, discount: 0, surcharge: recargoRenglon, iva: 19000, ivaBase: 100000, ivaRate: 19, impoconsumo: 0, total: 119000 + recargoRenglon }],
    }) as PurchaseDocument;

  it("toma el recargo de los renglones solo si el total lo incluye", () => {
    expect(excelDocToExtracted(doc(0, 5000, 124000)).surcharge).toBe(5000);
    expect(excelDocToExtracted(doc(3000, 0, 122000)).surcharge).toBe(3000);
    // El total no lo incluye: no se inventa.
    expect(excelDocToExtracted(doc(0, 5000, 119000)).surcharge).toBe(0);
  });
});
