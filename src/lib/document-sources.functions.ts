import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { interpretarEnlace, type Proposito } from "@/lib/drive-sync";
import type { SyncResult } from "@/lib/document-sync.server";
import type { ProveedorArchivos } from "@/lib/file-providers";

export type ConexionEstado = {
  provider: ProveedorArchivos;
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  missingEnv: string[];
};

export type FuenteEstado = {
  purpose: Proposito;
  provider: ProveedorArchivos;
  folderUrl: string;
  folderName: string | null;
  monthSubfolder: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastResult: SyncResult | null;
};

export type EgresoDoc = {
  id: string;
  kind: "soporte_pago" | "extracto";
  file_name: string;
  folder_path: string | null;
  period: string | null;
  storage_path: string;
  status: "pendiente" | "revisado" | "descartado";
  created_at: string;
};

type CompanyInput = { companyId: string };
const PROPOSITOS: Proposito[] = ["compras", "egresos"];

const conEmpresa = <T extends CompanyInput>(input: T) => {
  if (!input?.companyId) throw new Error("companyId requerido");
  return input;
};

/** Verifica con la sesión del usuario (RLS) que pertenece a la empresa. */
async function exigirMiembro(supabase: unknown, companyId: string) {
  const { data, error } = await (supabase as SupabaseClient)
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

export const fuentesEstado = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(conEmpresa)
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase, data.companyId);
    const { PROVEEDORES, faltantesConfiguracion } = await import("@/lib/oauth-connections.server");
    const admin = await adminClient();
    const [{ data: conns }, { data: srcs }] = await Promise.all([
      admin
        .from("document_connections")
        .select("provider, account_email, connected_at")
        .eq("company_id", data.companyId),
      admin
        .from("document_sources")
        .select(
          "purpose, provider, folder_url, folder_name, month_subfolder, enabled, last_run_at, last_status, last_result",
        )
        .eq("company_id", data.companyId),
    ]);
    const c = (conns ?? []) as Array<{
      provider: ProveedorArchivos;
      account_email: string | null;
      connected_at: string;
    }>;
    const s = (srcs ?? []) as Array<{
      purpose: Proposito;
      provider: ProveedorArchivos;
      folder_url: string;
      folder_name: string | null;
      month_subfolder: string | null;
      enabled: boolean;
      last_run_at: string | null;
      last_status: string | null;
      last_result: SyncResult | null;
    }>;
    const conexiones: ConexionEstado[] = PROVEEDORES.map((p) => {
      const row = c.find((x) => x.provider === p);
      return {
        provider: p,
        connected: !!row,
        email: row?.account_email ?? null,
        connectedAt: row?.connected_at ?? null,
        missingEnv: faltantesConfiguracion(p),
      };
    });
    const fuentes: FuenteEstado[] = s.map((r) => ({
      purpose: r.purpose,
      provider: r.provider,
      folderUrl: r.folder_url,
      folderName: r.folder_name,
      monthSubfolder: r.month_subfolder,
      enabled: r.enabled,
      lastRunAt: r.last_run_at,
      lastStatus: r.last_status,
      lastResult: r.last_result,
    }));
    return { conexiones, fuentes };
  });

/** URL de Google o Microsoft para autorizar la lectura con la cuenta que tiene acceso a las carpetas. */
export const fuentesConectar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompanyInput & { provider: ProveedorArchivos }) => {
    conEmpresa(input);
    if (input.provider !== "google" && input.provider !== "microsoft")
      throw new Error("Proveedor no válido");
    return input;
  })
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase, data.companyId);
    const { faltantesConfiguracion, urlAutorizacion } =
      await import("@/lib/oauth-connections.server");
    const faltan = faltantesConfiguracion(data.provider);
    if (faltan.length) throw new Error(`Falta configurar en el servidor: ${faltan.join(", ")}.`);
    const redirectUri = `${new URL(getRequest().url).origin}/api/oauth/callback`;
    const admin = await adminClient();
    const { data: row, error } = await admin
      .from("oauth_states")
      .insert({
        company_id: data.companyId,
        provider: data.provider,
        user_id: context.userId,
        redirect_uri: redirectUri,
      })
      .select("state")
      .single();
    if (error) throw new Error(error.message);
    return {
      url: urlAutorizacion(data.provider, { redirectUri, state: (row as { state: string }).state }),
    };
  });

export const fuentesDesconectar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompanyInput & { provider: ProveedorArchivos }) => conEmpresa(input))
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase, data.companyId);
    const admin = await adminClient();
    const { error } = await admin
      .from("document_connections")
      .delete()
      .eq("company_id", data.companyId)
      .eq("provider", data.provider);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Guarda la carpeta de compras o egresos: valida el enlace con la cuenta conectada y confirma su nombre. */
export const fuentesGuardar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (
      input: CompanyInput & {
        purpose: Proposito;
        folderUrl: string;
        monthSubfolder: string;
        enabled: boolean;
      },
    ) => {
      conEmpresa(input);
      if (!PROPOSITOS.includes(input.purpose)) throw new Error("Propósito no válido");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase, data.companyId);
    const enlace = interpretarEnlace(data.folderUrl);
    if (!enlace) {
      throw new Error("Pega el enlace de una carpeta de Google Drive o de OneDrive / SharePoint.");
    }
    const { tokenDeAcceso } = await import("@/lib/oauth-connections.server");
    const admin = await adminClient();
    const token = await tokenDeAcceso(admin, data.companyId, enlace.proveedor);
    let carpeta: { folderId: string; driveId: string | null; name: string; isFolder: boolean };
    if (enlace.proveedor === "google") {
      const { googleFolderInfo } = await import("@/lib/google-drive.server");
      const f = await googleFolderInfo(token, enlace.folderId);
      carpeta = { folderId: f.id, driveId: null, name: f.name, isFolder: f.isFolder };
    } else {
      const { microsoftResolveFolder } = await import("@/lib/microsoft-graph.server");
      const f = await microsoftResolveFolder(token, enlace);
      carpeta = { folderId: f.folderId, driveId: f.driveId, name: f.name, isFolder: f.isFolder };
    }
    if (!carpeta.isFolder) throw new Error(`"${carpeta.name}" no es una carpeta.`);
    const { error } = await admin.from("document_sources").upsert(
      {
        company_id: data.companyId,
        purpose: data.purpose,
        provider: enlace.proveedor,
        folder_url: data.folderUrl.trim(),
        folder_id: carpeta.folderId,
        drive_id: carpeta.driveId,
        folder_name: carpeta.name,
        month_subfolder: data.monthSubfolder.trim() || null,
        enabled: data.enabled,
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id,purpose" },
    );
    if (error) throw new Error(error.message);
    return { folderName: carpeta.name, provider: enlace.proveedor };
  });

export const fuentesRevisarAhora = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompanyInput & { purpose: Proposito }) => conEmpresa(input))
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase, data.companyId);
    const { revisarFuente } = await import("@/lib/document-sources.server");
    return revisarFuente(await adminClient(), data.companyId, data.purpose, context.userId);
  });

export const egresosListar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompanyInput & { incluirRevisados?: boolean }) => conEmpresa(input))
  .handler(async ({ data, context }): Promise<EgresoDoc[]> => {
    await exigirMiembro(context.supabase, data.companyId);
    let q = (context.supabase as unknown as SupabaseClient)
      .from("payment_documents")
      .select("id, kind, file_name, folder_path, period, storage_path, status, created_at")
      .eq("company_id", data.companyId)
      .order("created_at", { ascending: false })
      .limit(300);
    if (!data.incluirRevisados) q = q.eq("status", "pendiente");
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []) as EgresoDoc[];
  });

export const egresosMarcar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompanyInput & { id: string; status: EgresoDoc["status"] }) => {
    conEmpresa(input);
    if (!["pendiente", "revisado", "descartado"].includes(input.status))
      throw new Error("Estado no válido");
    return input;
  })
  .handler(async ({ data, context }) => {
    await exigirMiembro(context.supabase, data.companyId);
    const admin = await adminClient();
    const { error } = await admin
      .from("payment_documents")
      .update({
        status: data.status,
        reviewed_by: data.status === "pendiente" ? null : context.userId,
        reviewed_at: data.status === "pendiente" ? null : new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("company_id", data.companyId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
