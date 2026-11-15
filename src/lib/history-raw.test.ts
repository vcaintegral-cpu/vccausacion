import { describe, expect, it } from "vitest";

import { esMovimientoReal, separarMovimientos, type RawHistoryRow } from "./history-raw";

const fila = (p: Partial<RawHistoryRow>, primera = ""): RawHistoryRow => ({
  excel_row: 1,
  account_code: "22050501",
  account_name: "Proveedores",
  provider_nit: "900000001",
  provider_name: "Proveedor de prueba",
  branch: null,
  voucher: null,
  sequence: null,
  entry_date_text: null,
  description: null,
  detail: null,
  cost_center: null,
  debit: null,
  credit: null,
  debit_text: null,
  credit_text: null,
  original_row_data: { "Código contable": primera },
  ...p,
});

describe("historial: solo movimientos reales", () => {
  it("un movimiento exige comprobante, fecha y cuenta", () => {
    expect(esMovimientoReal(fila({ voucher: "FC-1-10", entry_date_text: "01/10/2026" }))).toBe(
      true,
    );
    expect(esMovimientoReal(fila({ voucher: "FC-1-10" }))).toBe(false);
    expect(esMovimientoReal(fila({ entry_date_text: "01/10/2026" }))).toBe(false);
    expect(
      esMovimientoReal(
        fila({ voucher: "FC-1-10", entry_date_text: "01/10/2026", account_code: null }),
      ),
    ).toBe(false);
  });

  it("separa títulos de tercero y saldos iniciales sin duplicar valores", () => {
    const r = separarMovimientos([
      fila({ voucher: "FC-1-10", entry_date_text: "01/10/2026", credit: 100 }),
      fila({ debit: 500, credit: 500 }, "Nombre del tercero: 900000001 Proveedor de prueba"),
      fila({}, "Cuenta contable: 22050501 Proveedores"),
      fila({}, "22050501"),
    ]);
    expect(r.movimientos).toHaveLength(1);
    expect(r.titulos).toBe(2);
    expect(r.saldosIniciales).toBe(1);
  });
});
