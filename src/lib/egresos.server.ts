// Egresos y RP — lado servidor compartido (pantalla y revisión automática de Drive).
// Recibe el cliente de Supabase: el de la usuaria (RLS) o el de servicio (cron).
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  aprenderEgresos,
  conceptoDe,
  grupoBancario,
  nitSinDv,
  patronConcepto,
  proponerEgreso,
  type Contexto,
  type CuentaPorPagar,
  type MovAux,
  type MovimientoPago,
  type Propuesta,
  type ReglaBanco,
  type ReglaConcepto,
  unirVencimientos,
} from "@/lib/egresos";
import type { LecturaConsolidado } from "@/lib/lector-consolidado-pagos";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const PAGINA = 1000;
async function todas<T>(
  consulta: (
    desde: number,
    hasta: number,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  max = 50000,
) {
  const out: T[] = [];
  for (let desde = 0; desde < max; desde += PAGINA) {
    const { data, error } = await consulta(desde, desde + PAGINA - 1);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as T[];
    out.push(...filas);
    if (filas.length < PAGINA) break;
  }
  return out;
}

export type FilaEgreso = {
  id: string;
  company_id: string;
  period: string;
  clave: string;
  fila: number | null;
  fecha: string;
  descripcion: string | null;
  tercero_nombre: string | null;
  tercero_nit: string | null;
  valor: number;
  cuenta_etiqueta: string | null;
  relacion: string | null;
  aplicacion: string | null;
  observaciones: string | null;
  tipo: string;
  propuesta: Propuesta | Record<string, never>;
  estado: string;
  motivos: string[];
  editado_por_usuaria: boolean;
  siigo_id: string | null;
  siigo_nombre: string | null;
};

export function movimientoDeFila(f: FilaEgreso): MovimientoPago {
  return {
    clave: f.clave,
    fila: f.fila,
    fecha: String(f.fecha).slice(0, 10),
    descripcion: f.descripcion,
    tercero: f.tercero_nombre,
    terceroNit: f.tercero_nit,
    valor: Number(f.valor),
    cuenta: f.cuenta_etiqueta,
    relacion: f.relacion,
    aplicacion: f.aplicacion,
    observaciones: f.observaciones,
    referencia: null,
  };
}

/** Contexto para proponer: CxP, terceros, reglas, precedente del auxiliar y facturas causadas. */
export async function cargarContexto(db: Db, companyId: string): Promise<Contexto> {
  const [cxp, provs, reglas, hist, causadas, puc] = await Promise.all([
    todas<{
      prefix: string;
      consecutive: number;
      quote: number;
      due_date: string | null;
      balance: number;
      provider_nit: string | null;
      provider_name: string | null;
      factura_proveedor: string | null;
      siigo_purchase_id: string | null;
    }>((a, b) =>
      db
        .from("siigo_cuentas_por_pagar")
        .select(
          "prefix, consecutive, quote, due_date, balance, provider_nit, provider_name, factura_proveedor, siigo_purchase_id",
        )
        .eq("company_id", companyId)
        .range(a, b),
    ),
    todas<{ nit: string; name: string }>((a, b) =>
      db.from("providers").select("nit, name").eq("company_id", companyId).range(a, b),
    ),
    todas<{
      clase: string;
      patron: string;
      tipo: string | null;
      cuenta_debito: string | null;
      tercero_nit: string | null;
      cuenta_banco: string | null;
      payment_type_id: string | null;
    }>((a, b) =>
      db
        .from("egreso_reglas")
        .select("clase, patron, tipo, cuenta_debito, tercero_nit, cuenta_banco, payment_type_id")
        .eq("company_id", companyId)
        .range(a, b),
    ),
    todas<MovAux>(
      (a, b) =>
        db
          .from("accounting_history")
          .select(
            "voucher, account_code, account_name, provider_nit, provider_name, description, detail, debit, credit",
          )
          .eq("company_id", companyId)
          .or("voucher.ilike.CE-%,voucher.ilike.RP-%")
          .range(a, b),
      30000,
    ).catch(() => [] as MovAux[]),
    todas<{
      prefix: string | null;
      number: string | null;
      provider_nit: string | null;
      siigo_number: string | null;
      siigo_id: string | null;
    }>((a, b) =>
      db
        .from("invoices")
        .select("prefix, number, provider_nit, siigo_number, siigo_id")
        .eq("company_id", companyId)
        .not("siigo_number", "is", null)
        .range(a, b),
    ),
    todas<{ code: string; name: string | null }>((a, b) =>
      db.from("puc_accounts").select("code, name").eq("company_id", companyId).range(a, b),
    ),
  ]);
  return {
    cxp: cxp.map((c): CuentaPorPagar => ({
      prefix: c.prefix,
      consecutive: Number(c.consecutive),
      quote: Number(c.quote ?? 1),
      dueDate: c.due_date,
      balance: Number(c.balance),
      providerNit: c.provider_nit,
      providerName: c.provider_name,
      facturaProveedor: c.factura_proveedor,
      siigoPurchaseId: c.siigo_purchase_id,
    })),
    causadas: causadas.map((c) => ({
      factura: [c.prefix, c.number].filter(Boolean).join("-"),
      nit: c.provider_nit,
      siigo: c.siigo_number,
      siigoId: c.siigo_id,
    })),
    // Terceros: proveedores y los de los egresos ya registrados en Siigo (empleados, entidades).
    terceros: [
      ...provs.filter((p) => p.nit && p.name).map((p) => ({ nit: p.nit, nombre: p.name })),
      ...hist
        .filter((h) => h.provider_nit && h.provider_name)
        .map((h) => ({ nit: String(h.provider_nit), nombre: String(h.provider_name) })),
    ],
    bancos: reglas.filter((r) => r.clase === "banco") as ReglaBanco[],
    conceptos: reglas.filter((r) => r.clase === "concepto") as ReglaConcepto[],
    precedente: hist.length ? aprenderEgresos(hist) : null,
    puc: new Set(puc.map((p) => p.code)),
    cuentasBanco: puc
      .filter((p) => /^11(05|10|20)/.test(p.code))
      .map((p) => ({ code: p.code, name: p.name ?? "" })),
  };
}

/** Guarda los pagos leídos del reporte: nuevos se insertan; los existentes actualizan sus datos de origen. */
export async function guardarLectura(
  db: Db,
  companyId: string,
  lectura: Pick<LecturaConsolidado, "periodo" | "egresos">,
  archivo: string | null,
): Promise<{ nuevos: number; actualizados: number; periodo: string | null }> {
  if (!lectura.periodo) throw new Error("No se pudo determinar el mes del reporte de pagos.");
  const existentes = await todas<{ clave: string; id: string; siigo_id: string | null }>((a, b) =>
    db
      .from("egresos")
      .select("clave, id, siigo_id")
      .eq("company_id", companyId)
      .eq("period", lectura.periodo!)
      .range(a, b),
  );
  const porClave = new Map(existentes.map((e) => [e.clave, e]));
  const nuevos = lectura.egresos.filter((e) => !porClave.has(e.clave));
  let actualizados = 0;
  if (nuevos.length) {
    for (let i = 0; i < nuevos.length; i += 500) {
      const { error } = await db.from("egresos").insert(
        nuevos.slice(i, i + 500).map((e) => ({
          company_id: companyId,
          period: lectura.periodo!,
          origen: "excel",
          origen_archivo: archivo,
          clave: e.clave,
          fila: e.fila,
          fecha: e.fecha,
          descripcion: e.descripcion,
          tercero_nombre: e.tercero,
          tercero_nit: e.terceroNit,
          valor: e.valor,
          cuenta_etiqueta: e.cuenta,
          relacion: e.relacion,
          aplicacion: e.aplicacion,
          observaciones: e.observaciones,
        })),
      );
      if (error) throw new Error(`No se guardaron los pagos: ${error.message}`);
    }
  }
  // El equipo completa RELACIÓN / APLICACIÓN / OBSERVACIONES durante el mes: se actualizan
  // (en lotes) los que cambiaron y aún no están en Siigo.
  const completas = await todas<FilaEgreso>((a, b) =>
    db
      .from("egresos")
      .select("*")
      .eq("company_id", companyId)
      .eq("period", lectura.periodo!)
      .is("siigo_id", null)
      .range(a, b),
  );
  const actual = new Map(completas.map((f) => [f.clave, f]));
  const cambios: FilaEgreso[] = [];
  for (const e of lectura.egresos) {
    const f = actual.get(e.clave);
    if (!f || !porClave.has(e.clave)) continue;
    if (
      f.tercero_nombre === e.tercero &&
      f.relacion === e.relacion &&
      f.aplicacion === e.aplicacion &&
      f.observaciones === e.observaciones &&
      f.fila === e.fila
    )
      continue;
    cambios.push({
      ...f,
      tercero_nombre: e.tercero,
      relacion: e.relacion,
      aplicacion: e.aplicacion,
      observaciones: e.observaciones,
      fila: e.fila,
    });
  }
  await guardarFilas(db, cambios);
  actualizados = cambios.length;
  return { nuevos: nuevos.length, actualizados, periodo: lectura.periodo };
}

/** Recalcula la propuesta de los egresos del mes que no están en Siigo ni editados a mano. */
export async function proponerPeriodo(db: Db, companyId: string, periodo: string, ctx?: Contexto) {
  const contexto = ctx ?? (await cargarContexto(db, companyId));
  const filas = await todas<FilaEgreso>((a, b) =>
    db
      .from("egresos")
      .select("*")
      .eq("company_id", companyId)
      .eq("period", periodo)
      .is("siigo_id", null)
      .range(a, b),
  );
  let listos = 0;
  let porRevisar = 0;
  const cambios: FilaEgreso[] = [];
  for (const f of filas) {
    if (f.editado_por_usuaria || ["enviando", "enviado", "aprobado"].includes(f.estado)) {
      // Lo revisado a mano se conserva; solo se le asigna su RP mensual de gastos bancarios.
      const prev = f.propuesta as Propuesta;
      if (f.estado === "enviando" || f.estado === "enviado" || prev?.tipo !== "detallado") continue;
      const grupo = grupoBancario(conceptoDe(movimientoDeFila(f))?.id ?? null, f.cuenta_etiqueta);
      if ((prev.grupo ?? null) !== grupo) cambios.push({ ...f, propuesta: { ...prev, grupo } });
      continue;
    }
    const p = proponerEgreso(movimientoDeFila(f), contexto);
    const estado = p.tipo === "omitir" && p.listo ? "omitido" : p.listo ? "listo" : "por_revisar";
    if (estado === "listo") listos += 1;
    if (estado === "por_revisar") porRevisar += 1;
    cambios.push({
      ...f,
      tipo: p.tipo,
      propuesta: p,
      estado,
      motivos: p.motivos,
      tercero_nit: p.terceroNit ?? f.tercero_nit,
    });
  }
  await guardarFilas(db, cambios);
  return { total: filas.length, listos, porRevisar };
}

/** Escribe filas completas en lotes (upsert por id): pocas llamadas aunque sean cientos de pagos. */
async function guardarFilas(db: Db, filas: FilaEgreso[]) {
  for (let i = 0; i < filas.length; i += 300) {
    const lote = filas.slice(i, i + 300).filter((f) => !f.siigo_id);
    if (!lote.length) continue;
    const { error } = await db.from("egresos").upsert(lote, { onConflict: "id" });
    if (error) throw new Error(`No se guardaron los egresos: ${error.message}`);
  }
}

/** Aprende de una corrección de la usuaria: el concepto del pago queda con su tipo, cuenta y tercero. */
export async function aprenderDeEdicion(db: Db, companyId: string, f: FilaEgreso, p: Propuesta) {
  const patron = patronConcepto(movimientoDeFila(f));
  if (p.tipo === "pago_facturas") return null; // las facturas son de cada pago, no un concepto
  const cuentaDebito =
    p.tipo === "detallado" ? (p.cuentas.find((c) => c.movimiento === "Debit")?.code ?? null) : null;
  const { data: previa } = await db
    .from("egreso_reglas")
    .select("id, veces")
    .eq("company_id", companyId)
    .eq("clase", "concepto")
    .eq("patron", patron)
    .maybeSingle();
  const fila = {
    company_id: companyId,
    clase: "concepto",
    patron,
    tipo: p.tipo,
    cuenta_debito: cuentaDebito,
    tercero_nit: p.terceroNit ? nitSinDv(p.terceroNit) : null,
  };
  if (previa)
    await db
      .from("egreso_reglas")
      .update({ ...fila, veces: Number(previa.veces ?? 1) + 1 })
      .eq("id", previa.id);
  else await db.from("egreso_reglas").insert(fila);
  return patron;
}

// ---------------------------------------------------------------------------
// Siigo: cuentas por pagar
// ---------------------------------------------------------------------------
type DueSiigo = {
  due?: {
    prefix?: string;
    consecutive?: number | string;
    quote?: number | string;
    date?: string;
    balance?: number;
  };
  provider?: { identification?: number | string; name?: string };
  cost_center?: { code?: string; name?: string };
};

export async function sincronizarCxP(
  db: Db,
  companyId: string,
  opts: { soloNit?: string | null } = {},
) {
  const { siigoGet, siigoUseCompany } = await import("./siigo.server");
  await siigoUseCompany(companyId);
  // Marca de esta lectura: lo que no se vuelva a marcar ya no está en Siigo (pagado).
  const inicio = new Date().toISOString();
  const filtroNit = opts.soloNit
    ? `&provider_identification=${encodeURIComponent(opts.soloNit)}`
    : "";
  const vencimientos: DueSiigo[] = [];
  for (let page = 1; page <= 40; page++) {
    const r = await siigoGet<
      { results?: DueSiigo[]; pagination?: { total_results?: number } } | DueSiigo[]
    >(`/v1/accounts-payable?page=${page}&page_size=100${filtroNit}`);
    const lista = Array.isArray(r) ? r : (r.results ?? []);
    // Si Siigo repite una página completa (paginación ignorada), no se sigue pidiendo.
    const firma = (v: DueSiigo) =>
      `${v.due?.prefix}|${v.due?.consecutive}|${v.due?.quote ?? 1}|${v.due?.balance}|${v.cost_center?.code ?? ""}|${v.provider?.identification ?? ""}`;
    const vistas = new Set(vencimientos.map(firma));
    if (lista.length && lista.every((v) => vistas.has(firma(v)))) break;
    vencimientos.push(...lista);
    const total = Array.isArray(r) ? lista.length : Number(r.pagination?.total_results ?? 0);
    if (lista.length < 100 || (total && vencimientos.length >= total)) break;
  }
  const filas = unirVencimientos(
    vencimientos
      .filter((v) => v.due?.prefix && v.due?.consecutive != null)
      .map((v) => ({
        company_id: companyId,
        prefix: String(v.due!.prefix).trim(),
        consecutive: Number(v.due!.consecutive),
        quote: Number(v.due!.quote ?? 1) || 1,
        due_date: v.due!.date ? String(v.due!.date).slice(0, 10) : null,
        balance: Number(v.due!.balance ?? 0),
        provider_nit: v.provider?.identification != null ? String(v.provider.identification) : null,
        provider_name: v.provider?.name ?? null,
        cost_center: v.cost_center?.code ?? null,
        factura_proveedor: null as string | null,
        invoice_id: null as string | null,
        siigo_purchase_id: null as string | null,
        synced_at: inicio,
      })),
  );
  // Lo que se debe al proveedor viene en POSITIVO; un saldo a favor (anticipo) viene negativo
  // y no se paga. Cada vencimiento del reporte se identifica por la FACTURA DEL PROVEEDOR
  // (prefijo y número, p. ej. A-5201365004): es el documento cruce de la CxP en Siigo.
  const compacto = (x: unknown) =>
    String(x ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const nitDe = (x: unknown) => nitSinDv(String(x ?? ""));

  // Listado de compras de Siigo (creadas en los últimos 150 días): factura del proveedor,
  // identificador y saldo pendiente de cada compra. Sirve para ligar cada vencimiento con
  // su compra y para agregar las compras con saldo que el reporte de CxP no trae.
  type Compra = {
    id?: string;
    name?: string;
    date?: string;
    balance?: number;
    supplier?: { identification?: string | number };
    provider_invoice?: { prefix?: string; number?: string | number };
    payments?: Array<{ due_date?: string }>;
  };
  const compras: Compra[] = [];
  let leidasSiigo = 0;
  if (!opts.soloNit) {
    const desde = new Date();
    desde.setUTCDate(desde.getUTCDate() - 150);
    for (let page = 1; page <= 20; page++) {
      let lista: Compra[] = [];
      try {
        const r = await siigoGet<{ results?: Compra[] } | Compra[]>(
          // El listado de compras de Siigo filtra por fecha de CREACIÓN (created_start).
          `/v1/purchases?created_start=${desde.toISOString().slice(0, 10)}&page=${page}&page_size=100`,
        );
        lista = Array.isArray(r) ? r : (r.results ?? []);
      } catch {
        break;
      }
      compras.push(...lista);
      leidasSiigo += lista.length;
      if (lista.length < 100) break;
    }
  }
  const facturaDe = (c: Compra) =>
    c.provider_invoice?.number != null && String(c.provider_invoice.number).trim()
      ? [c.provider_invoice.prefix, c.provider_invoice.number]
          .filter((x) => x != null && String(x).trim())
          .join("-")
      : null;
  const compraPorNombre = new Map(
    compras.filter((c) => c.name).map((c) => [String(c.name).toUpperCase(), c]),
  );
  const compraPorFactura = new Map<string, Compra>();
  for (const c of compras) {
    const f = facturaDe(c);
    if (f) compraPorFactura.set(`${nitDe(c.supplier?.identification)}|${compacto(f)}`, c);
  }

  // Ligar cada vencimiento del reporte con su compra.
  const ligadas = new Set<string>();
  for (const f of filas) {
    const porFc = compraPorNombre.get(`${f.prefix}-${f.consecutive}`.toUpperCase());
    if (porFc) {
      // Vencimiento identificado por el comprobante (FC-1-…).
      f.factura_proveedor = facturaDe(porFc);
      f.siigo_purchase_id = porFc.id ?? null;
      ligadas.add(String(porFc.id));
      continue;
    }
    f.factura_proveedor = [f.prefix, f.consecutive].filter((x) => String(x ?? "").trim()).join("-");
    const c = compraPorFactura.get(`${nitDe(f.provider_nit)}|${compacto(f.factura_proveedor)}`);
    if (c) {
      f.siigo_purchase_id = c.id ?? null;
      ligadas.add(String(c.id));
    }
  }

  // Compras con saldo que el reporte no trae: se agregan identificadas por la factura del
  // proveedor (como el reporte) o, si no tiene número, por su comprobante.
  let agregadasDeCompras = 0;
  const claves = new Set(filas.map((f) => `${f.prefix}|${f.consecutive}|${f.quote}`.toUpperCase()));
  for (const c of compras) {
    const saldo = Math.round(Number(c.balance ?? 0) * 100) / 100;
    if (!(saldo > 0.009) || ligadas.has(String(c.id))) continue;
    const pi = c.provider_invoice;
    const numero = String(pi?.number ?? "").trim();
    const fc = /^(.*)-(\d+)$/.exec(String(c.name ?? "").trim());
    const clave = /^\d+$/.test(numero)
      ? { prefix: String(pi?.prefix ?? "").trim(), consecutive: Number(numero) }
      : fc
        ? { prefix: fc[1]!, consecutive: Number(fc[2]) }
        : null;
    if (!clave) continue;
    const k = `${clave.prefix}|${clave.consecutive}|1`.toUpperCase();
    if (claves.has(k)) continue;
    claves.add(k);
    filas.push({
      company_id: companyId,
      prefix: clave.prefix,
      consecutive: clave.consecutive,
      quote: 1,
      due_date:
        String(c.payments?.find((p) => p.due_date)?.due_date ?? c.date ?? "").slice(0, 10) || null,
      balance: saldo,
      provider_nit: c.supplier?.identification != null ? String(c.supplier.identification) : null,
      provider_name: null,
      cost_center: null,
      factura_proveedor: facturaDe(c),
      invoice_id: null,
      siigo_purchase_id: c.id ?? null,
      synced_at: inicio,
    });
    agregadasDeCompras += 1;
  }

  // Lo ya conocido de cada vencimiento (compra de Siigo) se conserva.
  for (let i = 0; i < filas.length; i += 200) {
    const lote = filas.slice(i, i + 200);
    const { data } = await db
      .from("siigo_cuentas_por_pagar")
      .select("prefix, consecutive, quote, factura_proveedor, siigo_purchase_id")
      .eq("company_id", companyId)
      .in(
        "consecutive",
        lote.map((f) => f.consecutive),
      );
    const conocidos = new Map(
      (
        (data ?? []) as Array<{
          prefix: string;
          consecutive: number;
          quote: number;
          factura_proveedor: string | null;
          siigo_purchase_id: string | null;
        }>
      ).map((c) => [`${c.prefix}|${c.consecutive}|${c.quote}`, c]),
    );
    for (const f of lote) {
      const c = conocidos.get(`${f.prefix}|${f.consecutive}|${f.quote}`);
      f.factura_proveedor = f.factura_proveedor ?? c?.factura_proveedor ?? null;
      f.siigo_purchase_id = f.siigo_purchase_id ?? c?.siigo_purchase_id ?? null;
    }
  }

  // Compras causadas desde la herramienta: se ligan por el identificador de Siigo.
  const ids = [...new Set(filas.map((f) => f.siigo_purchase_id).filter((x): x is string => !!x))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db
      .from("invoices")
      .select("id, siigo_id, provider_name")
      .eq("company_id", companyId)
      .in("siigo_id", ids.slice(i, i + 200));
    const porId = new Map(
      ((data ?? []) as Array<{ id: string; siigo_id: string; provider_name: string | null }>).map(
        (x) => [x.siigo_id, x],
      ),
    );
    for (const f of filas) {
      const inv = f.siigo_purchase_id ? porId.get(f.siigo_purchase_id) : undefined;
      if (inv) {
        f.invoice_id = inv.id;
        f.provider_name = f.provider_name ?? inv.provider_name;
      }
    }
  }

  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await db
      .from("siigo_cuentas_por_pagar")
      .upsert(filas.slice(i, i + 500), { onConflict: "company_id,prefix,consecutive,quote" });
    if (error) throw new Error(`No se guardaron las cuentas por pagar: ${error.message}`);
  }
  // Lo que ya no aparece en Siigo está pagado. Al leer un solo proveedor no se borra nada:
  // las CxP tomadas del listado de compras solo se renuevan en la sincronización completa.
  if (!opts.soloNit)
    await db
      .from("siigo_cuentas_por_pagar")
      .delete()
      .eq("company_id", companyId)
      .lt("synced_at", inicio);
  return {
    vencimientos: filas.length,
    saldo: Math.round(filas.reduce((s, f) => s + f.balance, 0) * 100) / 100,
    sinFactura: filas.filter((f) => !f.factura_proveedor).length,
    comprasLeidas: leidasSiigo,
    agregadasDeCompras,
  };
}

/** Sugerencia de cuenta de banco/caja y forma de pago para cada origen de pago aún sin regla. */
export async function sugerirBancos(db: Db, companyId: string, etiquetas: string[]) {
  const { data: formas } = await db
    .from("siigo_payment_types")
    .select("siigo_id, name, account_code, account_name, active, due_date_required")
    .eq("company_id", companyId);
  const { data: reglas } = await db
    .from("egreso_reglas")
    .select("patron")
    .eq("company_id", companyId)
    .eq("clase", "banco");
  const conRegla = new Set(
    ((reglas ?? []) as Array<{ patron: string }>).map((r) => r.patron.toUpperCase()),
  );
  const activas = (
    (formas ?? []) as Array<{
      siigo_id: string;
      name: string;
      account_code: string | null;
      account_name: string | null;
      active: boolean;
      due_date_required: boolean;
    }>
  ).filter(
    (f) =>
      f.active !== false &&
      !f.due_date_required &&
      f.account_code &&
      /^11(05|10|20)/.test(f.account_code),
  );
  const creadas: string[] = [];
  for (const etiqueta of [...new Set(etiquetas.filter(Boolean))]) {
    const k = etiqueta.toUpperCase().trim();
    if (conRegla.has(k)) continue;
    const palabra =
      k === "EFECTIVO" || k === "CAJA"
        ? /EFECTIVO|CAJA/
        : new RegExp(
            k
              .replace(/[^A-Z0-9 ]/g, "")
              .split(" ")
              .filter((w) => w.length > 3)
              .join("|") || "^$",
          );
    const candidatas = activas.filter((f) =>
      palabra.test(`${f.name} ${f.account_name ?? ""}`.toUpperCase()),
    );
    if (candidatas.length !== 1) continue;
    const c = candidatas[0]!;
    const { error } = await db.from("egreso_reglas").insert({
      company_id: companyId,
      clase: "banco",
      patron: k,
      cuenta_banco: c.account_code,
      payment_type_id: c.siigo_id,
      notas: `Sugerida: forma de pago «${c.name}» (${c.account_code}). Cámbiala si no corresponde.`,
    });
    if (!error) creadas.push(`${k} → ${c.name}`);
  }
  return creadas;
}
