// Conciliación bancaria — funciones de servidor (núcleo global: todas las empresas).
//   conciliacionFuentes: extractos del mes (bandeja de egresos: Excel de los bancos y, con
//     el lector del reporte mensual, sus hojas de bancos y efectivo), RP enviados desde la
//     herramienta, RC de la API de Siigo y la conciliación guardada del mes anterior.
//   conciliacionGuardar: guarda el resultado por cuenta (partidas al corte) para el mes siguiente.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  AjustePropuesto,
  Reclasificacion,
  LineaAuxiliar,
  MovBanco,
  MovLibro,
  PartidaConciliatoria,
} from "@/lib/conciliacion";
import type { ItemPago } from "@/lib/egresos";
import type { TransaccionPasarela } from "@/lib/pasarelas";
import type { BalanceCuenta } from "@/lib/siigo-movimiento.server";

export type CuentaConciliable = {
  etiqueta: string;
  cuentaContable: string | null;
  paymentTypeId: string | null;
  fuente: string | null;
  movimientos: MovBanco[];
  saldoInicial: number | null;
  saldoFinal: number | null;
  advertencias: string[];
};

export type FuentesConciliacion = {
  cuentas: CuentaConciliable[];
  /** RP creados desde la herramienta (comprobante, cuenta, valor). */
  rpEnviados: Array<
    MovLibro & {
      cuenta: string | null;
      grupo: string | null;
      egresoId: string;
      pasarela: string | null;
    }
  >;
  /** Extractos en PDF de la bandeja (se leen en el navegador). */
  pdfs: Array<{ etiqueta: string; nombre: string; base64: string }>;
  /** Pasarelas de pago (empresas con esa función): cobros del mes y del mes anterior. */
  pasarelas: Array<{
    plataforma: string;
    transacciones: TransaccionPasarela[];
    advertencias: string[];
    terceroNit: string | null;
    terceroNombre: string | null;
    /** Facturas de la plataforma con saldo en las CxP de Siigo. */
    facturas: Array<Omit<ItemPago, "valor">>;
    /** RP de comisiones del mes ya creado en Egresos y pagos (por cuenta). */
    rp: Array<{ cuenta: string | null; estado: string; siigoNombre: string | null; valor: number }>;
  }>;
  cuentasPasarela: { retefuente: string | null; reteiva: string | null; reteica: string | null };
  /** Cuentas y tope del ajuste al peso (Egresos y pagos). */
  ajusteCuentas: { debito: string | null; credito: string | null; tope: number };
  /**
   * Comprobantes registrados desde la conciliación (enviados o con error): ajustes al peso y
   * reclasificaciones de RC/RP a la cuenta bancaria correcta (cuenta → cuentaDestino).
   */
  ajustes: Array<{
    clave: string;
    tipo: string;
    cuentaDestino: string | null;
    cuenta: string;
    fecha: string;
    valor: number;
    origen: string | null;
    estado: string;
    siigoNombre: string | null;
    error: string | null;
  }>;
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
      paymentTypeId: (r as { payment_type_id?: string | null }).payment_type_id ?? null,
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
    // Extractos en PDF (p. ej. Davivienda): se leen en el navegador; si la cuenta también
    // tiene la hoja del reporte mensual, se comparan (movimientos no reportados).
    const pdfs: FuentesConciliacion["pdfs"] = [];
    for (const c of cuentas) {
      const doc = lista.find(
        (d) =>
          d.kind === "extracto" &&
          /\.pdf$/i.test(d.file_name) &&
          coincideEtiqueta(c.etiqueta, d.file_name),
      );
      if (!doc) continue;
      try {
        const bytes = await bajar(doc.storage_path);
        if (bytes.length > 8 * 1024 * 1024) {
          c.advertencias.push(`${doc.file_name}: el PDF es muy grande; cárgalo a mano.`);
          continue;
        }
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        pdfs.push({ etiqueta: c.etiqueta, nombre: doc.file_name, base64: btoa(bin) });
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
      if (!c.movimientos.length && !pdfs.some((p) => p.etiqueta === c.etiqueta))
        c.advertencias.push(
          `No se encontró el extracto de ${c.etiqueta} de ${etiqueta}: cárgalo a mano.`,
        );

    // RP enviados y pagos aún sin RP (módulo de egresos).
    const { data: egresos } = await db
      .from("egresos")
      .select(
        "id, fecha, valor, cuenta_etiqueta, descripcion, tercero_nombre, tercero_nit, siigo_nombre, estado, propuesta, tipo, origen, clave",
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
      tercero_nit: string | null;
      siigo_nombre: string | null;
      estado: string;
      propuesta: { grupo?: string | null } | null;
      tipo: string;
      origen: string;
      clave: string;
    }>) {
      if (e.tipo === "omitir") continue;
      const pasarela = e.origen === "pasarela" ? (e.clave.split("|")[1] ?? null) : null;
      if (e.siigo_nombre)
        rpEnviados.push({
          id: `rp-${e.id}`,
          egresoId: e.id,
          fecha: String(e.fecha).slice(0, 10),
          comprobante: e.siigo_nombre.split(" + ")[0]!.trim(),
          tercero: e.tercero_nombre,
          terceroNit: e.tercero_nit,
          descripcion: e.descripcion,
          valor: -Number(e.valor),
          origen: "herramienta",
          cuenta: e.cuenta_etiqueta,
          grupo: e.propuesta?.grupo ?? null,
          pasarela,
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
              terceroNit: v.customer?.identification ?? null,
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

    // Pasarelas de pago: hojas de la plataforma del reporte del mes y del mes anterior (cobros
    // del final del mes anterior que se abonan en este mes).
    const pasarelas: FuentesConciliacion["pasarelas"] = [];
    if (funcionActiva(empresa.nit, "pasarelas_pago")) {
      const { leerHojaPasarela } = await import("./pasarelas");
      const [aA, mA] = mesAnterior(data.periodo).split("-").map(Number) as [number, number];
      const { data: docsAnt } = await db
        .from("payment_documents")
        .select("file_name, storage_path, created_at")
        .eq("company_id", data.companyId)
        .eq("period", etiquetaPeriodo({ anio: aA, mes: mA }))
        .eq("kind", "relacion_pagos")
        .order("created_at", { ascending: false })
        .limit(1);
      const reportes = [
        { periodo: data.periodo, doc: relacion },
        { periodo: mesAnterior(data.periodo), doc: (docsAnt ?? [])[0] },
      ];
      const porPlataforma = new Map<string, FuentesConciliacion["pasarelas"][number]>();
      for (const rep of reportes) {
        if (!rep.doc) {
          if (rep.periodo !== data.periodo)
            advertencias.push(
              "No está el reporte de pagos del mes anterior: los abonos de inicio de mes por cobros del mes anterior quedan sin identificar.",
            );
          continue;
        }
        try {
          const wb = lectores.libro(await bajar(rep.doc.storage_path));
          for (const hoja of wb.SheetNames) {
            if (/consolidado|efectivo|novedad/i.test(hoja)) continue;
            const plataforma = hoja.trim().toUpperCase();
            const r = leerHojaPasarela(wb.Sheets[hoja]!, plataforma, rep.periodo);
            if (!r.transacciones.length) continue;
            const p = porPlataforma.get(plataforma) ?? {
              plataforma,
              transacciones: [],
              advertencias: [],
              terceroNit: null,
              terceroNombre: null,
              facturas: [],
              rp: [],
            };
            p.transacciones.push(...r.transacciones);
            if (rep.periodo === data.periodo) p.advertencias.push(...r.advertencias);
            porPlataforma.set(plataforma, p);
          }
        } catch (e) {
          advertencias.push(
            `Pasarelas (${rep.periodo}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      // Tercero y facturas de comisiones con saldo (CxP de Siigo sincronizadas).
      for (const p of porPlataforma.values()) {
        const { data: cxp } = await db
          .from("siigo_cuentas_por_pagar")
          .select(
            "prefix, consecutive, quote, balance, due_date, provider_nit, provider_name, factura_proveedor",
          )
          .eq("company_id", data.companyId)
          .ilike("provider_name", `%${p.plataforma}%`)
          .gt("balance", 0)
          .order("due_date", { ascending: true });
        const filas = (cxp ?? []) as Array<{
          prefix: string;
          consecutive: number;
          quote: number;
          balance: number;
          due_date: string | null;
          provider_nit: string | null;
          provider_name: string | null;
          factura_proveedor: string | null;
        }>;
        p.terceroNit = filas[0]?.provider_nit ?? null;
        p.terceroNombre = filas[0]?.provider_name ?? null;
        if (!p.terceroNit) {
          const { data: prov } = await db
            .from("providers")
            .select("nit, name")
            .eq("company_id", data.companyId)
            .ilike("name", `%${p.plataforma}%`)
            .limit(1);
          const pr = (prov ?? [])[0] as { nit: string; name: string } | undefined;
          p.terceroNit = pr?.nit ?? null;
          p.terceroNombre = pr?.name ?? null;
        }
        p.facturas = filas.map((f) => ({
          prefix: f.prefix,
          consecutive: Number(f.consecutive),
          quote: Number(f.quote ?? 1),
          factura: f.factura_proveedor ?? `${f.prefix}-${f.consecutive}`,
          saldo: Number(f.balance),
          vence: f.due_date,
        }));
        p.rp = (
          (egresos ?? []) as Array<{
            clave: string;
            origen: string;
            cuenta_etiqueta: string | null;
            estado: string;
            siigo_nombre: string | null;
            valor: number;
          }>
        )
          .filter((e) => e.origen === "pasarela" && e.clave.split("|")[1] === p.plataforma)
          .map((e) => ({
            cuenta: e.cuenta_etiqueta,
            estado: e.estado,
            siigoNombre: e.siigo_nombre,
            valor: Number(e.valor),
          }));
        pasarelas.push(p);
      }
    }
    const { data: reglasCuenta } = await db
      .from("egreso_reglas")
      .select("patron, cuenta_debito")
      .eq("company_id", data.companyId)
      .eq("clase", "concepto")
      .like("patron", "cuenta:%");
    const regla = (k: string) =>
      ((reglasCuenta ?? []) as Array<{ patron: string; cuenta_debito: string | null }>).find(
        (r) => r.patron === k,
      )?.cuenta_debito ?? null;
    const { cargarAjustes } = await import("./egresos.server");
    const aj = await cargarAjustes(db, data.companyId);
    const { data: ajustesDb } = await db
      .from("conciliacion_ajustes")
      .select(
        "clave, tipo, cuenta_destino_etiqueta, cuenta_etiqueta, fecha, valor, comprobante_origen, estado, siigo_nombre, siigo_error",
      )
      .eq("company_id", data.companyId)
      .eq("periodo", data.periodo);

    return {
      cuentas,
      rpEnviados,
      egresosPendientes,
      rcApi,
      anterior,
      advertencias,
      pdfs,
      pasarelas,
      cuentasPasarela: {
        retefuente: regla("cuenta:pasarela_retefuente"),
        reteiva: regla("cuenta:pasarela_reteiva"),
        reteica: regla("cuenta:pasarela_reteica"),
      },
      ajusteCuentas: { debito: aj.debito, credito: aj.credito, tope: aj.tope },
      ajustes: (
        (ajustesDb ?? []) as Array<{
          clave: string;
          tipo: string;
          cuenta_destino_etiqueta: string | null;
          cuenta_etiqueta: string;
          fecha: string;
          valor: number;
          comprobante_origen: string | null;
          estado: string;
          siigo_nombre: string | null;
          siigo_error: string | null;
        }>
      ).map((a) => ({
        clave: a.clave,
        tipo: a.tipo,
        cuentaDestino: a.cuenta_destino_etiqueta,
        cuenta: a.cuenta_etiqueta,
        fecha: String(a.fecha).slice(0, 10),
        valor: Number(a.valor),
        origen: a.comprobante_origen,
        estado: a.estado,
        siigoNombre: a.siigo_nombre,
        error: a.siigo_error,
      })),
    };
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

/**
 * Movimiento de bancos y caja desde la API de Siigo (rango de fechas) y balance de prueba de
 * esas cuentas (saldo inicial, débitos, créditos y saldo final) para validarlo.
 */
export const conciliacionMovimientoSiigo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; desde: string; hasta: string }) => {
    const f = /^\d{4}-\d{2}-\d{2}$/;
    if (!input?.companyId || !f.test(input.desde ?? "") || !f.test(input.hasta ?? ""))
      throw new Error("Empresa y rango de fechas requeridos.");
    if (input.desde > input.hasta) throw new Error("La fecha inicial es posterior a la final.");
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      filas: LineaAuxiliar[];
      balance: BalanceCuenta[];
      advertencias: string[];
      documentos: number;
    }> => {
      const db = context.supabase;
      const { data: reglas, error } = await db
        .from("egreso_reglas")
        .select("patron, cuenta_banco, payment_type_id")
        .eq("company_id", data.companyId)
        .eq("clase", "banco");
      if (error) throw new Error(error.message);
      const cuentas = (
        (reglas ?? []) as Array<{
          patron: string;
          cuenta_banco: string | null;
          payment_type_id: string | null;
        }>
      )
        .filter((r) => r.cuenta_banco)
        .map((r) => ({
          etiqueta: r.patron,
          cuentaContable: String(r.cuenta_banco),
          paymentTypeId: r.payment_type_id,
        }));
      if (!cuentas.length)
        throw new Error(
          "No hay cuentas de banco/caja configuradas (Egresos y pagos → forma de pago y cuenta de cada origen).",
        );
      const { siigoUseCompany } = await import("./siigo.server");
      await siigoUseCompany(data.companyId);
      const { movimientoDesdeApi, balanceDesdeApi } = await import("./siigo-movimiento.server");
      const mov = await movimientoDesdeApi({ desde: data.desde, hasta: data.hasta, cuentas });
      let balance: BalanceCuenta[] = [];
      const [a1, m1] = data.desde.split("-").map(Number) as [number, number];
      const [a2, m2] = data.hasta.split("-").map(Number) as [number, number];
      if (a1 !== a2)
        mov.advertencias.push(
          "El balance de prueba de Siigo es por año: elige un rango dentro del mismo año para validar el movimiento.",
        );
      else
        try {
          balance = await balanceDesdeApi({
            anio: a1,
            mesInicial: m1,
            mesFinal: m2,
            cuentas: cuentas.map((c) => c.cuentaContable),
          });
          if (!balance.length)
            mov.advertencias.push(
              "El balance de prueba de Siigo no trajo las cuentas de bancos y caja (revisa el formato del reporte).",
            );
        } catch (e) {
          mov.advertencias.push(
            `Balance de prueba de Siigo: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      return { ...mov, balance };
    },
  );

/** Guarda las cuentas de retenciones descontadas por las pasarelas de pago. */
export const conciliacionGuardarCuentasPasarela = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      retefuente: string | null;
      reteiva: string | null;
      reteica: string | null;
    }) => {
      if (!input?.companyId) throw new Error("companyId requerido");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const filas = (
      [
        ["cuenta:pasarela_retefuente", data.retefuente],
        ["cuenta:pasarela_reteiva", data.reteiva],
        ["cuenta:pasarela_reteica", data.reteica],
      ] as const
    ).map(([patron, cuenta]) => ({
      company_id: data.companyId,
      clase: "concepto",
      patron,
      tipo: "cuenta",
      cuenta_debito: String(cuenta ?? "").replace(/\D/g, "") || null,
    }));
    const { error } = await context.supabase
      .from("egreso_reglas")
      .upsert(filas, { onConflict: "company_id,clase,patron" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Crea (o actualiza mientras no esté en Siigo) en «Egresos y pagos» el RP del mes de una
 * pasarela por lo descontado en sus abonos del mes a una cuenta: débito a la CxP cruzando
 * sus facturas de comisiones, débito a las retenciones y crédito al banco. Se revisa,
 * aprueba y envía desde Egresos y pagos (o desde la conciliación).
 */
export const conciliacionCrearRpPasarela = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      periodo: string;
      plataforma: string;
      cuenta: string;
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
      detalle: string;
    }) => {
      if (!input?.companyId || !/^\d{4}-\d{2}$/.test(input.periodo ?? "") || !input.plataforma)
        throw new Error("Datos del RP de la pasarela incompletos.");
      const a = input.abonado;
      const vals = [a.comision, a.ivaComision, a.retefuente, a.reteiva, a.reteica, a.deducciones];
      if (vals.some((v) => !Number.isFinite(Number(v)) || Number(v) < 0) || !(a.deducciones > 0))
        throw new Error("No hay descuentos de la pasarela para el RP.");
      const suma = a.comision + a.ivaComision + a.retefuente + a.reteiva + a.reteica;
      if (Math.abs(suma - a.deducciones) > 0.02)
        throw new Error("Los descuentos no suman el total del RP.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const clave = `pasarela|${data.plataforma}|${data.periodo}|${data.cuenta.toUpperCase()}`;
    const { data: prev } = await db
      .from("egresos")
      .select("id, siigo_id, siigo_nombre, estado")
      .eq("company_id", data.companyId)
      .eq("clave", clave)
      .maybeSingle();
    if (prev?.siigo_id)
      return {
        id: prev.id,
        estado: prev.estado,
        mensaje: `El RP de ${data.plataforma} ya está en Siigo (${prev.siigo_nombre ?? prev.siigo_id}).`,
      };
    if (prev && ["enviando", "enviado"].includes(prev.estado))
      throw new Error("El RP de la pasarela se está enviando; espera el resultado.");

    const { data: banco } = await db
      .from("egreso_reglas")
      .select("cuenta_banco")
      .eq("company_id", data.companyId)
      .eq("clase", "banco")
      .ilike("patron", data.cuenta)
      .maybeSingle();
    const { data: reglas } = await db
      .from("egreso_reglas")
      .select("patron, cuenta_debito")
      .eq("company_id", data.companyId)
      .eq("clase", "concepto")
      .like("patron", "cuenta:%");
    const regla = (k: string) =>
      ((reglas ?? []) as Array<{ patron: string; cuenta_debito: string | null }>).find(
        (r) => r.patron === k,
      )?.cuenta_debito ?? null;
    const { cargarAjustes } = await import("./egresos.server");
    const aj = await cargarAjustes(db, data.companyId);
    const { data: cxp } = await db
      .from("siigo_cuentas_por_pagar")
      .select(
        "prefix, consecutive, quote, balance, due_date, provider_nit, provider_name, factura_proveedor",
      )
      .eq("company_id", data.companyId)
      .ilike("provider_name", `%${data.plataforma}%`)
      .gt("balance", 0)
      .order("due_date", { ascending: true });
    const filas = (cxp ?? []) as Array<{
      prefix: string;
      consecutive: number;
      quote: number;
      balance: number;
      due_date: string | null;
      provider_nit: string | null;
      provider_name: string | null;
      factura_proveedor: string | null;
    }>;
    let nit = filas[0]?.provider_nit ?? null;
    let nombre = filas[0]?.provider_name ?? null;
    if (!nit) {
      const { data: prov } = await db
        .from("providers")
        .select("nit, name")
        .eq("company_id", data.companyId)
        .ilike("name", `%${data.plataforma}%`)
        .limit(1);
      const pr = (prov ?? [])[0] as { nit: string; name: string } | undefined;
      nit = pr?.nit ?? null;
      nombre = pr?.name ?? null;
    }
    const { propuestaPasarela } = await import("./pasarelas");
    const { propuesta, valor } = propuestaPasarela({
      r: {
        plataforma: data.plataforma,
        cobros: [],
        abonos: [],
        sinRc: [],
        sinAbono: [],
        abonosSinCobros: [],
        abonado: data.abonado,
      },
      terceroNit: nit,
      terceroNombre: nombre,
      facturas: filas.map((f) => ({
        prefix: f.prefix,
        consecutive: Number(f.consecutive),
        quote: Number(f.quote ?? 1),
        factura: f.factura_proveedor ?? `${f.prefix}-${f.consecutive}`,
        saldo: Number(f.balance),
        vence: f.due_date,
      })),
      cuentas: {
        cxp: aj.cxp,
        retefuente: regla("cuenta:pasarela_retefuente"),
        reteiva: regla("cuenta:pasarela_reteiva"),
        reteica: regla("cuenta:pasarela_reteica"),
        ajusteDebito: aj.debito,
        ajusteCredito: aj.credito,
        tope: aj.tope,
      },
      cuentaBanco: (banco as { cuenta_banco: string | null } | null)?.cuenta_banco ?? null,
    });
    const [anio, mes] = data.periodo.split("-").map(Number) as [number, number];
    const fecha = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
    const { erroresAntesDeEnviar } = await import("./egresos");
    const errores = [
      ...propuesta.motivos,
      ...erroresAntesDeEnviar({ valor, fecha }, propuesta).filter(
        (e) => !propuesta.motivos.includes(e),
      ),
    ];
    const fila = {
      company_id: data.companyId,
      period: data.periodo,
      clave,
      origen: "pasarela",
      origen_archivo: null,
      fecha,
      valor,
      cuenta_etiqueta: data.cuenta,
      descripcion: `Comisiones y retenciones ${data.plataforma} ${data.periodo}`,
      relacion: null,
      aplicacion: null,
      observaciones: data.detalle.slice(0, 1000),
      tercero_nit: nit,
      tercero_nombre: nombre,
      tipo: "pago_facturas",
      propuesta: { ...propuesta, listo: !errores.length, motivos: errores } as never,
      estado: errores.length ? "por_revisar" : "listo",
      motivos: errores,
      editado_por_usuaria: true,
    };
    const { data: guardada, error } = prev
      ? await db
          .from("egresos")
          .update(fila)
          .eq("id", prev.id)
          .is("siigo_id", null)
          .select("id, estado")
          .single()
      : await db.from("egresos").insert(fila).select("id, estado").single();
    if (error || !guardada) throw new Error(error?.message ?? "No se pudo guardar el RP.");
    return {
      id: guardada.id,
      estado: guardada.estado,
      mensaje: errores.length
        ? `RP de ${data.plataforma} creado en Egresos y pagos, por revisar: ${errores.join(" ")}`
        : `RP de ${data.plataforma} listo en Egresos y pagos por ${valor.toLocaleString("es-CO")}: apruébalo y envíalo.`,
    };
  });

/**
 * Envía a Siigo el ajuste al peso de una diferencia de la conciliación (comprobante
 * contable banco contra la cuenta de ajuste al peso), una sola vez por diferencia.
 */
export const conciliacionEnviarAjuste = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; periodo: string; cuenta: string; ajuste: AjustePropuesto }) => {
      if (!input?.companyId || !/^\d{4}-\d{2}$/.test(input.periodo ?? "") || !input.ajuste?.clave)
        throw new Error("Datos del ajuste incompletos.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.ajuste.fecha ?? ""))
        throw new Error("Fecha del ajuste inválida.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const a = data.ajuste;
    const { cargarAjustes } = await import("./egresos.server");
    const aj = await cargarAjustes(db, data.companyId);
    const v = Math.round(Math.abs(Number(a.valor)) * 100) / 100;
    if (!(v >= 0.01) || v > aj.tope + 0.001)
      throw new Error(
        `La diferencia (${v.toLocaleString("es-CO")}) no está dentro del tope del ajuste al peso (${aj.tope.toLocaleString("es-CO")}).`,
      );
    if (!a.terceroNit)
      throw new Error(
        `El ${a.origen} no trae el NIT del tercero: sube el auxiliar de Siigo o trae el movimiento desde Siigo.`,
      );
    const cuentaAjuste = Number(a.valor) > 0 ? aj.credito : aj.debito;
    if (!aj.debito || !aj.credito)
      throw new Error(
        "Faltan las cuentas del ajuste al peso (Egresos y pagos → cuentas de ajuste).",
      );
    const { data: banco } = await db
      .from("egreso_reglas")
      .select("cuenta_banco")
      .eq("company_id", data.companyId)
      .eq("clase", "banco")
      .ilike("patron", data.cuenta)
      .maybeSingle();
    const cuentaBanco = (banco as { cuenta_banco: string | null } | null)?.cuenta_banco;
    if (!cuentaBanco) throw new Error(`La cuenta ${data.cuenta} no tiene cuenta contable.`);

    const { data: u } = await context.supabase.auth.getUser();
    const { data: previo } = await db
      .from("conciliacion_ajustes")
      .select("id, siigo_id, siigo_nombre, estado")
      .eq("company_id", data.companyId)
      .eq("clave", a.clave)
      .maybeSingle();
    if (previo?.siigo_id)
      return {
        ok: true,
        siigoNombre: previo.siigo_nombre,
        mensaje: "Ya está en Siigo; no se reenvía.",
      };
    if (previo?.estado === "enviando")
      throw new Error("El ajuste se está enviando; espera el resultado.");
    const base = {
      company_id: data.companyId,
      periodo: data.periodo,
      cuenta_etiqueta: data.cuenta,
      clave: a.clave,
      fecha: a.fecha,
      valor: Number(a.valor),
      cuenta_banco: cuentaBanco,
      cuenta_ajuste: cuentaAjuste!,
      tercero_nit: a.terceroNit,
      comprobante_origen: a.origen,
      descripcion: a.descripcion,
      estado: "enviando",
      siigo_error: null,
      created_by: u.user?.id ?? null,
    };
    // Bloqueo: pasa a «enviando» solo desde pendiente/error (sin identidad de Siigo).
    const bloqueo = previo
      ? await db
          .from("conciliacion_ajustes")
          .update(base)
          .eq("id", previo.id)
          .in("estado", ["pendiente", "error"])
          .is("siigo_id", null)
          .select("id")
      : await db.from("conciliacion_ajustes").insert(base).select("id");
    if (bloqueo.error || !(bloqueo.data ?? []).length)
      throw new Error(bloqueo.error?.message ?? "El ajuste ya se está procesando.");
    const id = (bloqueo.data as Array<{ id: string }>)[0]!.id;

    try {
      const { siigoPost, siigoUseCompany, siigoJournalDocumentId } = await import("./siigo.server");
      await siigoUseCompany(data.companyId);
      const { payloadAjusteAlPeso } = await import("./conciliacion");
      const payload = payloadAjusteAlPeso({
        documentId: await siigoJournalDocumentId(),
        fecha: a.fecha,
        valor: Number(a.valor),
        cuentaBanco,
        cuentaIngreso: aj.credito,
        cuentaGasto: aj.debito,
        terceroNit: a.terceroNit,
        descripcion: a.descripcion,
        referencia: id.slice(0, 8),
      });
      const r = await siigoPost<{ id?: string; name?: string }>("/v1/journals", payload);
      await db
        .from("conciliacion_ajustes")
        .update({ estado: "enviado", siigo_id: String(r.id ?? ""), siigo_nombre: r.name ?? null })
        .eq("id", id);
      return {
        ok: true,
        siigoNombre: r.name ?? null,
        mensaje: `Ajuste creado en Siigo: ${r.name ?? r.id}.`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .from("conciliacion_ajustes")
        .update({ estado: "error", siigo_error: msg.slice(0, 2000) })
        .eq("id", id)
        .is("siigo_id", null);
      return { ok: false, siigoNombre: null, mensaje: msg };
    }
  });

/**
 * Reclasifica en Siigo RC/RP registrados en otra cuenta bancaria: un comprobante contable
 * por recibo (de la cuenta errada a la correcta, con su tercero). Uno a uno; los errores
 * quedan registrados y el lote sigue. Nunca se reenvía uno que ya está en Siigo.
 */
export const conciliacionReclasificar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; periodo: string; items: Reclasificacion[] }) => {
    if (!input?.companyId || !/^\d{4}-\d{2}$/.test(input.periodo ?? "") || !input.items?.length)
      throw new Error("Selecciona los recibos a reclasificar.");
    if (input.items.length > 100) throw new Error("Máximo 100 recibos por lote.");
    for (const r of input.items)
      if (
        !r.clave ||
        !/^\d{4}-\d{2}-\d{2}$/.test(r.fecha ?? "") ||
        !(Math.abs(Number(r.valor)) >= 0.01)
      )
        throw new Error(`Datos incompletos en ${r.comprobante ?? "un recibo"}.`);
    return input;
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { data: reglas, error } = await db
      .from("egreso_reglas")
      .select("patron, cuenta_banco")
      .eq("company_id", data.companyId)
      .eq("clase", "banco");
    if (error) throw new Error(error.message);
    const cuentaDe = (etiqueta: string) =>
      ((reglas ?? []) as Array<{ patron: string; cuenta_banco: string | null }>).find(
        (r) => r.patron.toUpperCase() === etiqueta.toUpperCase(),
      )?.cuenta_banco ?? null;
    const { data: u } = await context.supabase.auth.getUser();
    const { siigoPost, siigoUseCompany, siigoJournalDocumentId } = await import("./siigo.server");
    const { payloadReclasificacion } = await import("./conciliacion");
    await siigoUseCompany(data.companyId);
    let documentId: number | null = null;
    const resultados: Array<{ clave: string; ok: boolean; mensaje: string }> = [];
    for (const r of data.items) {
      const errada = cuentaDe(r.desde.etiqueta);
      const correcta = cuentaDe(r.hacia.etiqueta);
      if (!errada || !correcta || errada === correcta) {
        resultados.push({
          clave: r.clave,
          ok: false,
          mensaje: `${r.comprobante}: cuentas contables no configuradas.`,
        });
        continue;
      }
      if (!r.terceroNit) {
        resultados.push({
          clave: r.clave,
          ok: false,
          mensaje: `${r.comprobante}: sin NIT del tercero (sube el auxiliar o trae el movimiento de Siigo).`,
        });
        continue;
      }
      const { data: previo } = await db
        .from("conciliacion_ajustes")
        .select("id, siigo_id, siigo_nombre, estado")
        .eq("company_id", data.companyId)
        .eq("clave", r.clave)
        .maybeSingle();
      if (previo?.siigo_id) {
        resultados.push({
          clave: r.clave,
          ok: true,
          mensaje: `${r.comprobante}: ya reclasificado (${previo.siigo_nombre}).`,
        });
        continue;
      }
      if (previo?.estado === "enviando") {
        resultados.push({
          clave: r.clave,
          ok: false,
          mensaje: `${r.comprobante}: se está enviando.`,
        });
        continue;
      }
      const descripcion = `Reclasificación ${r.comprobante} de ${r.desde.etiqueta} a ${r.hacia.etiqueta}`;
      const base = {
        company_id: data.companyId,
        periodo: data.periodo,
        tipo: "reclasificacion",
        cuenta_etiqueta: r.desde.etiqueta,
        cuenta_destino_etiqueta: r.hacia.etiqueta,
        clave: r.clave,
        fecha: r.fecha,
        valor: Number(r.valor),
        cuenta_banco: errada,
        cuenta_ajuste: correcta,
        tercero_nit: r.terceroNit,
        comprobante_origen: r.comprobante,
        descripcion,
        estado: "enviando",
        siigo_error: null,
        created_by: u.user?.id ?? null,
      };
      const bloqueo = previo
        ? await db
            .from("conciliacion_ajustes")
            .update(base)
            .eq("id", previo.id)
            .in("estado", ["pendiente", "error"])
            .is("siigo_id", null)
            .select("id")
        : await db.from("conciliacion_ajustes").insert(base).select("id");
      if (bloqueo.error || !(bloqueo.data ?? []).length) {
        resultados.push({
          clave: r.clave,
          ok: false,
          mensaje: `${r.comprobante}: ${bloqueo.error?.message ?? "ya se está procesando"}`,
        });
        continue;
      }
      const id = (bloqueo.data as Array<{ id: string }>)[0]!.id;
      try {
        documentId ??= await siigoJournalDocumentId();
        const res = await siigoPost<{ id?: string; name?: string }>(
          "/v1/journals",
          payloadReclasificacion({
            documentId,
            fecha: r.fecha,
            valor: Number(r.valor),
            cuentaErrada: errada,
            cuentaCorrecta: correcta,
            terceroNit: r.terceroNit,
            descripcion,
            referencia: id.slice(0, 8),
          }),
        );
        await db
          .from("conciliacion_ajustes")
          .update({
            estado: "enviado",
            siigo_id: String(res.id ?? ""),
            siigo_nombre: res.name ?? null,
          })
          .eq("id", id);
        resultados.push({
          clave: r.clave,
          ok: true,
          mensaje: `${r.comprobante}: ${res.name ?? res.id}`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db
          .from("conciliacion_ajustes")
          .update({ estado: "error", siigo_error: msg.slice(0, 2000) })
          .eq("id", id)
          .is("siigo_id", null);
        resultados.push({ clave: r.clave, ok: false, mensaje: `${r.comprobante}: ${msg}` });
      }
    }
    return { resultados };
  });
