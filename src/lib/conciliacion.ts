// CONCILIACIÓN BANCARIA — motor puro (núcleo global: todas las empresas).
//
// Por cada cuenta (banco o caja) y mes cruza:
//   - el EXTRACTO del mes (movimientos del banco/caja, + ingreso / − salida),
//   - los LIBROS (movimiento de Siigo de la cuenta: auxiliar subido, completado con los
//     RC de la API y los RP enviados desde la herramienta; + débito / − crédito),
//   - las PARTIDAS CONCILIATORIAS del corte anterior (banco sin libros y libros sin banco).
// Orden de cruce (de la más fuerte a la más débil):
//   1. Comprobante citado en el extracto/relación (RC-1-…, RP-4-…) contra el de libros.
//   2. Gastos bancarios del mes de la cuenta contra su comprobante único (grupo).
//   3. Mismo valor exacto, fecha cercana (0, 1, 2, 3, 5, 10, 31 días), desempate por nombre.
//   4. Varios movimientos del banco contra un registro de libros (2 a 4, ±10 días: nómina).
// Lo que queda: falta en libros (RP o RC por registrar) y sobra en libros (en tránsito o
// errores). Esas son las partidas conciliatorias al corte. Nunca inventa valores.
import { roundCOP } from "@/lib/money";

export type MovBanco = {
  id: string;
  fecha: string; // yyyy-MM-dd
  descripcion: string;
  valor: number; // + ingreso, − salida
  /** Comprobantes citados para este movimiento (relación del reporte de pagos, RP enviado). */
  refs?: string[];
  tercero?: string | null;
  /** Partida que viene de la conciliación anterior. */
  previa?: boolean;
};

export type MovLibro = {
  id: string;
  fecha: string;
  comprobante: string;
  tercero: string | null;
  /** NIT del tercero (auxiliar o API), para ajustes en Siigo. */
  terceroNit?: string | null;
  descripcion: string | null;
  valor: number; // + débito (entra al banco), − crédito (sale)
  /** Origen: auxiliar subido, API de Siigo (RC) o RP enviado desde la herramienta. */
  origen?: "auxiliar" | "api" | "herramienta" | "previa";
  previa?: boolean;
};

export type Cruce = {
  banco: MovBanco[];
  libros: MovLibro[];
  criterio: string;
  diferencia: number; // banco − libros
  /** Abono de una pasarela de pagos (neto de comisiones y retenciones). */
  pasarela?: string;
};

export type ResultadoConciliacion = {
  conciliados: Cruce[];
  /** Cruzan por comprobante pero el valor difiere (p. ej. RC por un valor distinto al abono). */
  diferencias: Cruce[];
  /** En el extracto y no en libros: RP (salidas) o RC/ingresos (entradas) por registrar. */
  faltaEnLibros: MovBanco[];
  /** En libros y no en el extracto: partidas en tránsito o errores. */
  sobraEnLibros: MovLibro[];
};

export type PartidaConciliatoria = {
  tipo: "banco_sin_libros" | "libros_sin_banco" | "diferencia";
  fecha: string;
  descripcion: string;
  comprobante: string | null;
  tercero: string | null;
  valor: number; // signo del lado donde está (banco: + ingreso; libros: + débito; diferencia: banco − libros)
};

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const normalizarComprobante = (s: string | null | undefined) =>
  sinTildes(String(s ?? ""))
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();

/** Comprobantes citados en un texto: «RC-1-24500 y RC-1-24498», «RP-4-3287». */
export function comprobantesEnTexto(texto: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of sinTildes(String(texto ?? ""))
    .toUpperCase()
    .matchAll(/\b([A-Z]{1,4}-\d{1,4}-\d{1,9})\b/g))
    out.add(m[1]!);
  return [...out];
}

const VACIAS = new Set([
  "PAGO",
  "A",
  "DE",
  "NOMIN",
  "PROV",
  "PROVE",
  "INTERBANC",
  "TRANSFERENCIA",
  "CTA",
  "SUC",
  "VIRTUAL",
  "COMPRA",
  "EN",
  "SAS",
  "S",
  "LTDA",
  "SA",
  "ABONO",
  "ACH",
  "PSE",
  "QR",
  "LLAVE",
  "Y",
  "LA",
  "EL",
  "DEL",
]);
const palabras = (s: string | null | undefined) =>
  sinTildes(String(s ?? ""))
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !VACIAS.has(w) && !/^\d+$/.test(w));

/** Similitud de nombres 0..1 (palabras en común sobre las del más corto). */
export function similitud(a: string | null | undefined, b: string | null | undefined): number {
  const pa = new Set(palabras(a));
  const pb = new Set(palabras(b));
  if (!pa.size || !pb.size) return 0;
  let comunes = 0;
  for (const w of pa) if (pb.has(w)) comunes += 1;
  return comunes / Math.min(pa.size, pb.size);
}

const dias = (a: string, b: string) =>
  Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000;
const iguales = (a: number, b: number) => Math.abs(roundCOP(a) - roundCOP(b)) < 0.01;

/** Cargos del banco que van en un solo comprobante mensual (comisiones, IVA, 4x1000). */
export const esGastoBancario = (descripcion: string) =>
  /4\s*X\s*1000|GRAVAMEN|IMPTO GOBIERNO|CUOTA (PLAN|MANEJO)|C MANEJO|COMISION|SERVICIO PAGO|COBRO IVA|IVA CUOTA|IVA COMIS|CARGO/i.test(
    sinTildes(descripcion),
  );

export function conciliar(params: {
  banco: MovBanco[];
  libros: MovLibro[];
  /** Comprobantes (de libros) del RP mensual de gastos bancarios de esta cuenta. */
  comprobantesGastosBancarios?: string[];
  /**
   * Pasarelas de pago: sus abonos llegan netos de comisiones y retenciones contra RC por el
   * valor completo. Esas diferencias se cruzan con el RP de comisiones de la plataforma.
   */
  pasarelas?: Array<{ plataforma: string; patron: RegExp; comprobantes: string[] }>;
  /** Ajustes al peso ya enviados: comprobante del ajuste y el RC/RP que ajusta. */
  ajustes?: Array<{ comprobante: string; origen: string }>;
}): ResultadoConciliacion {
  const banco = params.banco.map((b) => ({ ...b, valor: roundCOP(b.valor) }));
  const libros = params.libros.map((l) => ({ ...l, valor: roundCOP(l.valor) }));
  const usadosB = new Set<string>();
  const usadosL = new Set<string>();
  const conciliados: Cruce[] = [];
  const diferencias: Cruce[] = [];
  const libresB = () => banco.filter((b) => !usadosB.has(b.id));
  const libresL = () => libros.filter((l) => !usadosL.has(l.id));
  const marcar = (bs: MovBanco[], ls: MovLibro[], criterio: string) => {
    for (const b of bs) usadosB.add(b.id);
    for (const l of ls) usadosL.add(l.id);
    const dif = roundCOP(bs.reduce((s, b) => s + b.valor, 0) - ls.reduce((s, l) => s + l.valor, 0));
    (Math.abs(dif) < 0.01 ? conciliados : diferencias).push({
      banco: bs,
      libros: ls,
      criterio,
      diferencia: dif,
    });
  };

  // 1. Comprobante citado.
  const porComprobante = new Map<string, MovLibro[]>();
  for (const l of libros) {
    const k = normalizarComprobante(l.comprobante);
    if (k) porComprobante.set(k, [...(porComprobante.get(k) ?? []), l]);
  }
  for (const b of banco) {
    if (usadosB.has(b.id) || !b.refs?.length) continue;
    const ls = b.refs
      .flatMap((r) => porComprobante.get(normalizarComprobante(r)) ?? [])
      .filter((l) => !usadosL.has(l.id));
    // Solo los movimientos de libros del mismo sentido (entrada o salida) que el banco.
    const mismos = ls.filter((l) => Math.sign(l.valor) === Math.sign(b.valor));
    if (mismos.length)
      marcar(
        [b],
        mismos,
        `Comprobante ${[...new Set(mismos.map((l) => l.comprobante))].join(", ")}`,
      );
  }

  // 1b. Abonos de pasarelas (netos) contra sus RC (brutos) y el RP de comisiones del mes.
  for (const p of params.pasarelas ?? []) {
    const difs = diferencias.filter(
      (d) =>
        d.diferencia < 0 && d.banco.length && d.banco.every((b) => p.patron.test(b.descripcion)),
    );
    if (!difs.length) continue;
    const comps = new Set(p.comprobantes.map(normalizarComprobante));
    const rp = libresL().filter(
      (l) => l.valor < 0 && comps.has(normalizarComprobante(l.comprobante)),
    );
    if (!rp.length) {
      for (const d of difs) {
        d.pasarela = p.plataforma;
        d.criterio = `${d.criterio} · abono de ${p.plataforma} neto de comisiones y retenciones: falta el RP de comisiones del mes`;
      }
      continue;
    }
    for (const d of difs) diferencias.splice(diferencias.indexOf(d), 1);
    for (const l of rp) usadosL.add(l.id);
    const bs = difs.flatMap((d) => d.banco);
    const ls = [...difs.flatMap((d) => d.libros), ...rp];
    const dif = roundCOP(bs.reduce((s, b) => s + b.valor, 0) - ls.reduce((s, l) => s + l.valor, 0));
    (Math.abs(dif) < 0.01 ? conciliados : diferencias).push({
      banco: bs,
      libros: ls,
      criterio:
        Math.abs(dif) < 0.01
          ? `Abonos de ${p.plataforma} netos de comisiones y retenciones (RP ${[...new Set(rp.map((l) => l.comprobante))].join(", ")})`
          : `Abonos de ${p.plataforma}: el RP de comisiones no cubre exactamente los descuentos`,
      diferencia: dif,
      pasarela: p.plataforma,
    });
  }

  // 1c. Diferencias ya ajustadas en Siigo (ajuste al peso enviado desde la conciliación).
  for (const a of params.ajustes ?? []) {
    const d = diferencias.find((x) =>
      x.libros.some((l) =>
        normalizarComprobante(a.origen).split(",").includes(normalizarComprobante(l.comprobante)),
      ),
    );
    const l = libresL().find(
      (x) => normalizarComprobante(x.comprobante) === normalizarComprobante(a.comprobante),
    );
    if (!d || !l) continue;
    usadosL.add(l.id);
    d.libros = [...d.libros, l];
    d.diferencia = roundCOP(d.diferencia - l.valor);
    d.criterio = `${d.criterio} · ajuste al peso ${l.comprobante}`;
    if (Math.abs(d.diferencia) < 0.01) {
      diferencias.splice(diferencias.indexOf(d), 1);
      conciliados.push(d);
    }
  }

  // 2. Gastos bancarios del mes contra su comprobante único.
  const gb = new Set((params.comprobantesGastosBancarios ?? []).map(normalizarComprobante));
  if (gb.size) {
    const ls = libresL().filter((l) => gb.has(normalizarComprobante(l.comprobante)));
    const bs = libresB().filter((b) => b.valor < 0 && esGastoBancario(b.descripcion) && !b.previa);
    if (ls.length && bs.length) marcar(bs, ls, "Gastos bancarios del mes (comprobante único)");
  }

  // 3. Mismo valor, fecha cercana, desempate por nombre.
  for (const tol of [0, 1, 2, 3, 5, 10, 31]) {
    for (const b of libresB()) {
      const cands = libresL().filter(
        (l) => iguales(l.valor, b.valor) && dias(l.fecha, b.fecha) <= tol,
      );
      if (!cands.length) continue;
      const mejor = cands.sort(
        (x, y) =>
          similitud(y.tercero ?? y.descripcion, b.descripcion) -
            similitud(x.tercero ?? x.descripcion, b.descripcion) ||
          dias(x.fecha, b.fecha) - dias(y.fecha, b.fecha),
      )[0]!;
      marcar(
        [b],
        [mejor],
        tol === 0 ? "Mismo valor y fecha" : `Mismo valor, ${tol} día(s) de diferencia`,
      );
    }
  }

  // 4. Varios movimientos del banco contra un registro de libros (nómina: 2 a 4 pagos).
  for (const l of libresL()) {
    const cands = libresB()
      .filter(
        (b) =>
          Math.sign(b.valor) === Math.sign(l.valor) &&
          Math.abs(b.valor) < Math.abs(l.valor) &&
          dias(b.fecha, l.fecha) <= 10,
      )
      .filter((b) => similitud(b.descripcion, l.tercero ?? l.descripcion) >= 0.5)
      .slice(0, 12);
    const combo = buscarCombinacion(cands, l.valor, 4);
    if (combo)
      marcar(
        combo,
        [l],
        `${combo.length} movimientos del banco contra un registro (pago en partes)`,
      );
  }

  return { conciliados, diferencias, faltaEnLibros: libresB(), sobraEnLibros: libresL() };
}

function buscarCombinacion(cands: MovBanco[], objetivo: number, max: number): MovBanco[] | null {
  const n = cands.length;
  const rec = (inicio: number, suma: number, elegidos: MovBanco[]): MovBanco[] | null => {
    if (elegidos.length >= 2 && iguales(suma, objetivo)) return elegidos;
    if (elegidos.length === max) return null;
    for (let i = inicio; i < n; i++) {
      const r = rec(i + 1, suma + cands[i]!.valor, [...elegidos, cands[i]!]);
      if (r) return r;
    }
    return null;
  };
  return rec(0, 0, []);
}

/** Partidas conciliatorias al corte (lo que no cruzó y las diferencias). */
export function partidasAlCorte(r: ResultadoConciliacion): PartidaConciliatoria[] {
  return [
    ...r.faltaEnLibros.map((b) => ({
      tipo: "banco_sin_libros" as const,
      fecha: b.fecha,
      descripcion: b.descripcion,
      comprobante: b.refs?.[0] ?? null,
      tercero: b.tercero ?? null,
      valor: b.valor,
    })),
    ...r.sobraEnLibros.map((l) => ({
      tipo: "libros_sin_banco" as const,
      fecha: l.fecha,
      descripcion: l.descripcion ?? l.comprobante,
      comprobante: l.comprobante,
      tercero: l.tercero,
      valor: l.valor,
    })),
    ...r.diferencias.map((d) => ({
      tipo: "diferencia" as const,
      fecha: d.banco[0]?.fecha ?? d.libros[0]?.fecha ?? "",
      descripcion: `${d.banco.map((b) => b.descripcion).join(" + ")} vs ${d.libros.map((l) => l.comprobante).join(", ")}`,
      comprobante: d.libros.map((l) => l.comprobante).join(", ") || null,
      tercero: d.libros[0]?.tercero ?? null,
      valor: d.diferencia,
    })),
  ];
}

/**
 * Prueba de la conciliación: saldo extracto − saldo libros = banco sin libros − libros sin
 * banco + diferencias. Devuelve la diferencia sin explicar (0 = cuadra).
 */
export function diferenciaSinExplicar(params: {
  saldoExtracto: number;
  saldoLibros: number;
  partidas: PartidaConciliatoria[];
}): number {
  const explicada = params.partidas.reduce(
    (s, p) => s + (p.tipo === "libros_sin_banco" ? -p.valor : p.valor),
    0,
  );
  return roundCOP(params.saldoExtracto - params.saldoLibros - explicada);
}

/** Partidas del corte anterior convertidas en movimientos del mes (para volver a cruzarlas). */
export function partidasPrevias(partidas: PartidaConciliatoria[]): {
  banco: MovBanco[];
  libros: MovLibro[];
} {
  const banco: MovBanco[] = [];
  const libros: MovLibro[] = [];
  partidas.forEach((p, i) => {
    if (p.tipo === "banco_sin_libros")
      banco.push({
        id: `previa-b-${i}`,
        fecha: p.fecha,
        descripcion: p.descripcion,
        valor: p.valor,
        refs: p.comprobante ? comprobantesEnTexto(p.comprobante) : [],
        tercero: p.tercero,
        previa: true,
      });
    else if (p.tipo === "libros_sin_banco")
      libros.push({
        id: `previa-l-${i}`,
        fecha: p.fecha,
        comprobante: p.comprobante ?? "",
        tercero: p.tercero,
        descripcion: p.descripcion,
        valor: p.valor,
        origen: "previa",
        previa: true,
      });
  });
  return { banco, libros };
}

/** Movimiento del auxiliar de Siigo (ya leído) de la cuenta contable conciliada. */
export type LineaAuxiliar = {
  account_code: string | null;
  voucher: string | null;
  entry_date_text: string | null;
  provider_name: string | null;
  provider_nit?: string | null;
  description: string | null;
  detail?: string | null;
  debit: number | null;
  credit: number | null;
};

/** «16/09/2026» o «2026-09-16» → «2026-09-16». */
export function fechaAuxiliar(t: string | null | undefined): string | null {
  const s = String(t ?? "").trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export type EntradaCuenta = {
  etiqueta: string;
  cuentaContable: string | null;
  periodo: string; // yyyy-MM
  extracto: MovBanco[];
  auxiliar: LineaAuxiliar[];
  rpEnviados: Array<
    MovLibro & { cuenta: string | null; grupo: string | null; pasarela?: string | null }
  >;
  rcApi: Array<MovLibro & { cuenta: string | null }>;
  /** Ajustes al peso enviados desde la conciliación (comprobante contable en Siigo). */
  ajustesEnviados?: Array<MovLibro & { cuenta: string | null; ajusta: string }>;
  previas: PartidaConciliatoria[];
  /** Pasarelas de pago de la empresa (Bold, Wompi…): sus abonos llegan netos. */
  pasarelas?: string[];
};

/**
 * Arma el banco y los libros de una cuenta para conciliar:
 * - extracto con los RP enviados citados (mismo valor y fecha);
 * - libros = auxiliar de la cuenta en el mes, completado con los RP enviados desde la
 *   herramienta y los RC de la API que no estén en el auxiliar (gastos bancarios agrupados
 *   en su comprobante único);
 * - partidas del corte anterior.
 */
export function armarConciliacion(e: EntradaCuenta): {
  banco: MovBanco[];
  libros: MovLibro[];
  comprobantesGastosBancarios: string[];
  pasarelas: Array<{ plataforma: string; patron: RegExp; comprobantes: string[] }>;
  ajustes: Array<{ comprobante: string; origen: string }>;
  movimientoLibros: number;
} {
  const enMes = (f: string | null) => !!f && f.slice(0, 7) === e.periodo;
  const auxiliar: MovLibro[] = e.auxiliar
    .filter((l) => e.cuentaContable && String(l.account_code ?? "").trim() === e.cuentaContable)
    .map((l, i) => ({
      id: `aux-${i}`,
      fecha: fechaAuxiliar(l.entry_date_text) ?? "",
      comprobante: String(l.voucher ?? "").trim(),
      tercero: l.provider_name,
      terceroNit: l.provider_nit ?? null,
      descripcion: l.description ?? l.detail ?? null,
      valor: roundCOP(Number(l.debit ?? 0) - Number(l.credit ?? 0)),
      origen: "auxiliar" as const,
    }))
    .filter((l) => enMes(l.fecha) && l.valor !== 0);
  const enAuxiliar = new Set(auxiliar.map((l) => normalizarComprobante(l.comprobante)));
  const k = (s: string | null) =>
    sinTildes(String(s ?? ""))
      .toUpperCase()
      .trim();
  const deCuenta = <T extends { cuenta: string | null }>(xs: T[]) =>
    xs.filter((x) => k(x.cuenta) === k(e.etiqueta));
  const rps = deCuenta(e.rpEnviados);
  // RP agrupados (gastos bancarios del mes): un solo registro por comprobante.
  const porComp = new Map<string, MovLibro>();
  for (const r of rps) {
    const c = normalizarComprobante(r.comprobante);
    const prev = porComp.get(c);
    if (prev) prev.valor = roundCOP(prev.valor + r.valor);
    else
      porComp.set(c, {
        ...r,
        id: `rp-${c}`,
        descripcion: r.grupo ? "Gastos bancarios del mes" : r.descripcion,
      });
  }
  const complemento = [
    ...[...porComp.values()].filter((r) => !enAuxiliar.has(normalizarComprobante(r.comprobante))),
    ...deCuenta(e.rcApi).filter((r) => !enAuxiliar.has(normalizarComprobante(r.comprobante))),
    ...deCuenta(e.ajustesEnviados ?? []).filter(
      (r) => !enAuxiliar.has(normalizarComprobante(r.comprobante)),
    ),
  ];
  // Citar en el extracto los RP individuales enviados (mismo valor y fecha).
  const individuales = rps.filter((r) => !r.grupo && !r.pasarela);
  const usados = new Set<string>();
  const banco = e.extracto.map((b) => {
    const r = individuales.find(
      (x) => !usados.has(x.id) && x.fecha === b.fecha && Math.abs(x.valor - b.valor) < 0.01,
    );
    if (!r) return b;
    usados.add(r.id);
    return { ...b, refs: [...new Set([...(b.refs ?? []), r.comprobante])] };
  });
  const libros = [...auxiliar, ...complemento.map((c) => ({ ...c, valor: roundCOP(c.valor) }))];
  const prev = partidasPrevias(e.previas);
  return {
    banco: [...banco, ...prev.banco],
    libros: [...libros, ...prev.libros],
    comprobantesGastosBancarios: [...new Set(rps.filter((r) => r.grupo).map((r) => r.comprobante))],
    ajustes: deCuenta(e.ajustesEnviados ?? []).map((a) => ({
      comprobante: a.comprobante,
      origen: a.ajusta,
    })),
    pasarelas: (e.pasarelas ?? []).map((plataforma) => ({
      plataforma,
      patron: new RegExp(`\\b${plataforma.replace(/[^A-Za-z0-9]/g, "")}\\b`, "i"),
      comprobantes: rps.filter((r) => r.pasarela === plataforma).map((r) => r.comprobante),
    })),
    movimientoLibros: roundCOP(libros.reduce((s, l) => s + l.valor, 0)),
  };
}

export type AjustePropuesto = {
  /** Clave estable: cuenta, comprobantes y abono del banco (fecha y valor). */
  clave: string;
  fecha: string;
  /** Diferencia banco − libros: > 0 ingreso (débito al banco), < 0 gasto (crédito al banco). */
  valor: number;
  origen: string;
  terceroNit: string | null;
  tercero: string | null;
  descripcion: string;
};

/**
 * Diferencias de valor dentro del tope del ajuste al peso (no de pasarelas): se pueden
 * ajustar en Siigo con un comprobante contable contra el banco.
 */
export function ajustesAlPeso(
  r: ResultadoConciliacion,
  etiqueta: string,
  tope: number,
): AjustePropuesto[] {
  return r.diferencias
    .filter(
      (d) =>
        !d.pasarela &&
        d.libros.length > 0 &&
        Math.abs(d.diferencia) >= 0.01 &&
        Math.abs(d.diferencia) <= tope + 0.001,
    )
    .map((d) => {
      const comps = [...new Set(d.libros.map((l) => l.comprobante).filter(Boolean))];
      const b = d.banco[0];
      return {
        clave: [
          "ajuste",
          etiqueta.toUpperCase(),
          comps.map(normalizarComprobante).sort().join(","),
          b?.fecha ?? "",
          roundCOP(d.banco.reduce((s, x) => s + x.valor, 0)).toFixed(2),
        ].join("|"),
        fecha: [b?.fecha, ...d.libros.map((l) => l.fecha)].filter(Boolean).sort().at(-1) ?? "",
        valor: d.diferencia,
        origen: comps.join(","),
        terceroNit: d.libros.find((l) => l.terceroNit)?.terceroNit ?? null,
        tercero: d.libros.find((l) => l.tercero)?.tercero ?? null,
        descripcion: `Ajuste al peso ${comps.join(", ")} vs banco ${b?.descripcion ?? ""}`
          .replace(/\s+/g, " ")
          .slice(0, 200),
      };
    });
}

/**
 * Comprobante contable del ajuste al peso: diferencia > 0 → débito al banco y crédito al
 * ingreso; < 0 → débito al gasto y crédito al banco. Con el tercero del RC/RP.
 */
export function payloadAjusteAlPeso(params: {
  documentId: number;
  fecha: string;
  valor: number;
  cuentaBanco: string;
  cuentaIngreso: string;
  cuentaGasto: string;
  terceroNit: string;
  descripcion: string;
  referencia: string;
}): Record<string, unknown> {
  const v = roundCOP(Math.abs(params.valor));
  const ingreso = params.valor > 0;
  const customer = { identification: params.terceroNit.replace(/\D/g, ""), branch_office: 0 };
  const obs = `${params.descripcion} · Ref ${params.referencia}`.slice(0, 250);
  return {
    document: { id: params.documentId },
    date: params.fecha,
    observations: obs,
    items: [
      {
        account: { code: ingreso ? params.cuentaBanco : params.cuentaGasto, movement: "Debit" },
        customer,
        description: params.descripcion.slice(0, 100),
        value: v,
      },
      {
        account: { code: ingreso ? params.cuentaIngreso : params.cuentaBanco, movement: "Credit" },
        customer,
        description: params.descripcion.slice(0, 100),
        value: v,
      },
    ],
  };
}
