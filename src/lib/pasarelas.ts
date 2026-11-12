// PASARELAS DE PAGO (Bold, Wompi…) — motor puro (núcleo; se activa por empresa con la
// función «pasarelas_pago», que lee las hojas de la plataforma del reporte mensual).
//
// El cliente paga por la plataforma el valor completo (el RC se hace por ese valor); la
// plataforma descuenta su comisión (+ IVA) y las retenciones y consigna el resto al banco.
// Mensualmente factura sus comisiones, que no se pagan: se cruzan con lo descontado.
//   1. leerHojaPasarela: transacciones aprobadas de la hoja exportada por la plataforma.
//   2. cruzarPasarela: cada cobro contra su RC en Siigo (valor bruto) y contra el abono del
//      banco (neto); abonos sin transacciones identificadas; cobros aún sin abonar.
//   3. propuestaPasarela: RP del mes por lo descontado en los abonos del mes — débito a la
//      CxP de la plataforma cruzando su(s) factura(s) de comisiones (comisión + IVA), débito a
//      las cuentas de retenciones (anticipos de impuestos) y crédito al banco.
import * as XLSX from "xlsx";

import { roundCOP } from "@/lib/money";
import type { MovBanco, MovLibro } from "@/lib/conciliacion";
import { comprobantesEnTexto, normalizarComprobante } from "@/lib/conciliacion";
import type { CuentaDetallada, ItemPago, Propuesta } from "@/lib/egresos";

export type TransaccionPasarela = {
  plataforma: string;
  id: string;
  fecha: string; // yyyy-MM-dd
  pagador: string | null;
  documento: string | null;
  bruto: number;
  /** Comisión de la plataforma (incluye la fija). */
  comision: number;
  /** IVA de la comisión, cuando la plataforma lo descuenta aparte. */
  ivaComision: number;
  retefuente: number;
  reteiva: number;
  reteica: number;
  neto: number;
  rcs: string[];
  aplicacion: string | null;
  /** «Queda para el movimiento de noviembre»: el abono llega el mes siguiente. */
  abonoMesSiguiente: boolean;
  /**
   * La fila no cuadra (valor − descuentos ≠ neto): se respetan el valor y el neto, y el
   * desglose se estima con las tarifas de las demás filas de la hoja (verificar en la plataforma).
   */
  estimada?: boolean;
};

export const deducciones = (
  t: Pick<TransaccionPasarela, "comision" | "ivaComision" | "retefuente" | "reteiva" | "reteica">,
) => roundCOP(t.comision + t.ivaComision + t.retefuente + t.reteiva + t.reteica);

const sinTildes = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const t = String(v ?? "").replace(/[$\s]/g, "");
  if (!t || !/\d/.test(t)) return 0;
  // «1.234.567,89» (es) o «1,234,567.89» (us).
  const es = /,\d{1,2}$/.test(t) || /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t);
  const n = Number(es ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const MESES_CORTOS = [
  "ENE",
  "FEB",
  "MAR",
  "ABR",
  "MAY",
  "JUN",
  "JUL",
  "AGO",
  "SEP",
  "OCT",
  "NOV",
  "DIC",
];

/** Fecha de la hoja: Date, «2026-10-02 10:18», «02/10/2026», «oct. 08 04:32 PM» (año del periodo). */
export function fechaPasarela(v: unknown, periodo: string): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const d = new Date(v.getTime() - v.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "number" && v > 30000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const t = sinTildes(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /^([A-Z]{3})[A-Z]*\.?\s+(\d{1,2})\b/.exec(t);
  if (m) {
    const mes = MESES_CORTOS.indexOf(m[1]!) + 1;
    if (mes > 0) {
      const [a, mp] = periodo.split("-").map(Number) as [number, number];
      // Un cobro de diciembre en el reporte de enero es del año anterior.
      const anio = mp === 1 && mes === 12 ? a - 1 : a;
      return `${anio}-${String(mes).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
    }
  }
  return null;
}

type Columnas = Partial<
  Record<
    | "id"
    | "fecha"
    | "estado"
    | "bruto"
    | "iva"
    | "retefuente"
    | "reteiva"
    | "reteica"
    | "neto"
    | "totalDeduccion"
    | "pagador"
    | "documento"
    | "relacion"
    | "aplicacion",
    number | undefined
  >
> & { comision: number[] };

function columnas(enc: unknown[]): Columnas | null {
  const h = enc.map(sinTildes);
  const idx = (re: RegExp, desde = 0) => {
    const i = h.findIndex((x, k) => k >= desde && re.test(x));
    return i >= 0 ? i : undefined;
  };
  const c: Columnas = {
    id: idx(/^ID TRANSACCION|^TRANSACCION NO|^ID$|REFERENCIA DE (LA )?TRANSACCION/),
    fecha: idx(/^FECHA$/),
    estado: idx(/^ESTADO/),
    bruto: idx(/^VALOR TOTAL$/) ?? idx(/^VALOR$/) ?? idx(/^MONTO$/),
    iva: idx(/^IVA$/),
    retefuente: idx(/RTE\.? ?FTE|RETE ?FUENTE|RETENCION EN LA FUENTE/),
    reteiva: idx(/RETE ?IVA/),
    reteica: idx(/RETE ?ICA/),
    neto: idx(/TOTAL A ?CONSIGNAR|DEPOSITO EN CUENTA|VALOR NETO|NETO A (ABONAR|CONSIGNAR)/),
    totalDeduccion: idx(/TOTAL DEDUCCION/),
    pagador: idx(/NOMBRE DEL PAGADOR|^PAGADOR$|^CLIENTE$/),
    documento: idx(/^DOCUMENTO|IDENTIFICACION DEL PAGADOR/),
    relacion: idx(/^RELACION/),
    aplicacion: idx(/^APLICACION/),
    comision: h.flatMap((x, i) => (/COMISION/.test(x) ? [i] : [])),
  };
  if (c.fecha == null || c.bruto == null || !c.comision.length) return null;
  return c;
}

/**
 * Transacciones aprobadas de la hoja de la plataforma (export de Bold, Wompi…). El IVA de
 * la comisión se toma como deducción solo si así cuadra el neto de la hoja (en Bold la
 * columna IVA es el de la venta).
 */
export function leerHojaPasarela(
  ws: XLSX.WorkSheet,
  plataforma: string,
  periodo: string,
): { transacciones: TransaccionPasarela[]; advertencias: string[] } {
  const filas = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const advertencias: string[] = [];
  const iEnc = filas.findIndex((f) => columnas(f ?? []) != null);
  if (iEnc < 0)
    return {
      transacciones: [],
      advertencias: [`${plataforma}: no se encontraron los encabezados.`],
    };
  const c = columnas(filas[iEnc]!)!;
  const val = (f: unknown[], i: number | undefined) => (i == null ? 0 : num(f[i]));
  const txt = (f: unknown[], i: number | undefined) =>
    i == null ? null : String(f[i] ?? "").trim() || null;
  const crudas: Array<Omit<TransaccionPasarela, "ivaComision"> & { iva: number }> = [];
  for (const f of filas.slice(iEnc + 1)) {
    if (!f) continue;
    const estado = sinTildes(c.estado != null ? f[c.estado] : "APROBADA");
    if (!/EXITOS|APROBAD|APPROVED|PAGAD/.test(estado) || /NO REALIZADO|RECHAZ|DECLIN/.test(estado))
      continue;
    const fecha = fechaPasarela(f[c.fecha!], periodo);
    const bruto = val(f, c.bruto);
    if (!fecha || !(bruto > 0)) continue;
    const comision = roundCOP(c.comision.reduce((s, i) => s + num(f[i]), 0));
    const retefuente = val(f, c.retefuente);
    const reteiva = val(f, c.reteiva);
    const reteica = val(f, c.reteica);
    const iva = val(f, c.iva);
    const netoHoja = c.neto != null ? num(f[c.neto]) : null;
    const neto =
      netoHoja ??
      roundCOP(
        bruto -
          (c.totalDeduccion != null
            ? num(f[c.totalDeduccion])
            : comision + retefuente + reteiva + reteica),
      );
    // Texto después de APLICACIÓN (nota de la usuaria, p. ej. «Queda para el movimiento de…»).
    const resto = f
      .slice((c.aplicacion ?? c.relacion ?? f.length) + 1)
      .map((x) => String(x ?? ""))
      .join(" ");
    crudas.push({
      plataforma,
      id: txt(f, c.id) ?? `${plataforma}-${crudas.length + 1}`,
      fecha,
      pagador: txt(f, c.pagador),
      documento: txt(f, c.documento),
      bruto: roundCOP(bruto),
      comision,
      iva: roundCOP(iva),
      retefuente: roundCOP(retefuente),
      reteiva: roundCOP(reteiva),
      reteica: roundCOP(reteica),
      neto: roundCOP(neto),
      rcs: comprobantesEnTexto(txt(f, c.relacion)),
      aplicacion: txt(f, c.aplicacion),
      abonoMesSiguiente: /QUEDA PARA|MES SIGUIENTE|PROXIMO MES|SIGUIENTE MES/.test(
        sinTildes(resto),
      ),
    });
  }
  // ¿La columna IVA es una deducción de la plataforma? Solo si así cuadran los netos.
  const cuadra = (conIva: boolean) =>
    crudas.filter(
      (t) =>
        Math.abs(
          t.bruto -
            t.comision -
            (conIva ? t.iva : 0) -
            t.retefuente -
            t.reteiva -
            t.reteica -
            t.neto,
        ) < 1,
    ).length;
  const ivaEsDeduccion = c.iva != null && cuadra(true) > cuadra(false);
  const transacciones = crudas.map(({ iva, ...t }) => ({
    ...t,
    ivaComision: ivaEsDeduccion ? iva : 0,
  }));
  // Filas que no cuadran (p. ej. columnas mal diligenciadas): se respetan el valor y el neto y
  // el desglose se estima con las tarifas medianas de las filas que sí cuadran.
  const ok = transacciones.filter((t) => Math.abs(t.bruto - deducciones(t) - t.neto) < 1);
  const mediana = (xs: number[]) => {
    const o = [...xs].sort((a, b) => a - b);
    return o.length ? o[Math.floor(o.length / 2)]! : 0;
  };
  const tasa = (k: "retefuente" | "reteiva" | "reteica" | "ivaComision") =>
    mediana(ok.map((t) => t[k] / t.bruto));
  const tasas = {
    retefuente: tasa("retefuente"),
    reteiva: tasa("reteiva"),
    reteica: tasa("reteica"),
    ivaComision: tasa("ivaComision"),
  };
  const estimadas: string[] = [];
  const finales = transacciones.map((t) => {
    if (Math.abs(t.bruto - deducciones(t) - t.neto) < 1) return t;
    const total = roundCOP(t.bruto - t.neto);
    const retefuente = roundCOP(t.bruto * tasas.retefuente);
    const reteiva = roundCOP(t.bruto * tasas.reteiva);
    const reteica = roundCOP(t.bruto * tasas.reteica);
    const ivaComision = roundCOP(t.bruto * tasas.ivaComision);
    const comision = roundCOP(total - retefuente - reteiva - reteica - ivaComision);
    estimadas.push(`${t.id} (${t.fecha})`);
    return { ...t, comision, ivaComision, retefuente, reteiva, reteica, estimada: true };
  });
  if (estimadas.length)
    advertencias.push(
      `${plataforma}: ${estimadas.length} cobro(s) con columnas que no cuadran con el neto (${estimadas.slice(0, 4).join(", ")}). Se respetan el valor y el neto; comisión y retenciones se estimaron con las tarifas de las demás filas: verifícalas en el portal de la plataforma.`,
    );
  return { transacciones: finales, advertencias };
}

export type EstadoCobro = {
  t: TransaccionPasarela;
  /** RC de Siigo del cobro y su valor (suma si son varios). */
  rc: { comprobantes: string[]; valor: number } | null;
  /** RC por un valor distinto al pagado por el cliente (bruto). */
  difRc: number;
  /** Abono del banco en que llegó (id del movimiento), o null si no ha llegado. */
  abono: string | null;
};

export type AbonoPasarela = {
  mov: MovBanco;
  cuenta: string;
  cobros: string[]; // ids de transacción
  /** Abono − suma de los netos de sus cobros. */
  diferencia: number;
};

export type ResultadoPasarela = {
  plataforma: string;
  cobros: EstadoCobro[];
  abonos: AbonoPasarela[];
  /** Cobros sin RC en Siigo. */
  sinRc: EstadoCobro[];
  /** Cobros del mes aún no abonados por la plataforma (pasan al mes siguiente). */
  sinAbono: EstadoCobro[];
  /** Abonos de la plataforma sin cobros identificados (p. ej. de otro mes sin hoja). */
  abonosSinCobros: AbonoPasarela[];
  /** Totales de los cobros abonados en el mes (lo que se cruza en el RP del mes). */
  abonado: {
    cobros: number;
    bruto: number;
    comision: number;
    ivaComision: number;
    retefuente: number;
    reteiva: number;
    reteica: number;
    neto: number;
    deducciones: number;
  };
};

const dias = (a: string, b: string) =>
  (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000;

/**
 * Cruza los cobros de la plataforma (del mes y los pendientes del mes anterior) con los RC de
 * Siigo y con los abonos de la plataforma en los extractos del mes.
 * - Abono que cita RC (relación del reporte): sus cobros son los de esos RC.
 * - Abono sin citas: un cobro con el mismo neto de 0 a 5 días antes.
 */
export function cruzarPasarela(params: {
  plataforma: string;
  periodo: string;
  transacciones: TransaccionPasarela[];
  /** Movimientos del banco del mes, por cuenta, ya filtrados a los de la plataforma. */
  abonos: Array<{ cuenta: string; mov: MovBanco }>;
  /** Libros (RC) de todas las cuentas: auxiliar, API y partidas previas. */
  libros: MovLibro[];
}): ResultadoPasarela {
  const porComp = new Map<string, MovLibro[]>();
  for (const l of params.libros) {
    const k = normalizarComprobante(l.comprobante);
    if (k && l.valor > 0) porComp.set(k, [...(porComp.get(k) ?? []), l]);
  }
  const usadosRc = new Set<string>();
  const cobros: EstadoCobro[] = params.transacciones.map((t) => {
    const ls = t.rcs.flatMap((r) => porComp.get(normalizarComprobante(r)) ?? []);
    // Un RC citado por varios cobros: se compara una vez contra la suma de esos cobros.
    const unicos = ls.filter((l) => !usadosRc.has(l.id));
    for (const l of unicos) usadosRc.add(l.id);
    const valor = roundCOP(unicos.reduce((s, l) => s + l.valor, 0));
    return {
      t,
      rc: ls.length ? { comprobantes: [...new Set(ls.map((l) => l.comprobante))], valor } : null,
      difRc: 0,
      abono: null,
    };
  });
  // Diferencia RC vs bruto por grupo de cobros que comparten RC.
  const grupos = new Map<string, EstadoCobro[]>();
  for (const c of cobros)
    if (c.rc) {
      const k = c.rc.comprobantes.map(normalizarComprobante).sort().join("|");
      grupos.set(k, [...(grupos.get(k) ?? []), c]);
    }
  for (const g of grupos.values()) {
    const bruto = roundCOP(g.reduce((s, c) => s + c.t.bruto, 0));
    const rc = roundCOP(g.reduce((s, c) => s + (c.rc?.valor ?? 0), 0));
    g[0]!.difRc = roundCOP(rc - bruto);
  }

  const porRc = new Map<string, EstadoCobro[]>();
  for (const c of cobros)
    for (const r of c.t.rcs) {
      const k = normalizarComprobante(r);
      porRc.set(k, [...(porRc.get(k) ?? []), c]);
    }
  const abonos: AbonoPasarela[] = [];
  const pendientesSinCita: AbonoPasarela[] = [];
  for (const { cuenta, mov } of params.abonos) {
    if (mov.valor <= 0) continue;
    const citados = [
      ...new Set((mov.refs ?? []).flatMap((r) => porRc.get(normalizarComprobante(r)) ?? [])),
    ].filter((c) => !c.abono);
    const a: AbonoPasarela = { mov, cuenta, cobros: [], diferencia: mov.valor };
    if (citados.length) {
      for (const c of citados) c.abono = mov.id;
      a.cobros = citados.map((c) => c.t.id);
      a.diferencia = roundCOP(mov.valor - citados.reduce((s, c) => s + c.t.neto, 0));
      abonos.push(a);
    } else pendientesSinCita.push(a);
  }
  // Abonos sin citas: un cobro con el mismo neto, abonado de 0 a 5 días después del cobro.
  for (const a of pendientesSinCita) {
    const c = cobros
      .filter(
        (x) =>
          !x.abono &&
          Math.abs(x.t.neto - a.mov.valor) < 1 &&
          dias(x.t.fecha, a.mov.fecha) >= 0 &&
          dias(x.t.fecha, a.mov.fecha) <= 5,
      )
      .sort((x, y) => dias(y.t.fecha, a.mov.fecha) - dias(x.t.fecha, a.mov.fecha))[0];
    if (c) {
      c.abono = a.mov.id;
      a.cobros = [c.t.id];
      a.diferencia = roundCOP(a.mov.valor - c.t.neto);
    }
    abonos.push(a);
  }
  abonos.sort((x, y) => x.mov.fecha.localeCompare(y.mov.fecha));

  const abonados = cobros.filter((c) => c.abono);
  const suma = (
    k: keyof Pick<
      TransaccionPasarela,
      "bruto" | "comision" | "ivaComision" | "retefuente" | "reteiva" | "reteica" | "neto"
    >,
  ) => roundCOP(abonados.reduce((s, c) => s + c.t[k], 0));
  return {
    plataforma: params.plataforma,
    cobros,
    abonos,
    sinRc: cobros.filter((c) => !c.rc && c.t.fecha.slice(0, 7) === params.periodo),
    sinAbono: cobros.filter((c) => !c.abono && c.t.fecha.slice(0, 7) === params.periodo),
    abonosSinCobros: abonos.filter((a) => !a.cobros.length),
    abonado: {
      cobros: abonados.length,
      bruto: suma("bruto"),
      comision: suma("comision"),
      ivaComision: suma("ivaComision"),
      retefuente: suma("retefuente"),
      reteiva: suma("reteiva"),
      reteica: suma("reteica"),
      neto: suma("neto"),
      deducciones: roundCOP(abonados.reduce((s, c) => s + deducciones(c.t), 0)),
    },
  };
}

export type CuentasPasarela = {
  cxp: string | null;
  retefuente: string | null;
  reteiva: string | null;
  reteica: string | null;
  ajusteDebito: string | null;
  ajusteCredito: string | null;
  tope: number;
};

/**
 * RP del mes de la plataforma por lo descontado en los abonos del mes (crédito al banco del
 * abono). La comisión (+ IVA) cruza las facturas de comisiones con saldo de la plataforma,
 * de la más antigua a la más nueva; una diferencia hasta el tope va como ajuste al peso.
 */
export function propuestaPasarela(params: {
  r: ResultadoPasarela;
  terceroNit: string | null;
  terceroNombre: string | null;
  /** Facturas de la plataforma con saldo (CxP de Siigo). */
  facturas: Array<Omit<ItemPago, "valor">>;
  cuentas: CuentasPasarela;
  cuentaBanco: string | null;
}): { propuesta: Propuesta; valor: number } {
  const { r, cuentas } = params;
  const motivos: string[] = [];
  const servicio = roundCOP(r.abonado.comision + r.abonado.ivaComision);
  let porCruzar = servicio;
  const items: ItemPago[] = [];
  for (const f of [...params.facturas].sort(
    (a, b) =>
      String(a.vence ?? "").localeCompare(String(b.vence ?? "")) || a.consecutive - b.consecutive,
  )) {
    if (porCruzar < 0.01) break;
    const v = roundCOP(Math.min(f.saldo, porCruzar));
    if (v < 0.01) continue;
    items.push({ ...f, valor: v });
    porCruzar = roundCOP(porCruzar - v);
  }
  let ajuste: Propuesta["ajuste"] = null;
  if (porCruzar >= 0.01) {
    if (items.length && porCruzar <= cuentas.tope && cuentas.ajusteDebito)
      ajuste = { valor: porCruzar, cuenta: cuentas.ajusteDebito };
    else
      motivos.push(
        `Faltan facturas de comisiones de ${r.plataforma} en las CxP de Siigo por ${porCruzar.toLocaleString("es-CO")} (comisión + IVA descontados ${servicio.toLocaleString("es-CO")}): causa la factura y sincroniza las CxP.`,
      );
  }
  const lineas: CuentaDetallada[] = [];
  const ret = (valor: number, cuenta: string | null, nombre: string) => {
    if (valor < 0.01) return;
    if (!cuenta) motivos.push(`Falta la cuenta de ${nombre} descontada por ${r.plataforma}.`);
    lineas.push({
      code: cuenta ?? "",
      movimiento: "Debit",
      valor: roundCOP(valor),
      descripcion: `${nombre} ${r.plataforma}`,
    });
  };
  ret(r.abonado.retefuente, cuentas.retefuente, "Retención en la fuente");
  ret(r.abonado.reteiva, cuentas.reteiva, "Retención de IVA");
  ret(r.abonado.reteica, cuentas.reteica, "Retención de ICA");
  if (!params.terceroNit) motivos.push(`Falta el NIT de ${r.plataforma}.`);
  if (!cuentas.cxp) motivos.push("Falta la cuenta por pagar de la plataforma.");
  if (!params.cuentaBanco) motivos.push("Falta la cuenta de banco del abono.");
  if (!r.abonado.cobros) motivos.push(`No hay abonos de ${r.plataforma} en el mes.`);
  const valor = r.abonado.deducciones;
  return {
    valor,
    propuesta: {
      tipo: "pago_facturas",
      terceroNit: params.terceroNit,
      terceroNombre: params.terceroNombre,
      items,
      cuentas: [],
      paymentTypeId: null,
      cuentaBanco: params.cuentaBanco,
      listo: motivos.length === 0,
      motivos,
      notas: [
        `Descuentos de ${r.plataforma} en ${r.abonado.cobros} cobro(s) abonado(s) en el mes: comisión ${r.abonado.comision.toLocaleString("es-CO")}${r.abonado.ivaComision ? `, IVA ${r.abonado.ivaComision.toLocaleString("es-CO")}` : ""}, retenciones ${roundCOP(r.abonado.retefuente + r.abonado.reteiva + r.abonado.reteica).toLocaleString("es-CO")}.`,
      ],
      ajuste,
      lineas,
      cuentaCxp: cuentas.cxp,
    },
  };
}

/** Totales de los cobros abonados en el mes, por cuenta del abono (un RP por cuenta). */
export function abonadoPorCuenta(r: ResultadoPasarela): Map<string, ResultadoPasarela["abonado"]> {
  const cuentaDe = new Map(r.abonos.map((a) => [a.mov.id, a.cuenta]));
  const out = new Map<string, ResultadoPasarela["abonado"]>();
  for (const c of r.cobros) {
    if (!c.abono) continue;
    const k = cuentaDe.get(c.abono);
    if (!k) continue;
    const a = out.get(k) ?? {
      cobros: 0,
      bruto: 0,
      comision: 0,
      ivaComision: 0,
      retefuente: 0,
      reteiva: 0,
      reteica: 0,
      neto: 0,
      deducciones: 0,
    };
    a.cobros += 1;
    a.bruto = roundCOP(a.bruto + c.t.bruto);
    a.comision = roundCOP(a.comision + c.t.comision);
    a.ivaComision = roundCOP(a.ivaComision + c.t.ivaComision);
    a.retefuente = roundCOP(a.retefuente + c.t.retefuente);
    a.reteiva = roundCOP(a.reteiva + c.t.reteiva);
    a.reteica = roundCOP(a.reteica + c.t.reteica);
    a.neto = roundCOP(a.neto + c.t.neto);
    a.deducciones = roundCOP(a.deducciones + deducciones(c.t));
    out.set(k, a);
  }
  return out;
}

/** Extracto con las referencias (RC) de los cobros de cada abono identificado de la pasarela. */
export function citarAbonos(movs: MovBanco[], r: ResultadoPasarela): MovBanco[] {
  const rcsDe = new Map(r.cobros.map((c) => [c.t.id, c.t.rcs]));
  const porMov = new Map(r.abonos.map((a) => [a.mov.id, a]));
  return movs.map((m) => {
    const a = porMov.get(m.id);
    if (!a?.cobros.length) return m;
    const refs = [
      ...new Set([...(m.refs ?? []), ...a.cobros.flatMap((id) => rcsDe.get(id) ?? [])]),
    ];
    return { ...m, refs };
  });
}
