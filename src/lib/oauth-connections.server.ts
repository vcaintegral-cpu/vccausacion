// Conexiones OAuth por empresa y proveedor (Google / Microsoft). El refresh token
// vive en document_connections, que solo lee el servidor.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { FileProvider, ProveedorArchivos } from "@/lib/file-providers";
import {
  emailFromIdToken,
  googleAuthorizationUrl,
  googleConfig,
  googleExchangeCode,
  googleProvider,
  googleRefresh,
} from "@/lib/google-drive.server";
import {
  microsoftAuthorizationUrl,
  microsoftConfig,
  microsoftExchangeCode,
  microsoftProvider,
  microsoftRefresh,
} from "@/lib/microsoft-graph.server";

export const PROVEEDORES: ProveedorArchivos[] = ["google", "microsoft"];

export function esProveedor(v: unknown): v is ProveedorArchivos {
  return v === "google" || v === "microsoft";
}

export function faltantesConfiguracion(p: ProveedorArchivos): string[] {
  return p === "google" ? googleConfig().missing : microsoftConfig().missing;
}

export function urlAutorizacion(
  p: ProveedorArchivos,
  params: { redirectUri: string; state: string },
): string {
  return p === "google" ? googleAuthorizationUrl(params) : microsoftAuthorizationUrl(params);
}

export async function canjearCodigo(p: ProveedorArchivos, code: string, redirectUri: string) {
  const tok =
    p === "google"
      ? await googleExchangeCode(code, redirectUri)
      : await microsoftExchangeCode(code, redirectUri);
  return { ...tok, email: emailFromIdToken(tok.id_token) };
}

/** Access token vigente; si el proveedor rota el refresh token (Microsoft), se guarda el nuevo. */
export async function tokenDeAcceso(
  admin: SupabaseClient,
  companyId: string,
  p: ProveedorArchivos,
): Promise<string> {
  const { data, error } = await admin
    .from("document_connections")
    .select("refresh_token")
    .eq("company_id", companyId)
    .eq("provider", p)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const refresh = (data as { refresh_token: string } | null)?.refresh_token;
  if (!refresh) {
    throw new Error(
      `La empresa no tiene ${p === "google" ? "Google Drive" : "OneDrive / SharePoint"} conectado.`,
    );
  }
  const tok = p === "google" ? await googleRefresh(refresh) : await microsoftRefresh(refresh);
  if (tok.refresh_token && tok.refresh_token !== refresh) {
    await admin
      .from("document_connections")
      .update({ refresh_token: tok.refresh_token })
      .eq("company_id", companyId)
      .eq("provider", p);
  }
  return tok.access_token;
}

export async function proveedorDeArchivos(
  admin: SupabaseClient,
  companyId: string,
  p: ProveedorArchivos,
  driveId: string | null,
): Promise<FileProvider> {
  const token = await tokenDeAcceso(admin, companyId, p);
  if (p === "google") return googleProvider(token);
  if (!driveId)
    throw new Error("La carpeta de OneDrive no tiene unidad registrada; vuelve a guardarla.");
  return microsoftProvider(token, driveId);
}
