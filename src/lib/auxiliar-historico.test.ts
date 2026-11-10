import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  analizarAuxiliar,
  aprenderPerfiles,
  baseDeTexto,
  cuentaGastoHistorica,
  fechaISO,
  fechasDelRango,
  rangoDelPeriodo,
  reconstruirCompras,
  tarifaDeTexto,
  type MovimientoAux,
} from "./auxiliar-historico";
import { readRawHistory } from "./history-raw";
import { construirPrecedentes, decidirRetenciones, type ImpuestoConfigurado } from "./precedente-tributario";
import { isValidExpenseAccount } from "./provider-rules";

const mov = (
  cuenta: string,
  nombre: string,
  voucher: string,
  fecha: string,
  nit: string,
  tercero: string,
  descripcion: string,
  detalle: string,
  d: number,
  c: number,
): MovimientoAux => ({
  account_code: cuenta,
  account_name: nombre,
  voucher,
  entry_date_text: fecha,
  provider_nit: nit,
  provider_name: tercero,
  description: descripcion,
  detail: detalle,
  cost_center: " ",
  debit: d,
  credit: c,
});

// Comprobantes con la estructura real del auxiliar de Siigo (terceros y valores ficticios).
const FC_5527 = [
  mov("13300501", "A proveedores", "FC-1-5527", "16/09/2026", "900000001", "ILUMINACION EJEMPLO SAS", "", "RP-4-3458 Cuota: 1", 0, 943810),
  mov("13300501", "A proveedores", "FC-1-5527", "16/09/2026", "900000001", "ILUMINACION EJEMPLO SAS", "", "RP-4-3357 Cuota: 1", 0, 4500),
  mov("14350101", "Mercancías no fabricadas", "FC-1-5527", "16/09/2026", "900000001", "ILUMINACION EJEMPLO SAS", "Bala de Piso Led Mini 1w 3000k Ecolite", "Producto: Bala de Piso Led Mini 1w 3000k Ecolite Cant: 22.00", 814000, 0),
  mov("23654001", "Retención por compras 2,5%", "FC-1-5527", "16/09/2026", "900000001", "ILUMINACION EJEMPLO SAS", "Compras 2.5%", "Compras 2.5% Base: 814,000.00", 0, 20350),
  mov("24081001", "Iva descontable por compras 19%", "FC-1-5527", "16/09/2026", "900000001", "ILUMINACION EJEMPLO SAS", "IVA compras 19%", "IVA compras 19% Base: 814,000.00", 154660, 0),
];
const FC_4522 = [
  mov("13300501", "A proveedores", "FC-1-4522", "20/02/2026", "10000001", "ARRENDADOR EJEMPLO", "", "RP-4-2643", 0, 3500000),
  mov("22050501", "Proveedores nacionales", "FC-1-4522", "20/02/2026", "10000001", "ARRENDADOR EJEMPLO", "Proveedores nacionales", "FC-44 Cuota: 2", 0, 10576606.39),
  mov("23653003", "Arrendamientos Inmuebles 3.5%", "FC-1-4522", "20/02/2026", "10000001", "ARRENDADOR EJEMPLO", "Arrendamientos 3.5%", "Arrendamientos 3.5% Base: 12,187,538.00", 0, 426563.83),
  mov("24082501", "IVA Descontable por gastos 19%", "FC-1-4522", "20/02/2026", "10000001", "ARRENDADOR EJEMPLO", "IVA Gastos 19%", "IVA Gastos 19% Base: 12,187,538.00", 2315632.22, 0),
  mov("51201001", "Arrendamientos - Construcciones y edificaciones", "FC-1-4522", "20/02/2026", "10000001", "ARRENDADOR EJEMPLO", "Arrendamientos - Construcciones y edificaciones", "Arrendamientos - Construcciones y edificaciones", 12187538, 0),
];
const FC_5460 = [
  mov("13300501", "A proveedores", "FC-1-5460", "01/09/2026", "10000002", "FERRETERO EJEMPLO", "", "RP-4-3393", 0, 241000),
  mov("24081001", "Iva descontable por compras 19%", "FC-1-5460", "01/09/2026", "10000002", "FERRETERO EJEMPLO", "IVA compras 19%", "IVA compras 19% Base: 202,521.00", 38478.99, 0),
  mov("51451001", "Mantenimientos - Construcciones y edificaciones", "FC-1-5460", "01/09/2026", "10000002", "FERRETERO EJEMPLO", "4 AEROSOLES PINTUCO", "", 48739, 0),
  mov("51451001", "Mantenimientos - Construcciones y edificaciones", "FC-1-5460", "01/09/2026", "10000002", "FERRETERO EJEMPLO", "3 BISAGRAS", "", 153782, 0),
  mov("53958101", "Ajuste al peso", "FC-1-5460", "01/09/2026", "10000002", "FERRETERO EJEMPLO", "Ajuste al peso", "Ajuste al peso", 0.01, 0),
];
// Un recibo de caja y una venta en el mismo auxiliar: no son compras.
const OTROS = [
  mov("11050501", "Caja general", "RC-1-21734", "13/01/2026", "10000003", "CLIENTE EJEMPLO", "Efectivo", "Caja general", 90000, 0),
  mov("41352401", "Venta de bombillos", "FV-3-100", "13/01/2026", "10000003", "CLIENTE EJEMPLO", "Bombillo", "", 0, 90000),
];

describe("lectura del auxiliar", () => {
  it("fechas, periodo, bases y tarifas con el formato de Siigo", () => {
    expect(fechaISO("16/09/2026")).toBe("2026-09-16");
    expect(rangoDelPeriodo("De Enero 01 2026 a Noviembre 30 2026 ")).toEqual({ desde: "2026-01-01", hasta: "2026-11-30" });
    expect(fechasDelRango("2026-02-27", "2026-03-02")).toEqual(["27/02/2026", "28/02/2026", "01/03/2026", "02/03/2026"]);
    expect(baseDeTexto("Compras 2.5% Base: 814,000.00")).toBe(814000);
    expect(baseDeTexto("IVA Gastos 19% Base: 12,187,538.00")).toBe(12187538);
    expect(tarifaDeTexto("Retención por compras 2,5%")).toBe(2.5);
    expect(tarifaDeTexto("Arrendamientos Inmuebles 3.5%")).toBe(3.5);
    expect(tarifaDeTexto("ReteICA 11,04 x mil")).toBeCloseTo(1.104);
  });

  it("lee el reporte real aunque el archivo declare una sola columna y descarta grupos y totales", async () => {
    const filas = [
      [null],
      ["Movimiento auxiliar por cuenta contable"],
      ["EMPRESA EJEMPLO S.A.S."],
      ["900000000-0"],
      ["De Enero 01 2026 a Noviembre 30 2026 "],
      [null],
      ["Código contable", "Cuenta contable", "Comprobante", "Secuencia", "Fecha elaboración", "Identificación", "Sucursal", "Nombre del tercero", "Descripción", "Detalle", "Centro de costo", "Saldo inicial", "Débito", "Crédito", "Saldo Movimiento", "Saldo total cuenta"],
      ["Cuenta contable: 11050501Caja general", null, null, null, null, null, null, null, null, null, null, 23156374.36, 90000, 266213, null, 89097762],
      ["11050501", "Caja general", "RP-4-2638", 2, "09/01/2026", "800000002", "0", "BANCO EJEMPLO", "Caja general", null, " ", null, 0, 266213, 22890161.36, null],
      ["11050501", "Caja general", "RC-1-21734", 2, "13/01/2026", "10000003", "0", "CLIENTE EJEMPLO", "Efectivo", "Caja general", " ", null, 90000, 0, 22980161.36, null],
      ["Cuenta contable: 14350101Mercancías no fabricadas", null, null, null, null, null, null, null, null, null, null, 0, 814000, 0, null, 814000],
      ["14350101", "Mercancías no fabricadas", "FC-1-5527", 1, "16/09/2026", "900000001", "0", "ILUMINACION EJEMPLO SAS", "Bala de Piso", "Producto: Bala de Piso Cant: 22.00", " ", null, 814000, 0, 814000, null],
      [null],
      ["Total general", null, null, null, null, null, null, null, null, null, null, null, 904000, 266213, null, null],
      [null],
      ["Procesado en: Noviembre 10 2026 16:40"],
    ];
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), "Sheet1");
    const completo = new Uint8Array(XLSX.write(libro, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    // Como lo exporta Siigo: todas las celdas, pero el rango declarado es de una sola columna.
    const zip = unzipSync(completo);
    const hojaXml = strFromU8(zip["xl/worksheets/sheet1.xml"]!).replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:A16"/>');
    expect(hojaXml).toContain('<dimension ref="A1:A16"/>');
    zip["xl/worksheets/sheet1.xml"] = strToU8(hojaXml);
    const bytes = zipSync(zip);
    const r = await readRawHistory(new File([bytes], "Movimiento_auxiliar_por_cuenta_contable.xlsx"));
    expect(r.rows.map((x) => [x.account_code, x.voucher, x.provider_name, x.debit, x.credit])).toEqual([
      ["11050501", "RP-4-2638", "BANCO EJEMPLO", 0, 266213],
      ["11050501", "RC-1-21734", "CLIENTE EJEMPLO", 90000, 0],
      ["14350101", "FC-1-5527", "ILUMINACION EJEMPLO SAS", 814000, 0],
    ]);
    expect(r.period?.trim()).toBe("De Enero 01 2026 a Noviembre 30 2026");
  });
});

describe("reconstrucción de compras y cinco pasadas", () => {
  const todo = [...FC_5527, ...FC_4522, ...FC_5460, ...OTROS];

  it("une cada comprobante FC con su gasto, IVA, retención, anticipo y cuenta por pagar", () => {
    const compras = reconstruirCompras(todo);
    expect(compras.map((c) => c.comprobante)).toEqual(["FC-1-4522", "FC-1-5460", "FC-1-5527"]);
    const c = compras.find((x) => x.comprobante === "FC-1-5527")!;
    expect(c).toMatchObject({ nit: "900000001", fecha: "2026-09-16", base: 814000 });
    expect(c.retenciones.retefuente).toEqual([
      expect.objectContaining({ cuenta: "23654001", valor: 20350, base: 814000, tarifa: 2.5 }),
    ]);
    expect(c.iva[0]).toMatchObject({ cuenta: "24081001", base: 814000, tarifa: 19 });
    expect(c.anticipos.map((a) => a.valor)).toEqual([943810, 4500]);
    const arriendo = compras.find((x) => x.comprobante === "FC-1-4522")!;
    expect(arriendo.cuentasPorPagar).toEqual([{ cuenta: "22050501", nombre: "Proveedores nacionales", valor: 10576606.39 }]);
    expect(arriendo.nombre).toBe("ARRENDADOR EJEMPLO");
  });

  it("las cinco pasadas: todo cuadra y se informan las novedades sin corregir nada", () => {
    const { informe } = analizarAuxiliar(todo);
    expect(informe.compras).toBe(3);
    expect(informe.proveedores).toBe(3);
    expect(informe.movimientosDeCompra).toBe(15);
    expect(informe.pasadas.map((p) => [p.numero, p.revisados, p.novedades])).toEqual([
      [1, 17, 0],
      [2, 3, 0],
      [3, 3, 0],
      [4, 2, 0],
      [5, 3, 0],
    ]);
    // Un IVA que no cuadra con su base queda como novedad de la pasada 3.
    const malo = analizarAuxiliar(FC_5527.map((m) => (m.account_code === "24081001" ? { ...m, debit: 150000 } : m)));
    expect(malo.informe.novedades.map((n) => n.pasada)).toEqual([2, 3]);
  });
});

describe("precedente por proveedor", () => {
  const compras = reconstruirCompras([...FC_5527, ...FC_4522, ...FC_5460]);
  const perfiles = aprenderPerfiles(compras);

  it("aprende cuenta, palabras, IVA, retención con tarifa y bases, y compras sin retención", () => {
    const ilum = perfiles.get("900000001")!;
    expect(ilum.gastos[0]).toMatchObject({ cuenta: "14350101", veces: 1 });
    expect(ilum.gastos[0]!.palabras).toContain("bala");
    expect(ilum.retenciones.retefuente[0]).toMatchObject({ cuenta: "23654001", tarifa: 2.5, baseMin: 814000, baseMax: 814000 });
    expect(ilum.sinRetencion.reteica.veces).toBe(1);
    const ferr = perfiles.get("10000002")!;
    expect(ferr.sinRetencion.retefuente).toEqual({ veces: 1, baseMax: 202521 });
  });

  it("cuenta de gasto del proveedor para una descripción nueva (solo cuentas de gasto válidas)", () => {
    const ferr = perfiles.get("10000002")!;
    expect(cuentaGastoHistorica(ferr, "2 AEROSOLES negro mate", isValidExpenseAccount)?.cuenta).toBe("51451001");
    // Sin palabras en común, la cuenta que usa en casi todas sus compras.
    expect(cuentaGastoHistorica(ferr, "Varsol", isValidExpenseAccount)?.cuenta).toBe("51451001");
    // Inventario (14) no es cuenta de gasto/costo de la causación: no se asigna.
    expect(cuentaGastoHistorica(perfiles.get("900000001")!, "Bala de piso", isValidExpenseAccount)).toBeNull();
  });

  it("identifica el impuesto exacto por cuenta y tarifa y decide la retención con base mínima", () => {
    const taxes: ImpuestoConfigurado[] = [
      { id: "rf-25", kind: "retefuente", name: "Compras 2,5%", rate: 2.5, account_code: "23654001", min_base: 524000 },
      { id: "rf-35", kind: "retefuente", name: "Arrendamiento 3,5%", rate: 3.5, account_code: "23653003" },
      { id: "iva19", kind: "iva", name: "IVA 19%", rate: 19, account_code: "24081001" },
    ];
    const prec = construirPrecedentes({ facturas: [], lineas: [], asientos: [], historico: [], comprasHistoricas: compras, taxes });
    const ilum = prec.get("900000001")!;
    expect(ilum.retenciones.retefuente[0]).toMatchObject({ taxId: "rf-25", tarifa: 2.5, veces: 1 });
    const d = decidirRetenciones({
      kinds: ["retefuente"],
      precedente: ilum,
      condicion: null,
      taxes,
      baseGravable: 1000000,
      ivaTotal: 190000,
      fecha: "2026-10-15",
      tablas: [],
    });
    expect(d.aplicar).toEqual([expect.objectContaining({ amount: 25000, base: 1000000 })]);
    // Bajo la base mínima no se practica.
    const bajo = decidirRetenciones({ kinds: ["retefuente"], precedente: ilum, condicion: null, taxes, baseGravable: 300000, ivaTotal: 0, fecha: "2026-10-15", tablas: [] });
    expect(bajo.aplicar).toEqual([]);
  });

  it("sin retención en el historial: solo se omite sin preguntar si ya hubo compras sin retención con bases iguales o mayores", () => {
    const sinRete = reconstruirCompras([
      ...FC_5460,
      ...FC_5460.map((m) => ({ ...m, voucher: "FC-1-5461", debit: Number(m.debit) * 5, credit: Number(m.credit) * 5 })),
    ]);
    const prec = construirPrecedentes({ facturas: [], lineas: [], asientos: [], historico: [], comprasHistoricas: sinRete, taxes: [] });
    const ferr = prec.get("10000002")!;
    expect(ferr.sinRetencion.retefuente).toBe(2);
    const comun = { kinds: ["retefuente" as const], precedente: ferr, condicion: null, taxes: [], ivaTotal: 0, fecha: "2026-10-01", tablas: [] };
    const igual = decidirRetenciones({ ...comun, baseGravable: 900000 });
    expect(igual.confirmar).toBeNull();
    expect(igual.avisos[0]).toContain("no se practica");
    const mayor = decidirRetenciones({ ...comun, baseGravable: 5000000 });
    expect(mayor.confirmar).not.toBeNull();
  });
});
