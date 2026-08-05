// Cliente server-only para la API de Siigo (https://api.siigo.com).
// Autenticación vigente: POST /auth  { username, access_key }  + header Partner-Id.
// Devuelve { access_token, expires_in, token_type }.

const SIIGO_BASE = "https://api.siigo.com";

let cached: { token: string; exp: number } | null = null;

export type SiigoConfig = {
  username: string;
  accessKey: string;
  partnerId: string;
  missing: string[];
  /** Avisos no bloqueantes (p. ej. Partner-Id sin configurar). */
  warnings: string[];
};

export function siigoConfig(): SiigoConfig {
  const username = (process.env["SIIGO_USERNAME"] ?? "").trim();
  const accessKey = (process.env["SIIGO_ACCESS_KEY"] ?? "").trim();
  // Sin valor por defecto. Es opcional: si no existe, no se envía el header Partner-Id.
  const partnerId = (process.env["SIIGO_PARTNER_ID"] ?? "").trim();

  const missing: string[] = [];
  if (!username) missing.push("SIIGO_USERNAME");
  if (!accessKey) missing.push("SIIGO_ACCESS_KEY");

  const warnings: string[] = [];
  if (!partnerId) {
    warnings.push(
      "SIIGO_PARTNER_ID no está configurado: se omite el header Partner-Id. Puedes configurarlo más adelante.",
    );
  }

  return { username, accessKey, partnerId, missing, warnings };
}

export class SiigoError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(params: { status: number; url: string; body: string; message?: string }) {
    super(params.message ?? `Siigo ${params.url} respondió ${params.status}: ${params.body}`);
    this.name = "SiigoError";
    this.status = params.status;
    this.url = params.url;
    this.body = params.body;
  }
}

function logHeaders(headers: Record<string, string>) {
  // Nunca se registran credenciales: se enmascaran Authorization y access_key.
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    safe[k] = k.toLowerCase() === "authorization" ? "Bearer ***" : v;
  }
  return safe;
}

export function siigoResetTokenCache() {
  cached = null;
}

export async function siigoToken(): Promise<string> {
  const { username, accessKey, partnerId, missing } = siigoConfig();
  if (missing.length > 0) {
    throw new SiigoError({
      status: 0,
      url: `${SIIGO_BASE}/auth`,
      body: "",
      message: `Faltan variables de entorno de Siigo: ${missing.join(", ")}. Configúralas antes de conectar.`,
    });
  }

  const now = Date.now();
  if (cached && cached.exp > now + 30_000) return cached.token;

  const url = `${SIIGO_BASE}/auth`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (partnerId) headers["Partner-Id"] = partnerId;
  else console.warn("[siigo] SIIGO_PARTNER_ID vacío: se omite el header Partner-Id.");
  console.log("[siigo] POST", url, "headers:", logHeaders(headers), "body: { username: ***, access_key: *** }");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ username, access_key: accessKey }),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[siigo] fallo de red en", url, detail);
    throw new SiigoError({ status: 0, url, body: detail, message: `No se pudo contactar a Siigo: ${detail}` });
  }

  const text = await res.text();
  console.log("[siigo] respuesta", url, "status:", res.status, "body:", text);

  if (!res.ok) {
    throw new SiigoError({ status: res.status, url, body: text });
  }

  let json: { access_token?: string; expires_in?: number };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new SiigoError({ status: res.status, url, body: text, message: `Siigo devolvió una respuesta no JSON: ${text}` });
  }

  if (!json.access_token) {
    throw new SiigoError({ status: res.status, url, body: text, message: `Siigo no devolvió access_token: ${text}` });
  }

  cached = { token: json.access_token, exp: now + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

async function siigoRequest<T>(method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
  const token = await siigoToken();
  const { partnerId } = siigoConfig();
  const url = `${SIIGO_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Partner-Id": partnerId,
    "Content-Type": "application/json",
  };

  console.log("[siigo]", method, url, "headers:", logHeaders(headers));

  let res: Response;
  try {
    const init: RequestInit = { method, headers };
    if (payload !== undefined) init.body = JSON.stringify(payload);
    res = await fetch(url, init);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[siigo] fallo de red en", url, detail);
    throw new SiigoError({ status: 0, url, body: detail, message: `No se pudo contactar a Siigo: ${detail}` });
  }

  const text = await res.text();
  console.log("[siigo] respuesta", url, "status:", res.status, "body:", text.slice(0, 4000));

  if (res.status === 401) {
    // El token pudo expirar antes de tiempo: se limpia la caché para el próximo intento.
    siigoResetTokenCache();
  }
  if (!res.ok) {
    throw new SiigoError({ status: res.status, url, body: text });
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SiigoError({ status: res.status, url, body: text, message: `Siigo devolvió una respuesta no JSON: ${text}` });
  }
}

export async function siigoGet<T>(path: string): Promise<T> {
  return siigoRequest<T>("GET", path);
}

export async function siigoPost<T>(path: string, payload: unknown): Promise<T> {
  return siigoRequest<T>("POST", path, payload);
}
