// Google Drive (OAuth 2.0 + REST v3) para las fuentes de documentos.
// Solo lectura: lista carpetas y descarga archivos. Nunca modifica, mueve ni
// borra nada en Drive.
import type { FileNode, FileProvider } from "@/lib/file-providers";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export function googleConfig() {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"] ?? "";
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"] ?? "";
  const missing = [
    ...(!clientId ? ["GOOGLE_OAUTH_CLIENT_ID"] : []),
    ...(!clientSecret ? ["GOOGLE_OAUTH_CLIENT_SECRET"] : []),
  ];
  return { clientId, clientSecret, missing };
}

export function googleAuthorizationUrl(params: { redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: googleConfig().clientId,
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

export type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

export async function postToken(
  url: string,
  body: Record<string, string>,
  quien: string,
): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `${quien} rechazó la autorización: ${json.error_description ?? json.error ?? res.status}`,
    );
  }
  return json;
}

export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1] ?? "";
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      email?: string;
      preferred_username?: string;
      upn?: string;
    };
    return json.email ?? json.preferred_username ?? json.upn ?? null;
  } catch {
    return null;
  }
}

export async function googleExchangeCode(code: string, redirectUri: string) {
  const { clientId, clientSecret } = googleConfig();
  return postToken(
    TOKEN_URL,
    {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    "Google",
  );
}

export async function googleRefresh(refreshToken: string) {
  const { clientId, clientSecret } = googleConfig();
  return postToken(
    TOKEN_URL,
    {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    },
    "Google",
  );
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
};

const toNode = (f: DriveFile, parentId: string | null): FileNode => ({
  id: f.id,
  name: f.name,
  isFolder: f.mimeType === FOLDER_MIME,
  mimeType: f.mimeType,
  size: f.size ? Number(f.size) : null,
  modifiedAt: f.modifiedTime ?? null,
  parentId: parentId ?? f.parents?.[0] ?? null,
});

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

const esc = (id: string) => id.replace(/'/g, "\\'");

/** Archivos que cumplen una consulta de Drive, con paginación completa. */
async function query(token: string, q: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await driveGet(token, "/files", {
      q,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
    out.push(...(json.files ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

/** Nombre y tipo de una carpeta, para confirmar a la usuaria que el enlace es el correcto. */
export async function googleFolderInfo(token: string, folderId: string) {
  const res = await driveGet(token, `/files/${encodeURIComponent(folderId)}`, {
    fields: "id,name,mimeType",
    supportsAllDrives: "true",
  });
  const f = (await res.json()) as DriveFile;
  return { id: f.id, name: f.name, isFolder: f.mimeType === FOLDER_MIME };
}

export function googleProvider(token: string): FileProvider {
  return {
    async listChildren(folderId) {
      return (await query(token, `'${esc(folderId)}' in parents and trashed = false`)).map((f) =>
        toNode(f, folderId),
      );
    },
    async listChildrenMany(folderIds) {
      const out: FileNode[] = [];
      // "'a' in parents or 'b' in parents ..." en grupos: pocas llamadas para muchas carpetas.
      for (let i = 0; i < folderIds.length; i += 25) {
        const grupo = folderIds.slice(i, i + 25);
        const padres = grupo.map((id) => `'${esc(id)}' in parents`).join(" or ");
        for (const f of await query(token, `(${padres}) and trashed = false`)) {
          out.push(toNode(f, f.parents?.find((p) => grupo.includes(p)) ?? null));
        }
      }
      return out;
    },
    async download(file) {
      const res = await driveGet(token, `/files/${encodeURIComponent(file.id)}`, {
        alt: "media",
        supportsAllDrives: "true",
      });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
