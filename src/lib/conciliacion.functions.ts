// Conciliación bancaria — funciones de servidor (núcleo global: todas las empresas).
//   conciliacionFuentes: extractos del mes (bandeja de egresos: Excel de los bancos y, con
//     el lector del reporte mensual, sus hojas de bancos y efectivo), RP enviados desde la
//     herramienta, RC de la API de Siigo y la conciliación guardada del mes anterior.
//   conciliacionGuardar: guarda el resultado por cuenta (partidas al corte) para el mes siguiente.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { MovBanco, MovLibro, PartidaConciliatoria } from "@/lib/conciliacion";

export type CuentaConciliable = {
  etiqueta: string;
  cuentaContable: string | null;
  fuente: string | null;
  movimientos: MovBanco[];
  saldoInicial: number | null;
  saldoFinal: number | null;
  advertencias: string[];
};

export type FuentesConciliacion = {
  cuentas: CuentaConciliable[];
  /** RP creados desde la herramienta (comprobante, cuenta, valor). */
  rpEnviados: Array<MovLibro & { cuenta: string | null; grupo: string | null; egresoId: string }>;
  /** Pagos del mes en la herramienta sin RP en Siigo (para el listado de RP faltantes). */
  egresosPendientes: Array<{
    id: string;
    fecha: string;
    valor: number;
    cuenta: string | null;
    descripcion: string | null;
    estado: string;
  }>;
  /** Recibos de caja de la API de Siigo (con la cuenta si se identificó por la forma de pago). */
  rcApi: Array<MovLibro & { cuenta: string | null; formaPago: string | null }>;
  anterior: Array<{
    cuenta: string;
    partidas: PartidaConciliatoria[];
    saldoLibrosFinal: number | null;
    saldoExtractoFinal: number | null;
  }>;
  advertencias: string[];
};

const N = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** La etiqueta de la cuenta (CORRIENTE, AHORROS…) aparece en el nombre del archivo o de la hoja. */
const coincideEtiqueta = (etiqueta: string, texto: string) => {
  const t = N(texto);
  const palabras = N(etiqueta)
    .split(" ")
    .filter((w) => w.length >= 4)
    .map((w) => w.replace(/S$/, ""));
  if (/EFECTIVO|CAJA/.test(N(etiqueta))) return /EFECTIVO|CAJA/.test(t);
  return palabras.some((w) => t.includes(w));
};

const mesAnterior = (periodo: string) => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(a, m - 2, 1));
  return d.toISOString().slice(0, 7);
};

export const conciliacionFuentes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; periodo: string }) => {
    if (!input?.companyId || !/^\d{4}-\d{2}$/.test(input.periodo ?? ""))
      throw new Error("Empresa y mes requeridos.");
    return input;
  })
  .handler(async ({ data, context }): Promise<FuentesConciliacion> => {
    const db = context.supabase;
    // Pertenencia a la empresa (RLS).
    const { data: empresa, error } = await db
      .from("companies")
      .select("id, nit")
      .eq("id", data.companyId)
      .single();
    if (error || !empresa) throw new Error("Empresa no encontrada.");
    const advertencias: string[] = [];
    const [anio, mes] = data.periodo.split("-").map(Number) as [number, number];
    const fin = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
    const { etiquetaPeriodo } = await import("./drive-sync");
    const etiqueta = etiquetaPeriodo({ anio, mes });

    // Cuentas a conciliar: los orígenes de pago con su cuenta de banco/caja.
    const { data: reglas } = await db
      .from("egreso_reglas")
      .select("patron, cuenta_banco, payment_type_id")
      .eq("company_id", data.companyId)
      .eq("clase", "banco");
    const cuentas: CuentaConciliable[] = (
      (reglas ?? []) as Array<{ patron: string; cuenta_banco: string | null }>
    ).map((r) => ({
      etiqueta: r.patron,
      cuentaContable: r.cuenta_banco,
      fuente: null,
      movimientos: [],
      saldoInicial: null,
      saldoFinal: null,
      advertencias: [],
    }));
    if (!cuentas.length)
      advertencias.push(
        "No hay cuentas configuradas: asigna en Egresos y pagos la forma de pago y la cuenta de banco/caja de cada origen.",
      );

    // Extractos del mes en la bandeja de egresos.
    const { data: docs } = await db
      .from("payment_documents")
      .select("id, kind, file_name, storage_path, created_at")
      .eq("company_id", data.companyId)
      .eq("period", etiqueta)
      .in("kind", ["extracto", "relacion_pagos"])
      .order("created_at", { ascending: false });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const bajar = async (ruta: string) => {
      const { data: blob, error: e } = await supabaseAdmin.storage.from("facturas").download(ruta);
      if (e || !blob) throw new Error(e?.message ?? "No se pudo leer el archivo.");
      return new Uint8Array(await blob.arrayBuffer());
    };
    const lectores = await import("./lectores-extracto");
    const lista = (docs ?? []) as Array<{ kind: string; file_name: string; storage_path: string }>;
    for (const c of cuentas) {
      const doc = lista.find(
        (d) =>
          d.kind === "extracto" &&
          /\.(xlsx|xls)$/i.test(d.file_name) &&
          coincideEtiqueta(c.etiqueta, d.file_name),
      );
      if (!doc) continue;
      try {
        const ext = lectores.leerExtractoBancolombia(
          await bajar(doc.storage_path),
          N(c.etiqueta).slice(0, 3),
        );
        const usable = ext.movimientos.length
          ? ext
          : lectores.leerExtractoGenerico(await bajar(doc.storage_path), N(c.etiqueta).slice(0, 3));
        Object.assign(c, {
          fuente: doc.file_name,
          movimientos: usable.movimientos,
          saldoInicial: ext.saldoInicial,
          saldoFinal: ext.saldoFinal,
          advertencias: usable.advertencias,
        });
      } catch (e) {
        c.advertencias.push(`${doc.file_name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Reporte mensual de pagos (empresas con ese lector): hojas de bancos sin extracto en
    // Excel y hoja de efectivo; su hoja Consolidado cita los comprobantes de cada movimiento.
    const { funcionActiva } = await import("@/empresas/registro");
    const relacion = lista.find((d) => d.kind === "relacion_pagos");
    if (relacion && funcionActiva(empresa.nit, "lector_consolidado_pagos")) {
      try {
        const wb = lectores.libro(await bajar(relacion.storage_path));
        const relaciones = lectores.relacionesConsolidado(wb);
        for (const c of cuentas) {
          if (!c.movimientos.length) {
            const hoja = /EFECTIVO|CAJA/.test(N(c.etiqueta))
              ? lectores.leerHojaEfectivo(wb, "caja")
              : lectores.leerHojaBanco(
                  wb,
                  new RegExp(
                    N(c.etiqueta)
                      .split(" ")
                      .filter((w) => w.length >= 4)
                      .map((w) => w.replace(/S$/, ""))
                      .join("|") || "^$",
                    "i",
                  ),
                  N(c.etiqueta).slice(0, 3),
                );
            if (hoja?.movimientos.length)
              Object.assign(c, {
                fuente: `${relacion.file_name} (hoja de ${c.etiqueta})`,
                movimientos: hoja.movimientos,
                saldoInicial: hoja.saldoInicial,
                saldoFinal: hoja.saldoFinal,
              });
          }
          c.movimientos = lectores.citarRelaciones(c.movimientos, relaciones, c.etiqueta);
        }
      } catch (e) {
        advertencias.push(
          `Reporte mensual de pagos: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    for (const c of cuentas)
      if (!c.movimientos.length)
        c.advertencias.push(
          `No se encontró el extracto de ${c.etiqueta} de ${etiqueta}: cárgalo a mano.`,
        );

    // RP enviados y pagos aún sin RP (módulo de egresos).
    const { data: egresos } = await db
      .from("egresos")
      .select(
        "id, fecha, valor, cuenta_etiqueta, descripcion, tercero_nombre, siigo_nombre, estado, propuesta, tipo",
      )
      .eq("company_id", data.companyId)
      .eq("period", data.periodo);
    const rpEnviados: FuentesConciliacion["rpEnviados"] = [];
    const egresosPendientes: FuentesConciliacion["egresosPendientes"] = [];
    for (const e of (egresos ?? []) as Array<{
      id: string;
      fecha: string;
      valor: number;
      cuenta_etiqueta: string | null;
      descripcion: string | null;
      tercero_nombre: string | null;
      siigo_nombre: string | null;
      estado: string;
      propuesta: { grupo?: string | null } | null;
      tipo: string;
    }>) {
      if (e.tipo === "omitir") continue;
      if (e.siigo_nombre)
        rpEnviados.push({
          id: `rp-${e.id}`,
          egresoId: e.id,
          fecha: String(e.fecha).slice(0, 10),
          comprobante: e.siigo_nombre.split(" + ")[0]!.trim(),
          tercero: e.tercero_nombre,
          descripcion: e.descripcion,
          valor: -Number(e.valor),
          origen: "herramienta",
          cuenta: e.cuenta_etiqueta,
          grupo: e.propuesta?.grupo ?? null,
        });
      else
        egresosPendientes.push({
          id: e.id,
          fecha: String(e.fecha).slice(0, 10),
          valor: Number(e.valor),
          cuenta: e.cuenta_etiqueta,
          descripcion: e.descripcion,
          estado: e.estado,
        });
    }

    // RC de la API de Siigo del mes (la cuenta se identifica por la forma de pago).
    const rcApi: FuentesConciliacion["rcApi"] = [];
    try {
      const { siigoGet, siigoUseCompany } = await import("./siigo.server");
      await siigoUseCompany(data.companyId);
      const porForma = new Map(
        ((reglas ?? []) as Array<{ patron: string; payment_type_id: string | null }>)
          .filter((r) => r.payment_type_id)
          .map((r) => [String(r.payment_type_id), r.patron]),
      );
      type Rc = {
        id?: string;
        name?: string;
        date?: string;
        customer?: { identification?: string };
        payment?: { id?: number; name?: string; value?: number };
        payments?: Array<{ id?: number; name?: string; value?: number }>;
      };
      for (let page = 1; page <= 10; page++) {
        const r = await siigoGet<{ results?: Rc[] } | Rc[]>(
          `/v1/vouchers?created_start=${data.periodo}-01&page=${page}&page_size=100`,
        );
        const l = Array.isArray(r) ? r : (r.results ?? []);
        for (const v of l) {
          const f = String(v.date ?? "").slice(0, 10);
          if (!f || f < `${data.periodo}-01` || f > fin) continue;
          for (const p of v.payments ?? (v.payment ? [v.payment] : [])) {
            const formaCuenta = p.id != null ? (porForma.get(String(p.id)) ?? null) : null;
            const cuenta =
              formaCuenta ??
              cuentas.find((c) => p.name && coincideEtiqueta(c.etiqueta, p.name))?.etiqueta ??
              null;
            rcApi.push({
              id: `rc-${v.id}-${p.id}`,
              fecha: f,
              comprobante: String(v.name ?? v.id),
              tercero: v.customer?.identification ?? null,
              descripcion: p.name ?? null,
              valor: Number(p.value ?? 0),
              origen: "api",
              cuenta,
              formaPago: p.name ?? null,
            });
          }
        }
        if (l.length < 100) break;
      }
    } catch (e) {
      advertencias.push(
        `No se pudieron leer los recibos de caja de Siigo: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Conciliación guardada del mes anterior.
    const { data: previas } = await db
      .from("conciliaciones_bancarias")
      .select("cuenta_etiqueta, partidas, saldo_libros_final, saldo_extracto_final")
      .eq("company_id", data.companyId)
      .eq("periodo", mesAnterior(data.periodo));
    const anterior = (
      (previas ?? []) as Array<{
        cuenta_etiqueta: string;
        partidas: unknown;
        saldo_libros_final: number | null;
        saldo_extracto_final: number | null;
      }>
    ).map((p) => ({
      cuenta: p.cuenta_etiqueta,
      partidas: (p.partidas ?? []) as PartidaConciliatoria[],
      saldoLibrosFinal: p.saldo_libros_final != null ? Number(p.saldo_libros_final) : null,
      saldoExtractoFinal: p.saldo_extracto_final != null ? Number(p.saldo_extracto_final) : null,
    }));

    return { cuentas, rpEnviados, egresosPendientes, rcApi, anterior, advertencias };
  });

export const conciliacionGuardar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      periodo: string;
      cuentas: Array<{
        etiqueta: string;
        cuentaContable: string | null;
        saldoExtractoInicial: number | null;
        saldoExtractoFinal: number | null;
        saldoLibrosInicial: number | null;
        saldoLibrosFinal: number | null;
        partidas: PartidaConciliatoria[];
        resumen: Record<string, unknown>;
      }>;
    }) => {
      if (!input?.companyId || !/^\d{4}-\d{2}$/.test(input.periodo ?? "") || !input.cuentas?.length)
        throw new Error("Datos de la conciliación incompletos.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const { data: u } = await context.supabase.auth.getUser();
    const filas = data.cuentas.map((c) => ({
      company_id: data.companyId,
      periodo: data.periodo,
      cuenta_etiqueta: c.etiqueta,
      cuenta_contable: c.cuentaContable,
      saldo_extracto_inicial: c.saldoExtractoInicial,
      saldo_extracto_final: c.saldoExtractoFinal,
      saldo_libros_inicial: c.saldoLibrosInicial,
      saldo_libros_final: c.saldoLibrosFinal,
      partidas: c.partidas as never,
      resumen: c.resumen as never,
      created_by: u.user?.id ?? null,
    }));
    const { error } = await context.supabase
      .from("conciliaciones_bancarias")
      .upsert(filas, { onConflict: "company_id,periodo,cuenta_etiqueta" });
    if (error) throw new Error(error.message);
    return { guardadas: filas.length };
  });
