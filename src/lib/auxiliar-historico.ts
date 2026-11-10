// APRENDIZAJE DEL AUXILIAR HISTÓRICO DE SIIGO (núcleo global: todas las empresas).
//
// Entrada: los movimientos del reporte "Movimiento auxiliar por cuenta contable"
// (o "… por tercero") de cualquier rango de fechas, ya leídos fila por fila.
// El análisis se hace en cinco pasadas, cada una con sus propias verificaciones:
//   1. Lectura: cada movimiento con cuenta, comprobante, fecha, tercero y valor.
//   2. Reconstrucción: los movimientos de cada comprobante de compra (FC, DS…) se
//      unen en un documento completo y se verifica que débitos = créditos.
//   3. IVA: base y tarifa de cada renglón de IVA ("IVA compras 19% Base: 814,000.00")
//      y que base × tarifa cuadre con el valor.
//   4. Retenciones: concepto, tarifa (del nombre de la cuenta) y base (del detalle) de
//      Retefuente, ReteIVA y ReteICA, y que base × tarifa cuadre con lo retenido.
//   5. Consolidación por proveedor: cuentas de gasto/costo, centros de costo, IVA,
//      retenciones (con tarifa, concepto y rango de bases), cuentas por pagar,
//      descuentos e impoconsumo, con su frecuencia, y las compras en las que NO se
//      retuvo. Las diferencias encontradas quedan como novedades, sin corregir nada.
// Nunca modifica valores: describe lo que la empresa hizo en Siigo para replicarlo.
import { roundCOP } from "@/lib/money";
import type { RetencionKind } from "@/lib/retenciones";

export type MovimientoAux = {
  account_code: string | null;
  account_name: string | null;
  provider_nit: string | null;
  provider_name: string | null;
  voucher: string | null;
  entry_date_text: string | null;
  description: string | null;
  detail: string | null;
  cost_center: string | null;
  debit: number | null;
  credit: number | null;
};

// ---------------------------------------------------------------------------
// Utilidades de lectura
// ---------------------------------------------------------------------------
const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const dos = (n: number) => String(n).padStart(2, "0");

/** "16/09/2026" → "2026-09-16"; también acepta "2026-09-16". */
export function fechaISO(texto: string | null | undefined): string | null {
  const t = String(texto ?? "").trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${dos(Number(m[2]))}-${dos(Number(m[1]))}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "De Enero 01 2026 a Noviembre 30 2026" → { desde: "2026-01-01", hasta: "2026-11-30" }. */
export function rangoDelPeriodo(texto: string | null | undefined): { desde: string; hasta: string } | null {
  const t = sinTildes(String(texto ?? "")).toLowerCase();
  const re = /([a-z]+)\s+(\d{1,2})\s+(?:de\s+)?(\d{4})/g;
  const fechas: string[] = [];
  for (const m of t.matchAll(re)) {
    const mes = MESES[m[1]!];
    if (mes) fechas.push(`${m[3]}-${dos(mes)}-${dos(Number(m[2]))}`);
  }
  return fechas.length >= 2 ? { desde: fechas[0]!, hasta: fechas[fechas.length - 1]! } : null;
}

/** Todas las fechas "DD/MM/AAAA" entre dos fechas ISO (para reemplazar solo ese periodo). */
export function fechasDelRango(desde: string, hasta: string): string[] {
  const out: string[] = [];
  const d = new Date(`${desde}T12:00:00Z`);
  const fin = new Date(`${hasta}T12:00:00Z`);
  for (let i = 0; d <= fin && i < 40000; i++) {
    out.push(`${dos(d.getUTCDate())}/${dos(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Tipo del comprobante: "FC-1-5527" → "FC-1"; "FC-1" → "FC-1". */
export function tipoComprobante(voucher: string | null | undefined): string {
  const v = String(voucher ?? "").trim();
  const m = /^([A-Za-z]+-\d+)-\d+$/.exec(v);
  return m ? m[1]!.toUpperCase() : v.toUpperCase();
}

/** Comprobantes de compra o gasto de Siigo: factura de compra (FC) y documento soporte (DS). */
export function esComprobanteDeCompra(voucher: string | null | undefined): boolean {
  return /^(FC|DS)-/i.test(String(voucher ?? "").trim());
}

/** "Compras 2.5% Base: 814,000.00" → 814000 (formato de Siigo: coma de miles, punto decimal). */
export function baseDeTexto(texto: string | null | undefined): number | null {
  const m = /base\s*:?\s*\$?\s*([\d.,]+)/i.exec(String(texto ?? ""));
  if (!m) return null;
  let v = m[1]!;
  if (/,\d{1,2}$/.test(v) && !/\.\d{1,2}$/.test(v)) v = v.replace(/\./g, "").replace(",", ".");
  else v = v.replace(/,/g, "");
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Tarifa escrita en el nombre de la cuenta o en el detalle:
 * "Retención por compras 2,5%" → 2.5 · "Arrendamientos 3.5%" → 3.5 ·
 * "ReteICA 11,04 x mil" → 1.104 (por mil se convierte a porcentaje).
 */
export function tarifaDeTexto(...textos: Array<string | null | undefined>): number | null {
  for (const texto of textos) {
    const t = String(texto ?? "");
    const porMil = /(\d+(?:[.,]\d+)?)\s*(?:x|por)\s*mil/i.exec(t);
    if (porMil) return Number(porMil[1]!.replace(",", ".")) / 10;
    const pct = /(\d+(?:[.,]\d+)?)\s*%/.exec(t);
    if (pct) return Number(pct[1]!.replace(",", "."));
  }
  return null;
}

/** NIT sin DV ni puntos. */
export function nitLimpio(nit: string | null | undefined): string {
  const t = String(nit ?? "").trim();
  const conGuion = /^(.*)-\s*\d\s*$/.exec(t);
  return (conGuion ? conGuion[1]! : t).replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// Pasada 2: reconstrucción de comprobantes de compra
// ---------------------------------------------------------------------------
export type RenglonValor = { cuenta: string; nombre: string; valor: number };
export type RenglonGasto = RenglonValor & { descripcion: string; centro: string | null };
export type RenglonImpuesto = RenglonValor & { base: number | null; tarifa: number | null; concepto: string };

export type CompraHistorica = {
  comprobante: string;
  tipo: string;
  fecha: string | null;
  nit: string;
  nombre: string;
  /** Gasto, costo, inventario o activo (débitos de las clases 1, 5, 6 y 7 que no son impuestos ni anticipos). */
  gastos: RenglonGasto[];
  iva: RenglonImpuesto[];
  retenciones: Record<RetencionKind, RenglonImpuesto[]>;
  impoconsumo: RenglonValor[];
  descuentos: RenglonValor[];
  cuentasPorPagar: RenglonValor[];
  anticipos: RenglonValor[];
  ajustes: RenglonValor[];
  otros: Array<RenglonValor & { naturaleza: "debito" | "credito" }>;
  debitos: number;
  creditos: number;
  /** Suma de gastos/costos (base de la compra). */
  base: number;
};

const esClaseGasto = (c: string) => /^(5|6|7|14|15|16|17)/.test(c);

/** Une los movimientos de cada comprobante de compra en un documento completo. */
export function reconstruirCompras(movs: MovimientoAux[]): CompraHistorica[] {
  const grupos = new Map<string, MovimientoAux[]>();
  for (const m of movs) {
    if (!esComprobanteDeCompra(m.voucher)) continue;
    const clave = String(m.voucher).trim().toUpperCase();
    const lista = grupos.get(clave);
    if (lista) lista.push(m);
    else grupos.set(clave, [m]);
  }
  const out: CompraHistorica[] = [];
  for (const [comprobante, lineas] of grupos) {
    // El proveedor es el tercero de la cuenta por pagar o, si no hay, el más frecuente.
    const cxp = lineas.find((l) => /^(22|23)/.test(String(l.account_code)) && !/^236/.test(String(l.account_code)));
    const frecuencia = new Map<string, number>();
    for (const l of lineas) {
      const n = nitLimpio(l.provider_nit);
      if (n) frecuencia.set(n, (frecuencia.get(n) ?? 0) + 1);
    }
    const nit = nitLimpio(cxp?.provider_nit) || [...frecuencia].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const compra: CompraHistorica = {
      comprobante,
      tipo: tipoComprobante(comprobante),
      fecha: fechaISO(lineas[0]?.entry_date_text),
      nit,
      nombre: String((cxp ?? lineas.find((l) => nitLimpio(l.provider_nit) === nit))?.provider_name ?? "").trim(),
      gastos: [],
      iva: [],
      retenciones: { retefuente: [], reteiva: [], reteica: [] },
      impoconsumo: [],
      descuentos: [],
      cuentasPorPagar: [],
      anticipos: [],
      ajustes: [],
      otros: [],
      debitos: 0,
      creditos: 0,
      base: 0,
    };
    for (const l of lineas) {
      const cuenta = String(l.account_code ?? "").trim();
      const nombre = String(l.account_name ?? "").trim();
      const d = Number(l.debit ?? 0);
      const c = Number(l.credit ?? 0);
      compra.debitos += d;
      compra.creditos += c;
      const neto = d - c;
      if (!cuenta || neto === 0) continue;
      const valor = Math.abs(neto);
      const texto = `${l.description ?? ""} ${l.detail ?? ""}`;
      const impuesto = (): RenglonImpuesto => ({
        cuenta,
        nombre,
        valor,
        base: baseDeTexto(l.detail) ?? baseDeTexto(l.description),
        tarifa: tarifaDeTexto(nombre, l.description, l.detail),
        concepto: String(l.description ?? nombre).trim(),
      });
      if (/^2408/.test(cuenta)) compra.iva.push(impuesto());
      else if (/^2365/.test(cuenta)) compra.retenciones.retefuente.push(impuesto());
      else if (/^2367/.test(cuenta)) compra.retenciones.reteiva.push(impuesto());
      else if (/^2368/.test(cuenta)) compra.retenciones.reteica.push(impuesto());
      else if (/^1330/.test(cuenta)) compra.anticipos.push({ cuenta, nombre, valor });
      else if (/^(22|23)/.test(cuenta) && neto < 0) compra.cuentasPorPagar.push({ cuenta, nombre, valor });
      else if (/^(4295|5395)/.test(cuenta) || /ajuste al peso/i.test(nombre)) compra.ajustes.push({ cuenta, nombre, valor: neto });
      else if (/impoconsumo|impuesto al consumo|\binc\b/i.test(`${nombre} ${texto}`) && neto > 0)
        compra.impoconsumo.push({ cuenta, nombre, valor });
      else if (neto < 0 && (/^42/.test(cuenta) || /descuento/i.test(nombre))) compra.descuentos.push({ cuenta, nombre, valor });
      else if (neto > 0 && esClaseGasto(cuenta))
        compra.gastos.push({
          cuenta,
          nombre,
          valor,
          descripcion: String(l.description ?? "").trim(),
          centro: String(l.cost_center ?? "").trim() || null,
        });
      else compra.otros.push({ cuenta, nombre, valor, naturaleza: neto > 0 ? "debito" : "credito" });
    }
    compra.debitos = roundCOP2(compra.debitos);
    compra.creditos = roundCOP2(compra.creditos);
    compra.base = roundCOP2(compra.gastos.reduce((s, g) => s + g.valor, 0));
    out.push(compra);
  }
  return out.sort((a, b) => String(a.fecha ?? "").localeCompare(String(b.fecha ?? "")) || a.comprobante.localeCompare(b.comprobante));
}

const roundCOP2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Pasadas 1 a 5: verificación del análisis
// ---------------------------------------------------------------------------
export type Novedad = { pasada: 1 | 2 | 3 | 4 | 5; comprobante?: string; mensaje: string };

export type InformeAnalisis = {
  pasadas: Array<{ numero: 1 | 2 | 3 | 4 | 5; nombre: string; revisados: number; correctos: number; novedades: number }>;
  movimientos: number;
  movimientosDeCompra: number;
  compras: number;
  proveedores: number;
  desde: string | null;
  hasta: string | null;
  novedades: Novedad[];
};

/** Cuadra base × tarifa con el valor: $1 de tolerancia o 0,5 % (redondeos de Siigo). */
export function cuadraTarifa(base: number | null, tarifa: number | null, valor: number): boolean | null {
  if (base == null || tarifa == null || !(base > 0)) return null;
  const esperado = (base * tarifa) / 100;
  return Math.abs(esperado - valor) <= Math.max(1, valor * 0.005);
}

export function analizarAuxiliar(movs: MovimientoAux[]): { compras: CompraHistorica[]; informe: InformeAnalisis } {
  const novedades: Novedad[] = [];
  // Pasada 1: lectura.
  let leidos = 0;
  let fechas: string[] = [];
  for (const m of movs) {
    const ok = !!String(m.account_code ?? "").trim() && (m.debit != null || m.credit != null);
    if (ok) leidos += 1;
    else novedades.push({ pasada: 1, mensaje: `Movimiento sin cuenta o sin valor (${m.voucher ?? "sin comprobante"}).` });
    const f = fechaISO(m.entry_date_text);
    if (f) fechas.push(f);
  }
  fechas = fechas.sort();
  const deCompra = movs.filter((m) => esComprobanteDeCompra(m.voucher));

  // Pasada 2: reconstrucción y cuadre.
  const compras = reconstruirCompras(deCompra);
  let cuadran = 0;
  for (const c of compras) {
    if (Math.abs(c.debitos - c.creditos) <= 1) cuadran += 1;
    else novedades.push({ pasada: 2, comprobante: c.comprobante, mensaje: `Débitos ${c.debitos} y créditos ${c.creditos} no cuadran.` });
    if (!c.nit) novedades.push({ pasada: 2, comprobante: c.comprobante, mensaje: "Sin tercero identificado." });
  }

  // Pasada 3: IVA.
  let ivaRev = 0;
  let ivaOk = 0;
  for (const c of compras)
    for (const i of c.iva) {
      ivaRev += 1;
      const ok = cuadraTarifa(i.base, i.tarifa, i.valor);
      if (ok !== false) ivaOk += 1;
      else novedades.push({ pasada: 3, comprobante: c.comprobante, mensaje: `IVA ${i.valor} no cuadra con base ${i.base} × ${i.tarifa}% (${i.cuenta}).` });
    }

  // Pasada 4: retenciones.
  let retRev = 0;
  let retOk = 0;
  for (const c of compras)
    for (const kind of ["retefuente", "reteiva", "reteica"] as RetencionKind[])
      for (const r of c.retenciones[kind]) {
        retRev += 1;
        const ok = cuadraTarifa(r.base, r.tarifa, r.valor);
        if (ok !== false) retOk += 1;
        else novedades.push({ pasada: 4, comprobante: c.comprobante, mensaje: `${kind} ${r.valor} no cuadra con base ${r.base} × ${r.tarifa}% (${r.cuenta}).` });
      }

  // Pasada 5: consolidación (coherencia de cada documento con su proveedor).
  const perfiles = aprenderPerfiles(compras);
  let consolidados = 0;
  for (const c of compras) {
    const total = c.gastos.length + c.cuentasPorPagar.length;
    if (total > 0 && c.nit && perfiles.has(c.nit)) consolidados += 1;
    else if (c.nit) novedades.push({ pasada: 5, comprobante: c.comprobante, mensaje: "Comprobante sin gasto/costo ni cuenta por pagar: no aporta precedente." });
  }

  return {
    compras,
    informe: {
      movimientos: movs.length,
      movimientosDeCompra: deCompra.length,
      compras: compras.length,
      proveedores: perfiles.size,
      desde: fechas[0] ?? null,
      hasta: fechas[fechas.length - 1] ?? null,
      novedades,
      pasadas: [
        { numero: 1, nombre: "Lectura de movimientos", revisados: movs.length, correctos: leidos, novedades: movs.length - leidos },
        { numero: 2, nombre: "Reconstrucción y cuadre de comprobantes de compra", revisados: compras.length, correctos: cuadran, novedades: compras.length - cuadran },
        { numero: 3, nombre: "IVA: base × tarifa", revisados: ivaRev, correctos: ivaOk, novedades: ivaRev - ivaOk },
        { numero: 4, nombre: "Retenciones: concepto, base × tarifa", revisados: retRev, correctos: retOk, novedades: retRev - retOk },
        { numero: 5, nombre: "Consolidación por proveedor", revisados: compras.length, correctos: consolidados, novedades: compras.length - consolidados },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Pasada 5: precedente por proveedor
// ---------------------------------------------------------------------------
export type UsoCuenta = { cuenta: string; nombre: string; veces: number; valor: number; ultima: string | null };
export type UsoRetencion = UsoCuenta & {
  tarifa: number | null;
  concepto: string;
  baseMin: number | null;
  baseMax: number | null;
};

export type PerfilHistorico = {
  nit: string;
  nombre: string;
  compras: number;
  ultima: string | null;
  gastos: Array<UsoCuenta & { palabras: string[] }>;
  centros: Array<{ centro: string; veces: number }>;
  iva: Array<UsoCuenta & { tarifa: number | null }>;
  retenciones: Record<RetencionKind, UsoRetencion[]>;
  /** Compras del proveedor en las que NO se practicó cada retención, y la mayor base de esas compras. */
  sinRetencion: Record<RetencionKind, { veces: number; baseMax: number }>;
  cuentasPorPagar: UsoCuenta[];
  descuentos: UsoCuenta[];
  impoconsumo: UsoCuenta[];
};

const PALABRAS_VACIAS = new Set(["de", "la", "el", "los", "las", "y", "en", "por", "para", "con", "del", "al", "producto", "cant"]);
export function palabrasClave(texto: string): string[] {
  return [
    ...new Set(
      sinTildes(texto)
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((p) => p.length >= 3 && !PALABRAS_VACIAS.has(p) && !/^\d+$/.test(p)),
    ),
  ];
}

const masReciente = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

function sumar<T extends UsoCuenta>(lista: T[], r: RenglonValor, fecha: string | null, extra: Omit<T, keyof UsoCuenta> & Partial<T>, igual: (u: T) => boolean): T {
  let u = lista.find((x) => x.cuenta === r.cuenta && igual(x));
  if (!u) {
    u = { cuenta: r.cuenta, nombre: r.nombre, veces: 0, valor: 0, ultima: null, ...extra } as T;
    lista.push(u);
  }
  u.veces += 1;
  u.valor = roundCOP2(u.valor + r.valor);
  u.ultima = masReciente(u.ultima, fecha);
  return u;
}

const ordenar = <T extends { veces: number; ultima?: string | null }>(lista: T[]) =>
  lista.sort((a, b) => b.veces - a.veces || String(b.ultima ?? "").localeCompare(String(a.ultima ?? "")));

/** Precedente de cada proveedor a partir de sus compras reconstruidas. */
export function aprenderPerfiles(compras: CompraHistorica[]): Map<string, PerfilHistorico> {
  const out = new Map<string, PerfilHistorico>();
  for (const c of compras) {
    if (!c.nit) continue;
    let p = out.get(c.nit);
    if (!p) {
      p = {
        nit: c.nit,
        nombre: c.nombre,
        compras: 0,
        ultima: null,
        gastos: [],
        centros: [],
        iva: [],
        retenciones: { retefuente: [], reteiva: [], reteica: [] },
        sinRetencion: { retefuente: { veces: 0, baseMax: 0 }, reteiva: { veces: 0, baseMax: 0 }, reteica: { veces: 0, baseMax: 0 } },
        cuentasPorPagar: [],
        descuentos: [],
        impoconsumo: [],
      };
      out.set(c.nit, p);
    }
    p.compras += 1;
    p.ultima = masReciente(p.ultima, c.fecha);
    if (c.nombre && (!p.nombre || (c.fecha && c.fecha >= String(p.ultima)))) p.nombre = c.nombre;

    // Cuenta de gasto/costo una vez por compra (no por renglón), con sus palabras clave.
    const porCuenta = new Map<string, RenglonGasto[]>();
    for (const g of c.gastos) porCuenta.set(g.cuenta, [...(porCuenta.get(g.cuenta) ?? []), g]);
    for (const [cuenta, gs] of porCuenta) {
      const u = sumar(p.gastos, { cuenta, nombre: gs[0]!.nombre, valor: gs.reduce((s, g) => s + g.valor, 0) }, c.fecha, { palabras: [] }, () => true);
      u.palabras = [...new Set([...u.palabras, ...gs.flatMap((g) => palabrasClave(g.descripcion))])].slice(0, 60);
    }
    for (const centro of new Set(c.gastos.map((g) => g.centro).filter((x): x is string => !!x))) {
      const u = p.centros.find((x) => x.centro === centro);
      if (u) u.veces += 1;
      else p.centros.push({ centro, veces: 1 });
    }
    for (const i of c.iva) sumar(p.iva, i, c.fecha, { tarifa: i.tarifa }, (u) => u.tarifa === i.tarifa);
    for (const kind of ["retefuente", "reteiva", "reteica"] as RetencionKind[]) {
      const lista = c.retenciones[kind];
      if (!lista.length) {
        p.sinRetencion[kind].veces += 1;
        const base = kind === "reteiva" ? c.iva.reduce((s, i) => s + i.valor, 0) : c.base;
        p.sinRetencion[kind].baseMax = Math.max(p.sinRetencion[kind].baseMax, base);
        continue;
      }
      for (const r of lista) {
        const u = sumar(p.retenciones[kind], r, c.fecha, { tarifa: r.tarifa, concepto: r.concepto, baseMin: null, baseMax: null }, (x) => x.tarifa === r.tarifa);
        if (r.base != null) {
          u.baseMin = u.baseMin == null ? r.base : Math.min(u.baseMin, r.base);
          u.baseMax = u.baseMax == null ? r.base : Math.max(u.baseMax, r.base);
        }
      }
    }
    for (const r of new Map(c.cuentasPorPagar.map((x) => [x.cuenta, x])).values()) sumar(p.cuentasPorPagar, r, c.fecha, {}, () => true);
    for (const r of c.descuentos) sumar(p.descuentos, r, c.fecha, {}, () => true);
    for (const r of c.impoconsumo) sumar(p.impoconsumo, r, c.fecha, {}, () => true);
  }
  for (const p of out.values()) {
    ordenar(p.gastos);
    p.centros.sort((a, b) => b.veces - a.veces);
    ordenar(p.iva);
    for (const k of ["retefuente", "reteiva", "reteica"] as RetencionKind[]) ordenar(p.retenciones[k]);
    ordenar(p.cuentasPorPagar);
    ordenar(p.descuentos);
    ordenar(p.impoconsumo);
  }
  return out;
}

/** Perfil del proveedor (por NIT con o sin DV). */
export function perfilDe(perfiles: Map<string, PerfilHistorico> | null | undefined, nit: string | null | undefined) {
  return perfiles?.get(nitLimpio(nit)) ?? null;
}

/**
 * Cuenta de gasto/costo del historial para una descripción: la del proveedor que más
 * palabras comparte con la descripción; si ninguna coincide y el proveedor usa una
 * sola cuenta en la mayoría de sus compras (≥ 80 %), esa.
 */
export function cuentaGastoHistorica(
  perfil: PerfilHistorico | null,
  descripcion: string,
  valida: (cuenta: string) => boolean,
): { cuenta: string; nombre: string; motivo: string } | null {
  if (!perfil) return null;
  const candidatas = perfil.gastos.filter((g) => valida(g.cuenta));
  if (!candidatas.length) return null;
  const palabras = palabrasClave(descripcion);
  let mejor: { g: (typeof candidatas)[number]; p: number } | null = null;
  for (const g of candidatas) {
    const p = palabras.filter((w) => g.palabras.includes(w)).length;
    if (p > 0 && (!mejor || p > mejor.p || (p === mejor.p && g.veces > mejor.g.veces))) mejor = { g, p };
  }
  if (mejor)
    return { cuenta: mejor.g.cuenta, nombre: mejor.g.nombre, motivo: `Historial Siigo: ${mejor.g.veces} compra(s) del proveedor con descripción similar.` };
  const top = candidatas[0]!;
  const totalCompras = Math.max(1, perfil.compras);
  if (top.veces / totalCompras >= 0.8)
    return { cuenta: top.cuenta, nombre: top.nombre, motivo: `Historial Siigo: cuenta usada en ${top.veces} de ${perfil.compras} compra(s) del proveedor.` };
  return null;
}
