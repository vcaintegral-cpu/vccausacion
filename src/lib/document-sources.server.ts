// Ejecución de una fuente (botón "Revisar ahora" o tarea programada).
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Proposito } from "@/lib/drive-sync";
import { syncSource, type DocumentSource, type SyncResult } from "@/lib/document-sync.server";
import { proveedorDeArchivos } from "@/lib/oauth-connections.server";

const COLUMNAS = "id, company_id, purpose, provider, folder_id, drive_id, month_subfolder";

async function ejecutar(
  admin: SupabaseClient,
  source: DocumentSource,
  userId?: string | null,
): Promise<SyncResult> {
  try {
    const provider = await proveedorDeArchivos(
      admin,
      source.company_id,
      source.provider,
      source.drive_id,
    );
    return await syncSource(admin, source, { provider, userId });
  } catch (e) {
    // Falla de conexión (token vencido, permiso retirado): se deja registrada en la fuente.
    const message = e instanceof Error ? e.message : String(e);
    const result = {
      sourceId: source.id,
      companyId: source.company_id,
      purpose: source.purpose,
      periodos: [],
      modo: "por_mes",
      encontrados: 0,
      facturasEncoladas: 0,
      documentosExcel: 0,
      egresosRecibidos: 0,
      duplicados: 0,
      renombrados: 0,
      pendientesProximaEjecucion: 0,
      uploadIds: [],
      advertencias: [],
      errores: [message],
    } satisfies SyncResult;
    await admin
      .from("document_sources")
      .update({
        last_run_at: new Date().toISOString(),
        last_status: "con_errores",
        last_result: result,
      })
      .eq("id", source.id);
    return result;
  }
}

export async function revisarFuente(
  admin: SupabaseClient,
  companyId: string,
  purpose: Proposito,
  userId?: string | null,
): Promise<SyncResult> {
  const { data, error } = await admin
    .from("document_sources")
    .select(COLUMNAS)
    .eq("company_id", companyId)
    .eq("purpose", purpose)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`La empresa no tiene carpeta de ${purpose} configurada.`);
  return ejecutar(admin, data as DocumentSource, userId);
}

/** Todas las fuentes activas de todas las empresas (tarea programada diaria). */
export async function revisarTodas(admin: SupabaseClient): Promise<SyncResult[]> {
  const { data, error } = await admin.from("document_sources").select(COLUMNAS).eq("enabled", true);
  if (error) throw new Error(error.message);
  const resultados: SyncResult[] = [];
  for (const s of (data ?? []) as DocumentSource[]) resultados.push(await ejecutar(admin, s));
  return resultados;
}
