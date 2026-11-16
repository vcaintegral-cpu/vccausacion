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
      .eq("status", "borrador")
      .gte("issue_date", op.mes.desde)
      .lte("issue_date", op.mes.hasta)
      .is("siigo_id", null)
      .is("siigo_number", null)
      .is("processing_at", null)
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
      { needs_review: boolean | null; status: string; upload_id: string }
    >();
    for (const g of chunk(ids, 100)) {
      const { data } = await db
        .from("bulk_upload_items")
        .select("invoice_id, status, needs_review, upload_id")
        .in("invoice_id", g);
      for (const t of (data ?? []) as Array<{
        invoice_id: string;
        status: string;
        needs_review: boolean | null;
        upload_id: string;
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
      const etiqueta = [f.prefix, f.number].filter(Boolean).join("-") || f.id.slice(0, 8);
      const acc = classifyJournal((asientos.get(f.id) ?? []) as never);
      const t = tareas.get(f.id);
      const decisiones = Object.values(
        ((
          f["raw_extraction"] as {
            account_decisions?: Record<string, { confidence?: string }>;
          } | null
        )?.account_decisions ?? {}) as Record<string, { confidence?: string }>,
      );
      const motivos = motivosNoVerde({
        alertas: alertasBorrador(f as never, acc, pucCodes, inventario),
        tareaSinRevision: !!t && t.status === "completed" && !t.needs_review,
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
        const ap = await aprobarBorrador(f as never, acc, pucCodes, etiqueta, dueno, inventario);
        if (!ap.ok) throw new Error(`No se pudo aprobar: ${ap.message}`);
        const { data: fresca } = await db.from("invoices").select("*").eq("id", f.id).single();
        const ca = await causarFactura(fresca as never, etiqueta);
        if (!ca.ok) throw new Error(`No se pudo causar: ${ca.message}`);
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
