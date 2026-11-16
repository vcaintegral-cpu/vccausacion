// Causación de los documentos del Excel RECIBIDOS en el servidor (piloto automático).
// Usa EXACTAMENTE la misma lógica de la carga masiva del navegador (processItem → saveExtractedInvoice
// → motor con histórico, precedente, IVA y retenciones), sin IA: el Excel ya trae los datos.
// Los PDF no se causan aquí (necesitan lectura con IA): quedan en la cola para el navegador.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type ResultadoCola = {
  /** Documentos del Excel tomados en esta llamada. */
  procesadas: number;
  /** Quedaron causadas (borrador) y sin nada que revisar: «en verde». */
  verdes: number;
  /** Quedaron causadas pero requieren revisión de la usuaria. */
  amarillas: number;
  /** No se pudieron causar (error o duplicado). */
  conError: number;
  /** Documentos del Excel que siguen esperando en la cola. */
  pendientes: number;
  /** PDF que esperan en la cola (se causan desde la aplicación). */
  pdfPendientes: number;
};

export async function causarColaExcel(
  db: Db,
  companyId: string,
  limite = 8,
): Promise<ResultadoCola> {
  const { conClienteDeServicio } = await import("./db-contextual");
  return conClienteDeServicio(db, async () => {
    const [{ loadDeps, invalidateBulkDeps, processItem }, { resetBulkBatch }] = await Promise.all([
      import("./bulk-runner"),
      import("./bulk-invoices"),
    ]);
    const base = () =>
      db
        .from("bulk_upload_items")
        .select("*", { count: "exact" })
        .eq("company_id", companyId)
        .eq("status", "pending");
    const { data: items, error } = await base()
      .like("fingerprint", "excel:%")
      .order("created_at")
      .limit(limite);
    if (error) throw new Error(error.message);
    const tomadas = (items ?? []) as Array<
      Record<string, unknown> & { id: string; upload_id: string }
    >;
    const resultado: ResultadoCola = {
      procesadas: 0,
      verdes: 0,
      amarillas: 0,
      conError: 0,
      pendientes: 0,
      pdfPendientes: 0,
    };
    if (tomadas.length) {
      // Dueño de la carga (quien configuró la fuente): los borradores quedan a su nombre.
      const { data: carga } = await db
        .from("bulk_uploads")
        .select("created_by")
        .eq("id", tomadas[0]!.upload_id)
        .maybeSingle();
      const dueno = (carga as { created_by: string } | null)?.created_by;
      if (!dueno)
        throw new Error("No se encontró el dueño de la carga para causar los documentos.");
      resetBulkBatch();
      invalidateBulkDeps(companyId);
      const deps = await loadDeps(companyId, dueno);
      for (const item of tomadas) {
        await processItem(item as never, companyId, deps);
        resultado.procesadas += 1;
      }
      const { data: despues } = await db
        .from("bulk_upload_items")
        .select("id, status, needs_review")
        .in(
          "id",
          tomadas.map((i) => i.id),
        );
      for (const d of (despues ?? []) as Array<{ status: string; needs_review: boolean | null }>) {
        if (d.status === "completed")
          d.needs_review ? (resultado.amarillas += 1) : (resultado.verdes += 1);
        else resultado.conError += 1;
      }
    }
    const { count: excel } = await base().like("fingerprint", "excel:%").limit(1);
    const { count: pdf } = await base().not("fingerprint", "like", "excel:%").limit(1);
    resultado.pendientes = excel ?? 0;
    resultado.pdfPendientes = pdf ?? 0;
    return resultado;
  });
}
