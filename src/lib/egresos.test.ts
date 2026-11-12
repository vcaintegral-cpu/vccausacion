import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { esReporteDeMes, tipoDeArchivo } from "./drive-sync";
import {
  aprenderEgresos,
  erroresAntesDeEnviar,
  montosPorFactura,
  nitPorNombre,
  parseMonto,
  patronConcepto,
  payloadRecibo,
  proponerEgreso,
  referenciasFactura,
  type Contexto,
  type MovimientoPago,
} from "./egresos";
import { leerConsolidadoPagos, periodoDeNombre } from "./lector-consolidado-pagos";

// Datos ficticios.
const mov = (p: Partial<MovimientoPago>): MovimientoPago => ({
  clave: "k",
  fila: 1,
  fecha: "2026-10-14",
  descripcion: "PAGO A PROVE",
  tercero: "PINTURAS DEL VALLE S.A.S.",
  terceroNit: null,
  valor: 100000,
  cuenta: "CORRIENTE",
  relacion: null,
  aplicacion: null,
  observaciones: null,
  referencia: null,
  ...p,
});
const ctx = (p: Partial<Contexto> = {}): Contexto => ({
  cxp: [
    {
      prefix: "FC-1",
      consecutive: 101,
      quote: 1,
      dueDate: "2026-10-01",
      balance: 392725,
      providerNit: "900111222",
      providerName: "PINTURAS DEL VALLE S.A.S.",
      facturaProveedor: "FE-7003",
    },
    {
      prefix: "FC-1",
      consecutive: 102,
      quote: 1,
      dueDate: "2026-10-03",
      balance: 2488025,
      providerNit: "900111222",
      providerName: "PINTURAS DEL VALLE S.A.S.",
      facturaProveedor: "FE-7009",
    },
    {
      prefix: "FC-1",
      consecutive: 103,
      quote: 1,
      dueDate: "2026-10-05",
      balance: 500000,
      providerNit: "900333444",
      providerName: "TRANSPORTES ANDINOS SAS",
      facturaProveedor: "TA-55",
    },
  ],
  causadas: [{ factura: "FE-54769", nit: "70111222", siigo: "FC-1-90" }],
  terceros: [
    { nit: "900111222", nombre: "PINTURAS DEL VALLE S.A.S." },
    { nit: "900333444", nombre: "TRANSPORTES ANDINOS SAS" },
    { nit: "70111222", nombre: "FERRETERIA EL TORNILLO" },
    { nit: "890903938", nombre: "BANCO EJEMPLO S.A." },
  ],
  bancos: [
    { patron: "CORRIENTE", cuenta_banco: "11100501", payment_type_id: "5638" },
    { patron: "EFECTIVO", cuenta_banco: "11050501", payment_type_id: "5640" },
  ],
  conceptos: [],
  precedente: null,
  ...p,
});

describe("lectura de montos y facturas escritos a mano", () => {
  it("montos en formato con coma o punto de miles", () => {
    expect(parseMonto("$ 1,076,889.89")).toBe(1076889.89);
    expect(parseMonto("$13.000,37")).toBe(13000.37);
    expect(parseMonto("$11.600")).toBe(11600);
    expect(parseMonto("392725")).toBe(392725);
  });
  it("facturas citadas en la relación", () => {
    const r = (t: string) => referenciasFactura(t).map((x) => `${x.prefijo}-${x.numero}`);
    expect(r("FE 7003\nFE 7009")).toEqual(["FE-7003", "FE-7009"]);
    expect(r("RR-8524, RR-8527 y RR-8546")).toEqual(["RR-8524", "RR-8527", "RR-8546"]);
    expect(r("FE - 3615\nFE - 3637")).toEqual(["FE-3615", "FE-3637"]);
    expect(r("FMED130197")).toEqual(["FMED-130197"]);
    expect(r("A520-1365004")).toEqual(["A520-1365004"]);
    expect(r("N/F - Tiquete: 252459")).toEqual([]);
    expect(r("GTO. BANCARIO")).toEqual([]);
  });
  it("valor de cada factura en las observaciones", () => {
    const refs = referenciasFactura("FE 7003\nFE 7009");
    const m = montosPorFactura("FE 7003 $ 392,725.00\nFE 7009 $ 2,488,025.00", refs);
    expect([...m]).toEqual([
      ["FE|7003", 392725],
      ["FE|7009", 2488025],
    ]);
  });
  it("NIT por nombre: exacto o por palabras, solo si es único", () => {
    const t = ctx().terceros;
    expect(nitPorNombre("Pinturas del Valle SAS", t)).toBe("900111222");
    expect(nitPorNombre("TRANSPORTES ANDINOS", t)).toBe("900333444");
    expect(nitPorNombre("JUAN", t)).toBeNull();
  });
});

describe("propuesta del recibo de pago", () => {
  it("un pago de dos facturas con el valor de cada una → abono a deuda con dos vencimientos", () => {
    const m = mov({
      valor: 2880750,
      relacion: "FE 7003\nFE 7009",
      observaciones: "FE 7003 $ 392,725.00\nFE 7009 $ 2,488,025.00",
    });
    const p = proponerEgreso(m, ctx());
    expect(p).toMatchObject({
      tipo: "pago_facturas",
      listo: true,
      terceroNit: "900111222",
      paymentTypeId: "5638",
    });
    expect(p.items.map((i) => [i.consecutive, i.valor])).toEqual([
      [101, 392725],
      [102, 2488025],
    ]);
    expect(payloadRecibo(m, p, 77)).toEqual({
      document: { id: 77 },
      date: "2026-10-14",
      type: "DebtPayment",
      supplier: { identification: "900111222", branch_office: 0 },
      items: [
        { due: { prefix: "FC-1", consecutive: 101, quote: 1 }, value: 392725 },
        { due: { prefix: "FC-1", consecutive: 102, quote: 1 }, value: 2488025 },
      ],
      payment: { id: 5638, value: 2880750 },
      observations: "PAGO A PROVE · FE 7003 FE 7009",
    });
    expect(erroresAntesDeEnviar(m, p)).toEqual([]);
  });
  it("pago menor que el saldo sin decir «abono» → alerta de diferencia con la CxP", () => {
    const p = proponerEgreso(
      mov({ valor: 487500, relacion: "TA-55", tercero: "TRANSPORTES ANDINOS SAS" }),
      ctx(),
    );
    expect(p.listo).toBe(false);
    expect(p.motivos.join(" ")).toMatch(/Diferencia con la CxP.*Analizar diferencia/);
  });
  it("pago menor que el saldo con «abono» en la aplicación → abono a la factura", () => {
    const p = proponerEgreso(
      mov({
        valor: 200000,
        relacion: "TA-55",
        aplicacion: "Abono",
        tercero: "TRANSPORTES ANDINOS SAS",
      }),
      ctx(),
    );
    expect(p.listo).toBe(true);
    expect(p.items).toMatchObject([{ consecutive: 103, valor: 200000, saldo: 500000 }]);
    expect(p.notas.join(" ")).toMatch(/abono/);
  });
  it("centavos de las observaciones: la diferencia de hasta $1 se ajusta en la factura mayor", () => {
    const m = mov({
      valor: 2880751,
      relacion: "FE 7003\nFE 7009",
      observaciones: "FE 7003 $ 392,725.00\nFE 7009 $ 2,488,025.40",
    });
    const c = ctx();
    c.cxp[1]!.balance = 2488026;
    const p = proponerEgreso(m, c);
    expect(p.listo).toBe(true);
    expect(p.items.reduce((s, i) => s + i.valor, 0)).toBe(2880751);
    expect(erroresAntesDeEnviar(m, p)).toEqual([]);
  });
  it("las facturas no cuadran con el pago (cruce con saldo a favor) → por revisar con el motivo", () => {
    const p = proponerEgreso(
      mov({
        valor: 721557.86,
        relacion: "FE 7003\nFE 7009",
        aplicacion: "Cruza con saldo a favor",
        observaciones: "FE 7003 $ 392,725.00\nFE 7009 $ 2,488,025.00",
      }),
      ctx(),
    );
    expect(p.listo).toBe(false);
    expect(p.motivos.join(" ")).toMatch(/suman .* y el pago es .*saldo a favor/);
  });
  it("factura que no está en las CxP → por revisar; causada sin saldo → sin recibo (pagada de contado)", () => {
    expect(proponerEgreso(mov({ relacion: "ZZ 999" }), ctx()).motivos.join(" ")).toMatch(
      /no está en las cuentas por pagar/,
    );
    const p = proponerEgreso(
      mov({ relacion: "FE 54769", tercero: "FERRETERIA EL TORNILLO", cuenta: "EFECTIVO" }),
      ctx(),
    );
    expect(p.tipo).toBe("omitir");
    expect(p.listo).toBe(false);
    expect(p.motivos.join(" ")).toMatch(/sin saldo por pagar/);
  });
  it("anticipo", () => {
    const m = mov({
      relacion: "ANTICIPO IMPORTACIÓN",
      tercero: "TRANSPORTES ANDINOS SAS",
      valor: 3000000,
    });
    const p = proponerEgreso(m, ctx());
    expect(p).toMatchObject({ tipo: "anticipo", listo: true, terceroNit: "900333444" });
    expect(payloadRecibo(m, p, 77)).toMatchObject({
      type: "AdvancePayment",
      payment: { id: 5638, value: 3000000 },
    });
  });
  it("gasto bancario: por revisar sin cuenta; con la regla aprendida → RP detallado débito gasto / crédito banco", () => {
    const m = mov({
      descripcion: "CUOTA PLAN CANAL NEGOCIOS",
      tercero: null,
      relacion: "GTO. BANCARIO",
      valor: 78000,
      cuenta: "CORRIENTE",
    });
    expect(proponerEgreso(m, ctx()).listo).toBe(false);
    const patron = patronConcepto(m);
    expect(patron).toBe("concepto:gasto_bancario");
    const p = proponerEgreso(
      m,
      ctx({
        conceptos: [
          { patron, tipo: "detallado", cuenta_debito: "53050501", tercero_nit: "890903938" },
        ],
      }),
    );
    expect(p).toMatchObject({ tipo: "detallado", listo: true, terceroNit: "890903938" });
    expect(payloadRecibo(m, p, 77)).toMatchObject({
      type: "Detailed",
      supplier: { identification: "890903938" },
      items: [
        { account: { code: "53050501", movement: "Debit" }, value: 78000 },
        { account: { code: "11100501", movement: "Credit" }, value: 78000 },
      ],
    });
  });
  it("nómina: la regla da la cuenta, pero el tercero es el empleado de cada pago", () => {
    const regla = {
      patron: "concepto:nomina",
      tipo: "detallado",
      cuenta_debito: "25050101",
      tercero_nit: "1000000001",
    };
    const p = proponerEgreso(
      mov({ relacion: "NÓM. 1Q OCTUBRE", tercero: "EMPLEADO NUEVO", valor: 900000 }),
      ctx({ conceptos: [regla] }),
    );
    expect(p.terceroNit).toBeNull();
    expect(p.motivos.join(" ")).toMatch(/Falta el tercero/);
  });
  it("una categoría escrita en la relación se aprende tal cual y puede omitirse", () => {
    const m = mov({
      relacion: "TRASLADO",
      descripcion: "TRANSFERENCIA ENTRE CUENTAS",
      tercero: null,
    });
    expect(patronConcepto(m)).toBe("relacion:TRASLADO");
    expect(
      proponerEgreso(
        m,
        ctx({
          conceptos: [
            { patron: "relacion:TRASLADO", tipo: "omitir", cuenta_debito: null, tercero_nit: null },
          ],
        }),
      ),
    ).toMatchObject({ tipo: "omitir", listo: true });
  });
  it("precedente del auxiliar: cuenta y tercero de los comprobantes de egreso", () => {
    const linea = (
      voucher: string,
      account_code: string,
      debit: number,
      credit: number,
      description: string,
      provider_nit: string | null,
    ) => ({ voucher, account_code, debit, credit, description, provider_nit });
    const prec = aprenderEgresos([
      linea("CE-1-10", "53051501", 1000, 0, "GRAVAMEN MOVIMIENTO FINANCIERO", "890903938"),
      linea("CE-1-10", "11100501", 0, 1000, "GRAVAMEN MOVIMIENTO FINANCIERO", "890903938"),
      linea("CE-1-11", "53051501", 2000, 0, "IMPTO GOBIERNO 4X1000", "890903938"),
      linea("CE-1-11", "11100501", 0, 2000, "IMPTO GOBIERNO 4X1000", "890903938"),
      linea("FC-1-5", "51350501", 9000, 0, "COMPRA", "900111222"),
    ]);
    expect(prec.comprobantes).toBe(2);
    const m = mov({
      relacion: "4X1000",
      descripcion: "IMPTO GOBIERNO 4X1000",
      tercero: null,
      valor: 3500,
    });
    const p = proponerEgreso(m, ctx({ precedente: prec }));
    expect(p).toMatchObject({ tipo: "detallado", listo: true, terceroNit: "890903938" });
    expect(p.cuentas[0]).toMatchObject({ code: "53051501", movimiento: "Debit" });
  });
  it("sin forma de pago para el origen del pago → por revisar", () => {
    const p = proponerEgreso(
      mov({ valor: 392725, relacion: "FE 7003", cuenta: "DAVIVIENDA" }),
      ctx(),
    );
    expect(p.listo).toBe(false);
    expect(p.motivos.join(" ")).toMatch(/Falta la forma de pago de Siigo para «DAVIVIENDA»/);
  });
});

describe("reporte mensual de pagos (hoja Consolidado)", () => {
  const libro = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["FECHA", "DESCRIPCIÓN"],
        [new Date(2026, 9, 1), "x"],
      ]),
      "Cte. (W)",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        [
          "FECHA",
          "DESCRIPCIÓN",
          "SUCURSAL/CANAL",
          "REFERENCIA 1",
          "REFERENCIA 2",
          "TERCERO",
          "VALOR",
          "CUENTA",
          "RELACIÓN",
          "APLICACIÓN",
          "OBSERVACIONES",
        ],
        [
          new Date(2026, 9, 1),
          "CUOTA PLAN CANAL NEGOCIOS",
          "SUC",
          null,
          null,
          null,
          -78000,
          "AHORROS",
          "GTO. BANCARIO",
          null,
          null,
        ],
        [
          new Date(2026, 9, 2),
          "ABONO CLIENTE",
          "SUC",
          null,
          null,
          "CLIENTE X",
          500000,
          "CORRIENTE",
          "RC-1-1",
          null,
          null,
        ],
        [
          new Date(2026, 9, 14),
          "PAGO A PROVE PINTURAS",
          "SUC",
          900111222,
          null,
          "PINTURAS DEL VALLE S.A.S.",
          -2880750,
          "CORRIENTE",
          "FE 7003\nFE 7009",
          null,
          "FE 7003 $ 392,725.00\nFE 7009 $ 2,488,025.00",
        ],
        [
          new Date(2026, 9, 14),
          "PAGO A PROVE PINTURAS",
          "SUC",
          900111222,
          null,
          "PINTURAS DEL VALLE S.A.S.",
          -2880750,
          "CORRIENTE",
          "FE 7003\nFE 7009",
          null,
          null,
        ],
      ]),
      "Consolidado",
    );
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  };
  it("lee solo los egresos, con su periodo y una clave estable por pago", () => {
    const r = leerConsolidadoPagos(libro(), "OCTUBRE 2026");
    expect(r.periodo).toBe("2026-10");
    expect(r.ingresos).toBe(1);
    expect(r.egresos).toHaveLength(3);
    expect(r.egresos[0]).toMatchObject({
      fecha: "2026-10-01",
      valor: 78000,
      cuenta: "AHORROS",
      relacion: "GTO. BANCARIO",
      tercero: null,
    });
    expect(r.egresos[1]).toMatchObject({
      valor: 2880750,
      tercero: "PINTURAS DEL VALLE S.A.S.",
      referencia: "900111222",
    });
    // Dos pagos iguales el mismo día: claves distintas.
    expect(new Set(r.egresos.map((e) => e.clave)).size).toBe(3);
  });
  it("nombre del reporte del mes y su tipo en la carpeta de egresos", () => {
    expect(periodoDeNombre("OCTUBRE 2026")).toBe("2026-10");
    expect(esReporteDeMes("OCTUBRE 2026")).toBe(true);
    expect(esReporteDeMes("Corriente - 33375219677_OCT2026.xlsx")).toBe(false);
    expect(esReporteDeMes("Formato_350_9_2026.xlsx")).toBe(false);
    expect(
      tipoDeArchivo("egresos", "OCTUBRE 2026", "application/vnd.google-apps.spreadsheet"),
    ).toBe("relacion_pagos");
    expect(tipoDeArchivo("egresos", "Extracto octubre 2026.xlsx", null)).toBe("extracto");
    expect(
      tipoDeArchivo("compras", "OCTUBRE 2026", "application/vnd.google-apps.spreadsheet"),
    ).toBeNull();
  });
});

describe("correcciones: CxP repetidas, cuenta del banco y CxP sin leer", () => {
  it("un vencimiento repetido por Siigo se guarda una vez; partido por centro de costo se suma", async () => {
    const { unirVencimientos } = await import("./egresos");
    const v = (balance: number, cost_center: string | null) => ({
      prefix: "FC-1",
      consecutive: 10,
      quote: 1,
      balance,
      cost_center,
      provider_nit: "900111222",
    });
    expect(unirVencimientos([v(1000, null), v(1000, null)])).toEqual([v(1000, null)]);
    expect(unirVencimientos([v(600, "1"), v(400, "2")])[0]!.balance).toBe(1000);
    expect(unirVencimientos([v(1000, null), { ...v(5, null), consecutive: 11 }])).toHaveLength(2);
  });
  it("cuenta de banco/caja del origen desde el PUC cuando la forma de pago no la trae", async () => {
    const { cuentaBancoDeOrigen } = await import("./egresos");
    const puc = [
      { code: "1105", name: "Caja" },
      { code: "11050501", name: "Caja general" },
      { code: "1110", name: "Bancos" },
      { code: "11100501", name: "Bancolombia cuenta corriente" },
      { code: "11200501", name: "Bancolombia cuenta de ahorros" },
      { code: "11200502", name: "Davivienda ahorros" },
    ];
    expect(cuentaBancoDeOrigen("CORRIENTE", puc)).toBe("11100501");
    expect(cuentaBancoDeOrigen("EFECTIVO", puc)).toBe("11050501");
    expect(cuentaBancoDeOrigen("DAVIVIENDA", puc)).toBe("11200502");
    // «AHORROS» coincide con dos cuentas: solo se elige si una es la usada en egresos.
    expect(cuentaBancoDeOrigen("AHORROS", puc)).toBeNull();
    expect(cuentaBancoDeOrigen("AHORROS", puc, new Map([["11200501", 1]]))).toBe("11200501");
    const m = mov({
      descripcion: "IMPTO GOBIERNO 4X1000",
      relacion: "4X1000",
      tercero: null,
      cuenta: "CORRIENTE",
      valor: 400,
    });
    const p = proponerEgreso(
      m,
      ctx({
        bancos: [{ patron: "CORRIENTE", cuenta_banco: null, payment_type_id: "5638" }],
        cuentasBanco: puc,
      }),
    );
    expect(p.cuentaBanco).toBe("11100501");
  });
  it("sin CxP leídas de Siigo no se concluye que una factura causada no tenga saldo", () => {
    const p = proponerEgreso(
      mov({ relacion: "FE 54769", tercero: "FERRETERIA EL TORNILLO", cuenta: "EFECTIVO" }),
      ctx({ cxp: [] }),
    );
    expect(p.tipo).toBe("pago_facturas");
    expect(p.motivos.join(" ")).toMatch(/Sincronizar CxP de Siigo/);
  });
});

describe("RP único del mes de gastos bancarios por cuenta bancaria", () => {
  it("comisiones, IVA bancario y 4x1000 de un banco llevan el mismo grupo; efectivo y proveedores no", async () => {
    const { grupoBancario } = await import("./egresos");
    expect(grupoBancario("4x1000", "CORRIENTE")).toBe("bancario|CORRIENTE");
    expect(grupoBancario("iva_bancario", "Ahorros")).toBe("bancario|AHORROS");
    expect(grupoBancario("gasto_bancario", "EFECTIVO")).toBeNull();
    expect(grupoBancario("nomina", "CORRIENTE")).toBeNull();
    const regla = {
      patron: "concepto:4x1000",
      tipo: "detallado",
      cuenta_debito: "53051501",
      tercero_nit: "890903938",
    };
    const p = proponerEgreso(
      mov({ relacion: "4X1000", descripcion: "IMPTO GOBIERNO 4X1000", tercero: null, valor: 400 }),
      ctx({ conceptos: [regla] }),
    );
    expect(p.grupo).toBe("bancario|CORRIENTE");
  });
  it("un solo RP detallado: un débito por movimiento y un crédito al banco por el total", async () => {
    const { payloadReciboAgrupado } = await import("./egresos");
    const prop = (cuenta: string) => ({
      tipo: "detallado" as const,
      terceroNit: "900470166",
      terceroNombre: null,
      items: [],
      cuentas: [{ code: cuenta, movimiento: "Debit" as const, valor: 0, descripcion: "" }],
      paymentTypeId: null,
      cuentaBanco: "11100501",
      listo: true,
      motivos: [],
      notas: [],
      grupo: "bancario|CORRIENTE",
    });
    const r = payloadReciboAgrupado(
      [
        {
          fecha: "2026-10-01",
          descripcion: "CUOTA PLAN CANAL NEGOCIOS",
          valor: 78000,
          propuesta: prop("53050501"),
        },
        {
          fecha: "2026-10-01",
          descripcion: "IVA CUOTA PLAN CANAL NEGOCIOS",
          valor: 14820,
          propuesta: prop("24081002"),
        },
        {
          fecha: "2026-10-30",
          descripcion: "IMPTO GOBIERNO 4X1000",
          valor: 35841.18,
          propuesta: prop("53051501"),
        },
      ],
      77,
      "2026-10-31",
      "CORRIENTE",
    );
    expect(r.errores).toEqual([]);
    expect(r.total).toBe(128661.18);
    expect(r.payload).toMatchObject({
      type: "Detailed",
      date: "2026-10-31",
      supplier: { identification: "900470166" },
    });
    const items = (
      r.payload as { items: Array<{ account: { code: string; movement: string }; value: number }> }
    ).items;
    expect(items.map((i) => [i.account.code, i.account.movement, i.value])).toEqual([
      ["53050501", "Debit", 78000],
      ["24081002", "Debit", 14820],
      ["53051501", "Debit", 35841.18],
      ["11100501", "Credit", 128661.18],
    ]);
  });
});

describe("cruce del pago con la CxP por el número de la compra en Siigo", () => {
  it("si el vencimiento no tiene la factura del proveedor, se cruza por FC-1-… de la compra causada", () => {
    const c = ctx({
      cxp: [
        {
          prefix: "FC-1",
          consecutive: 900,
          quote: 1,
          dueDate: "2026-10-30",
          balance: 150000,
          providerNit: "900333444",
          providerName: "TRANSPORTES ANDINOS SAS",
          facturaProveedor: null,
        },
      ],
      causadas: [{ factura: "IT-417", nit: "900333444", siigo: "FC-1-900" }],
    });
    const p = proponerEgreso(
      mov({ valor: 150000, relacion: "IT417", tercero: "TRANSPORTES ANDINOS SAS" }),
      c,
    );
    expect(p).toMatchObject({ tipo: "pago_facturas", listo: true });
    expect(p.items).toMatchObject([{ prefix: "FC-1", consecutive: 900, valor: 150000 }]);
  });
});

describe("vencimientos identificados por la factura del proveedor", () => {
  it("«A520-1365004» y «A-5201365004» son la misma factura", async () => {
    const { mismaFactura, refFactura } = await import("./egresos");
    expect(mismaFactura(refFactura("A520-1365004")!, refFactura("A-5201365004")!)).toBe(true);
    expect(mismaFactura(refFactura("A520-1365004")!, refFactura("A-5201365005")!)).toBe(false);
  });
  it("el pago se cruza con el vencimiento del reporte (por factura del proveedor) o por el id de la compra", () => {
    const venc = {
      prefix: "A",
      consecutive: 5201365004,
      quote: 1,
      dueDate: "2026-10-02",
      balance: 100000,
      providerNit: "830111222",
      providerName: "COMBUSTIBLES EJEMPLO SA",
      facturaProveedor: "A-5201365004",
      siigoPurchaseId: "abc",
    };
    const p = proponerEgreso(
      mov({
        valor: 100000,
        relacion: "A520-1365004",
        tercero: "COMBUSTIBLES EJEMPLO SA",
        terceroNit: "830111222",
      }),
      ctx({ cxp: [venc] }),
    );
    expect(p).toMatchObject({ tipo: "pago_facturas", listo: true });
    expect(p.items).toMatchObject([{ prefix: "A", consecutive: 5201365004, valor: 100000 }]);
    // Sin la factura del proveedor en el vencimiento: se cruza por el id de la compra causada.
    const p2 = proponerEgreso(
      mov({
        valor: 100000,
        relacion: "ZX 77",
        tercero: "COMBUSTIBLES EJEMPLO SA",
        terceroNit: "830111222",
      }),
      ctx({
        cxp: [{ ...venc, facturaProveedor: null }],
        causadas: [{ factura: "ZX-77", nit: "830111222", siigo: "FC-1-10", siigoId: "abc" }],
      }),
    );
    expect(p2).toMatchObject({ tipo: "pago_facturas", listo: true });
  });
});

describe("ajuste al peso del recibo de pago", () => {
  const ajustes = { debito: "53958101", credito: "42958101", cxp: "22050501", tope: 1000 };
  it("crédito si se pagó de menos, débito si se pagó de más; sobre el tope no se ajusta", async () => {
    const { ajusteAlPesoRecibo } = await import("./egresos");
    expect(ajusteAlPesoRecibo(93400, 93400.35, ajustes)).toEqual({
      valor: -0.35,
      cuenta: "42958101",
    });
    expect(ajusteAlPesoRecibo(100500, 100000, ajustes)).toEqual({ valor: 500, cuenta: "53958101" });
    expect(ajusteAlPesoRecibo(100000, 100000, ajustes)).toBeNull();
    expect(ajusteAlPesoRecibo(102000, 100000, ajustes)).toHaveProperty("error");
  });
  it("pago con saldo a favor y centavos: RP detallado que cruza cada vencimiento, el ajuste y el banco", () => {
    const c = ctx({
      ajustes,
      cxp: [
        {
          prefix: "FE",
          consecutive: 501,
          quote: 1,
          dueDate: "2026-10-02",
          balance: 133000.35,
          providerNit: "900111222",
          providerName: "PINTURAS DEL VALLE S.A.S.",
          facturaProveedor: "FE-501",
        },
        {
          prefix: "RP-4",
          consecutive: 77,
          quote: 1,
          dueDate: "2026-09-01",
          balance: -39600,
          providerNit: "900111222",
          providerName: "PINTURAS DEL VALLE S.A.S.",
          facturaProveedor: "RP-4-77",
        },
      ],
    });
    const m = mov({ valor: 93400, relacion: "FE 501" });
    const p = proponerEgreso(m, c);
    // El saldo a favor lo elige la usuaria en pantalla: se simula su edición.
    const editada = {
      ...p,
      items: [
        {
          prefix: "RP-4",
          consecutive: 77,
          quote: 1,
          valor: -39600,
          factura: "RP-4-77",
          saldo: -39600,
        },
        {
          prefix: "FE",
          consecutive: 501,
          quote: 1,
          valor: 133000.35,
          factura: "FE-501",
          saldo: 133000.35,
        },
      ],
      ajuste: { valor: -0.35, cuenta: "42958101" },
      cuentaCxp: "22050501",
    };
    expect(erroresAntesDeEnviar(m, editada)).toEqual([]);
    const payload = payloadRecibo(m, editada, 77) as {
      type: string;
      items: Array<{ account: { code: string; movement: string }; due?: unknown; value: number }>;
    };
    expect(payload.type).toBe("Detailed");
    expect(
      payload.items.map((i) => [i.account.code, i.account.movement, i.value, !!i.due]),
    ).toEqual([
      ["22050501", "Credit", 39600, true],
      ["22050501", "Debit", 133000.35, true],
      ["42958101", "Credit", 0.35, false],
      ["11100501", "Credit", 93400, false],
    ]);
    // Débitos = créditos.
    const d = payload.items
      .filter((i) => i.account.movement === "Debit")
      .reduce((s, i) => s + i.value, 0);
    const cr = payload.items
      .filter((i) => i.account.movement === "Credit")
      .reduce((s, i) => s + i.value, 0);
    expect(Math.round((d - cr) * 100)).toBe(0);
  });
  it("con cuentas de ajuste, los centavos van al ajuste (la factura queda pagada completa)", () => {
    const c = ctx({ ajustes });
    c.cxp[1]!.balance = 2488026;
    const p = proponerEgreso(
      mov({
        valor: 2880751,
        relacion: "FE 7003\nFE 7009",
        observaciones: "FE 7003 $ 392,725.00\nFE 7009 $ 2,488,025.40",
      }),
      c,
    );
    expect(p.ajuste).toEqual({ valor: 0.6, cuenta: "53958101" });
    expect(p.listo).toBe(true);
  });
});

describe("excedente del pago como anticipo al proveedor", () => {
  const cuentas = {
    debito: "53958101",
    credito: "42958101",
    cxp: "22050501",
    anticipo: "13300501",
    tope: 1000,
  };
  it("hasta el tope es ajuste al peso; por encima, si se pagó de más, es anticipo", async () => {
    const { diferenciaDelPago } = await import("./egresos");
    expect(diferenciaDelPago(100500, 100000, cuentas)).toEqual({
      ajuste: { valor: 500, cuenta: "53958101" },
      anticipo: null,
      error: null,
    });
    expect(diferenciaDelPago(2500000, 600000, cuentas)).toEqual({
      ajuste: null,
      anticipo: { valor: 1900000, cuenta: "13300501" },
      error: null,
    });
    expect(diferenciaDelPago(2500000, 600000, { ...cuentas, anticipo: null }).error).toMatch(
      /anticipos/,
    );
    // Pagó de menos por encima del tope: no es anticipo, queda por revisar.
    expect(diferenciaDelPago(500000, 600000, cuentas).error).toMatch(/tope/);
  });
  it("RP detallado: CxP de la factura, anticipo por el excedente y crédito al banco", async () => {
    const { cuentaAnticipoProveedores } = await import("./egresos.server");
    expect(
      cuentaAnticipoProveedores([
        { code: "1330", name: "Anticipos y avances" },
        { code: "13300501", name: "A proveedores" },
        { code: "13301001", name: "A contratistas" },
      ]),
    ).toBe("13300501");
    const m = mov({ valor: 2500000, relacion: "DS-417" });
    const p = {
      ...proponerEgreso(m, ctx()),
      tipo: "pago_facturas" as const,
      terceroNit: "900111222",
      items: [
        {
          prefix: "DS",
          consecutive: 417,
          quote: 1,
          valor: 600000,
          factura: "DS-417",
          saldo: 600000,
        },
      ],
      ajuste: null,
      anticipo: { valor: 1900000, cuenta: "13300501" },
      cuentaCxp: "22050501",
      cuentaBanco: "11100501",
    };
    expect(erroresAntesDeEnviar(m, p)).toEqual([]);
    const payload = payloadRecibo(m, p, 77) as {
      type: string;
      items: Array<{ account: { code: string; movement: string }; value: number }>;
    };
    expect(payload.type).toBe("Detailed");
    expect(payload.items.map((i) => [i.account.code, i.account.movement, i.value])).toEqual([
      ["22050501", "Debit", 600000],
      ["13300501", "Debit", 1900000],
      ["11100501", "Credit", 2500000],
    ]);
  });
});

describe("tope del ajuste al peso configurable por empresa", () => {
  it("con tope de 5.000, una diferencia de 3.000 es ajuste; con tope de 100, el excedente es anticipo", async () => {
    const { diferenciaDelPago } = await import("./egresos");
    const base = { debito: "53958101", credito: "42958101", cxp: "22050501", anticipo: "13300501" };
    expect(diferenciaDelPago(103000, 100000, { ...base, tope: 5000 }).ajuste).toEqual({
      valor: 3000,
      cuenta: "53958101",
    });
    expect(diferenciaDelPago(100500, 100000, { ...base, tope: 100 }).anticipo).toEqual({
      valor: 500,
      cuenta: "13300501",
    });
    expect(diferenciaDelPago(99500, 100000, { ...base, tope: 100 }).error).toMatch(/tope/);
  });
});

describe("líneas adicionales en el pago de facturas", () => {
  it("factura + línea de gasto sin factura: RP detallado que cuadra con el pago", async () => {
    const { netoLineas } = await import("./egresos");
    const lineas = [
      {
        code: "51959501",
        movimiento: "Debit" as const,
        valor: 49102,
        descripcion: "Consumo sin factura",
      },
    ];
    expect(netoLineas(lineas)).toBe(49102);
    const m = mov({ valor: 160000, relacion: "GUE172736" });
    const p = {
      ...proponerEgreso(m, ctx()),
      tipo: "pago_facturas" as const,
      terceroNit: "900111222",
      items: [
        {
          prefix: "GUE",
          consecutive: 172736,
          quote: 1,
          valor: 110898,
          factura: "GUE-172736",
          saldo: 110898,
        },
      ],
      ajuste: null,
      anticipo: null,
      lineas,
      cuentaCxp: "22050501",
      cuentaBanco: "11050501",
    };
    expect(erroresAntesDeEnviar(m, p)).toEqual([]);
    const payload = payloadRecibo(m, p, 77) as {
      type: string;
      items: Array<{ account: { code: string; movement: string }; value: number }>;
    };
    expect(payload.type).toBe("Detailed");
    expect(payload.items.map((i) => [i.account.code, i.account.movement, i.value])).toEqual([
      ["22050501", "Debit", 110898],
      ["51959501", "Debit", 49102],
      ["11050501", "Credit", 160000],
    ]);
    // Una línea sin cuenta o sin valor no se puede enviar.
    expect(
      erroresAntesDeEnviar(m, { ...p, lineas: [{ ...lineas[0]!, code: "" }] }).join(" "),
    ).toMatch(/no tiene cuenta/);
  });
});
