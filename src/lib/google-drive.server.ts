// Cliente mínimo de Google Drive (OAuth 2.0 + REST v3) para el importador.
// Solo lectura: lista carpetas y descarga PDF. Nunca modifica, mueve ni borra
// archivos en Drive.
import type { SupabaseClient } from "@supabase/supabase-js";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export function googleConfig() {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"] ?? "";
  const missing = [
    ...(!clientId ? ["GOOGLE_OAUTH_CLIENT_ID"] : []),
    ...(!clientSecret ? ["GOOGLE_OAUTH_CLIENT_SECRET"] : []),
  ];
  return { clientId, clientSecret, missing };
}

export function authorizationUrl(params: { redirectUri: string; state: string }): string {
  const { clientId } = googleConfig();
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // "consent" garantiza que Google entregue refresh token también al reconectar.
    prompt: "consent",
    include_granted_scopes: "true",
    state: params.state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `Google rechazó la autorización: ${json.error_description ?? json.error ?? res.status}`,
    );
  }
  return json;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const { clientId, clientSecret } = googleConfig();
  const tok = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  return { ...tok, email: emailFromIdToken(tok.id_token) };
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1] ?? "";
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      email?: string;
    };
    return json.email ?? null;
  } catch {
    return null;
  }
}

/** Access token vigente para la empresa, renovado con el refresh token guardado. */
export async function accessTokenForCompany(
  admin: SupabaseClient,
  companyId: string,
): Promise<string> {
  const { data, error } = await admin
    .from("google_drive_connections")
    .select("refresh_token")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const refresh = (data as { refresh_token: string } | null)?.refresh_token;
  if (!refresh) throw new Error("La empresa no tiene Google Drive conectado.");
  const { clientId, clientSecret } = googleConfig();
  const tok = await tokenRequest({
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  return tok.access_token;
}

export type DriveItem = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
};

async function driveGet(
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<Response> {
  const res = await fetch(`${DRIVE}${path}?${new URLSearchParams(params).toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Drive respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

export async function getItem(token: string, id: string): Promise<DriveItem> {
  const res = await driveGet(token, `/files/${encodeURIComponent(id)}`, {
    fields: "id,name,mimeType,size,modifiedTime,md5Checksum",
    supportsAllDrives: "true",
  });
  return (await res.json()) as DriveItem;
}

/** Hijos directos de una carpeta (sin papelera), con paginación completa. */
export async function listChildren(token: string, folderId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let pageToken: string | undefined;
  do {
    const res = await driveGet(token, "/files", {
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const json = (await res.json()) as { files?: DriveItem[]; nextPageToken?: string };
    out.push(...(json.files ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

export type DriveChild = DriveItem & { parents?: string[] };

/**
 * Hijos de varias carpetas a la vez ("'a' in parents or 'b' in parents ...").
 * Reduce las llamadas a Drive al recorrer una carpeta con muchas subcarpetas.
 */
export async function listChildrenMany(token: string, folderIds: string[]): Promise<DriveChild[]> {
  const out: DriveChild[] = [];
  for (let i = 0; i < folderIds.length; i += 25) {
    const grupo = folderIds.slice(i, i + 25);
    const padres = grupo.map((id) => `'${id.replace(/'/g, "\\'")}' in parents`).join(" or ");
    let pageToken: string | undefined;
    do {
      const res = await driveGet(token, "/files", {
        q: `(${padres}) and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      const json = (await res.json()) as { files?: DriveChild[]; nextPageToken?: string };
      out.push(...(json.files ?? []));
      pageToken = json.nextPageToken;
    } while (pageToken);
  }
  return out;
}

export async function downloadFile(token: string, id: string): Promise<Uint8Array> {
  const res = await driveGet(token, `/files/${encodeURIComponent(id)}`, {
    alt: "media",
    supportsAllDrives: "true",
  });
  return new Uint8Array(await res.arrayBuffer());
}
