import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  ajustesAlPeso,
  armarConciliacion,
  conciliar,
  detectarCuentaErrada,
  payloadAjusteAlPeso,
  payloadReclasificacion,
  type MovBanco,
} from "./conciliacion";
import { compararExtractos, leerExtractoPdf, type ItemPdf } from "./extracto-pdf";
import {
  abonadoPorCuenta,
  citarAbonos,
  cruzarPasarela,
  leerHojaPasarela,
  propuestaPasarela,
} from "./pasarelas";
import { leerBalancePrueba } from "./siigo-movimiento.server";

// Datos ficticios.
const hoja = (filas: unknown[][]) => XLSX.utils.aoa_to_sheet(filas);
const b = (id: string, fecha: string, descripcion: string, valor: number, refs: string[] = []) =>
  ({ id, fecha, descripcion, valor, refs }) as MovBanco;

const BOLD = hoja([
  [
    "ID TRANSACCION",
    "FECHA",
    "ESTADO ACTUAL",
    "VALOR TOTAL",
    "IVA",
    "VALOR RETE FUENTE",
    "VALOR RETE IVA",
    "VALOR RETE ICA",
    "% COMISIÓN BOLD",
    "COMISIÓN BOLD FIJA",
    "TOTAL DEDUCCIÓN",
    "DEPOSITO EN CUENTA BOLD",
    "RELACIÓN",
    "APLICACIÓN",
    null,
  ],
  [
    "T1",
    new Date(Date.UTC(2026, 9, 2, 15)),
    "COBRO EXITOSO",
    1000000,
    0,
    15000,
    0,
    2000,
    26900,
    300,
    44200,
    955800,
    "RC-1-10",
    "Fact. 1",
    null,
  ],
  [
    "T2",
    new Date(Date.UTC(2026, 9, 2, 16)),
    "COBRO NO REALIZADO",
    500000,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    "N/A",
    null,
    null,
  ],
  [
    "T3",
    new Date(Date.UTC(2026, 9, 2, 17)),
    "COBRO EXITOSO",
    200000,
    0,
    3000,
    0,
    400,
    5380,
    300,
    9080,
    190920,
    "RC-1-11",
    "Fact. 2",
    null,
  ],
  // Fila mal diligenciada: se respetan valor y neto; el desglose se estima.
  [
    "T4",
    new Date(Date.UTC(2026, 9, 20, 15)),
    "COBRO EXITOSO",
    100000,
    100000,
    100000,
    100000,
    100000,
    100000,
    300,
    4420,
    95580,
    "RC-1-12",
    "Fact. 3",
    null,
  ],
  [
    "T5",
    new Date(Date.UTC(2026, 9, 30, 15)),
    "COBRO EXITOSO",
    300000,
    0,
    4500,
    0,
    600,
    8070,
    300,
    13470,
    286530,
    "RC-1-13",
    "Fact. 4",
    "Queda para el movimiento de Noviembre",
  ],
]);
const WOMPI = hoja([
  [
    "Fecha",
    "Transacción No.",
    "Estado",
    "Valor",
    "Comisión",
    "Iva",
    "Rte. Fte.",
    "Total a\nConsignar",
    "Pagador",
    "RELACIÓN",
    "APLICACIÓN",
  ],
  [
    "oct. 08 09:15 AM",
    "W-1",
    "Aprobada",
    450000,
    12000,
    2280,
    6750,
    428970,
    "CLIENTE UNO SAS",
    "RC-1-20",
    "Fact. 9",
  ],
  ["oct. 09 10:00 AM", "W-2", "Declinada", 450000, 0, 0, 0, 0, "CLIENTE UNO SAS", "N/A", null],
]);

describe("pasarelas de pago", () => {
  it("lee la hoja de Bold: solo cobros exitosos, comisión con la fija y fila descuadrada estimada", () => {
    const r = leerHojaPasarela(BOLD, "BOLD", "2026-10");
    expect(r.transacciones.map((t) => t.id)).toEqual(["T1", "T3", "T4", "T5"]);
    const t1 = r.transacciones[0]!;
    expect(t1).toMatchObject({
      fecha: "2026-10-02",
      bruto: 1000000,
      comision: 27200,
      retefuente: 15000,
      reteica: 2000,
      ivaComision: 0,
      neto: 955800,
      rcs: ["RC-1-10"],
    });
    const t4 = r.transacciones[2]!;
    expect(t4.estimada).toBe(true);
    expect(t4.retefuente).toBe(1500);
    expect(t4.reteica).toBe(200);
    expect(t4.comision + t4.retefuente + t4.reteica + t4.reteiva).toBeCloseTo(4420, 2);
    expect(r.transacciones[3]!.abonoMesSiguiente).toBe(true);
    expect(r.advertencias[0]).toMatch(/T4/);
  });

  it("lee la hoja de Wompi: IVA de la comisión como descuento (cuadra con el neto)", () => {
    const r = leerHojaPasarela(WOMPI, "WOMPI", "2026-10");
    expect(r.transacciones).toHaveLength(1);
    expect(r.transacciones[0]).toMatchObject({
      fecha: "2026-10-08",
      ivaComision: 2280,
      neto: 428970,
      pagador: "CLIENTE UNO SAS",
    });
  });

  it("cruza cobros con RC y abonos, propone el RP y la conciliación cruza con el RP de comisiones", () => {
    const tx = leerHojaPasarela(BOLD, "BOLD", "2026-10").transacciones;
    const abonos = [
      {
        cuenta: "DAVIVIENDA",
        mov: b("d1", "2026-10-03", "Abono ACH BOLD CF 1", 1146720, ["RC-1-10", "RC-1-11"]),
      },
      { cuenta: "DAVIVIENDA", mov: b("d2", "2026-10-21", "Abono ACH BOLD CF 2", 95580) },
      { cuenta: "DAVIVIENDA", mov: b("d3", "2026-10-01", "Abono ACH BOLD CF 3", 50000) },
    ];
    const libros = [
      {
        id: "l1",
        fecha: "2026-10-02",
        comprobante: "RC-1-10",
        tercero: "A",
        descripcion: null,
        valor: 1000000,
      },
      {
        id: "l2",
        fecha: "2026-10-02",
        comprobante: "RC-1-11",
        tercero: "B",
        descripcion: null,
        valor: 199000,
      },
      {
        id: "l3",
        fecha: "2026-10-20",
        comprobante: "RC-1-12",
        tercero: "C",
        descripcion: null,
        valor: 100000,
      },
    ];
    const r = cruzarPasarela({
      plataforma: "BOLD",
      periodo: "2026-10",
      transacciones: tx,
      abonos,
      libros,
    });
    expect(r.abonos.map((a) => [a.mov.id, a.cobros, a.diferencia])).toEqual([
      ["d3", [], 50000],
      ["d1", ["T1", "T3"], 0],
      ["d2", ["T4"], 0],
    ]);
    expect(r.sinRc.map((c) => c.t.id)).toEqual(["T5"]);
    expect(r.cobros.find((c) => c.t.id === "T3")!.difRc).toBe(-1000);
    expect(r.sinAbono.map((c) => c.t.id)).toEqual(["T5"]);
    expect(r.abonado).toMatchObject({
      cobros: 3,
      bruto: 1300000,
      neto: 1242300,
      deducciones: 57700,
    });
    expect(abonadoPorCuenta(r).get("DAVIVIENDA")!.deducciones).toBe(57700);
    expect(
      citarAbonos(
        abonos.map((a) => a.mov),
        r,
      )[1]!.refs,
    ).toEqual(["RC-1-12"]);

    const { propuesta, valor } = propuestaPasarela({
      r,
      terceroNit: "900000001",
      terceroNombre: "PLATAFORMA SAS",
      facturas: [
        {
          prefix: "FC",
          consecutive: 7,
          quote: 1,
          factura: "FE-7",
          saldo: 40000,
          vence: "2026-11-30",
        },
      ],
      cuentas: {
        cxp: "22050501",
        retefuente: "13551501",
        reteiva: "13551701",
        reteica: "13551801",
        ajusteDebito: "53958101",
        ajusteCredito: "42958101",
        tope: 1000,
      },
      cuentaBanco: "11100502",
    });
    expect(valor).toBe(57700);
    expect(propuesta.items.map((i) => i.valor)).toEqual([r.abonado.comision]);
    expect(propuesta.lineas!.map((l) => [l.code, l.valor])).toEqual([
      ["13551501", r.abonado.retefuente],
      ["13551801", r.abonado.reteica],
    ]);
    expect(propuesta.listo).toBe(true);

    // Conciliación: abonos netos contra RC brutos → diferencias; con el RP enviado, cruzan.
    const armado = armarConciliacion({
      etiqueta: "DAVIVIENDA",
      cuentaContable: "11100502",
      periodo: "2026-10",
      extracto: citarAbonos(
        abonos.map((a) => a.mov),
        r,
      ),
      auxiliar: [],
      rpEnviados: [
        {
          id: "rp",
          fecha: "2026-10-31",
          comprobante: "RP-4-500",
          tercero: null,
          descripcion: null,
          valor: -57700,
          cuenta: "DAVIVIENDA",
          grupo: null,
          pasarela: "BOLD",
        },
      ],
      rcApi: libros.map((l) => ({ ...l, cuenta: "DAVIVIENDA" })),
      previas: [],
      pasarelas: ["BOLD"],
    });
    const c = conciliar(armado);
    // El RC-1-11 quedó 1.000 por debajo del cobro: es la única diferencia que queda.
    expect(c.conciliados).toHaveLength(0);
    expect(c.diferencias).toHaveLength(1);
    expect(c.diferencias[0]).toMatchObject({ pasarela: "BOLD", diferencia: 1000 });
    expect(c.faltaEnLibros.map((x) => x.id)).toEqual(["d3"]);
  });
});

describe("ajustes al peso y extractos PDF", () => {
  it("diferencia dentro del tope → comprobante contable banco contra ajuste", () => {
    const r = conciliar({
      banco: [b("b1", "2026-10-05", "PAGO DE PROV CLIENTE", 100000, ["RC-1-1"])],
      libros: [
        {
          id: "l1",
          fecha: "2026-10-05",
          comprobante: "RC-1-1",
          tercero: "CLIENTE",
          terceroNit: "800000001",
          descripcion: null,
          valor: 99600,
        },
      ],
    });
    const a = ajustesAlPeso(r, "CORRIENTE", 1000);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      valor: 400,
      origen: "RC-1-1",
      terceroNit: "800000001",
      fecha: "2026-10-05",
    });
    expect(ajustesAlPeso(r, "CORRIENTE", 100)).toHaveLength(0);
    const p = payloadAjusteAlPeso({
      documentId: 1,
      fecha: "2026-10-05",
      valor: 400,
      cuentaBanco: "11100501",
      cuentaIngreso: "42958101",
      cuentaGasto: "53958101",
      terceroNit: "800000001",
      descripcion: "Ajuste",
      referencia: "x",
    });
    expect(
      (p["items"] as Array<{ account: { code: string; movement: string } }>).map((i) => [
        i.account.code,
        i.account.movement,
      ]),
    ).toEqual([
      ["11100501", "Debit"],
      ["42958101", "Credit"],
    ]);
    // Enviado el ajuste, la diferencia queda conciliada.
    const r2 = conciliar({
      banco: [b("b1", "2026-10-05", "PAGO DE PROV CLIENTE", 100000, ["RC-1-1"])],
      libros: [
        {
          id: "l1",
          fecha: "2026-10-05",
          comprobante: "RC-1-1",
          tercero: "CLIENTE",
          descripcion: null,
          valor: 99600,
        },
        {
          id: "l2",
          fecha: "2026-10-05",
          comprobante: "CC-1-9",
          tercero: null,
          descripcion: null,
          valor: 400,
        },
      ],
      ajustes: [{ comprobante: "CC-1-9", origen: "RC-1-1" }],
    });
    expect(r2.diferencias).toHaveLength(0);
    expect(r2.conciliados).toHaveLength(1);
  });

  it("extracto PDF tipo Davivienda y comparación con la hoja de la empresa", () => {
    let y = 700;
    const linea = (celdas: Array<[number, string]>): ItemPdf[] => {
      y -= 10;
      return celdas.map(([x, texto]) => ({ pagina: 1, x, y, texto }));
    };
    const items: ItemPdf[] = [
      ...linea([
        [405, "INFORME DEL MES:"],
        [471, "OCTUBRE /2026"],
      ]),
      ...linea([
        [232, "Saldo Anterior"],
        [339, "$1,000,000.00"],
      ]),
      ...linea([
        [232, "Nuevo Saldo"],
        [339, "$1,095,000.00"],
      ]),
      ...linea([
        [52, "01"],
        [71, "10"],
        [134, "$ 100,000.00"],
        [178, "+"],
        [197, "1234"],
        [224, "Abono ACH PLATAFORMA"],
        [451, "PROCESOS ACH"],
      ]),
      ...linea([
        [52, "31"],
        [71, "10"],
        [146, "$ 5,000.00"],
        [180, "-"],
        [197, "0000"],
        [224, "IVA por Servicios"],
      ]),
    ];
    const e = leerExtractoPdf(items, "dv");
    expect(e.advertencias).toEqual([]);
    expect(e.movimientos.map((m) => [m.fecha, m.valor, m.descripcion])).toEqual([
      ["2026-10-01", 100000, "Abono ACH PLATAFORMA (PROCESOS ACH)"],
      ["2026-10-31", -5000, "IVA por Servicios"],
    ]);
    const c = compararExtractos(e.movimientos, [
      b("h1", "2026-10-01", "Abono ACH PLATAFORMA", 100000, ["RC-1-5"]),
      b("h2", "2026-10-21", "Cobro IVA", -5000),
      b("h3", "2026-10-02", "Rendimientos", 70),
    ]);
    expect(c.coinciden).toBe(2);
    expect(c.oficialConRefs[0]!.refs).toEqual(["RC-1-5"]);
    expect(c.fechaDistinta).toHaveLength(1);
    expect(c.sobranEnRelacion.map((m) => m.id)).toEqual(["h3"]);
  });

  it("balance de prueba de Siigo (Excel)", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      hoja([
        ["Balance de prueba"],
        [
          "Nivel",
          "Código cuenta contable",
          "Nombre cuenta contable",
          "Saldo inicial",
          "Movimiento débito",
          "Movimiento crédito",
          "Saldo final",
        ],
        ["Auxiliar", "11100501", "Banco uno", 1000, 500, 200, 1300],
        ["Grupo", "11", "Disponible", 1000, 500, 200, 1300],
      ]),
      "Hoja1",
    );
    const r = leerBalancePrueba(
      new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
    );
    expect(r.find((x) => x.cuenta === "11100501")).toEqual({
      cuenta: "11100501",
      saldoInicial: 1000,
      debitos: 500,
      creditos: 200,
      saldoFinal: 1300,
    });
  });
});

describe("RC/RP en otra cuenta bancaria", () => {
  it("detecta el recibo en la cuenta errada, arma la reclasificación y, enviada, ambas cuentas cruzan", () => {
    const corriente = conciliar({
      banco: [b("c1", "2026-10-10", "PAGO DE PROV CLIENTE DOS", 250000)],
      libros: [],
    });
    const ahorros = conciliar({
      banco: [],
      libros: [
        {
          id: "a1",
          fecha: "2026-10-10",
          comprobante: "RC-1-77",
          tercero: "CLIENTE DOS",
          terceroNit: "800000002",
          descripcion: null,
          valor: 250000,
        },
        {
          id: "a2",
          fecha: "2026-10-12",
          comprobante: "RP-4-88",
          tercero: "OTRO",
          descripcion: null,
          valor: -90000,
        },
      ],
    });
    const r = detectarCuentaErrada([
      { etiqueta: "CORRIENTE", cuentaContable: "11100501", resultado: corriente },
      { etiqueta: "AHORROS", cuentaContable: "11200501", resultado: ahorros },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      comprobante: "RC-1-77",
      desde: { etiqueta: "AHORROS" },
      hacia: { etiqueta: "CORRIENTE" },
      criterio: "Mismo valor y fecha en el extracto de CORRIENTE",
    });
    const p = payloadReclasificacion({
      documentId: 1,
      fecha: "2026-10-10",
      valor: 250000,
      cuentaErrada: "11200501",
      cuentaCorrecta: "11100501",
      terceroNit: "800000002",
      descripcion: "Reclasificación",
      referencia: "x",
    });
    expect(
      (p["items"] as Array<{ account: { code: string; movement: string } }>).map((i) => [
        i.account.code,
        i.account.movement,
      ]),
    ).toEqual([
      ["11100501", "Debit"],
      ["11200501", "Credit"],
    ]);
    // Enviada (CC-1-5): en Ahorros anula el RC; en Corriente cruza con el abono.
    const ah2 = conciliar({
      banco: [],
      libros: [
        {
          id: "a1",
          fecha: "2026-10-10",
          comprobante: "RC-1-77",
          tercero: null,
          descripcion: null,
          valor: 250000,
        },
        {
          id: "x",
          fecha: "2026-10-10",
          comprobante: "CC-1-5",
          tercero: null,
          descripcion: null,
          valor: -250000,
        },
      ],
      reclasificaciones: [{ comprobante: "CC-1-5", origen: "RC-1-77" }],
    });
    expect(ah2.sobraEnLibros).toHaveLength(0);
    const co2 = conciliar({
      banco: [b("c1", "2026-10-10", "PAGO DE PROV CLIENTE DOS", 250000)],
      libros: [
        {
          id: "y",
          fecha: "2026-10-10",
          comprobante: "CC-1-5",
          tercero: null,
          descripcion: null,
          valor: 250000,
        },
      ],
    });
    expect(co2.conciliados).toHaveLength(1);
  });
});
