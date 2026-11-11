// EGRESOS Y RECIBOS DE PAGO (RP) — motor puro, núcleo global (todas las empresas).
//
// Entrada: los pagos del mes (de cualquier reporte de pagos ya leído), las cuentas por
// pagar de Siigo, el precedente del auxiliar y las reglas que la usuaria enseñó.
// Salida: por cada pago, la propuesta del recibo de pago/egreso de Siigo:
//   - pago_facturas: abono a deuda (DebtPayment) a una o varias facturas causadas en
//     Siigo (FC-1-757…), con el valor de cada una; si no cubre el saldo es un abono.
//   - anticipo: anticipo al proveedor (AdvancePayment), sin factura.
//   - detallado: RP con cuentas (Detailed): débito a la cuenta del concepto (gasto
//     bancario, 4x1000, nómina por pagar, impuestos, seguridad social, tarjeta…) y
//     crédito al banco o caja del pago.
//   - omitir: no genera RP (p. ej. traslados entre cuentas propias).
// Nunca inventa: si falta un dato (factura que no está en las CxP, cuenta, tercero,
// valores que no cuadran) el pago queda «por revisar» con el motivo.
import { roundCOP } from "@/lib/money";

export type TipoEgreso = "por_definir" | "pago_facturas" | "anticipo" | "detallado" | "omitir";

/** Un pago (egreso) leído del reporte de pagos de la empresa. Valor siempre positivo. */
export type MovimientoPago = {
  clave: string;
  fila: number | null;
  fecha: string; // yyyy-MM-dd
  descripcion: string | null;
  tercero: string | null;
  terceroNit: string | null;
  valor: number;
  /** Origen del pago tal como lo escribe la empresa: CORRIENTE, AHORROS, EFECTIVO… */
  cuenta: string | null;
  relacion: string | null;
  aplicacion: string | null;
  observaciones: string | null;
  referencia: string | null;
};

/** Vencimiento de una cuenta por pagar en Siigo. */
export type CuentaPorPagar = {
  prefix: string;
  consecutive: number;
  quote: number;
  dueDate: string | null;
  balance: number;
  providerNit: string | null;
  providerName: string | null;
  /** Factura del proveedor ("FE-7003"), si se conoce. */
  facturaProveedor: string | null;
};

export type ItemPago = {
  prefix: string;
  consecutive: number;
  quote: number;
  valor: number;
  factura: string | null;
  saldo: number;
};
export type CuentaDetallada = {
  code: string;
  movimiento: "Debit" | "Credit";
  valor: number;
  descripcion: string;
};

export type Propuesta = {
  tipo: TipoEgreso;
  terceroNit: string | null;
  terceroNombre: string | null;
  items: ItemPago[];
  cuentas: CuentaDetallada[];
  /** Forma de pago de Siigo (pago de facturas y anticipos) y cuenta de banco/caja (detallado). */
  paymentTypeId: string | null;
  cuentaBanco: string | null;
  listo: boolean;
  motivos: string[];
  notas: string[];
};

export type ReglaBanco = {
  patron: string;
  cuenta_banco: string | null;
  payment_type_id: string | null;
};
export type ReglaConcepto = {
  patron: string;
  tipo: string | null;
  cuenta_debito: string | null;
  tercero_nit: string | null;
};

export type Tercero = { nit: string; nombre: string };

// ---------------------------------------------------------------------------
// Texto y montos
// ---------------------------------------------------------------------------
const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const normalizar = (s: string | null | undefined) =>
  sinTildes(String(s ?? ""))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const soloDigitos = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");

/** NIT sin dígito de verificación ("900.470.166-4" → "900470166"). */
export function nitSinDv(nit: string | null | undefined): string {
  const t = String(nit ?? "").trim();
  const m = /^(.*\d)\s*-\s*\d\s*$/.exec(t);
  return soloDigitos(m ? m[1] : t);
}

/**
 * Monto escrito a mano: "$ 1,076,889.89", "$13.000,37", "$11.600", "392725".
 * El último separador seguido de 1 o 2 dígitos es el decimal; los demás son de miles.
 */
export function parseMonto(texto: string | null | undefined): number | null {
  const t = String(texto ?? "").replace(/[^\d.,-]/g, "");
  if (!/\d/.test(t)) return null;
  const neg = t.startsWith("-");
  const limpio = t.replace(/-/g, "");
  const m = /^(.*?)([.,])(\d{1,2})$/.exec(limpio);
  const n = m
    ? Number(`${m[1]!.replace(/[.,]/g, "")}.${m[3]}`)
    : Number(limpio.replace(/[.,]/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// ---------------------------------------------------------------------------
// Referencias de factura en el texto ("FE 7003\nFE 7009", "RR-8524, RR-8527 y RR-8546")
// ---------------------------------------------------------------------------
export type RefFactura = { texto: string; prefijo: string; numero: string };

/** Pagos que la empresa marca expresamente sin factura ("N/F", "No tiene factura"). */
export const esSinFactura = (s: string | null | undefined) =>
  /(^|\s)N\s*\/\s*F(\s|$|-)|SIN FACTURA|NO TIENE FACTURA/i.test(String(s ?? ""));

export function refFactura(texto: string): RefFactura | null {
  const t = sinTildes(texto)
    .toUpperCase()
    .replace(/FACT(URA)?\.?|NO\.|N°|#/g, " ")
    .trim();
  // Prefijo (letras y dígitos que empiezan por letra) + número; o solo número largo.
  const m =
    /^([A-Z][A-Z0-9]*?)\s*-?\s*(\d{2,})$/.exec(
      t
        .replace(/\s*-\s*/g, "-")
        .replace(/\s+/g, " ")
        .replace(/-(?=\d+$)/, " ")
        .trim(),
    ) ?? /^([A-Z][A-Z0-9]*)\s+(\d{2,})$/.exec(t);
  if (m)
    return {
      texto: texto.trim(),
      prefijo: m[1]!.replace(/[^A-Z0-9]/g, ""),
      numero: m[2]!.replace(/^0+(?=\d)/, ""),
    };
  const solo = /^(\d{3,})$/.exec(t.replace(/\s+/g, ""));
  return solo
    ? { texto: texto.trim(), prefijo: "", numero: solo[1]!.replace(/^0+(?=\d)/, "") }
    : null;
}

/** Facturas citadas en la relación del pago. */
export function referenciasFactura(texto: string | null | undefined): RefFactura[] {
  const t = String(texto ?? "");
  if (!t.trim() || esSinFactura(t)) return [];
  const piezas = t
    .split(/\r?\n|,|;|\s+[yY]\s+|\s+-\s+(?=[A-Za-z]{1,6}\s*-?\s*\d)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: RefFactura[] = [];
  for (const p of piezas) {
    const r = refFactura(p);
    if (r && !out.some((o) => o.prefijo === r.prefijo && o.numero === r.numero)) out.push(r);
  }
  return out;
}

/** "FE-7003" / {prefix:"FE", number:"7003"} → referencia normalizada. */
export function refDeFacturaProveedor(f: string | null | undefined): RefFactura | null {
  const t = String(f ?? "").trim();
  if (!t) return null;
  return refFactura(t);
}

export function mismaFactura(a: RefFactura, b: RefFactura): boolean {
  if (a.numero !== b.numero) return false;
  if (!a.prefijo || !b.prefijo) return true;
  return (
    a.prefijo === b.prefijo || a.prefijo.startsWith(b.prefijo) || b.prefijo.startsWith(a.prefijo)
  );
}

/** Valor de cada factura escrito en las observaciones ("FE 7003 $ 392,725.00"). */
export function montosPorFactura(
  observaciones: string | null | undefined,
  refs: RefFactura[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const linea of String(observaciones ?? "").split(/\r?\n/)) {
    const m = /\$\s*([\d.,]+)/.exec(linea);
    if (!m) continue;
    const valor = parseMonto(m[1]);
    if (valor == null) continue;
    const antes = linea.slice(0, m.index);
    const r = refs.find((x) => {
      const enLinea = refFactura(antes.replace(/[-–:]+\s*$/, "").trim());
      return enLinea ? mismaFactura(enLinea, x) : soloDigitos(antes).endsWith(x.numero);
    });
    if (r) out.set(`${r.prefijo}|${r.numero}`, valor);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terceros por nombre
// ---------------------------------------------------------------------------
const PALABRAS_VACIAS = new Set([
  "SAS",
  "S",
  "A",
  "LTDA",
  "SA",
  "DE",
  "LA",
  "EL",
  "Y",
  "CIA",
  "E",
  "S A S",
  "BIC",
  "ZOMAC",
]);
const palabrasNombre = (s: string) =>
  normalizar(s)
    .split(" ")
    .filter((p) => p.length > 1 && !PALABRAS_VACIAS.has(p));

/** NIT del tercero por su nombre: coincidencia exacta o todas las palabras del nombre corto en el largo (única). */
export function nitPorNombre(
  nombre: string | null | undefined,
  terceros: Tercero[],
): string | null {
  const n = normalizar(nombre);
  if (!n) return null;
  const exactos = [
    ...new Set(terceros.filter((t) => normalizar(t.nombre) === n).map((t) => nitSinDv(t.nit))),
  ];
  if (exactos.length === 1) return exactos[0]!;
  const p = palabrasNombre(n);
  if (p.length < 2 && !(p.length === 1 && p[0]!.length >= 6)) return null;
  const candidatos = [
    ...new Set(
      terceros
        .filter((t) => {
          const q = palabrasNombre(t.nombre);
          if (!q.length) return false;
          const [corto, largo] = p.length <= q.length ? [p, q] : [q, p];
          return corto.length >= Math.min(2, largo.length) && corto.every((w) => largo.includes(w));
        })
        .map((t) => nitSinDv(t.nit)),
    ),
  ];
  return candidatos.length === 1 ? candidatos[0]! : null;
}

// ---------------------------------------------------------------------------
// Conceptos sin factura (RP detallado)
// ---------------------------------------------------------------------------
export type Concepto = { id: string; etiqueta: string; prueba: RegExp };

/** Conceptos frecuentes de egresos sin factura (se reconocen en la relación o la descripción). */
export const CONCEPTOS: Concepto[] = [
  { id: "4x1000", etiqueta: "Gravamen 4x1000", prueba: /4\s*X\s*1000|GRAVAMEN|GMF|IMPTO GOBIERNO/ },
  {
    id: "iva_bancario",
    etiqueta: "IVA de gastos bancarios",
    prueba: /IVA BANCARIO|^IVA CUOTA|COBRO IVA/,
  },
  {
    id: "gasto_bancario",
    etiqueta: "Gasto bancario",
    prueba:
      /GTO\.? BANCARIO|GASTO BANCARIO|CUOTA PLAN|COMISION|SERVICIO PAGO A PROVEEDORES|CUOTA MANEJO/,
  },
  { id: "nomina", etiqueta: "Nómina", prueba: /^NOM\b|NOMINA|PAGO DE NOMI|LIQUIDACION/ },
  {
    id: "seguridad_social",
    etiqueta: "Seguridad social",
    prueba: /^SS\b|SEGURIDAD SOCIAL|PILA|APORTES/,
  },
  {
    id: "impuestos",
    etiqueta: "Impuestos",
    prueba: /\bDIAN\b|RTE\.? ?FTE|RETENCION|IMPUESTO|INDUSTRIA Y COMERCIO|PREDIAL/,
  },
  {
    id: "tarjeta_credito",
    etiqueta: "Tarjeta de crédito",
    prueba: /^TC\b|TARJETA DE CREDITO|PAGO TC/,
  },
  { id: "cuenta_cobro", etiqueta: "Cuenta de cobro", prueba: /CTA\.? COBRO|CUENTA DE COBRO/ },
  { id: "prestamo", etiqueta: "Préstamo", prueba: /PRESTAMO|CREDITO/ },
];

export function conceptoDe(
  m: Pick<MovimientoPago, "relacion" | "descripcion" | "aplicacion">,
): Concepto | null {
  const textos = [m.relacion, m.aplicacion, m.descripcion].map((t) =>
    normalizar(t).replace(/ X /g, "X"),
  );
  for (const t of textos) {
    if (!t) continue;
    const c = CONCEPTOS.find((k) => k.prueba.test(t) || k.prueba.test(normalizar(t)));
    if (c) return c;
  }
  return null;
}

/** Patrón con que se guarda y reconoce una regla de concepto aprendida. */
export function patronConcepto(m: Pick<MovimientoPago, "relacion" | "descripcion">): string {
  const c = conceptoDe({ ...m, aplicacion: null });
  if (c) return `concepto:${c.id}`;
  // Relación escrita como categoría («LIGIA», «IVAN», «COSTO»): se aprende tal cual.
  const rel = normalizar(m.relacion);
  if (
    rel &&
    rel.length <= 30 &&
    !referenciasFactura(m.relacion).length &&
    !esSinFactura(m.relacion) &&
    rel !== "OK"
  )
    return `relacion:${rel}`;
  const d = normalizar(m.descripcion)
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
  return `descripcion:${d}`;
}

// ---------------------------------------------------------------------------
// Precedente del auxiliar (egresos CE / RP ya registrados en Siigo)
// ---------------------------------------------------------------------------
export type MovAux = {
  voucher: string | null;
  account_code: string | null;
  account_name?: string | null;
  provider_nit: string | null;
  provider_name?: string | null;
  description: string | null;
  detail?: string | null;
  debit: number | null;
  credit: number | null;
};

export type PrecedenteEgresos = {
  /** NIT del tercero → cuenta débito (no CxP) → veces. */
  porTercero: Map<string, Map<string, number>>;
  /** Concepto → cuenta débito → veces. */
  porConcepto: Map<string, Map<string, number>>;
  /** Concepto → NIT del tercero → veces (p. ej. el banco de los gastos bancarios). */
  terceroPorConcepto: Map<string, Map<string, number>>;
  /** Cuentas de caja y bancos usadas en egresos → veces. */
  bancos: Map<string, { nombre: string | null; veces: number }>;
  comprobantes: number;
};

export const esComprobanteEgreso = (v: string | null | undefined) =>
  /^(CE|RP)-/i.test(String(v ?? "").trim());
const esCajaBanco = (c: string) => /^11(05|10|20)/.test(c);
const esCxP = (c: string) => /^(22|2335|2380)/.test(c);

const sumar = <K>(m: Map<K, Map<string, number>>, k: K, c: string) => {
  const x = m.get(k) ?? new Map<string, number>();
  x.set(c, (x.get(c) ?? 0) + 1);
  m.set(k, x);
};

export function aprenderEgresos(movs: MovAux[]): PrecedenteEgresos {
  const porComp = new Map<string, MovAux[]>();
  for (const m of movs) {
    if (!esComprobanteEgreso(m.voucher)) continue;
    const k = String(m.voucher).trim().toUpperCase();
    porComp.set(k, [...(porComp.get(k) ?? []), m]);
  }
  const out: PrecedenteEgresos = {
    porTercero: new Map(),
    porConcepto: new Map(),
    terceroPorConcepto: new Map(),
    bancos: new Map(),
    comprobantes: porComp.size,
  };
  for (const lineas of porComp.values()) {
    for (const l of lineas) {
      const c = String(l.account_code ?? "").trim();
      if (!c) continue;
      if (esCajaBanco(c) && Number(l.credit ?? 0) > 0) {
        const b = out.bancos.get(c) ?? { nombre: l.account_name ?? null, veces: 0 };
        b.veces += 1;
        out.bancos.set(c, b);
        continue;
      }
      if (!(Number(l.debit ?? 0) > 0) || esCxP(c) || esCajaBanco(c)) continue;
      const nit = nitSinDv(l.provider_nit);
      if (nit) sumar(out.porTercero, nit, c);
      const concepto = conceptoDe({
        relacion: null,
        aplicacion: null,
        descripcion: `${l.description ?? ""} ${l.detail ?? ""}`,
      });
      if (concepto) {
        sumar(out.porConcepto, concepto.id, c);
        if (nit) sumar(out.terceroPorConcepto, concepto.id, nit);
      }
    }
  }
  return out;
}

const masUsada = (m: Map<string, number> | undefined): string | null => {
  if (!m?.size) return null;
  const orden = [...m].sort((a, b) => b[1] - a[1]);
  // Solo si es claramente la más usada (≥ 2/3 de los usos).
  const total = orden.reduce((s, [, n]) => s + n, 0);
  return orden[0]![1] / total >= 2 / 3 ? orden[0]![0] : null;
};

// ---------------------------------------------------------------------------
// Propuesta de cada pago
// ---------------------------------------------------------------------------
export type Contexto = {
  cxp: CuentaPorPagar[];
  /** Facturas ya causadas en Siigo (para reconocer las pagadas de contado, sin saldo). */
  causadas?: Array<{ factura: string; nit: string | null; siigo: string | null }>;
  terceros: Tercero[];
  bancos: ReglaBanco[];
  conceptos: ReglaConcepto[];
  precedente: PrecedenteEgresos | null;
  /** Cuentas del PUC que existen (para validar las elegidas). */
  puc?: Set<string>;
};

const TOLERANCIA = 1; // peso

export function reglaBanco(
  cuenta: string | null | undefined,
  bancos: ReglaBanco[],
): ReglaBanco | null {
  const k = normalizar(cuenta);
  return bancos.find((b) => normalizar(b.patron) === k) ?? null;
}

export function proponerEgreso(m: MovimientoPago, ctx: Contexto): Propuesta {
  const motivos: string[] = [];
  const notas: string[] = [];
  const valor = roundCOP(m.valor);
  const banco = reglaBanco(m.cuenta, ctx.bancos);
  let terceroNit = nitSinDv(m.terceroNit) || null;
  if (!terceroNit) {
    const ref = soloDigitos(m.referencia);
    if (ref.length >= 6 && ref.length <= 10 && ctx.terceros.some((t) => nitSinDv(t.nit) === ref))
      terceroNit = ref;
  }
  if (!terceroNit)
    terceroNit = nitPorNombre(m.tercero, [
      ...ctx.terceros,
      ...ctx.cxp
        .filter((c) => c.providerNit && c.providerName)
        .map((c) => ({ nit: c.providerNit!, nombre: c.providerName! })),
    ]);
  const base = (tipo: TipoEgreso): Propuesta => ({
    tipo,
    terceroNit,
    terceroNombre: m.tercero,
    items: [],
    cuentas: [],
    paymentTypeId: banco?.payment_type_id ?? null,
    cuentaBanco: banco?.cuenta_banco ?? null,
    listo: false,
    motivos,
    notas,
  });

  // 1. Regla enseñada por la usuaria para este concepto.
  const patron = patronConcepto(m);
  const regla = ctx.conceptos.find((r) => r.patron === patron);
  if (regla?.tipo === "omitir") {
    notas.push("No genera recibo de pago (regla aprendida).");
    return { ...base("omitir"), listo: true };
  }

  const texto = [m.relacion, m.aplicacion].filter(Boolean).join(" ");
  const refs = referenciasFactura(m.relacion);
  const concepto = conceptoDe(m);
  const esAnticipo = /ANTICIPO/.test(normalizar(texto));

  // 2. Pago de facturas causadas (abono a deuda).
  if (refs.length && !esAnticipo && regla?.tipo !== "detallado") {
    const p = base("pago_facturas");
    const delTercero = (c: CuentaPorPagar) => !terceroNit || nitSinDv(c.providerNit) === terceroNit;
    const montos = montosPorFactura(m.observaciones, refs);
    const encontradas: Array<{ ref: RefFactura; cxp: CuentaPorPagar }> = [];
    const sinSaldo: string[] = [];
    for (const r of refs) {
      const candidatas = ctx.cxp.filter((c) => {
        const f = refDeFacturaProveedor(c.facturaProveedor);
        return f && mismaFactura(f, r) && delTercero(c) && c.balance > 0;
      });
      if (candidatas.length === 1) encontradas.push({ ref: r, cxp: candidatas[0]! });
      else if (candidatas.length > 1)
        motivos.push(
          `La factura ${r.texto} coincide con ${candidatas.length} cuentas por pagar; elige la correcta.`,
        );
      else {
        const causada = (ctx.causadas ?? []).find((c) => {
          const f = refDeFacturaProveedor(c.factura);
          return f && mismaFactura(f, r) && (!terceroNit || nitSinDv(c.nit) === terceroNit);
        });
        if (causada) sinSaldo.push(`${r.texto}${causada.siigo ? ` (${causada.siigo})` : ""}`);
        else
          motivos.push(
            `La factura ${r.texto} no está en las cuentas por pagar de Siigo (¿no está causada o es de otro proveedor?).`,
          );
      }
    }
    // Todas causadas y sin saldo: se pagaron en la misma compra (contado); no se hace RP.
    if (!encontradas.length && sinSaldo.length === refs.length) {
      const o = base("omitir");
      motivos.push(
        `${sinSaldo.join(", ")} ya está causada en Siigo sin saldo por pagar (pagada de contado o ya pagada): confirma que no lleva recibo de pago.`,
      );
      return o;
    }
    if (sinSaldo.length)
      motivos.push(`${sinSaldo.join(", ")} está causada en Siigo sin saldo por pagar.`);
    if (!terceroNit && encontradas.length) {
      const nits = [...new Set(encontradas.map((e) => nitSinDv(e.cxp.providerNit)))];
      if (nits.length === 1) p.terceroNit = nits[0]!;
    }
    if (encontradas.length) {
      // Valor de cada factura: el escrito en observaciones; si no, el saldo (y la última recibe el resto).
      let restante = valor;
      const orden = [...encontradas].sort((a, b) =>
        String(a.cxp.dueDate ?? "").localeCompare(String(b.cxp.dueDate ?? "")),
      );
      for (const [i, e] of orden.entries()) {
        const escrito = montos.get(`${e.ref.prefijo}|${e.ref.numero}`);
        const ultimo = i === orden.length - 1;
        const v = roundCOP(escrito ?? (ultimo ? restante : Math.min(e.cxp.balance, restante)));
        restante = roundCOP(restante - v);
        p.items.push({
          prefix: e.cxp.prefix,
          consecutive: e.cxp.consecutive,
          quote: e.cxp.quote,
          valor: v,
          factura: e.ref.texto,
          saldo: e.cxp.balance,
        });
        if (v > e.cxp.balance + TOLERANCIA)
          motivos.push(
            `A ${e.ref.texto} se le aplicarían $${v.toLocaleString("es-CO")} y su saldo en Siigo es $${e.cxp.balance.toLocaleString("es-CO")}.`,
          );
        else if (v < e.cxp.balance - TOLERANCIA)
          notas.push(
            `${e.ref.texto}: abono de $${v.toLocaleString("es-CO")} (saldo $${e.cxp.balance.toLocaleString("es-CO")}).`,
          );
      }
      let suma = roundCOP(p.items.reduce((s, x) => s + x.valor, 0));
      // Centavos escritos en las observaciones (p. ej. 208.757,60 + 41.669 = 250.426,60 y el
      // banco pagó 250.427): la diferencia de hasta $1 se lleva a la factura de mayor valor.
      const dif = roundCOP(valor - suma);
      if (dif !== 0 && Math.abs(dif) <= TOLERANCIA && p.items.length) {
        const mayor = p.items.reduce((a, b) => (b.valor > a.valor ? b : a));
        if (mayor.valor + dif <= mayor.saldo + 0.009) {
          mayor.valor = roundCOP(mayor.valor + dif);
          suma = valor;
          notas.push(
            `Ajuste de ${dif.toLocaleString("es-CO")} pesos por centavos en ${mayor.factura ?? "la factura"}.`,
          );
        }
      }
      if (Math.abs(suma - valor) > 0.009)
        motivos.push(
          `Las facturas suman $${suma.toLocaleString("es-CO")} y el pago es $${valor.toLocaleString("es-CO")}${m.aplicacion ? ` (${m.aplicacion})` : ""}.`,
        );
      if (p.items.some((x) => x.valor <= 0))
        motivos.push("Una factura quedaría con valor 0 o negativo.");
    }
    if (!p.paymentTypeId)
      motivos.push(`Falta la forma de pago de Siigo para «${m.cuenta ?? "sin origen"}».`);
    if (!p.terceroNit)
      motivos.push(`No se identificó el NIT de «${m.tercero ?? m.descripcion ?? ""}».`);
    p.listo = motivos.length === 0 && p.items.length > 0;
    return p;
  }

  // 3. Anticipo (sin factura todavía).
  if (esAnticipo || regla?.tipo === "anticipo") {
    const p = base("anticipo");
    if (!p.terceroNit)
      motivos.push(`No se identificó el NIT de «${m.tercero ?? m.descripcion ?? ""}».`);
    if (!p.paymentTypeId)
      motivos.push(`Falta la forma de pago de Siigo para «${m.cuenta ?? "sin origen"}».`);
    p.listo = motivos.length === 0;
    return p;
  }

  // 4. Detallado (concepto sin factura): débito a la cuenta del concepto, crédito al banco.
  const p = base("detallado");
  const precedente = ctx.precedente;
  let cuenta = regla?.cuenta_debito ?? null;
  if (!cuenta && concepto) cuenta = masUsada(precedente?.porConcepto.get(concepto.id));
  if (!cuenta && p.terceroNit) cuenta = masUsada(precedente?.porTercero.get(p.terceroNit));
  // El tercero aprendido para el concepto (p. ej. el banco de los gastos bancarios) solo se usa
  // cuando el pago no trae su propio tercero (en nómina cada pago es de un empleado distinto).
  if (!p.terceroNit && !m.tercero)
    p.terceroNit =
      regla?.tercero_nit ??
      (concepto ? masUsada(precedente?.terceroPorConcepto.get(concepto.id)) : null);
  if (esSinFactura(m.relacion))
    motivos.push(
      "Pago sin factura (N/F): confirma la cuenta del gasto o si la factura llegará después.",
    );
  if (/VALIDA[RD]/.test(normalizar(m.relacion)))
    motivos.push(`La relación dice «${m.relacion}»: confirma la factura antes de enviar.`);
  if (!cuenta)
    motivos.push(
      `Falta la cuenta débito${concepto ? ` de «${concepto.etiqueta}»` : ""}: elígela una vez y la herramienta la recordará.`,
    );
  else if (ctx.puc && !ctx.puc.has(cuenta))
    motivos.push(`La cuenta ${cuenta} no está en el PUC sincronizado.`);
  if (!p.cuentaBanco)
    motivos.push(`Falta la cuenta de banco/caja de «${m.cuenta ?? "sin origen"}».`);
  if (!p.terceroNit)
    motivos.push(`Falta el tercero del pago${m.tercero ? ` «${m.tercero}»` : ""}.`);
  if (cuenta && p.cuentaBanco) {
    const desc = String(m.descripcion ?? concepto?.etiqueta ?? "Egreso").slice(0, 100);
    p.cuentas = [
      { code: cuenta, movimiento: "Debit", valor, descripcion: desc },
      { code: p.cuentaBanco, movimiento: "Credit", valor, descripcion: desc },
    ];
  }
  if (concepto) notas.push(`Concepto: ${concepto.etiqueta}.`);
  p.listo = motivos.length === 0 && p.cuentas.length === 2;
  return p;
}

// ---------------------------------------------------------------------------
// Payload del recibo de pago/egreso para Siigo (POST /v1/payment-receipts)
// ---------------------------------------------------------------------------
export function payloadRecibo(
  m: Pick<MovimientoPago, "fecha" | "descripcion" | "relacion" | "valor">,
  p: Propuesta,
  documentId: number,
): Record<string, unknown> {
  const valor = roundCOP(m.valor);
  const observaciones = [m.descripcion, m.relacion]
    .filter(Boolean)
    .join(" · ")
    .replace(/\s+/g, " ")
    .slice(0, 250);
  const supplier = { identification: String(p.terceroNit ?? ""), branch_office: 0 };
  if (p.tipo === "pago_facturas")
    return {
      document: { id: documentId },
      date: m.fecha,
      type: "DebtPayment",
      supplier,
      items: p.items.map((i) => ({
        due: { prefix: i.prefix, consecutive: i.consecutive, quote: i.quote },
        value: roundCOP(i.valor),
      })),
      payment: { id: Number(p.paymentTypeId), value: valor },
      observations: observaciones,
    };
  if (p.tipo === "anticipo")
    return {
      document: { id: documentId },
      date: m.fecha,
      type: "AdvancePayment",
      supplier,
      payment: { id: Number(p.paymentTypeId), value: valor },
      observations: observaciones,
    };
  if (p.tipo === "detallado")
    return {
      document: { id: documentId },
      date: m.fecha,
      type: "Detailed",
      supplier,
      items: p.cuentas.map((c) => ({
        account: { code: c.code, movement: c.movimiento },
        description: c.descripcion,
        value: roundCOP(c.valor),
      })),
      observations: observaciones,
    };
  throw new Error("Este egreso no genera recibo de pago en Siigo.");
}

/** Validaciones antes de enviar (además de `listo`). */
export function erroresAntesDeEnviar(
  m: Pick<MovimientoPago, "valor" | "fecha">,
  p: Propuesta,
): string[] {
  const e: string[] = [];
  const valor = roundCOP(m.valor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.fecha)) e.push("Fecha inválida.");
  if (!p.terceroNit) e.push("Falta el NIT del tercero.");
  if (p.tipo === "pago_facturas") {
    if (!p.items.length) e.push("No hay facturas a las que aplicar el pago.");
    const suma = roundCOP(p.items.reduce((s, i) => s + i.valor, 0));
    if (Math.abs(suma - valor) > 0.009)
      e.push(
        `Las facturas suman $${suma.toLocaleString("es-CO")} y el pago es $${valor.toLocaleString("es-CO")}.`,
      );
    for (const i of p.items)
      if (i.valor > i.saldo + 0.009)
        e.push(
          `${i.factura ?? `${i.prefix}-${i.consecutive}`}: el valor supera el saldo en Siigo.`,
        );
  }
  if ((p.tipo === "pago_facturas" || p.tipo === "anticipo") && !p.paymentTypeId)
    e.push("Falta la forma de pago de Siigo.");
  if (p.tipo === "detallado") {
    const d = roundCOP(
      p.cuentas.filter((c) => c.movimiento === "Debit").reduce((s, c) => s + c.valor, 0),
    );
    const c = roundCOP(
      p.cuentas.filter((x) => x.movimiento === "Credit").reduce((s, x) => s + x.valor, 0),
    );
    if (!p.cuentas.length) e.push("Faltan las cuentas del recibo detallado.");
    if (Math.abs(d - c) > 0.009 || Math.abs(d - valor) > 0.009)
      e.push("Débitos y créditos no cuadran con el valor del pago.");
  }
  if (p.tipo === "omitir" || p.tipo === "por_definir")
    e.push("Este egreso no genera recibo de pago.");
  return e;
}
