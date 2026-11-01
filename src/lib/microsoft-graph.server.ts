// OneDrive / SharePoint (Microsoft identity platform + Microsoft Graph) para las
// fuentes de documentos. Solo lectura: lista carpetas y descarga archivos.
import type { EnlaceCarpeta } from "@/lib/drive-sync";
import type { FileNode, FileProvider } from "@/lib/file-providers";
import { postToken } from "@/lib/google-drive.server";

// Files.Read.All permite leer carpetas que otra persona compartió (OneDrive de
// mbustamante@...). Según la configuración del tenant puede requerir que un
// administrador de Microsoft 365 apruebe la app.
export const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "User.Read",
  "Files.Read.All",
];

const GRAPH = "https://graph.microsoft.com/v1.0";

export function microsoftConfig() {
  const clientId = process.env["MICROSOFT_OAUTH_CLIENT_ID"] ?? "";
  const clientSecret = process.env["MICROSOFT_OAUTH_CLIENT_SECRET"] ?? "";
  // "organizations" acepta cuentas de cualquier empresa; con el ID del tenant se limita a integralyasesores.com.
  const tenant = process.env["MICROSOFT_OAUTH_TENANT"] || "organizations";
  const missing = [
    ...(!clientId ? ["MICROSOFT_OAUTH_CLIENT_ID"] : []),
    ...(!clientSecret ? ["MICROSOFT_OAUTH_CLIENT_SECRET"] : []),
  ];
  return { clientId, clientSecret, tenant, missing };
}

const authority = () =>
  `https://login.microsoftonline.com/${encodeURIComponent(microsoftConfig().tenant)}/oauth2/v2.0`;

export function microsoftAuthorizationUrl(params: { redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: microsoftConfig().clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    prompt: "select_account",
    state: params.state,
  });
  return `${authority()}/authorize?${q.toString()}`;
}

export async function microsoftExchangeCode(code: string, redirectUri: string) {
  const { clientId, clientSecret } = microsoftConfig();
  return postToken(
    `${authority()}/token`,
    {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPES.join(" "),
    },
    "Microsoft",
  );
}

/** Microsoft rota el refresh token: el nuevo que devuelve debe guardarse. */
export async function microsoftRefresh(refreshToken: string) {
  const { clientId, clientSecret } = microsoftConfig();
  return postToken(
    `${authority()}/token`,
    {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      scope: MICROSOFT_SCOPES.join(" "),
    },
    "Microsoft",
  );
}

type GraphItem = {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: unknown;
  file?: { mimeType?: string };
  parentReference?: { id?: string; driveId?: string };
  remoteItem?: { id: string; parentReference?: { driveId?: string } };
};

async function graph<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Microsoft Graph respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

const SELECT = "$select=id,name,size,lastModifiedDateTime,folder,file,parentReference,remoteItem";

const toNode = (i: GraphItem, parentId: string | null): FileNode => ({
  id: i.id,
  name: i.name,
  isFolder: !!i.folder,
  mimeType: i.file?.mimeType ?? null,
  size: i.size ?? null,
  modifiedAt: i.lastModifiedDateTime ?? null,
  parentId: parentId ?? i.parentReference?.id ?? null,
});

const encodePath = (ruta: string) =>
  ruta.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/** Convierte el enlace pegado en la carpeta real de Graph (unidad + id). */
export async function microsoftResolveFolder(
  token: string,
  enlace: Extract<EnlaceCarpeta, { proveedor: "microsoft" }>,
): Promise<{ driveId: string; folderId: string; name: string; isFolder: boolean }> {
  let item: GraphItem;
  if (enlace.tipo === "compartido") {
    // Codificación de Graph para vínculos compartidos: "u!" + base64url de la URL.
    const bytes = new TextEncoder().encode(enlace.url);
    const b64 = btoa(String.fromCharCode(...bytes))
      .replace(/=+$/, "")
      .replace(/\//g, "_")
      .replace(/\+/g, "-");
    item = await graph<GraphItem>(token, `/shares/u!${b64}/driveItem?${SELECT}`);
  } else {
    const site = await graph<{ id: string }>(
      token,
      `/sites/${enlace.host}:/${encodePath(enlace.sitio)}`,
    );
    const drives = await graph<{ value: Array<{ id: string; webUrl: string; name: string }> }>(
      token,
      `/sites/${site.id}/drives?$select=id,webUrl,name`,
    );
    const drive =
      drives.value.find((d) =>
        decodeURIComponent(d.webUrl).replace(/\/$/, "").endsWith(`/${enlace.biblioteca}`),
      ) ??
      (/^(documents|shared documents|documentos|documentos compartidos)$/i.test(enlace.biblioteca)
        ? await graph<{ id: string; webUrl: string; name: string }>(
            token,
            `/sites/${site.id}/drive?$select=id,webUrl,name`,
          )
        : undefined);
    if (!drive)
      throw new Error(`No se encontró la biblioteca "${enlace.biblioteca}" en ${enlace.sitio}.`);
    item = enlace.ruta
      ? await graph<GraphItem>(
          token,
          `/drives/${drive.id}/root:/${encodePath(enlace.ruta)}?${SELECT}`,
        )
      : await graph<GraphItem>(token, `/drives/${drive.id}/root?${SELECT}`);
  }
  // Carpeta compartida desde otra unidad: se usa la referencia remota.
  const driveId = item.remoteItem?.parentReference?.driveId ?? item.parentReference?.driveId;
  if (!driveId) throw new Error("Microsoft no devolvió la unidad de la carpeta.");
  return {
    driveId,
    folderId: item.remoteItem?.id ?? item.id,
    name: item.name,
    isFolder: !!item.folder || !!item.remoteItem,
  };
}

export function microsoftProvider(token: string, driveId: string): FileProvider {
  const children = async (folderId: string) => {
    const out: FileNode[] = [];
    let next: string | undefined =
      `/drives/${driveId}/items/${folderId}/children?${SELECT}&$top=999`;
    while (next) {
      const page: { value: GraphItem[]; "@odata.nextLink"?: string } = await graph(token, next);
      out.push(...page.value.map((i) => toNode(i, folderId)));
      next = page["@odata.nextLink"];
    }
    return out;
  };
  return {
    listChildren: children,
    async listChildrenMany(folderIds) {
      const out: FileNode[] = [];
      // $batch: hasta 20 carpetas por llamada.
      for (let i = 0; i < folderIds.length; i += 20) {
        const grupo = folderIds.slice(i, i + 20);
        const res = await graph<{
          responses: Array<{
            id: string;
            status: number;
            body: { value?: GraphItem[]; "@odata.nextLink"?: string };
          }>;
        }>(token, "/$batch", {
          method: "POST",
          body: JSON.stringify({
            requests: grupo.map((id, n) => ({
              id: String(n),
              method: "GET",
              url: `/drives/${driveId}/items/${id}/children?${SELECT}&$top=999`,
            })),
          }),
        });
        for (const r of res.responses) {
          const folderId = grupo[Number(r.id)]!;
          if (r.status !== 200)
            throw new Error(`Microsoft Graph respondió ${r.status} al listar una carpeta.`);
          out.push(...(r.body.value ?? []).map((it) => toNode(it, folderId)));
          // Carpeta con más de 999 elementos: se completa página por página.
          let next = r.body["@odata.nextLink"];
          while (next) {
            const page: { value: GraphItem[]; "@odata.nextLink"?: string } = await graph(
              token,
              next,
            );
            out.push(...page.value.map((it) => toNode(it, folderId)));
            next = page["@odata.nextLink"];
          }
        }
      }
      return out;
    },
    async download(file) {
      // /content responde con redirección a una URL de descarga temporal; fetch la sigue.
      const res = await fetch(`${GRAPH}/drives/${driveId}/items/${file.id}/content`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok)
        throw new Error(`Microsoft Graph respondió ${res.status} al descargar ${file.name}.`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
