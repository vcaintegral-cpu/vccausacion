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
  /** Identificador de la compra en Siigo a la que corresponde el vencimiento. */
  siigoPurchaseId?: string | null;
};

export type ItemPago = {
  prefix: string;
  consecutive: number;
  quote: number;
  valor: number;
  factura: string | null;
  saldo: number;
  /** Fecha de vencimiento de la CxP (yyyy-MM-dd): Siigo la exige al cruzarla en un RP detallado. */
  vence?: string | null;
  /** El vencimiento ya no está en las CxP sincronizadas de Siigo (pagado o reidentificado). */
  noVigente?: boolean;
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
  /**
   * Grupo de envío: los gastos bancarios (comisiones, IVA bancario, 4x1000) de cada cuenta
   * bancaria se envían juntos en un solo RP por mes ("bancario|CORRIENTE").
   */
  grupo?: string | null;
  /**
   * Ajuste al peso del recibo: valor > 0 = débito (se pagó de más), < 0 = crédito (se pagó
   * de menos). Pago = suma de las facturas + ajuste. Con ajuste, el RP va detallado.
   */
  ajuste?: { valor: number; cuenta: string } | null;
  /** Parte del pago que excede las facturas: anticipo al proveedor (débito, cuenta 1330…). */
  anticipo?: { valor: number; cuenta: string } | null;
  /** Líneas adicionales escritas por la usuaria en un pago de facturas (otras cuentas y valores). */
  lineas?: CuentaDetallada[] | null;
  /** Cuenta por pagar que se cruza en el RP detallado (p. ej. 22050501). */
  cuentaCxp?: string | null;
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
  // La misma factura escrita con el guion en otra posición («A520-1365004» = «A-5201365004»).
  if (a.prefijo + a.numero === b.prefijo + b.numero) return true;
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

/** Conceptos que se agrupan en un solo RP mensual por cuenta bancaria. */
export const CONCEPTOS_BANCARIOS = new Set(["gasto_bancario", "iva_bancario", "4x1000"]);

/** Grupo del RP mensual de gastos bancarios de una cuenta («bancario|CORRIENTE»). */
export function grupoBancario(
  conceptoId: string | null,
  cuenta: string | null | undefined,
): string | null {
  const c = normalizar(cuenta);
  return conceptoId && CONCEPTOS_BANCARIOS.has(conceptoId) && c && !/EFECTIVO|CAJA/.test(c)
    ? `bancario|${c}`
    : null;
}

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
  causadas?: Array<{
    factura: string;
    nit: string | null;
    siigo: string | null;
    siigoId?: string | null;
  }>;
  terceros: Tercero[];
  bancos: ReglaBanco[];
  conceptos: ReglaConcepto[];
  precedente: PrecedenteEgresos | null;
  /** Cuentas del PUC que existen (para validar las elegidas). */
  puc?: Set<string>;
  /** Cuentas del ajuste al peso del recibo y CxP cruzada; tope del ajuste automático. */
  ajustes?: AjustesRecibo;
  /** Cuentas auxiliares de caja y bancos (1105/1110/1120) con su nombre. */
  cuentasBanco?: Array<{ code: string; name: string }>;
};

/** Palabras con que se reconoce la cuenta de cada origen de pago («AHORROS» → AHORRO). */
const palabrasOrigen = (etiqueta: string) => {
  const n = normalizar(etiqueta);
  if (/EFECTIVO|CAJA/.test(n)) return ["CAJA", "EFECTIVO"];
  return n
    .split(" ")
    .filter((w) => w.length >= 4)
    .map((w) => w.replace(/S$/, ""));
};

/**
 * Cuenta de banco/caja de un origen de pago cuando la forma de pago de Siigo no la trae:
 * la única cuenta auxiliar de caja/bancos cuyo nombre contiene el origen (CORRIENTE,
 * AHORRO, DAVIVIENDA, CAJA). Si hay varias, se prefieren las usadas en egresos del auxiliar.
 */
export function cuentaBancoDeOrigen(
  etiqueta: string | null | undefined,
  cuentas: Array<{ code: string; name: string }>,
  usadas?: Map<string, unknown>,
): string | null {
  if (!etiqueta) return null;
  const palabras = palabrasOrigen(etiqueta);
  if (!palabras.length) return null;
  const codigos = new Set(cuentas.map((c) => c.code));
  const hojas = cuentas.filter(
    (c) =>
      /^11(05|10|20)/.test(c.code) &&
      ![...codigos].some((o) => o !== c.code && o.startsWith(c.code)),
  );
  const candidatas = hojas.filter((c) => palabras.some((w) => normalizar(c.name).includes(w)));
  if (candidatas.length === 1) return candidatas[0]!.code;
  const enUso = candidatas.filter((c) => usadas?.has(c.code));
  return enUso.length === 1 ? enUso[0]!.code : null;
}

const TOLERANCIA = 1; // peso

export type AjustesRecibo = {
  debito: string | null;
  credito: string | null;
  cxp: string | null;
  tope: number;
  /** Cuenta de anticipos a proveedores (1330…) para el excedente del pago. */
  anticipo?: string | null;
};

/**
 * Diferencia entre el pago y las facturas elegidas: hasta el tope es ajuste al peso; si se
 * pagó MÁS por encima del tope, el excedente es un anticipo al proveedor.
 */
export function diferenciaDelPago(
  pago: number,
  sumaFacturas: number,
  cuentas: AjustesRecibo | undefined,
): {
  ajuste: { valor: number; cuenta: string } | null;
  anticipo: { valor: number; cuenta: string } | null;
  error: string | null;
} {
  const dif = roundCOP(roundCOP(pago) - roundCOP(sumaFacturas));
  const tope = cuentas?.tope ?? 1000;
  if (dif > tope) {
    if (!cuentas?.anticipo)
      return {
        ajuste: null,
        anticipo: null,
        error: "Falta la cuenta de anticipos a proveedores para el excedente del pago.",
      };
    return { ajuste: null, anticipo: { valor: dif, cuenta: cuentas.anticipo }, error: null };
  }
  const aj = ajusteAlPesoRecibo(pago, sumaFacturas, cuentas);
  if (!aj) return { ajuste: null, anticipo: null, error: null };
  return "valor" in aj
    ? { ajuste: aj, anticipo: null, error: null }
    : { ajuste: null, anticipo: null, error: aj.error };
}

/**
 * Ajuste al peso para que el recibo cuadre con el banco: pago − suma de facturas, dentro
 * del tope. Positivo = débito (se pagó de más, gasto); negativo = crédito (de menos, ingreso).
 */
export function ajusteAlPesoRecibo(
  pago: number,
  sumaFacturas: number,
  cuentas: AjustesRecibo | undefined,
): { valor: number; cuenta: string } | { error: string } | null {
  const dif = roundCOP(roundCOP(pago) - roundCOP(sumaFacturas));
  if (Math.abs(dif) < 0.01) return null;
  const tope = cuentas?.tope ?? 1000;
  if (Math.abs(dif) > tope)
    return {
      error: `La diferencia de ${Math.abs(dif).toLocaleString("es-CO")} supera el tope del ajuste al peso (${tope.toLocaleString("es-CO")}).`,
    };
  const cuenta = dif > 0 ? cuentas?.debito : cuentas?.credito;
  if (!cuenta)
    return {
      error: `Falta la cuenta de ajuste al peso ${dif > 0 ? "débito (gasto)" : "crédito (ingreso)"}.`,
    };
  return { valor: dif, cuenta };
}

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
    cuentaBanco:
      banco?.cuenta_banco ??
      cuentaBancoDeOrigen(m.cuenta, ctx.cuentasBanco ?? [], ctx.precedente?.bancos) ??
      null,
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
      let candidatas = ctx.cxp.filter((c) => {
        const f = refDeFacturaProveedor(c.facturaProveedor);
        return f && mismaFactura(f, r) && delTercero(c) && c.balance > 0;
      });
      // Respaldo: la compra causada en Siigo (FC-1-5712) se busca en las CxP por su número de
      // comprobante, aunque el vencimiento no tenga guardada la factura del proveedor.
      if (!candidatas.length) {
        const nombres = new Set(
          (ctx.causadas ?? [])
            .filter((c) => {
              const f = refDeFacturaProveedor(c.factura);
              return (
                f &&
                mismaFactura(f, r) &&
                (!terceroNit || nitSinDv(c.nit) === terceroNit) &&
                c.siigo
              );
            })
            .map((c) => String(c.siigo).trim().toUpperCase()),
        );
        const idsCompra = new Set(
          (ctx.causadas ?? [])
            .filter((c) => {
              const f = refDeFacturaProveedor(c.factura);
              return (
                f &&
                mismaFactura(f, r) &&
                (!terceroNit || nitSinDv(c.nit) === terceroNit) &&
                c.siigoId
              );
            })
            .map((c) => String(c.siigoId)),
        );
        candidatas = ctx.cxp.filter(
          (c) =>
            (nombres.has(`${c.prefix}-${c.consecutive}`.toUpperCase()) ||
              (!!c.siigoPurchaseId && idsCompra.has(c.siigoPurchaseId))) &&
            c.balance > 0,
        );
      }
      if (candidatas.length === 1) encontradas.push({ ref: r, cxp: candidatas[0]! });
      else if (candidatas.length > 1)
        motivos.push(
          `La factura ${r.texto} coincide con ${candidatas.length} cuentas por pagar; elige la correcta.`,
        );
      else {
        // Sin CxP leídas de Siigo no se puede afirmar que una factura no tiene saldo.
        const causada = !ctx.cxp.length
          ? null
          : (ctx.causadas ?? []).find((c) => {
              const f = refDeFacturaProveedor(c.factura);
              return f && mismaFactura(f, r) && (!terceroNit || nitSinDv(c.nit) === terceroNit);
            });
        if (causada) {
          // Qué trae el reporte de CxP de Siigo para esa compra (diagnóstico para la usuaria).
          const nombre = String(causada.siigo ?? "").toUpperCase();
          const enCxp = nombre
            ? ctx.cxp.filter(
                (c) =>
                  `${c.prefix}-${c.consecutive}`.toUpperCase() === nombre ||
                  (!!causada.siigoId && c.siigoPurchaseId === causada.siigoId),
              )
            : [];
          const detalle = !nombre
            ? ""
            : enCxp.length
              ? `; en el reporte de CxP de Siigo aparece con saldo ${enCxp.map((c) => c.balance.toLocaleString("es-CO")).join(" / ")} y NIT ${enCxp[0]!.providerNit ?? "—"}`
              : "; Siigo no la reporta con saldo por pagar (ni en el reporte de CxP ni en el saldo de la compra)";
          sinSaldo.push(`${r.texto}${causada.siigo ? ` (${causada.siigo}${detalle})` : ""}`);
        } else if (!ctx.cxp.length)
          motivos.push(
            "Aún no se han leído las cuentas por pagar de Siigo: usa «Sincronizar CxP de Siigo».",
          );
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
          vence: e.cxp.dueDate,
        });
        const declaradoAbono = /ABONO|PARCIAL/.test(
          normalizar([m.aplicacion, m.observaciones].join(" ")),
        );
        if (v > e.cxp.balance + TOLERANCIA)
          motivos.push(
            `Diferencia con la CxP: a ${e.ref.texto} se le pagaron $${v.toLocaleString("es-CO")} y su saldo en Siigo es $${e.cxp.balance.toLocaleString("es-CO")} (¿retención causada que el pago no descontó?). Usa «Analizar diferencia».`,
          );
        else if (v < e.cxp.balance - TOLERANCIA && !declaradoAbono)
          motivos.push(
            `Diferencia con la CxP: a ${e.ref.texto} se le pagaron $${v.toLocaleString("es-CO")} y su saldo en Siigo es $${e.cxp.balance.toLocaleString("es-CO")} (¿retención no causada, descuento o abono?). Usa «Analizar diferencia» o escribe «abono» en la aplicación.`,
          );
        else if (v < e.cxp.balance - TOLERANCIA)
          notas.push(
            `${e.ref.texto}: abono de $${v.toLocaleString("es-CO")} (saldo $${e.cxp.balance.toLocaleString("es-CO")}).`,
          );
      }
      let suma = roundCOP(p.items.reduce((s, x) => s + x.valor, 0));
      // Diferencia con el banco (centavos de las observaciones, redondeos): ajuste al peso
      // dentro del tope, débito si se pagó de más y crédito si se pagó de menos.
      const aj = ajusteAlPesoRecibo(valor, suma, ctx.ajustes);
      if (aj && "valor" in aj && !(aj.valor < 0 && !p.items.length)) {
        if (!ctx.ajustes?.cxp)
          motivos.push("Falta la cuenta por pagar que se cruza en el recibo con ajuste al peso.");
        p.ajuste = aj;
        p.cuentaCxp = ctx.ajustes?.cxp ?? null;
        suma = valor;
        notas.push(
          `Ajuste al peso ${aj.valor > 0 ? "débito" : "crédito"} ${aj.cuenta}: ${Math.abs(aj.valor).toLocaleString("es-CO")} (el recibo va detallado).`,
        );
      } else if (aj && "error" in aj && Math.abs(valor - suma) <= TOLERANCIA && p.items.length) {
        // Sin cuentas de ajuste: los centavos (hasta $1) se llevan a la factura de mayor valor.
        const dif = roundCOP(valor - suma);
        const mayor = p.items.reduce((a, b) => (b.valor > a.valor ? b : a));
        if (mayor.valor + dif <= mayor.saldo + 0.009) {
          mayor.valor = roundCOP(mayor.valor + dif);
          suma = valor;
          notas.push(
            `Ajuste de ${dif.toLocaleString("es-CO")} pesos por centavos en ${mayor.factura ?? "la factura"}.`,
          );
        }
      } else if (aj && "error" in aj) motivos.push(aj.error);
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
  const grupo = grupoBancario(concepto?.id ?? null, m.cuenta);
  if (grupo) {
    p.grupo = grupo;
    notas.push(`Va en el RP único de gastos bancarios de ${normalizar(m.cuenta)} del mes.`);
  }
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
  /**
   * Referencia única y estable del pago (p. ej. el id del egreso). Dos pagos legítimos
   * idénticos (mismo tercero, valor, fecha y cuentas) no se confunden en Siigo
   * («duplicated_document»), y el reintento de un mismo pago sigue siendo idéntico.
   */
  referencia?: string | null,
): Record<string, unknown> {
  const valor = roundCOP(m.valor);
  const ref = referencia ? ` · Ref ${referencia}` : "";
  const observaciones =
    [m.descripcion, m.relacion]
      .filter(Boolean)
      .join(" · ")
      .replace(/\s+/g, " ")
      .slice(0, 250 - ref.length) + ref;
  const supplier = { identification: String(p.terceroNit ?? ""), branch_office: 0 };
  if (
    p.tipo === "pago_facturas" &&
    ((p.ajuste && Math.abs(p.ajuste.valor) >= 0.01) ||
      (p.anticipo && p.anticipo.valor >= 0.01) ||
      (p.lineas ?? []).length > 0)
  ) {
    // Con ajuste al peso: RP detallado. Débito a la CxP cruzando cada vencimiento (crédito si
    // es un saldo a favor), el ajuste y el crédito al banco por lo pagado.
    const items: Array<Record<string, unknown>> = p.items.map((i) => ({
      account: { code: String(p.cuentaCxp ?? ""), movement: i.valor >= 0 ? "Debit" : "Credit" },
      due: {
        prefix: i.prefix,
        consecutive: i.consecutive,
        quote: i.quote,
        ...(i.vence ? { date: String(i.vence).slice(0, 10) } : {}),
      },
      description: `Pago ${i.factura ?? `${i.prefix}-${i.consecutive}`}`.slice(0, 100),
      value: roundCOP(Math.abs(i.valor)),
    }));
    if (p.ajuste && Math.abs(p.ajuste.valor) >= 0.01)
      items.push({
        account: { code: p.ajuste.cuenta, movement: p.ajuste.valor > 0 ? "Debit" : "Credit" },
        description: "Ajuste al peso",
        value: roundCOP(Math.abs(p.ajuste.valor)),
      });
    if (p.anticipo && p.anticipo.valor >= 0.01)
      items.push({
        account: { code: p.anticipo.cuenta, movement: "Debit" },
        description: "Anticipo (excedente del pago)",
        value: roundCOP(p.anticipo.valor),
      });
    for (const l of p.lineas ?? [])
      items.push({
        account: { code: l.code, movement: l.movimiento },
        description: (l.descripcion || "Otra línea").slice(0, 100),
        value: roundCOP(l.valor),
      });
    items.push({
      account: { code: String(p.cuentaBanco ?? ""), movement: "Credit" },
      description: observaciones.slice(0, 100) || "Pago",
      value: valor,
    });
    return {
      document: { id: documentId },
      date: m.fecha,
      type: "Detailed",
      supplier,
      items,
      observations: observaciones,
    };
  }
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

/** Neto de las líneas adicionales: débitos − créditos (lo que suman al pago). */
export function netoLineas(lineas: CuentaDetallada[] | null | undefined): number {
  return roundCOP(
    (lineas ?? []).reduce(
      (s, l) => s + (l.movimiento === "Debit" ? 1 : -1) * Number(l.valor || 0),
      0,
    ),
  );
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
    const ajuste = roundCOP(p.ajuste?.valor ?? 0);
    const anticipo = roundCOP(p.anticipo?.valor ?? 0);
    const otras = netoLineas(p.lineas);
    if (Math.abs(suma + ajuste + anticipo + otras - valor) > 0.009)
      e.push(
        `Las facturas suman ${suma.toLocaleString("es-CO")}${otras ? `, las otras líneas ${otras.toLocaleString("es-CO")}` : ""}${ajuste ? `, el ajuste al peso ${ajuste.toLocaleString("es-CO")}` : ""}${anticipo ? `, el anticipo ${anticipo.toLocaleString("es-CO")}` : ""} y el pago es ${valor.toLocaleString("es-CO")}.`,
      );
    for (const l of p.lineas ?? []) {
      if (!l.code) e.push("Una línea adicional no tiene cuenta.");
      if (!(Number(l.valor) > 0)) e.push(`La línea de la cuenta ${l.code || "—"} no tiene valor.`);
    }
    if (ajuste && !p.ajuste?.cuenta) e.push("Falta la cuenta del ajuste al peso.");
    if (anticipo && !p.anticipo?.cuenta) e.push("Falta la cuenta de anticipos a proveedores.");
    if ((ajuste || anticipo || (p.lineas ?? []).length) && p.items.some((i) => !i.vence))
      e.push(
        "Falta la fecha de vencimiento de una factura (Siigo la exige en el recibo detallado): sincroniza las CxP y vuelve a proponer.",
      );
    if (ajuste || anticipo || (p.lineas ?? []).length) {
      if (!p.cuentaCxp) e.push("Falta la cuenta por pagar que se cruza en el recibo detallado.");
      if (!p.cuentaBanco) e.push("Falta la cuenta de banco/caja del recibo detallado.");
    }
    for (const i of p.items) {
      if (Math.abs(Number(i.valor)) < 0.01)
        e.push(`${i.factura ?? `${i.prefix}-${i.consecutive}`}: quita la factura con valor 0.`);
      if (i.noVigente)
        e.push(
          `${i.factura ?? `${i.prefix}-${i.consecutive}`} (${i.prefix}-${i.consecutive}) ya no está en las cuentas por pagar de Siigo: vuelve a elegir la factura.`,
        );
    }
    for (const i of p.items)
      if (i.valor > i.saldo + 0.009)
        e.push(
          `${i.factura ?? `${i.prefix}-${i.consecutive}`}: el valor supera el saldo en Siigo.`,
        );
  }
  if (
    (p.tipo === "anticipo" ||
      (p.tipo === "pago_facturas" &&
        !p.ajuste?.valor &&
        !p.anticipo?.valor &&
        !(p.lineas ?? []).length)) &&
    !p.paymentTypeId
  )
    e.push("Falta la forma de pago de Siigo.");
  if (p.tipo === "detallado") {
    const d = roundCOP(
      p.cuentas.filter((c) => c.movimiento === "Debit").reduce((s, c) => s + c.valor, 0),
    );
    const c = roundCOP(
      p.cuentas.filter((x) => x.movimiento === "Credit").reduce((s, x) => s + x.valor, 0),
    );
    if (!p.cuentas.length) e.push("Faltan las cuentas del recibo detallado.");
    // El banco/caja sale por lo pagado; débitos y créditos (incluidas otras líneas) cuadran.
    const banco = roundCOP(
      p.cuentas
        .filter((x) => x.movimiento === "Credit" && (!p.cuentaBanco || x.code === p.cuentaBanco))
        .reduce((s, x) => s + x.valor, 0),
    );
    if (Math.abs(d - c) > 0.009) e.push("Débitos y créditos del recibo no cuadran.");
    else if (Math.abs((p.cuentaBanco ? banco : d) - valor) > 0.009)
      e.push("El crédito al banco/caja no es el valor del pago.");
    if (p.cuentas.some((x) => !x.code || !(Number(x.valor) > 0)))
      e.push("Hay una línea sin cuenta o sin valor.");
  }
  if (p.tipo === "omitir" || p.tipo === "por_definir")
    e.push("Este egreso no genera recibo de pago.");
  return e;
}

/**
 * El reporte de CxP de Siigo puede traer el mismo vencimiento (prefijo, consecutivo, cuota)
 * más de una vez: repetido entre páginas (se toma una vez) o partido por centro de costo
 * (se suman los saldos). Así cada vencimiento queda en una sola fila.
 */
export function unirVencimientos<
  T extends {
    prefix: string;
    consecutive: number;
    quote: number;
    balance: number;
    cost_center: string | null;
    provider_nit: string | null;
  },
>(filas: T[]): T[] {
  const porClave = new Map<string, { fila: T; firmas: Set<string> }>();
  for (const f of filas) {
    const k = `${f.prefix.toUpperCase()}|${f.consecutive}|${f.quote}`;
    const firma = `${f.balance}|${f.cost_center ?? ""}|${f.provider_nit ?? ""}`;
    const previo = porClave.get(k);
    if (!previo) {
      porClave.set(k, { fila: { ...f }, firmas: new Set([firma]) });
      continue;
    }
    if (previo.firmas.has(firma)) continue; // repetido
    previo.firmas.add(firma);
    previo.fila.balance = Math.round((previo.fila.balance + f.balance) * 100) / 100;
  }
  return [...porClave.values()].map((x) => x.fila);
}

/**
 * RP detallado único con los gastos bancarios del mes de una cuenta bancaria: un débito
 * por movimiento (cuenta del concepto, con su fecha y descripción) y un solo crédito al
 * banco por el total. Un solo tercero (el más usado en los movimientos).
 */
export function payloadReciboAgrupado(
  movimientos: Array<{
    fecha: string;
    descripcion: string | null;
    valor: number;
    propuesta: Propuesta;
  }>,
  documentId: number,
  fecha: string,
  etiqueta: string,
): { payload: Record<string, unknown>; total: number; errores: string[] } {
  const errores: string[] = [];
  const bancos = [...new Set(movimientos.map((m) => m.propuesta.cuentaBanco).filter(Boolean))];
  if (bancos.length !== 1)
    errores.push(
      bancos.length
        ? `Los movimientos tienen distintas cuentas de banco (${bancos.join(", ")}).`
        : `Falta la cuenta de banco de «${etiqueta}».`,
    );
  const conteo = new Map<string, number>();
  for (const m of movimientos)
    if (m.propuesta.terceroNit)
      conteo.set(m.propuesta.terceroNit, (conteo.get(m.propuesta.terceroNit) ?? 0) + 1);
  const tercero = [...conteo].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!tercero) errores.push("Falta el tercero (el banco o la empresa) de los gastos bancarios.");
  const items: Array<Record<string, unknown>> = [];
  for (const m of movimientos) {
    const debito = m.propuesta.cuentas.find((c) => c.movimiento === "Debit");
    if (!debito) {
      errores.push(`${m.fecha} ${m.descripcion ?? ""}: falta la cuenta débito.`);
      continue;
    }
    items.push({
      account: { code: debito.code, movement: "Debit" },
      description: `${m.fecha} ${m.descripcion ?? ""}`.trim().slice(0, 100),
      value: roundCOP(m.valor),
    });
  }
  const total = roundCOP(movimientos.reduce((s, m) => s + roundCOP(m.valor), 0));
  items.push({
    account: { code: bancos[0] ?? "", movement: "Credit" },
    description: `Gastos bancarios ${etiqueta} ${fecha.slice(0, 7)}`,
    value: total,
  });
  return {
    payload: {
      document: { id: documentId },
      date: fecha,
      type: "Detailed",
      supplier: { identification: String(tercero ?? ""), branch_office: 0 },
      items,
      observations: `Gastos bancarios ${etiqueta} ${fecha.slice(0, 7)}: ${movimientos.length} movimientos (comisiones, IVA bancario, 4x1000).`,
    },
    total,
    errores,
  };
}

/**
 * Saldos vigentes de las facturas de un pago revisado a mano: se actualizan con las CxP
 * sincronizadas de Siigo (p. ej. después de corregir una retención en Siigo), sin cambiar lo
 * que eligió la usuaria. Devuelve la propuesta actualizada y si cambió algún saldo.
 */
export function refrescarSaldos(
  p: Propuesta,
  cxp: Array<
    Pick<CuentaPorPagar, "prefix" | "consecutive" | "quote" | "balance"> & {
      dueDate?: string | null;
    }
  >,
): { propuesta: Propuesta; cambio: boolean } {
  if (p.tipo !== "pago_facturas" || !p.items?.length) return { propuesta: p, cambio: false };
  const vigente = new Map(cxp.map((c) => [`${c.prefix}|${c.consecutive}|${c.quote}`, c]));
  let cambio = false;
  // Las facturas con valor 0 sobran (Siigo las rechaza: «invalid_amount»).
  const items = p.items
    .filter((i) => {
      if (Math.abs(Number(i.valor)) >= 0.01) return true;
      cambio = true;
      return false;
    })
    .map((i) => {
      const c = vigente.get(`${i.prefix}|${i.consecutive}|${i.quote}`);
      if (!c) {
        if (i.noVigente) return i;
        cambio = true;
        return { ...i, noVigente: true };
      }
      const saldo = Number(c.balance);
      const vence = c.dueDate ?? i.vence ?? null;
      if (Math.abs(saldo - Number(i.saldo)) < 0.005 && vence === (i.vence ?? null) && !i.noVigente)
        return i;
      cambio = true;
      return { ...i, saldo, vence, noVigente: false };
    });
  return { propuesta: cambio ? { ...p, items } : p, cambio };
}
