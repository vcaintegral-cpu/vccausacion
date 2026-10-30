import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { idDeCarpetaDrive } from "@/lib/drive-sync";
import type { DriveSyncResult } from "@/lib/drive-sync.server";

export type DriveSyncStatus = {
  missingEnv: string[];
  connected: boolean;
  googleEmail: string | null;
  connectedAt: string | null;
  folderId: string | null;
  folderName: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastResult: DriveSyncResult | null;
};

type CompanyInput = { companyId: string };

const conEmpresa = (input: CompanyInput) => {
  if (!input?.companyId) throw new Error("companyId requerido");
  return input;
};

/** Verifica con la sesión del usuario (RLS) que pertenece a la empresa. */
async function exigirMiembro(supabase: SupabaseClient, companyId: string) {
  const { data, error } = await supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No tienes acceso a esta empresa.");
}

async function adminClient(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

export const driveSyncStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(conEmpresa)
  .handler(async ({ data, context }): Promise<DriveSyncStatus> => {
    await exigirMiembro(context.supabase as unknown as SupabaseClient, data.companyId);
    const { googleConfig } = await import("@/lib/google-drive.server");
    const admin = await adminClient();
    const [{ data: conn }, { data: src }] = await Promise.all([
      admin
        .from("google_drive_connections")
        .select("google_email, connected_at")
        .eq("company_id", data.companyId)
        .maybeSingle(),
      admin
        .from("drive_sync_sources")
        .select("root_folder_id, root_folder_name, enabled, last_run_at, last_status, last_result")
        .eq("company_id", data.companyId)
        .maybeSingle(),
    ]);
    const c = conn as { google_email: string | null; connected_at: string } | null;
    const s = src as {
      root_folder_id: string;
      root_folder_name: string | null;
      enabled: boolean;
      last_run_at: string | null;
      last_status: string | null;
      last_result: DriveSyncResult | null;
    } | null;
    return {
      missingEnv: googleConfig().missing,
      connected: !!c,
      googleEmail: c?.google_email ?? null,
      connectedAt: c?.connected_at ?? null,
      folderId: s?.root_folder_id ?? null,
      folderName: s?.root_folder_name ?? null,
      enabled: s?.enabled ?? false,
      lastRunAt: s?.last_run_at ?? null,
      lastStatus: s?.last_status ?? null,
      lastResult: s?.last_result ?? null,
    };
  });

/** Devuelve la URL de Google para autorizar la lectura de Drive con la cuenta que tiene acceso a la carpeta. */
export const driveConnectStart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(conEmpresa)
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase as unknown as SupabaseClient, data.companyId);
    const { authorizationUrl, googleConfig } = await import("@/lib/google-drive.server");
    const cfg = googleConfig();
    if (cfg.missing.length)
      throw new Error(`Falta configurar en el servidor: ${cfg.missing.join(", ")}.`);
    const request = getRequest();
    const redirectUri = `${new URL(request.url).origin}/api/google/callback`;
    const admin = await adminClient();
    const { data: row, error } = await admin
      .from("google_oauth_states")
      .insert({ company_id: data.companyId, user_id: context.userId, redirect_uri: redirectUri })
      .select("state")
      .single();
    if (error) throw new Error(error.message);
    return { url: authorizationUrl({ redirectUri, state: (row as { state: string }).state }) };
  });

export const driveSaveFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompanyInput & { folder: string; enabled: boolean }) => {
    conEmpresa(input);
    if (typeof input.folder !== "string") throw new Error("Carpeta requerida");
    return input;
  })
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase as unknown as SupabaseClient, data.companyId);
    const folderId = idDeCarpetaDrive(data.folder);
    if (!folderId)
      throw new Error(
        "Pega el enlace de la carpeta de Google Drive (https://drive.google.com/drive/folders/...).",
      );
    const { accessTokenForCompany, getItem, FOLDER_MIME } =
      await import("@/lib/google-drive.server");
    const admin = await adminClient();
    // Se valida con la cuenta conectada que la carpeta existe y es legible.
    const token = await accessTokenForCompany(admin, data.companyId);
    const item = await getItem(token, folderId);
    if (item.mimeType !== FOLDER_MIME) throw new Error(`"${item.name}" no es una carpeta.`);
    const { error } = await admin.from("drive_sync_sources").upsert(
      {
        company_id: data.companyId,
        root_folder_id: folderId,
        root_folder_name: item.name,
        enabled: data.enabled,
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id" },
    );
    if (error) throw new Error(error.message);
    return { folderId, folderName: item.name };
  });

export const driveSyncRunNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(conEmpresa)
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase as unknown as SupabaseClient, data.companyId);
    const { syncDriveCompany } = await import("@/lib/drive-sync.server");
    return syncDriveCompany(await adminClient(), data.companyId, { userId: context.userId });
  });

export const driveDisconnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(conEmpresa)
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase as unknown as SupabaseClient, data.companyId);
    const admin = await adminClient();
    const { error } = await admin
      .from("google_drive_connections")
      .delete()
      .eq("company_id", data.companyId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
