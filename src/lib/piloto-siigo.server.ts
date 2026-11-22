// Piloto automático — paso «Aprobar y enviar a Siigo las compras en verde».
// Usa las MISMAS funciones de la aplicación: aprobarBorrador → causarFactura → siigoSyncInvoiceCore
// (con todas sus barreras: empresa, duplicados, nota crédito, doble envío, validaciones y lectura de vuelta).
// Seguridad:
//   - Solo borradores del mes de trabajo que salieron de la carga masiva sin «necesita revisión».
//   - Semáforo estricto (piloto-verde.ts): errores, advertencias, cuentas de confianza no alta o valor
//     sobre el tope → «por revisar»; nunca se envían.
//   - «enviar = false» es el modo prueba: evalúa y reporta qué enviaría, sin tocar nada.
//   - Un envío con error no se reintenta solo (queda marcado en Siigo/Historial para revisión).
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type ResultadoEnvio = {
  /** Borradores del mes evaluados. */
  candidatas: number;
  verdes: number;
  /** Enviadas a Siigo en esta pasada. */
  enviadas: number;
  /** Fallaron al aprobar, causar o enviar (quedan marcadas para revisión). */
  conError: number;
  /** Verdes que aún no se han enviado (se envían de a pocas por pasada). */
  verdesPendientes: number;
  porRevisar: Array<{ etiqueta: string; motivos: string[] }>;
  modoPrueba: boolean;
  /** Primer error inesperado de un envío (para el reporte). */
  primerError: string | null;
};

const chunk = <T>(a: T[], n: number) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export type ResultadoRecalculo = { evaluados: number; recalculados: number; fallidos: number };

/**
 * Recalcula las cuentas, el IVA y la CxP de los borradores del mes con el conocimiento de AHORA
 * (precedente por proveedor, histórico, reglas enseñadas, cuentas manuales) y actualiza la marca de
 * «necesita revisión» de su tarea. Solo borradores sin documento en Siigo, no tocados en la última hora.
 */
export async function recalcularBorradoresMes(
  db: Db,
  companyId: string,
  mes: { desde: string; hasta: string },
  limite = 20,
): Promise<ResultadoRecalculo> {
  const { conClienteDeServicio } = await import("./db-contextual");
  return conClienteDeServicio(db, async () => {
    // Primero aprende de lo que la usuaria corrigió a mano (cuenta y tipo por proveedor y concepto).
    try {
      const { data: t0 } = await db
        .from("bulk_upload_items")
        .select("upload_id")
        .eq("company_id", companyId)
        .not("invoice_id", "is", null)
        .limit(1)
        .maybeSingle();
      const { data: c0 } = t0
        ? await db
            .from("bulk_uploads")
            .select("created_by")
            .eq("id", (t0 as { upload_id: string }).upload_id)
            .maybeSingle()
        : { data: null };
      const { aprenderDeBorradoresManuales } = await import("./aprender-borradores");
      await aprenderDeBorradoresManuales(
        db,
        companyId,
        mes,
        (c0 as { created_by: string } | null)?.created_by ?? null,
      );
    } catch {
      /* el aprendizaje es una mejora: si falla, el recálculo sigue */
    }
    // Solo las tareas que hoy están marcadas «necesita revisión»: son las que pueden cambiar de estado
    // con el conocimiento actual. No se repite el cálculo de lo recalculado hace menos de 5 minutos.
    const hace5m = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const hace3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { MOTOR_VERSION: motorVersion } = await import("./bulk-invoices");
    const { data: marcadas } = await db
      .from("bulk_upload_items")
      .select("invoice_id")
      .eq("company_id", companyId)
      .eq("status", "completed")
      .eq("needs_review", true)
      .not("invoice_id", "is", null)
      .limit(300);
    const candidatas = [
      ...new Set(((marcadas ?? []) as Array<{ invoice_id: string }>).map((x) => x.invoice_id)),
    ];
    const ids: string[] = [];
    for (let i = 0; i < candidatas.length && ids.length < limite; i += 100) {
      const { data } = await db
        .from("invoices")
        .select("id")
        .in("id", candidatas.slice(i, i + 100))
        .eq("doc_kind", "compra")
        .eq("status", "borrador")
        .gte("issue_date", mes.desde)
        .lte("issue_date", mes.hasta)
        .is("siigo_id", null)
        .is("siigo_number", null)
        .is("processing_at", null)
        // Una vez por versión del motor (cambia cuando se mejora la lógica) y de nuevo si pasaron 3 horas.
        .or(
          `raw_extraction->>motor_version.is.null,raw_extraction->>motor_version.neq.${motorVersion},updated_at.lt.${hace3h}`,
        )
        .lt("updated_at", hace5m)
        .order("updated_at")
        .limit(limite - ids.length);
      ids.push(...((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    }
    const r: ResultadoRecalculo = { evaluados: ids.length, recalculados: 0, fallidos: 0 };
    if (!ids.length) return r;
    const [{ recalcularCuentasBorrador }, { loadDeps, invalidateBulkDeps }] = await Promise.all([
      import("./bulk-invoices"),
      import("./bulk-runner"),
    ]);
    // El dueño de las cargas da el contexto (config, conocimiento) igual que al causar.
    const { data: tarea } = await db
      .from("bulk_upload_items")
      .select("upload_id")
      .in("invoice_id", ids)
      .limit(1)
      .maybeSingle();
    const { data: carga } = tarea
      ? await db
          .from("bulk_uploads")
          .select("created_by")
          .eq("id", (tarea as { upload_id: string }).upload_id)
          .maybeSingle()
      : { data: null };
    const dueno = (carga as { created_by: string } | null)?.created_by;
    invalidateBulkDeps(companyId);
    const deps = await loadDeps(companyId, dueno);
    for (const id of ids) {
      try {
        const res = await recalcularCuentasBorrador(id, deps.config);
        if (!res.ok) {
          r.fallidos += 1;
          continue;
        }
        r.recalculados += 1;
        if (res.needsReview !== undefined)
          await db
            .from("bulk_upload_items")
            .update({
              needs_review: res.needsReview,
              // El motivo queda en la tarea para que el reporte diga POR QUÉ no está en verde.
              user_message: res.needsReview ? res.message.slice(0, 400) : null,
            })
            .eq("invoice_id", id)
            .eq("status", "completed");
      } catch {
        r.fallidos += 1;
      }
    }
    return r;
  });
}

export async function enviarVerdesASiigo(
  db: Db,
  companyId: string,
  op: { mes: { desde: string; hasta: string }; tope: number; enviar: boolean; limite?: number },
): Promise<ResultadoEnvio> {
  const { conClienteDeServicio } = await import("./db-contextual");
  return conClienteDeServicio(db, async () => {
    const [
      { classifyJournal, aprobarBorrador, causarFactura },
      { motivosNoVerde, alertasBorrador },
      { fetchCompanyPuc },
      { siigoSyncInvoiceCore },
      { funcionActiva },
    ] = await Promise.all([
      import("./draft-review"),
      import("./piloto-verde"),
      import("./puc-data"),
      import("./siigo.functions"),
      import("@/empresas/registro"),
    ]);
    const { data: emp } = await db.from("companies").select("nit").eq("id", companyId).single();
    const inventario = funcionActiva(
      (emp as { nit: string | null } | null)?.nit ?? null,
      "productos_inventario",
    );

    const { data: invs, error } = await db
      .from("invoices")
      .select("*")
      .eq("company_id", companyId)
      .eq("doc_kind", "compra")
      // Borradores, y también las que quedaron APROBADAS o CAUSADAS sin llegar a Siigo (aprobadas a mano o que se
      // detuvieron a medio camino): continúan solas hasta SINCRONIZADA.
      .in("status", ["borrador", "aprobado", "causada"])
      .gte("issue_date", op.mes.desde)
      .lte("issue_date", op.mes.hasta)
      .is("siigo_id", null)
      .is("siigo_number", null)
      .is("processing_at", null)
      // Un envío que ya falló no se reintenta solo (queda para revisión).
      .or("siigo_status.is.null,siigo_status.neq.error")
      .order("issue_date")
      .order("id")
      .limit(300);
    if (error) throw new Error(error.message);
    const facturas = (invs ?? []) as Array<
      Record<string, unknown> & {
        id: string;
        total: number;
        prefix: string | null;
        number: string | null;
      }
    >;
    const resultado: ResultadoEnvio = {
      candidatas: facturas.length,
      verdes: 0,
      enviadas: 0,
      conError: 0,
      verdesPendientes: 0,
      porRevisar: [],
      modoPrueba: !op.enviar,
      primerError: null,
    };
    if (!facturas.length) return resultado;

    // Tarea de la carga masiva de cada factura (¿quedó sin revisión pendiente?) y su dueño.
    const ids = facturas.map((f) => f.id);
    const tareas = new Map<
      string,
      {
        needs_review: boolean | null;
        status: string;
        upload_id: string;
        user_message: string | null;
      }
    >();
    for (const g of chunk(ids, 100)) {
      const { data } = await db
        .from("bulk_upload_items")
        .select("invoice_id, status, needs_review, upload_id, user_message")
        .in("invoice_id", g);
      for (const t of (data ?? []) as Array<{
        invoice_id: string;
        status: string;
        needs_review: boolean | null;
        upload_id: string;
        user_message: string | null;
      }>)
        tareas.set(t.invoice_id, t);
    }
    const asientos = new Map<string, Array<Record<string, unknown>>>();
    for (const g of chunk(ids, 50)) {
      const { data } = await db
        .from("journal_lines")
        .select("invoice_id, account_code, account_name, debit, credit, cost_center, position")
        .in("invoice_id", g)
        .order("position");
      for (const j of (data ?? []) as Array<{ invoice_id: string }>)
        asientos.set(j.invoice_id, [...(asientos.get(j.invoice_id) ?? []), j]);
    }
    const puc = await fetchCompanyPuc(companyId);
    const pucCodes = new Set(puc.map((p) => p.code));

    const verdes: Array<{
      f: (typeof facturas)[number];
      acc: ReturnType<typeof classifyJournal>;
      etiqueta: string;
    }> = [];
    for (const f of facturas) {
      const etiqueta = `${[f.prefix, f.number].filter(Boolean).join("-") || f.id.slice(0, 8)} · ${String(f["provider_name"] ?? "").slice(0, 30)}`;
      const acc = classifyJournal((asientos.get(f.id) ?? []) as never);
      const t = tareas.get(f.id);
      const decisiones = Object.values(
        ((
          f["raw_extraction"] as {
            account_decisions?: Record<string, { confidence?: string }>;
          } | null
        )?.account_decisions ?? {}) as Record<string, { confidence?: string }>,
      );
      // Ya aprobada/causada: pasó la revisión (a mano o del propio piloto); solo falta completar el camino.
      if (String(f["status"]) !== "borrador") {
        verdes.push({ f, acc, etiqueta });
        continue;
      }
      const motivos = motivosNoVerde({
        alertas: alertasBorrador(f as never, acc, pucCodes, inventario),
        tareaSinRevision: !!t && t.status === "completed" && !t.needs_review,
        motivoRevision: t?.user_message ?? null,
        confianzas: decisiones.map((d) => d.confidence),
        total: Number(f.total || 0),
        tope: op.tope,
      });
      if (motivos.length) resultado.porRevisar.push({ etiqueta, motivos });
      else verdes.push({ f, acc, etiqueta });
    }
    resultado.verdes = verdes.length;
    if (!op.enviar) {
      resultado.verdesPendientes = verdes.length;
      return resultado;
    }

    // Dueño de las cargas: a su nombre quedan la aprobación y el envío.
    const dueno = [...tareas.values()][0]?.upload_id
      ? (
          (
            await db
              .from("bulk_uploads")
              .select("created_by")
              .eq("id", [...tareas.values()][0]!.upload_id)
              .maybeSingle()
          ).data as { created_by: string } | null
        )?.created_by
      : null;
    if (!dueno)
      throw new Error("No se encontró el usuario dueño de las cargas para aprobar y enviar.");

    const turno = verdes.slice(0, op.limite ?? 2);
    for (const { f, acc, etiqueta } of turno) {
      try {
        if (String(f["status"]) === "borrador") {
          const ap = await aprobarBorrador(f as never, acc, pucCodes, etiqueta, dueno, inventario);
          if (!ap.ok) throw new Error(`No se pudo aprobar: ${ap.message}`);
        }
        if (!f["voucher_number"] || String(f["status"]) !== "causada") {
          const { data: fresca } = await db.from("invoices").select("*").eq("id", f.id).single();
          if (!(fresca as { voucher_number?: string | null } | null)?.voucher_number) {
            const ca = await causarFactura(fresca as never, etiqueta);
            if (!ca.ok) throw new Error(`No se pudo causar: ${ca.message}`);
          }
        }
        const r = await siigoSyncInvoiceCore(db as never, dueno, f.id);
        if (!r.ok) throw new Error(`Siigo: ${r.error ?? "no se pudo crear el documento"}`);
        resultado.enviadas += 1;
      } catch (e) {
        resultado.conError += 1;
        const msg = e instanceof Error ? e.message : String(e);
        resultado.porRevisar.push({ etiqueta, motivos: [msg.slice(0, 300)] });
        resultado.primerError ??= msg.slice(0, 300);
      }
    }
    // Las que fallaron ya no están en borrador verde: no se reintentan solas.
    resultado.verdesPendientes = Math.max(0, verdes.length - turno.length);
    return resultado;
  });
}
