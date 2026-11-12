import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  armarConciliacion,
  comprobantesEnTexto,
  conciliar,
  diferenciaSinExplicar,
  partidasAlCorte,
  type MovBanco,
  type MovLibro,
} from "./conciliacion";
import { leerConciliacionAnterior, leerExtractoBancolombia } from "./lectores-extracto";

// Datos ficticios.
const b = (
  id: string,
  fecha: string,
  descripcion: string,
  valor: number,
  refs: string[] = [],
): MovBanco => ({ id, fecha, descripcion, valor, refs });
const l = (
  id: string,
  fecha: string,
  comprobante: string,
  valor: number,
  tercero: string | null = null,
): MovLibro => ({
  id,
  fecha,
  comprobante,
  tercero,
  descripcion: null,
  valor,
});

describe("cruce extracto vs libros", () => {
  it("por comprobante, por valor y fecha, agrupado (nómina) y gastos bancarios en un comprobante", () => {
    const banco = [
      b("b1", "2026-10-01", "PAGO DE PROV CLIENTE UNO", 1007400, ["RC-1-100"]),
      b("b2", "2026-10-03", "PAGO A PROVE PINTURAS DEL VALLE", -392725),
      b("b3", "2026-10-25", "PAGO A NOMIN JUAN PEREZ", -1514416),
      b("b4", "2026-10-25", "PAGO A NOMIN JUAN PEREZ", -326230),
      b("b5", "2026-10-05", "IMPTO GOBIERNO 4X1000", -1570.9),
      b("b6", "2026-10-05", "CUOTA PLAN CANAL NEGOCIOS", -78000),
      b("b7", "2026-10-20", "PAGO DE PROV CLIENTE DOS", 500000),
      b("b8", "2026-10-22", "PAGO A PROVE SIN REGISTRO", -250000),
    ];
    const libros = [
      l("l1", "2026-10-01", "RC-1-100", 1007400, "CLIENTE UNO"),
      l("l2", "2026-10-04", "RP-4-10", -392725, "PINTURAS DEL VALLE SAS"),
      l("l3", "2026-10-31", "CC-997-5", -1840646, "JUAN PEREZ"),
      l("l4", "2026-10-31", "RP-4-99", -79570.9, "BANCO EJEMPLO"),
      l("l5", "2026-10-20", "RC-1-200", 480000, "CLIENTE DOS"),
      l("l6", "2026-10-30", "RP-4-50", -120000, "PROVEEDOR EN TRANSITO"),
    ];
    banco[6]!.refs = ["RC-1-200"];
    const r = conciliar({ banco, libros, comprobantesGastosBancarios: ["RP-4-99"] });
    expect(r.conciliados.map((c) => c.criterio)).toEqual([
      "Comprobante RC-1-100",
      "Gastos bancarios del mes (comprobante único)",
      "Mismo valor, 1 día(s) de diferencia",
      "2 movimientos del banco contra un registro (pago en partes)",
    ]);
    // El RC por un valor distinto al abono es una diferencia a ajustar en Siigo.
    expect(r.diferencias).toHaveLength(1);
    expect(r.diferencias[0]).toMatchObject({ diferencia: 20000 });
    expect(r.faltaEnLibros.map((x) => x.id)).toEqual(["b8"]);
    expect(r.sobraEnLibros.map((x) => x.id)).toEqual(["l6"]);
    const partidas = partidasAlCorte(r);
    expect(partidas.map((p) => [p.tipo, p.valor])).toEqual([
      ["banco_sin_libros", -250000],
      ["libros_sin_banco", -120000],
      ["diferencia", 20000],
    ]);
    // Prueba de saldos: extracto − libros = −250.000 − (−120.000) + 20.000 = −110.000.
    expect(diferenciaSinExplicar({ saldoExtracto: 1000000, saldoLibros: 1110000, partidas })).toBe(
      0,
    );
  });

  it("las partidas del corte anterior se cruzan en el mes y lo que sigue pendiente queda al nuevo corte", () => {
    const r0 = conciliar({
      ...armarConciliacion({
        etiqueta: "CORRIENTE",
        cuentaContable: "11100501",
        periodo: "2026-10",
        extracto: [b("b1", "2026-10-02", "PAGO A PROVE EN TRANSITO", -120000)],
        auxiliar: [],
        rpEnviados: [],
        rcApi: [],
        previas: [
          {
            tipo: "libros_sin_banco",
            fecha: "2026-09-30",
            descripcion: "Cheque",
            comprobante: "RP-4-50",
            tercero: null,
            valor: -120000,
          },
          {
            tipo: "banco_sin_libros",
            fecha: "2026-09-29",
            descripcion: "Consignación sin identificar",
            comprobante: null,
            tercero: null,
            valor: 75000,
          },
        ],
      }),
    });
    expect(r0.conciliados).toHaveLength(1);
    expect(partidasAlCorte(r0).map((p) => [p.tipo, p.valor])).toEqual([
      ["banco_sin_libros", 75000],
    ]);
  });

  it("libros: auxiliar de la cuenta en el mes, completado con RP de la herramienta y RC de la API", () => {
    const a = armarConciliacion({
      etiqueta: "CORRIENTE",
      cuentaContable: "11100501",
      periodo: "2026-10",
      extracto: [
        b("b1", "2026-10-03", "PAGO A PROVE X", -392725),
        b("b2", "2026-10-05", "IMPTO GOBIERNO 4X1000", -1570.9),
      ],
      auxiliar: [
        {
          account_code: "11100501",
          voucher: "RC-1-100",
          entry_date_text: "01/10/2026",
          provider_name: "CLIENTE",
          description: null,
          debit: 1007400,
          credit: 0,
        },
        {
          account_code: "11200502",
          voucher: "RC-1-101",
          entry_date_text: "01/10/2026",
          provider_name: "OTRA CUENTA",
          description: null,
          debit: 5,
          credit: 0,
        },
        {
          account_code: "11100501",
          voucher: "RC-1-90",
          entry_date_text: "30/09/2026",
          provider_name: "MES ANTERIOR",
          description: null,
          debit: 7,
          credit: 0,
        },
      ],
      rpEnviados: [
        {
          id: "x1",
          fecha: "2026-10-03",
          comprobante: "RP-4-10",
          tercero: "X",
          descripcion: null,
          valor: -392725,
          cuenta: "CORRIENTE",
          grupo: null,
        },
        {
          id: "x2",
          fecha: "2026-10-05",
          comprobante: "RP-4-99",
          tercero: null,
          descripcion: null,
          valor: -1000,
          cuenta: "CORRIENTE",
          grupo: "bancario|CORRIENTE",
        },
        {
          id: "x3",
          fecha: "2026-10-09",
          comprobante: "RP-4-99",
          tercero: null,
          descripcion: null,
          valor: -570.9,
          cuenta: "CORRIENTE",
          grupo: "bancario|CORRIENTE",
        },
      ],
      rcApi: [
        {
          id: "r1",
          fecha: "2026-10-01",
          comprobante: "RC-1-100",
          tercero: null,
          descripcion: null,
          valor: 1007400,
          cuenta: "CORRIENTE",
        },
        {
          id: "r2",
          fecha: "2026-10-08",
          comprobante: "RC-1-150",
          tercero: null,
          descripcion: null,
          valor: 300000,
          cuenta: "CORRIENTE",
        },
      ],
      previas: [],
    });
    expect(a.libros.map((x) => [x.comprobante, x.valor])).toEqual([
      ["RC-1-100", 1007400],
      ["RP-4-10", -392725],
      ["RP-4-99", -1570.9],
      ["RC-1-150", 300000],
    ]);
    expect(a.banco[0]!.refs).toEqual(["RP-4-10"]);
    expect(a.comprobantesGastosBancarios).toEqual(["RP-4-99"]);
  });

  it("comprobantes citados en la relación", () => {
    expect(comprobantesEnTexto("RC-1-24500 y RC-1-24498")).toEqual(["RC-1-24500", "RC-1-24498"]);
    expect(comprobantesEnTexto("Fact. 27508")).toEqual([]);
  });
});

describe("lectores", () => {
  it("extracto Bancolombia en Excel: saldos y movimientos con el año del corte", () => {
    const filas = [
      [null],
      ["Información General:"],
      ["DESDE", "HASTA", "TIPO CUENTA", "NRO CUENTA"],
      ["2026/09/30", "2026/10/31", "CUENTA CORRIENTE", "00000000001"],
      ["Resumen:"],
      ["SALDO ANTERIOR", "TOTAL ABONOS", "TOTAL CARGOS", "SALDO ACTUAL"],
      ["1,000,000.00", "500,000.00", "200,000.00", "1,300,000.00"],
      ["Movimientos:"],
      ["FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO"],
      ["1/10", "PAGO DE PROV CLIENTE", null, null, "500,000.00", "1,500,000.00"],
      ["2/10", "PAGO A PROVE PROVEEDOR", null, null, "-200,000.00", "1,300,000.00"],
      [null, "FIN ESTADO DE CUENTA"],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), "Table1");
    const ext = leerExtractoBancolombia(
      new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
    );
    expect(ext).toMatchObject({
      saldoInicial: 1000000,
      saldoFinal: 1300000,
      cuentaNumero: "00000000001",
    });
    expect(ext.movimientos.map((m) => [m.fecha, m.valor])).toEqual([
      ["2026-10-01", 500000],
      ["2026-10-02", -200000],
    ]);
  });

  it("conciliación anterior: hojas «Falta / Sobra en contabilidad» o el formato que exporta la herramienta", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Fecha", "Concepto", "Tercero", "Ingreso", "Salida"],
        ["29/09/2026", "Consignación sin identificar", null, 75000, null],
      ]),
      "Falta en Contabilidad",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Fecha", "Comprobante", "Tercero", "Débito", "Crédito"],
        ["30/09/2026", "RP-4-50", "PROVEEDOR", null, 120000],
      ]),
      "Sobra en Contabilidad",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Cuenta", "Tipo", "Fecha", "Descripción", "Comprobante", "Tercero", "Valor"],
        ["AHORROS", "Libros sin banco", "30/09/2026", "Cheque", "RP-4-60", "X", -50000],
      ]),
      "Partidas",
    );
    const r = leerConciliacionAnterior(
      new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
      "CORRIENTE",
    );
    expect(r.porCuenta.get("CORRIENTE")!.map((p) => [p.tipo, p.valor])).toEqual([
      ["banco_sin_libros", 75000],
      ["libros_sin_banco", -120000],
    ]);
    expect(r.porCuenta.get("AHORROS")!.map((p) => [p.tipo, p.comprobante, p.valor])).toEqual([
      ["libros_sin_banco", "RP-4-60", -50000],
    ]);
  });
});

describe("un pago registrado en varios recibos y comisiones del exterior", () => {
  it("completa la diferencia por comprobante con otro RP del mismo tercero y cruza 1 banco : N libros", () => {
    const r = conciliar({
      banco: [
        b("b1", "2026-10-08", "PAGO A PROVE ANA LOPEZ C", -1500000, ["RP-4-10"]),
        b("b2", "2026-10-09", "PAGO A PROVE SALUD EJEMPLO S", -141750),
        b("b3", "2026-10-08", "COMIS SWIFT GIRO VTA MDA EXT", -104000),
      ],
      libros: [
        l("l1", "2026-10-08", "RP-4-10", -600000, "Ana Lopez Cano"),
        l("l2", "2026-10-08", "RP-4-11", -900000, "Ana Lopez Cano"),
        l("l3", "2026-10-09", "RP-4-12", -70875, "Salud Ejemplo SAS"),
        l("l4", "2026-10-12", "RP-4-13", -70875, "Salud Ejemplo SAS"),
        l("l5", "2026-10-31", "RP-4-99", -104000, "BANCO"),
      ],
      comprobantesGastosBancarios: ["RP-4-99"],
    });
    expect(r.diferencias).toHaveLength(0);
    expect(r.faltaEnLibros).toHaveLength(0);
    expect(r.sobraEnLibros).toHaveLength(0);
    expect(r.conciliados.map((c) => c.libros.map((x) => x.comprobante).join("+")).sort()).toEqual([
      "RP-4-10+RP-4-11",
      "RP-4-12+RP-4-13",
      "RP-4-99",
    ]);
  });
});

describe("conciliación anterior en formato de reporte", () => {
  it("lee cuenta contable, saldos y las dos secciones de partidas", () => {
    const filas: unknown[][] = [
      [null, "EMPRESA EJEMPLO S.A.S."],
      [null, "Banco Uno – Cuenta Corriente   |   Cuenta contable 11100501 – Cta cte"],
      [null, "Fecha de corte: 30 de septiembre de 2026   |   Cifras en pesos"],
      [null, "1.  RESUMEN DE LA CONCILIACIÓN"],
      [
        null,
        "Saldo según libros contables al 30/09/2026",
        null,
        null,
        null,
        null,
        null,
        null,
        1000000,
      ],
      [
        null,
        "Saldo según extracto bancario al 30/09/2026",
        null,
        null,
        null,
        null,
        null,
        null,
        1200000,
      ],
      [null, "2.  PARTIDAS DEL EXTRACTO QUE NO ESTÁN EN EL AUXILIAR"],
      [
        null,
        "N°",
        "Fecha",
        "Descripción del movimiento bancario",
        "# Ref.",
        null,
        "Valor",
        "Período",
        "Estado",
        "Observación / acción requerida",
      ],
      [
        null,
        1,
        "19/05",
        "PAGO PSE PROVEEDOR",
        null,
        null,
        -50000,
        "MAYO",
        "PENDIENTE",
        "Por identificar",
      ],
      [null, 2, "15/09", "CONSIGNACION", null, null, 300000, "SEPTIEMBRE", "PENDIENTE", null],
      [null, "TOTAL PARTIDAS", null, null, null, null, 250000],
      [null, "3.  PARTIDAS DEL AUXILIAR QUE NO FIGURAN EN EL EXTRACTO"],
      [
        null,
        "N°",
        "Fecha",
        "Concepto registrado en el auxiliar",
        "# Ref.",
        null,
        "Valor",
        "Período",
        "Estado",
        "Observación",
      ],
      [
        null,
        1,
        "30/09/2026",
        "CLIENTE — recaudo en tránsito",
        "RC-1-5",
        null,
        50000,
        "Septiembre",
        "EN TRÁNSITO",
        "Ingresa en octubre",
      ],
      [null, "TOTAL", null, null, null, null, 50000],
      [null, "4.  RESUMEN POR TIPO DE PARTIDA"],
      [null, "Tipo de partida", null, null, null, "Cant.", 99999],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), "Reporte Conciliación");
    const r = leerConciliacionAnterior(
      new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
      "AHORROS",
      [
        { etiqueta: "AHORROS", cuentaContable: "11200502" },
        { etiqueta: "CORRIENTE", cuentaContable: "11100501" },
      ],
      false,
    );
    const ps = r.porCuenta.get("CORRIENTE")!;
    expect(ps.map((p) => [p.tipo, p.fecha, p.valor, p.comprobante, p.nota ?? null])).toEqual([
      ["banco_sin_libros", "2026-05-19", -50000, null, "Por identificar"],
      ["banco_sin_libros", "2026-09-15", 300000, null, null],
      ["libros_sin_banco", "2026-09-30", 50000, "RC-1-5", "Ingresa en octubre"],
    ]);
    expect(r.saldos.get("CORRIENTE")).toEqual({ libros: 1000000, extracto: 1200000 });
    expect(
      diferenciaSinExplicar({ saldoExtracto: 1200000, saldoLibros: 1000000, partidas: ps }),
    ).toBe(0);
  });
});

describe("partidas del corte anterior registradas después con su fecha original", () => {
  it("el RP con fecha de mayo creado en noviembre cruza con la partida pendiente; los demás se ignoran", () => {
    const armado = armarConciliacion({
      etiqueta: "CORRIENTE",
      cuentaContable: "11100501",
      periodo: "2026-10",
      extracto: [b("b1", "2026-10-05", "PAGO A PROVE X", -100000, ["RP-4-1"])],
      auxiliar: [
        {
          account_code: "11100501",
          voucher: "RP-4-1",
          entry_date_text: "05/10/2026",
          provider_name: "X",
          description: null,
          debit: 0,
          credit: 100000,
        },
      ],
      rpEnviados: [],
      rcApi: [],
      previas: [
        {
          tipo: "banco_sin_libros",
          fecha: "2026-05-19",
          descripcion: "PAGO PSE PROVEEDOR",
          comprobante: null,
          tercero: null,
          valor: -351050,
        },
      ],
      librosAnteriores: [
        {
          account_code: "11100501",
          voucher: "RP-4-90",
          entry_date_text: "19/05/2026",
          provider_name: "PROVEEDOR",
          description: null,
          debit: 0,
          credit: 351050,
        },
        // Otro registro atrasado que no corresponde a ninguna partida: ya estaba en el saldo.
        {
          account_code: "11100501",
          voucher: "RP-4-91",
          entry_date_text: "20/09/2026",
          provider_name: "OTRO",
          description: null,
          debit: 0,
          credit: 5000,
        },
      ],
    });
    expect(armado.movimientoLibros).toBe(-100000);
    expect(armado.movimientoAnterior).toBe(-351050);
    const r = conciliar(armado);
    expect(r.faltaEnLibros).toHaveLength(0);
    expect(r.sobraEnLibros).toHaveLength(0);
    expect(r.conciliados).toHaveLength(2);
  });
});

describe("registro en lote", () => {
  it("un RP que agrupa varias salidas cruza con cada movimiento del extracto", () => {
    const armado = armarConciliacion({
      etiqueta: "CORRIENTE",
      cuentaContable: "11100501",
      periodo: "2026-10",
      extracto: [
        b("b1", "2026-10-05", "PAGO PSE TIENDA", -70000),
        b("b2", "2026-10-09", "PAGO PSE TIENDA", -30000),
        b("b3", "2026-10-09", "OTRO", -5000),
      ],
      auxiliar: [],
      rpEnviados: [],
      rcApi: [],
      previas: [],
      lotesEnviados: [
        {
          id: "lote-1",
          fecha: "2026-10-31",
          comprobante: "RP-4-500",
          tercero: null,
          descripcion: null,
          valor: -100000,
          cuenta: "CORRIENTE",
          movimientos: [
            { fecha: "2026-10-05", valor: -70000 },
            { fecha: "2026-10-09", valor: -30000 },
          ],
        },
      ],
    });
    const r = conciliar(armado);
    expect(r.conciliados).toHaveLength(1);
    expect(r.conciliados[0]!.banco.map((x) => x.id)).toEqual(["b1", "b2"]);
    expect(r.faltaEnLibros.map((x) => x.id)).toEqual(["b3"]);
    expect(armado.movimientoLibros).toBe(-100000);
  });
});
