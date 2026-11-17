// Causación de la cola de la carga masiva en el servidor (piloto automático).
// Usa EXACTAMENTE la misma lógica de la carga masiva del navegador (processItem → saveExtractedInvoice
// → motor con histórico, precedente, IVA y retenciones):
//   - Documentos del Excel RECIBIDOS: sin IA, el Excel ya trae los datos.
//   - PDF: se leen con IA desde el servidor; el PDF viaja completo, sin renderizar páginas.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type ResultadoCola = {
  /** Documentos tomados en esta llamada (Excel + PDF). */
  procesadas: number;
  /** Quedaron causadas (borrador) y sin nada que revisar: «en verde». */
  verdes: number;
  /** Quedaron causadas pero requieren revisión de la usuaria. */
  amarillas: number;
  /** No se pudieron causar (error o duplicado). */
  conError: number;
  /** Documentos del Excel que siguen esperando en la cola. */
  pendientes: number;
  /** PDF que siguen esperando en la cola. */
  pdfPendientes: number;
  /** Apartados por no ser del mes de trabajo (anteriores o posteriores). */
  fueraDeMes: number;
  /** Tareas que otro proceso ya había tomado (no se tocaron). */
  ocupadas: number;
};

type Tarea = Record<string, unknown> & {
  id: string;
  upload_id: string;
  fingerprint?: string | null;
};

// Documentos que se leen sin IA: filas del Excel RECIBIDOS y facturas desde su XML.
const esExcel = (t: Tarea) => /^(excel|xml):/.test(String(t.fingerprint ?? ""));

export async function causarCola(
  db: Db,
  companyId: string,
  opciones: {
    limiteExcel?: number;
    limitePdf?: number;
    mes?: import("./bulk-invoices").RangoMes;
  } = {},
): Promise<ResultadoCola> {
  const limiteExcel = opciones.limiteExcel ?? 3;
  const limitePdf = opciones.limitePdf ?? 2;
  const { conClienteDeServicio } = await import("./db-contextual");
  return conClienteDeServicio(db, async () => {
    const [{ loadDeps, invalidateBulkDeps, processItem }, { resetBulkBatch }] = await Promise.all([
      import("./bulk-runner"),
      import("./bulk-invoices"),
    ]);
    const pendientes = () =>
      db
        .from("bulk_upload_items")
        .select("*", { count: "exact" })
        .eq("company_id", companyId)
        .eq("status", "pending");
    const soloExcel = <T extends { or: (f: string) => T }>(q: T) =>
      q.or("fingerprint.like.excel:%,fingerprint.like.xml:%");
    const soloPdf = <T extends { or: (f: string) => T }>(q: T) =>
      q.or("fingerprint.is.null,and(fingerprint.not.like.excel:%,fingerprint.not.like.xml:%)");

    // Tareas que quedaron a medias (el proceso se cortó): si llevan más de 15 minutos sin cambios vuelven
    // a la cola; si ya se intentaron 3 veces se marcan con error para no repetirlas sin fin.
    const hace15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const transitorios = [
      "downloading",
      "reading",
      "ocr",
      "extracting_data",
      "validating_company",
      "ready_for_accounting",
      "processing",
    ];
    const colgadas = () =>
      db
        .from("bulk_upload_items")
        .update({ status: "pending" })
        .eq("company_id", companyId)
        .in("status", transitorios)
        .lt("updated_at", hace15);
    await colgadas().lt("attempts", 3);
    await db
      .from("bulk_upload_items")
      .update({
        status: "error",
        error_message: "Se interrumpió 3 veces al causarla de noche.",
        user_message: "Se interrumpió 3 veces al causarla de noche. Revísela en la aplicación.",
      })
      .eq("company_id", companyId)
      .in("status", transitorios)
      .lt("updated_at", hace15)
      .gte("attempts", 3);

    const { data: excel, error } = await soloExcel(pendientes())
      .order("created_at")
      .limit(limiteExcel);
    if (error) throw new Error(error.message);
    const tomadasExcel = (excel ?? []) as Tarea[];
    // Los PDF solo se toman si no se llenó el cupo con documentos del Excel.
    let tomadasPdf: Tarea[] = [];
    if (tomadasExcel.length < limiteExcel && limitePdf > 0) {
      const { data: pdf } = await soloPdf(pendientes()).order("created_at").limit(limitePdf);
      tomadasPdf = (pdf ?? []) as Tarea[];
    }
    const todas = [...tomadasExcel, ...tomadasPdf];

    const resultado: ResultadoCola = {
      procesadas: 0,
      verdes: 0,
      amarillas: 0,
      conError: 0,
      pendientes: 0,
      pdfPendientes: 0,
      fueraDeMes: 0,
      ocupadas: 0,
    };
    if (todas.length) {
      // Dueño de la carga (quien configuró la fuente): los borradores quedan a su nombre.
      const { data: carga } = await db
        .from("bulk_uploads")
        .select("created_by")
        .eq("id", todas[0]!.upload_id)
        .maybeSingle();
      const dueno = (carga as { created_by: string } | null)?.created_by;
      if (!dueno)
        throw new Error("No se encontró el dueño de la carga para causar los documentos.");

      let servidor: import("./bulk-runner").ModoServidor | undefined;
      if (tomadasPdf.length) {
        const llave = process.env["LOVABLE_API_KEY"] ?? "";
        if (!llave)
          throw new Error("Falta la configuración de IA (LOVABLE_API_KEY) para leer los PDF.");
        const [{ extractInvoiceWithAi }, { prepararArchivoServidor }] = await Promise.all([
          import("./extract.server"),
          import("./invoice-file-servidor"),
        ]);
        servidor = {
          extract: (async (args: { data: Parameters<typeof extractInvoiceWithAi>[0] }) =>
            extractInvoiceWithAi(args.data, llave)) as never,
          preparar: prepararArchivoServidor,
        };
      }

      resetBulkBatch();
      invalidateBulkDeps(companyId);
      const deps = await loadDeps(companyId, dueno);
      for (const item of todas) {
        // Se reclama la tarea de forma atómica: si la aplicación abierta (u otro proceso) ya la tomó, se salta.
        const { data: reclamada } = await db
          .from("bulk_upload_items")
          .update({ status: "downloading" })
          .eq("id", item.id)
          .eq("status", "pending")
          .select("id");
        if (!reclamada?.length) {
          resultado.ocupadas += 1;
          continue;
        }
        await processItem(
          item as never,
          companyId,
          deps,
          esExcel(item) ? undefined : servidor,
          opciones.mes,
        );
        resultado.procesadas += 1;
      }
      const { data: despues } = await db
        .from("bulk_upload_items")
        .select("id, status, needs_review, stage")
        .in(
          "id",
          todas.map((i) => i.id),
        );
      for (const d of (despues ?? []) as Array<{
        status: string;
        needs_review: boolean | null;
        stage: string | null;
      }>) {
        if (d.status === "completed")
          d.needs_review ? (resultado.amarillas += 1) : (resultado.verdes += 1);
        else if (d.stage === "fuera_de_mes") resultado.fueraDeMes += 1;
        else resultado.conError += 1;
      }
    }
    const { count: nExcel } = await soloExcel(pendientes()).limit(1);
    const { count: nPdf } = await soloPdf(pendientes()).limit(1);
    resultado.pendientes = nExcel ?? 0;
    resultado.pdfPendientes = nPdf ?? 0;
    return resultado;
  });
}
