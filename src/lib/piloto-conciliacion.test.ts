import { describe, expect, it, vi } from "vitest";

const fuentes = vi.hoisted(() => ({
  cuentas: [
    {
      etiqueta: "CORRIENTE",
      cuentaContable: "11100501",
      movimientos: [],
      saldoInicial: null,
      saldoFinal: null,
    },
    {
      etiqueta: "DAVIVIENDA",
      cuentaContable: "11200501",
      movimientos: [],
      saldoInicial: null,
      saldoFinal: null,
    },
    {
      etiqueta: "AHORROS",
      cuentaContable: "11200502",
      movimientos: [],
      saldoInicial: null,
      saldoFinal: null,
    },
  ],
  pdfs: [{ etiqueta: "DAVIVIENDA", nombre: "extracto.pdf", base64: "" }],
  advertencias: ["Aviso de prueba"],
  anterior: [],
  ajustes: [],
  rpEnviados: [],
  rcApi: [],
  librosAnteriores: [],
  pasarelas: [],
}));
const movimiento = vi.hoisted(() => vi.fn());

vi.mock("./conciliacion.functions", () => ({
  conciliacionFuentesCore: async () => fuentes,
  conciliacionMovimientoSiigoCore: movimiento,
}));

import { conciliarMes } from "./piloto-conciliacion.server";

describe("conciliación del piloto (solo lectura)", () => {
  it("sin extractos legibles no consulta a Siigo y dice qué cuentas faltan", async () => {
    const r = await conciliarMes({} as never, "empresa", "2026-11");
    expect(r.cuentas).toEqual([]);
    expect(r.sinExtracto).toEqual(["CORRIENTE", "AHORROS"]);
    expect(r.soloPdf).toEqual(["DAVIVIENDA"]);
    expect(r.advertencias).toEqual(["Aviso de prueba"]);
    expect(movimiento).not.toHaveBeenCalled();
  });

  it("con extracto cruza contra el movimiento de Siigo y cuenta lo que falta registrar", async () => {
    fuentes.cuentas[0]!.movimientos = [
      {
        id: "b1",
        fecha: "2026-11-03",
        descripcion: "PAGO PROVEEDOR RP-1-100",
        valor: -500000,
        refs: ["RP-1-100"],
      },
      { id: "b2", fecha: "2026-11-05", descripcion: "TRANSFERENCIA DESCONOCIDA", valor: -120000 },
      { id: "b3", fecha: "2026-11-06", descripcion: "ABONO CLIENTE", valor: 300000 },
    ] as never;
    movimiento.mockResolvedValue({
      filas: [
        {
          account_code: "11100501",
          voucher: "RP-1-100",
          entry_date_text: "03/11/2026",
          debit: 0,
          credit: 500000,
          provider_name: "Proveedor de prueba",
          description: "Pago",
        },
      ],
      balance: [],
      advertencias: ["Balance de prueba no disponible"],
      documentos: 1,
    });
    const r = await conciliarMes({} as never, "empresa", "2026-11");
    expect(movimiento).toHaveBeenCalledWith(expect.anything(), {
      companyId: "empresa",
      desde: "2026-11-01",
      hasta: "2026-11-30",
    });
    expect(r.cuentas).toHaveLength(1);
    const c = r.cuentas[0]!;
    expect(c.etiqueta).toBe("CORRIENTE");
    expect(c.movimientosBanco).toBe(3);
    expect(c.cruzados).toBe(1);
    expect(c.salidasSinRp).toBe(1);
    expect(c.ingresosSinRc).toBe(1);
    expect(r.advertencias).toContain("Balance de prueba no disponible");
  });
});
