// PRECEDENTE TRIBUTARIO POR PROVEEDOR (núcleo global: todas las empresas).
//
// Aprende de lo que YA se sincronizó con Siigo (facturas y documentos soporte con
// identidad en Siigo) y del auxiliar histórico importado de Siigo:
//   - qué impuesto de IVA (registro exacto) se usó con cada proveedor y tarifa;
//   - qué retenciones (Retefuente / ReteIVA / ReteICA) se le practicaron, con qué
//     impuesto/cuenta/tarifa, y en cuántas facturas NO se le retuvo.
// Con eso decide, para una factura nueva:
//   - el IVA exacto de cada renglón cuando hay varios impuestos con la misma tarifa;
//   - si se practica retención (precedente + base mínima del concepto) o si hay
//     que pedir confirmación de la condición del proveedor (autorretenedor,
//     régimen especial, no sujeto, etc.), que queda guardada en su perfil.
// Nunca cambia valores de la factura ni inventa tarifas: el IVA solo se elige
// entre los impuestos configurados de la tarifa del documento (o, sin tarifa,
// solo si el precedente del proveedor cuadra al peso con el valor del renglón).
import { roundCOP } from "@/lib/money";
import type { RetencionKind } from "@/lib/retenciones";

export const RETENCIONES: RetencionKind[] = ["retefuente", "reteiva", "reteica"];

const PREFIJO_RETENCION: Record<RetencionKind, string> = {
  retefuente: "2365",
  reteiva: "2367",
  reteica: "2368",
};
const PREFIJO_IVA = "2408";

export type ImpuestoConfigurado = {
  id: string;
  kind: string;
  name: string;
  rate: number;
  account_code?: string | null;
  active?: boolean | null;
  min_base?: number | null;
  retention_concept?: string | null;
};

// ---------------------------------------------------------------------------
// Entradas (lo que se lee de la base)
// ---------------------------------------------------------------------------
export type FacturaSincronizada = {
  id: string;
  provider_nit: string | null;
  issue_date: string | null;
  subtotal: number | null;
  iva: number | null;
  retefuente: number | null;
  reteiva: number | null;
  reteica: number | null;
};
export type LineaSincronizada = {
  invoice_id: string;
  iva: number | null;
  iva_tax_id: string | null;
};
export type AsientoSincronizado = {
  invoice_id: string;
  account_code: string;
  debit: number | null;
  credit: number | null;
};
export type MovimientoHistorico = {
  provider_nit: string | null;
  account_code: string | null;
  debit: number | null;
  credit: number | null;
  period?: string | null;
};

// ---------------------------------------------------------------------------
// Precedente aprendido
// ---------------------------------------------------------------------------
export type UsoImpuesto = {
  /** Registro exacto de Administración → Retenciones, si se pudo identificar. */
  taxId: string | null;
  cuenta: string | null;
  /** Tarifa del registro (o la observada en la factura si no se identificó). */
  tarifa: number | null;
  veces: number;
  ultima: string | null;
};

export type PrecedenteProveedor = {
  nit: string;
  /** Documentos del proveedor ya sincronizados con Siigo. */
  documentosSiigo: number;
  /** Movimientos de impuestos del auxiliar histórico de Siigo. */
  movimientosHistoricos: number;
  iva: UsoImpuesto[];
  retenciones: Record<RetencionKind, UsoImpuesto[]>;
  /** Documentos sincronizados en los que NO se practicó cada retención. */
  sinRetencion: Record<RetencionKind, number>;
};

export type PrecedentesEmpresa = Map<string, PrecedenteProveedor>;

/** NIT sin DV ni puntos: "900.470.166-4" → "900470166". */
export function nitBase(nit: string | null | undefined): string {
  if (!nit) return "";
  const conGuion = /^(.*)-\s*\d\s*$/.exec(nit);
  return (conGuion ? conGuion[1]! : nit).replace(/\D/g, "");
}

const vacio = (nit: string): PrecedenteProveedor => ({
  nit,
  documentosSiigo: 0,
  movimientosHistoricos: 0,
  iva: [],
  retenciones: { retefuente: [], reteiva: [], reteica: [] },
  sinRetencion: { retefuente: 0, reteiva: 0, reteica: 0 },
});

const masReciente = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

function sumarUso(lista: UsoImpuesto[], uso: Omit<UsoImpuesto, "veces">) {
  const previo = lista.find((u) =>
    uso.taxId ? u.taxId === uso.taxId : !u.taxId && u.cuenta === uso.cuenta,
  );
  if (previo) {
    previo.veces += 1;
    previo.ultima = masReciente(previo.ultima, uso.ultima);
    if (!previo.cuenta) previo.cuenta = uso.cuenta;
  } else lista.push({ ...uso, veces: 1 });
}

/** Más usado primero; a igualdad, el más reciente. */
const ordenar = (lista: UsoImpuesto[]) =>
  lista.sort(
    (a, b) => b.veces - a.veces || String(b.ultima ?? "").localeCompare(String(a.ultima ?? "")),
  );

const cuentaCoincide = (cuentaImpuesto: string | null | undefined, cuenta: string) => {
  const c = String(cuentaImpuesto ?? "").trim();
  return !!c && (cuenta === c || cuenta.startsWith(c));
};

/**
 * Impuesto configurado que corresponde a una cuenta usada en Siigo: misma clase,
 * cuenta igual (o auxiliar de la configurada) y, si se conoce, la tarifa más
 * cercana a la observada. Si no hay un único candidato claro, null.
 */
export function impuestoDeCuenta(
  taxes: ImpuestoConfigurado[],
  kind: string,
  cuenta: string,
  tarifaObservada: number | null,
): ImpuestoConfigurado | null {
  const candidatos = taxes.filter((t) => t.kind === kind && cuentaCoincide(t.account_code, cuenta));
  if (candidatos.length <= 1) return candidatos[0] ?? null;
  const exactos = candidatos.filter((t) => String(t.account_code ?? "").trim() === cuenta);
  const grupo = exactos.length ? exactos : candidatos;
  if (grupo.length === 1) return grupo[0]!;
  if (tarifaObservada == null) return null;
  const conTarifa = grupo.filter((t) => Math.abs(Number(t.rate) - tarifaObservada) <= 0.05);
  return conTarifa.length === 1 ? conTarifa[0]! : null;
}

/** Aprende el precedente de cada proveedor de la empresa. */
export function construirPrecedentes(input: {
  facturas: FacturaSincronizada[];
  lineas: LineaSincronizada[];
  asientos: AsientoSincronizado[];
  historico: MovimientoHistorico[];
  taxes: ImpuestoConfigurado[];
}): PrecedentesEmpresa {
  const out: PrecedentesEmpresa = new Map();
  const de = (nit: string) => {
    let p = out.get(nit);
    if (!p) out.set(nit, (p = vacio(nit)));
    return p;
  };
  const taxPorId = new Map(input.taxes.map((t) => [String(t.id), t]));
  const lineasPorFactura = new Map<string, LineaSincronizada[]>();
  for (const l of input.lineas)
    lineasPorFactura.set(l.invoice_id, [...(lineasPorFactura.get(l.invoice_id) ?? []), l]);
  const asientosPorFactura = new Map<string, AsientoSincronizado[]>();
  for (const a of input.asientos)
    asientosPorFactura.set(a.invoice_id, [...(asientosPorFactura.get(a.invoice_id) ?? []), a]);

  for (const f of input.facturas) {
    const nit = nitBase(f.provider_nit);
    if (!nit) continue;
    const p = de(nit);
    p.documentosSiigo += 1;
    const fecha = f.issue_date ?? null;
    const asientos = asientosPorFactura.get(f.id) ?? [];

    // IVA: el impuesto exacto elegido en cada renglón sincronizado.
    const idsIva = new Set<string>();
    for (const l of lineasPorFactura.get(f.id) ?? []) {
      if (!(Number(l.iva ?? 0) > 0) || !l.iva_tax_id || idsIva.has(l.iva_tax_id)) continue;
      idsIva.add(l.iva_tax_id);
      const t = taxPorId.get(String(l.iva_tax_id));
      sumarUso(p.iva, {
        taxId: String(l.iva_tax_id),
        cuenta: t?.account_code ?? null,
        tarifa: t ? Number(t.rate) : null,
        ultima: fecha,
      });
    }
    // Sin impuesto por renglón (documentos antiguos): la cuenta 2408 del asiento.
    if (idsIva.size === 0) {
      for (const cuenta of new Set(
        asientos
          .filter((a) => a.account_code.startsWith(PREFIJO_IVA) && Number(a.debit ?? 0) > 0)
          .map((a) => a.account_code),
      )) {
        const t = impuestoDeCuenta(input.taxes, "iva", cuenta, null);
        sumarUso(p.iva, {
          taxId: t ? String(t.id) : null,
          cuenta,
          tarifa: t ? Number(t.rate) : null,
          ultima: fecha,
        });
      }
    }

    // Retenciones: valor del encabezado + cuenta del asiento.
    for (const kind of RETENCIONES) {
      const valor = roundCOP(Number(f[kind] ?? 0));
      if (!(valor > 0)) {
        p.sinRetencion[kind] += 1;
        continue;
      }
      const base = kind === "reteiva" ? Number(f.iva ?? 0) : Number(f.subtotal ?? 0);
      const observada = base > 0 ? Math.round((valor / base) * 100000) / 1000 : null;
      const cuentas = asientos.filter(
        (a) => a.account_code.startsWith(PREFIJO_RETENCION[kind]) && Number(a.credit ?? 0) > 0,
      );
      const cuenta =
        cuentas.sort((a, b) => Number(b.credit ?? 0) - Number(a.credit ?? 0))[0]?.account_code ??
        null;
      const t = cuenta ? impuestoDeCuenta(input.taxes, kind, cuenta, observada) : null;
      sumarUso(p.retenciones[kind], {
        taxId: t ? String(t.id) : null,
        cuenta,
        tarifa: t ? Number(t.rate) : observada,
        ultima: fecha,
      });
    }
  }

  // Auxiliar histórico de Siigo: evidencia adicional de cuentas usadas (sin base
  // confiable, así que no infiere tarifa ni cuenta facturas "sin retención").
  for (const m of input.historico) {
    const nit = nitBase(m.provider_nit);
    const cuenta = String(m.account_code ?? "").trim();
    if (!nit || !cuenta) continue;
    const fecha = m.period ?? null;
    if (cuenta.startsWith(PREFIJO_IVA) && Number(m.debit ?? 0) > 0) {
      const p = de(nit);
      p.movimientosHistoricos += 1;
      const t = impuestoDeCuenta(input.taxes, "iva", cuenta, null);
      sumarUso(p.iva, {
        taxId: t ? String(t.id) : null,
        cuenta,
        tarifa: t ? Number(t.rate) : null,
        ultima: fecha,
      });
      continue;
    }
    const kind = RETENCIONES.find((k) => cuenta.startsWith(PREFIJO_RETENCION[k]));
    if (kind && Number(m.credit ?? 0) > 0) {
      const p = de(nit);
      p.movimientosHistoricos += 1;
      const t = impuestoDeCuenta(input.taxes, kind, cuenta, null);
      sumarUso(p.retenciones[kind], {
        taxId: t ? String(t.id) : null,
        cuenta,
        tarifa: t ? Number(t.rate) : null,
        ultima: fecha,
      });
    }
  }

  for (const p of out.values()) {
    ordenar(p.iva);
    for (const k of RETENCIONES) ordenar(p.retenciones[k]);
  }
  return out;
}

export function precedenteDe(
  precedentes: PrecedentesEmpresa | null | undefined,
  nit: string | null | undefined,
) {
  return precedentes?.get(nitBase(nit)) ?? null;
}

// ---------------------------------------------------------------------------
// Decisión de IVA por renglón
// ---------------------------------------------------------------------------
export type EleccionIva = { tax: ImpuestoConfigurado | null; motivo: string };

/**
 * IVA exacto de un renglón:
 * 1. Tarifa del documento con un único impuesto configurado → ese.
 * 2. Tarifa con varios impuestos → el que el proveedor usa históricamente.
 * 3. Sin tarifa en el documento → el impuesto histórico del proveedor solo si
 *    su tarifa cuadra al peso con el IVA del renglón (no se infiere de totales).
 */
export function elegirIva(params: {
  taxes: ImpuestoConfigurado[];
  linea: { iva: number; iva_rate: number | null; base: number };
  precedente: PrecedenteProveedor | null;
}): EleccionIva {
  const { linea, precedente } = params;
  if (!(linea.iva > 0)) return { tax: null, motivo: "" };
  const activos = params.taxes.filter((t) => t.kind === "iva" && t.active !== false);
  const usos = precedente?.iva ?? [];
  const puntaje = (t: ImpuestoConfigurado) =>
    usos
      .filter(
        (u) =>
          u.taxId === String(t.id) ||
          (!u.taxId && u.cuenta && cuentaCoincide(t.account_code, u.cuenta)),
      )
      .reduce((s, u) => s + u.veces, 0);
  const mejorPorPrecedente = (candidatos: ImpuestoConfigurado[]) => {
    const conPuntaje = candidatos
      .map((t) => ({ t, p: puntaje(t) }))
      .filter((x) => x.p > 0)
      .sort((a, b) => b.p - a.p);
    if (!conPuntaje.length) return null;
    if (conPuntaje.length > 1 && conPuntaje[0]!.p === conPuntaje[1]!.p) return null;
    return conPuntaje[0]!;
  };

  if (linea.iva_rate != null) {
    const mismaTarifa = activos.filter((t) => Number(t.rate) === Number(linea.iva_rate));
    if (mismaTarifa.length === 1)
      return { tax: mismaTarifa[0]!, motivo: "Único IVA configurado con la tarifa del documento." };
    if (mismaTarifa.length === 0)
      return { tax: null, motivo: `No hay IVA configurado del ${linea.iva_rate}%.` };
    const mejor = mejorPorPrecedente(mismaTarifa);
    if (mejor)
      return {
        tax: mejor.t,
        motivo: `IVA del ${linea.iva_rate}% que se le usa al proveedor (${mejor.p} vez/veces en Siigo).`,
      };
    return {
      tax: null,
      motivo: `Hay ${mismaTarifa.length} IVA del ${linea.iva_rate}% y el proveedor no tiene precedente: selecciónalo.`,
    };
  }

  const cuadran = activos.filter(
    (t) =>
      puntaje(t) > 0 &&
      linea.base > 0 &&
      Math.abs(roundCOP((linea.base * Number(t.rate)) / 100) - linea.iva) <= 1,
  );
  const mejor = mejorPorPrecedente(cuadran);
  if (mejor)
    return {
      tax: mejor.t,
      motivo: `IVA histórico del proveedor; su tarifa (${mejor.t.rate}%) cuadra con el renglón.`,
    };
  return { tax: null, motivo: "El documento no trae la tarifa de IVA: selecciónala." };
}

// ---------------------------------------------------------------------------
// Bases mínimas
// ---------------------------------------------------------------------------
export type ConceptoBase = {
  id: string;
  concepto: string;
  base_uvt: number;
  tarifa_declarante?: number | null;
  tarifa_no_declarante?: number | null;
  notas?: string | null;
};
export type TablaBases = { year: number; uvt: number; concepts: ConceptoBase[] };

export type BaseMinima = { valor: number; origen: string } | null;

/**
 * Base mínima en pesos de una retención para la fecha de la factura:
 * concepto asociado × UVT del año; si no tiene concepto, la base fija del registro.
 */
export function baseMinimaDe(
  tax: ImpuestoConfigurado,
  fecha: string | null,
  tablas: TablaBases[],
): BaseMinima {
  const anio = Number(String(fecha ?? "").slice(0, 4)) || new Date().getFullYear();
  if (tax.retention_concept) {
    const tabla = tablas.find((t) => t.year === anio);
    const concepto = tabla?.concepts.find((c) => c.id === tax.retention_concept);
    if (tabla && concepto) {
      return {
        valor: roundCOP(Number(concepto.base_uvt) * Number(tabla.uvt)),
        origen: `${concepto.concepto}: ${concepto.base_uvt} UVT × $${Number(tabla.uvt).toLocaleString("es-CO")} (${anio})`,
      };
    }
  }
  const fija = Number(tax.min_base ?? 0);
  return fija > 0
    ? { valor: roundCOP(fija), origen: `Base mínima configurada en ${tax.name}` }
    : null;
}

// ---------------------------------------------------------------------------
// Condición tributaria del proveedor (memoria confirmada por la usuaria)
// ---------------------------------------------------------------------------
export type MotivoSinRetencion =
  | "autorretenedor"
  | "regimen_especial"
  | "no_sujeto"
  | "gran_contribuyente"
  | "no_declarante"
  | "otro";

export const MOTIVO_LABEL: Record<MotivoSinRetencion, string> = {
  autorretenedor: "Autorretenedor",
  regimen_especial: "Régimen tributario especial (ESAL)",
  no_sujeto: "No sujeto / no contribuyente",
  gran_contribuyente: "Gran contribuyente",
  no_declarante: "No declarante / tarifa especial",
  otro: "Otra condición",
};

export type CondicionTributaria = {
  /** Retenciones que NO se le practican y por qué. */
  sinRetencion?: Partial<
    Record<RetencionKind, { motivo: MotivoSinRetencion; detalle?: string | null }>
  >;
  /** Retención que SÍ se le practica siempre, con el impuesto exacto (aunque no tenga precedente). */
  retenerCon?: Partial<Record<RetencionKind, string>>;
  confirmadoPor?: string | null;
  confirmadoEn?: string | null;
};

/** Lee la condición guardada en providers.purchase_tax_profile (convive con los demás datos del perfil). */
export function condicionDePerfil(perfil: unknown): CondicionTributaria | null {
  if (!perfil || typeof perfil !== "object") return null;
  const c = (perfil as { condicion_retencion?: unknown }).condicion_retencion;
  return c && typeof c === "object" ? (c as CondicionTributaria) : null;
}

/** Perfil actualizado con la nueva condición, conservando las demás claves (Excel RECIBIDOS, etc.). */
export function perfilConCondicion(
  perfil: unknown,
  condicion: CondicionTributaria | null,
): Record<string, unknown> {
  const base =
    perfil && typeof perfil === "object" ? { ...(perfil as Record<string, unknown>) } : {};
  if (!condicion) {
    delete base["condicion_retencion"];
    return base;
  }
  base["condicion_retencion"] = condicion;
  // Banderas que ya usa el flujo del Excel RECIBIDOS (calculatePurchase).
  const motivos = Object.values(condicion.sinRetencion ?? {}).map((s) => s?.motivo);
  if (motivos.includes("autorretenedor")) base["selfWithholder"] = true;
  if (motivos.includes("gran_contribuyente")) base["largeTaxpayer"] = true;
  if (motivos.includes("no_sujeto") || motivos.includes("regimen_especial"))
    base["nonSubject"] = true;
  return base;
}

// ---------------------------------------------------------------------------
// Decisión de retenciones
// ---------------------------------------------------------------------------
export type RetencionDecidida = {
  kind: RetencionKind;
  tax: ImpuestoConfigurado;
  base: number;
  amount: number;
  origen: string;
};

export type DecisionRetenciones = {
  aplicar: RetencionDecidida[];
  /** Explicaciones para la revisión (no bloquean). */
  avisos: string[];
  /** Pide confirmar la condición del proveedor; deja el borrador para revisión. */
  confirmar: string | null;
};

const ETIQUETA: Record<RetencionKind, string> = {
  retefuente: "Retefuente",
  reteiva: "ReteIVA",
  reteica: "ReteICA",
};
const pesos = (v: number) => `$${roundCOP(v).toLocaleString("es-CO")}`;

/**
 * Retenciones a practicar en una factura nueva, para los tipos que el documento
 * no trae (lo que viene del documento o de una regla por proveedor manda).
 * 1. Condición confirmada "no se le retiene X" → no se practica.
 * 2. Condición "retener siempre con T" o precedente en Siigo → impuesto T.
 * 3. Con impuesto: se practica solo si la base alcanza la base mínima del concepto.
 * 4. Retefuente sin precedente ni condición → se pide confirmación.
 */
export function decidirRetenciones(params: {
  kinds: RetencionKind[];
  precedente: PrecedenteProveedor | null;
  condicion: CondicionTributaria | null;
  taxes: ImpuestoConfigurado[];
  baseGravable: number;
  ivaTotal: number;
  fecha: string | null;
  tablas: TablaBases[];
}): DecisionRetenciones {
  const out: DecisionRetenciones = { aplicar: [], avisos: [], confirmar: null };
  const { precedente, condicion } = params;
  for (const kind of params.kinds) {
    const exento = condicion?.sinRetencion?.[kind];
    if (exento) {
      out.avisos.push(
        `${ETIQUETA[kind]}: no se practica (${MOTIVO_LABEL[exento.motivo]}${exento.detalle ? `: ${exento.detalle}` : ""}; condición confirmada).`,
      );
      continue;
    }
    const fijado = condicion?.retenerCon?.[kind];
    const uso = precedente?.retenciones[kind].find((u) => u.taxId) ?? null;
    const taxId = fijado ?? uso?.taxId ?? null;
    const tax = taxId
      ? params.taxes.find(
          (t) => String(t.id) === String(taxId) && t.kind === kind && t.active !== false,
        )
      : undefined;

    if (!tax) {
      if (taxId) {
        out.avisos.push(
          `${ETIQUETA[kind]}: el impuesto que se le aplicaba ya no está activo en Administración → Retenciones; revísalo.`,
        );
      } else if ((precedente?.retenciones[kind].length ?? 0) > 0) {
        const cuentas = precedente!.retenciones[kind]
          .map((u) => u.cuenta)
          .filter(Boolean)
          .join(", ");
        out.avisos.push(
          `${ETIQUETA[kind]}: históricamente se le retuvo (cuenta ${cuentas}), pero no se identificó el impuesto configurado; selecciónalo.`,
        );
      } else if (kind === "retefuente") {
        const n = precedente?.sinRetencion.retefuente ?? 0;
        out.confirmar =
          n > 0
            ? `En ${n} documento(s) sincronizados con Siigo no se le practicó retención en la fuente. Confirma su condición (autorretenedor, régimen especial, no sujeto…) o indica con qué concepto retenerle.`
            : "Proveedor sin precedente en Siigo: confirma si se le practica retención en la fuente (y con qué concepto) o su condición.";
      }
      continue;
    }

    const base = kind === "reteiva" ? roundCOP(params.ivaTotal) : roundCOP(params.baseGravable);
    if (!(base > 0)) continue;
    const origen = fijado
      ? "condición confirmada del proveedor"
      : `precedente en Siigo (${uso!.veces} vez/veces)`;
    const minima = baseMinimaDe(tax, params.fecha, params.tablas);
    if (minima && base < minima.valor) {
      out.avisos.push(
        `${ETIQUETA[kind]} (${tax.name}): no se practica porque la base ${pesos(base)} no alcanza la base mínima ${pesos(minima.valor)} (${minima.origen}).`,
      );
      continue;
    }
    if (!minima && kind === "retefuente") {
      out.avisos.push(
        `${ETIQUETA[kind]} (${tax.name}): sin base mínima configurada; se practicó sin verificarla (Administración → Bases mínimas).`,
      );
    }
    const amount = roundCOP((base * Number(tax.rate)) / 100);
    if (!(amount > 0)) continue;
    out.aplicar.push({ kind, tax, base, amount, origen });
  }
  return out;
}
