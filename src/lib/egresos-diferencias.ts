// DIFERENCIAS ENTRE EL PAGO Y LA CUENTA POR PAGAR — motor puro (núcleo global).
//
// Cuando lo pagado a una factura no es su saldo en Siigo, se calcula a qué se puede deber:
//   - pagó MENOS:  retención que el pago descontó pero no está causada (Retefuente,
//                  ReteIVA, ReteICA, solas o combinadas); descuento por pronto pago;
//                  comisión o gasto bancario del mismo día; anticipo o saldo a favor;
//                  ajuste al peso (hasta $1.000).
//   - pagó MÁS:    retención causada que el pago no descontó; excedente como anticipo;
//                  ajuste al peso.
// Solo explica: la corrección (editar la compra en Siigo) la confirma la usuaria.
import { roundCOP, tarifaPorcentaje } from "@/lib/money";

export type KindRetencion = "retefuente" | "reteiva" | "reteica";

/** Impuesto de retención del catálogo de la empresa (sincronizado de Siigo). */
export type ImpuestoRetencion = {
  siigoId: string;
  kind: KindRetencion;
  name: string;
  rate: number;
};

/** Compra leída de Siigo (lo necesario para recalcular retenciones como Siigo). */
export type CompraSiigo = {
  nombre: string; // FC-1-757
  subtotal: number;
  iva: number;
  /** Base de cada renglón (cantidad × precio − descuento). */
  renglones: number[];
  /** Retenciones causadas: id de Siigo, tipo y valor. */
  retenciones: Array<{ siigoId: string; kind: KindRetencion; name: string; valor: number }>;
};

export type AccionCorreccion = {
  tipo: "agregar" | "quitar";
  impuestos: Array<{ siigoId: string; kind: KindRetencion; name: string; valor: number }>;
};

export type CausaDiferencia = {
  causa:
    | "retencion_no_causada"
    | "retencion_no_descontada"
    | "descuento_pronto_pago"
    | "gasto_bancario"
    | "anticipo"
    | "ajuste_peso"
    | "excedente";
  descripcion: string;
  valor: number;
  /** La causa explica la diferencia al peso. */
  exacta: boolean;
  accion?: AccionCorreccion;
};

const TOL_EXACTA = 1;
const AJUSTE_PESO = 1000;
const fmt = (n: number) => `$${roundCOP(n).toLocaleString("es-CO")}`;

/** Valor de una retención como la calcula Siigo (Retefuente por renglón; ReteIVA sobre el IVA). */
export function valorRetencionSiigo(
  t: ImpuestoRetencion,
  compra: Pick<CompraSiigo, "subtotal" | "iva" | "renglones">,
): number {
  const pct = tarifaPorcentaje(t.kind, t.rate);
  if (!(pct > 0)) return 0;
  if (t.kind === "retefuente")
    return roundCOP(compra.renglones.reduce((s, b) => s + roundCOP((b * pct) / 100), 0));
  const base = t.kind === "reteiva" ? compra.iva : compra.subtotal;
  return roundCOP((base * pct) / 100);
}

/** Combinaciones de 1 a 3 elementos, a lo sumo uno por tipo de retención. */
function combinaciones<T extends { kind: string }>(xs: T[]): T[][] {
  const out: T[][] = [];
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    out.push([xs[i]!]);
    for (let j = i + 1; j < n; j++) {
      if (xs[j]!.kind === xs[i]!.kind) continue;
      out.push([xs[i]!, xs[j]!]);
      for (let k = j + 1; k < n; k++) {
        if (xs[k]!.kind === xs[i]!.kind || xs[k]!.kind === xs[j]!.kind) continue;
        out.push([xs[i]!, xs[j]!, xs[k]!]);
      }
    }
  }
  return out;
}

const ETIQUETA: Record<KindRetencion, string> = {
  retefuente: "Retefuente",
  reteiva: "ReteIVA",
  reteica: "ReteICA",
};
const nombreImp = (t: { kind: KindRetencion; name: string }) =>
  t.name.toUpperCase().includes(ETIQUETA[t.kind].toUpperCase())
    ? t.name
    : `${ETIQUETA[t.kind]} ${t.name}`;

export function explicarDiferencia(params: {
  saldo: number;
  pagado: number;
  compra: CompraSiigo | null;
  catalogo: ImpuestoRetencion[];
  /** Gastos bancarios (comisión, IVA, 4x1000) del mismo día y cuenta. */
  gastosBancariosMismoDia?: number[];
  /** Anticipos ya registrados al proveedor. */
  anticipos?: number[];
  /** Texto de la aplicación/observaciones del pago (p. ej. «saldo a favor»). */
  instruccion?: string | null;
}): { diferencia: number; causas: CausaDiferencia[] } {
  const diferencia = roundCOP(params.saldo - params.pagado); // > 0: pagó menos
  const causas: CausaDiferencia[] = [];
  if (Math.abs(diferencia) < 0.01) return { diferencia: 0, causas };
  const abs = Math.abs(diferencia);
  const compra = params.compra;

  if (compra) {
    if (diferencia > 0) {
      // Retenciones no causadas: del catálogo, de tipos que la compra aún no tiene.
      const tiene = new Set(compra.retenciones.map((r) => r.kind));
      const candidatas = params.catalogo
        .filter((t) => !tiene.has(t.kind))
        .map((t) => ({ ...t, valor: valorRetencionSiigo(t, compra) }))
        .filter((t) => t.valor > 0);
      for (const combo of combinaciones(candidatas)) {
        const v = roundCOP(combo.reduce((s, t) => s + t.valor, 0));
        const resto = roundCOP(diferencia - v);
        if (Math.abs(resto) > AJUSTE_PESO) continue;
        const exacta = Math.abs(resto) <= TOL_EXACTA;
        causas.push({
          causa: "retencion_no_causada",
          descripcion:
            `El pago descontó ${combo.map((t) => `${nombreImp(t)} (${fmt(t.valor)})`).join(" + ")} que no está causada en ${compra.nombre}` +
            (exacta ? "." : `; queda una diferencia de ${fmt(resto)} (ajuste al peso).`),
          valor: v,
          exacta,
          accion: {
            tipo: "agregar",
            impuestos: combo.map((t) => ({
              siigoId: t.siigoId,
              kind: t.kind,
              name: t.name,
              valor: t.valor,
            })),
          },
        });
      }
    } else {
      // Retenciones causadas que el pago no descontó.
      for (const combo of combinaciones(compra.retenciones)) {
        const v = roundCOP(combo.reduce((s, t) => s + t.valor, 0));
        const resto = roundCOP(abs - v);
        if (Math.abs(resto) > AJUSTE_PESO) continue;
        const exacta = Math.abs(resto) <= TOL_EXACTA;
        causas.push({
          causa: "retencion_no_descontada",
          descripcion:
            `${combo.map((t) => `${nombreImp(t)} (${fmt(t.valor)})`).join(" + ")} está causada en ${compra.nombre} pero el pago no la descontó (se pagó el total)` +
            (exacta ? "." : `; queda una diferencia de ${fmt(resto)} (ajuste al peso).`),
          valor: v,
          exacta,
          accion: { tipo: "quitar", impuestos: combo.map((t) => ({ ...t })) },
        });
      }
    }
  }

  if (diferencia > 0) {
    const pct = (diferencia / params.saldo) * 100;
    const redondo = Math.round(pct * 20) / 20; // múltiplos de 0,05 %
    if (pct >= 0.5 && pct <= 10 && Math.abs(pct - redondo) < 0.01)
      causas.push({
        causa: "descuento_pronto_pago",
        descripcion: `Descuento por pronto pago del ${redondo.toLocaleString("es-CO")} % sobre ${fmt(params.saldo)} (${fmt(diferencia)}).`,
        valor: diferencia,
        exacta: true,
      });
    const gastos = params.gastosBancariosMismoDia ?? [];
    const sumaGastos = roundCOP(gastos.reduce((s, g) => s + g, 0));
    if (
      gastos.some((g) => Math.abs(g - diferencia) <= TOL_EXACTA) ||
      (gastos.length > 1 && Math.abs(sumaGastos - diferencia) <= TOL_EXACTA)
    )
      causas.push({
        causa: "gasto_bancario",
        descripcion: `El banco descontó comisión/gastos del mismo día por ${fmt(diferencia)}: el pago al proveedor sería el saldo completo.`,
        valor: diferencia,
        exacta: true,
      });
    if (
      (params.anticipos ?? []).some((a) => Math.abs(a - diferencia) <= TOL_EXACTA) ||
      /SALDO A FAVOR|ANTICIPO|CRUZA/i.test(params.instruccion ?? "")
    )
      causas.push({
        causa: "anticipo",
        descripcion: `La diferencia de ${fmt(diferencia)} se cruzaría con un anticipo o saldo a favor del proveedor.`,
        valor: diferencia,
        exacta: (params.anticipos ?? []).some((a) => Math.abs(a - diferencia) <= TOL_EXACTA),
      });
  } else {
    causas.push({
      causa: "excedente",
      descripcion: `Se pagaron ${fmt(abs)} de más: pueden quedar como anticipo / saldo a favor del proveedor.`,
      valor: abs,
      exacta: false,
    });
  }
  if (abs <= AJUSTE_PESO && !causas.some((c) => c.exacta))
    causas.push({
      causa: "ajuste_peso",
      descripcion: `Diferencia de ${fmt(abs)} por redondeo (ajuste al peso).`,
      valor: abs,
      exacta: true,
    });

  // Primero las que explican la diferencia al peso, y entre ellas las de menos impuestos.
  causas.sort(
    (a, b) =>
      Number(b.exacta) - Number(a.exacta) ||
      (a.accion?.impuestos.length ?? 9) - (b.accion?.impuestos.length ?? 9),
  );
  return { diferencia, causas: causas.slice(0, 8) };
}

/** Lee la compra de Siigo (GET /v1/purchases/{id}) en la forma que usa el motor. */
export function compraDeSiigo(
  doc: {
    name?: string;
    items?: Array<{
      quantity?: number;
      price?: number;
      discount?: number | { value?: number } | null;
      taxes?: Array<{ id?: number | string; type?: string; name?: string; value?: number }>;
    }>;
    retentions?: Array<{ id?: number | string; type?: string; name?: string; value?: number }>;
  },
  catalogo: ImpuestoRetencion[],
): CompraSiigo {
  const porId = new Map(catalogo.map((t) => [String(t.siigoId), t]));
  const renglones = (doc.items ?? []).map((i) => {
    const descuento = typeof i.discount === "number" ? i.discount : Number(i.discount?.value ?? 0);
    return roundCOP(Number(i.quantity ?? 1) * Number(i.price ?? 0) - descuento);
  });
  let iva = 0;
  const ret = new Map<
    string,
    { siigoId: string; kind: KindRetencion; name: string; valor: number }
  >();
  const anotar = (t: { id?: number | string; type?: string; name?: string; value?: number }) => {
    const id = String(t.id ?? "");
    const tipo = String(t.type ?? "").toLowerCase();
    const cat = porId.get(id);
    const kind = (cat?.kind ??
      (/reteiva/.test(tipo)
        ? "reteiva"
        : /reteica/.test(tipo)
          ? "reteica"
          : /retefuente|retención|retencion/.test(tipo)
            ? "retefuente"
            : null)) as KindRetencion | null;
    if (!kind) {
      if (/iva/.test(tipo)) iva += Number(t.value ?? 0);
      return;
    }
    const previo = ret.get(id) ?? {
      siigoId: id,
      kind,
      name: cat?.name ?? String(t.name ?? kind),
      valor: 0,
    };
    previo.valor = roundCOP(previo.valor + Number(t.value ?? 0));
    ret.set(id, previo);
  };
  for (const i of doc.items ?? []) for (const t of i.taxes ?? []) anotar(t);
  for (const t of doc.retentions ?? []) anotar(t);
  return {
    nombre: String(doc.name ?? ""),
    subtotal: roundCOP(renglones.reduce((s, b) => s + b, 0)),
    iva: roundCOP(iva),
    renglones,
    retenciones: [...ret.values()],
  };
}

// ---------------------------------------------------------------------------
// Edición de la compra en Siigo (PUT /v1/purchases/{id})
// ---------------------------------------------------------------------------
export type DocCompra = {
  id?: string;
  name?: string;
  number?: number;
  date?: string;
  document?: { id?: number };
  supplier?: { identification?: string; branch_office?: number };
  cost_center?: number | null;
  provider_invoice?: { prefix?: string; number?: string | number } | null;
  observations?: string | null;
  discount_type?: string | null;
  supplier_by_item?: boolean | null;
  tax_included?: boolean | null;
  currency?: { code?: string; exchange_rate?: number } | null;
  items?: Array<{
    type?: string;
    code?: string;
    description?: string;
    quantity?: number;
    price?: number;
    discount?: number | { value?: number } | null;
    taxes?: Array<{ id?: number | string; type?: string; name?: string; value?: number }>;
    warehouse?: { id?: number } | number | null;
  }>;
  retentions?: Array<{ id?: number | string; type?: string; name?: string; value?: number }>;
  payments?: Array<{ id?: number; name?: string; value?: number; due_date?: string }>;
  balance?: number;
};

/** Cuerpo de edición (PUT) de la compra con la retención agregada o quitada. */
export function compraEditada(doc: DocCompra, accion: AccionCorreccion): Record<string, unknown> {
  const ids = new Set(accion.impuestos.map((t) => String(t.siigoId)));
  const retefuentes = accion.impuestos
    .filter((t) => t.kind === "retefuente")
    .map((t) => String(t.siigoId));
  const deDocumento = accion.impuestos
    .filter((t) => t.kind !== "retefuente")
    .map((t) => String(t.siigoId));
  const delta = Math.round(accion.impuestos.reduce((s, t) => s + t.valor, 0) * 100) / 100;
  const items = (doc.items ?? []).map((i) => {
    let taxes = (i.taxes ?? []).map((t) => String(t.id));
    if (accion.tipo === "quitar") taxes = taxes.filter((t) => !ids.has(t));
    else for (const id of retefuentes) if (!taxes.includes(id)) taxes.push(id);
    const descuento = typeof i.discount === "number" ? i.discount : Number(i.discount?.value ?? 0);
    const bodega = typeof i.warehouse === "number" ? i.warehouse : i.warehouse?.id;
    return {
      type: i.type,
      code: i.code,
      description: i.description,
      quantity: i.quantity,
      price: i.price,
      ...(descuento ? { discount: descuento } : {}),
      ...(bodega ? { warehouse: bodega } : {}),
      taxes: taxes.map((id) => ({ id: Number(id) })),
    };
  });
  let retenciones = (doc.retentions ?? []).map((r) => String(r.id));
  if (accion.tipo === "quitar") retenciones = retenciones.filter((r) => !ids.has(r));
  else for (const id of deDocumento) if (!retenciones.includes(id)) retenciones.push(id);
  // El neto por pagar cambia en el valor de la retención: se ajusta la forma de pago mayor (la CxP).
  const pagos = (doc.payments ?? []).map((p) => ({
    id: p.id,
    value: Number(p.value ?? 0),
    ...(p.due_date ? { due_date: p.due_date } : {}),
  }));
  if (!pagos.length) throw new Error("La compra no tiene formas de pago en Siigo.");
  const mayor = pagos.reduce((a, b) => (b.value > a.value ? b : a));
  mayor.value =
    Math.round((mayor.value + (accion.tipo === "agregar" ? -delta : delta)) * 100) / 100;
  if (mayor.value < 0)
    throw new Error("La forma de pago de la compra no alcanza para descontar la retención.");
  return cuerpoCompra(doc, items, retenciones, pagos);
}

/** Cuerpo completo de la compra para PUT /v1/purchases/{id} (lo que no cambia se conserva). */
export function cuerpoCompra(
  doc: DocCompra,
  items: Array<Record<string, unknown>>,
  retenciones: string[],
  pagos: Array<{ id?: number | undefined; value: number; due_date?: string }>,
): Record<string, unknown> {
  return {
    document: { id: doc.document?.id },
    // El número no se envía: Siigo lo rechaza en la edición («The number cannot be used»).
    date: doc.date,
    supplier: {
      identification: doc.supplier?.identification,
      branch_office: doc.supplier?.branch_office ?? 0,
    },
    ...(doc.cost_center ? { cost_center: doc.cost_center } : {}),
    ...(doc.provider_invoice?.number != null ? { provider_invoice: doc.provider_invoice } : {}),
    ...(doc.discount_type ? { discount_type: doc.discount_type } : {}),
    ...(doc.supplier_by_item != null ? { supplier_by_item: doc.supplier_by_item } : {}),
    ...(doc.tax_included != null ? { tax_included: doc.tax_included } : {}),
    ...(doc.currency?.code && doc.currency.code !== "COP" ? { currency: doc.currency } : {}),
    observations: doc.observations ?? "",
    items,
    ...(retenciones.length ? { retentions: retenciones.map((id) => ({ id: Number(id) })) } : {}),
    payments: pagos,
  };
}

/** Renglones de la compra tal como están (para editar solo otra parte del documento). */
export function itemsDeCompra(doc: DocCompra): Array<Record<string, unknown>> {
  return (doc.items ?? []).map((i) => {
    const descuento = typeof i.discount === "number" ? i.discount : Number(i.discount?.value ?? 0);
    const bodega = typeof i.warehouse === "number" ? i.warehouse : i.warehouse?.id;
    return {
      type: i.type,
      code: i.code,
      description: i.description,
      quantity: i.quantity,
      price: i.price,
      ...(descuento ? { discount: descuento } : {}),
      ...(bodega ? { warehouse: bodega } : {}),
      taxes: (i.taxes ?? []).map((t) => ({ id: Number(t.id) })),
    };
  });
}

/** La misma compra con una sola forma de pago por pagar (crédito) por el total de las formas actuales. */
export function compraPorPagar(
  doc: DocCompra,
  formaId: number,
  vencimiento: string,
): Record<string, unknown> {
  const total =
    Math.round((doc.payments ?? []).reduce((s, p) => s + Number(p.value ?? 0), 0) * 100) / 100;
  if (!(total > 0)) throw new Error("La compra no tiene valor en sus formas de pago.");
  return cuerpoCompra(
    doc,
    itemsDeCompra(doc),
    (doc.retentions ?? []).map((r) => String(r.id)),
    [{ id: formaId, value: total, due_date: vencimiento }],
  );
}
