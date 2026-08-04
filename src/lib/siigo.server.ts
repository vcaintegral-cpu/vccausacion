const SIIGO_BASE = "https://api.siigo.com";

let cached: { token: string; exp: number } | null = null;

export function siigoConfig() {
  return {
    username: process.env["SIIGO_USERNAME"] ?? "",
    accessKey: process.env["SIIGO_ACCESS_KEY"] ?? "",
    partnerId: process.env["SIIGO_PARTNER_ID"] ?? "ContaSync",
  };
}

export async function siigoToken(): Promise<string> {
  const { username, accessKey, partnerId } = siigoConfig();
  if (!username || !accessKey) {
    throw new Error("Faltan credenciales de Siigo (usuario API y Access Key).");
  }
  const now = Date.now();
  if (cached && cached.exp > now + 30_000) return cached.token;

  const res = await fetch(`${SIIGO_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Partner-Id": partnerId },
    body: JSON.stringify({ username, access_key: accessKey }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Siigo /auth [${res.status}]: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Siigo no devolvió access_token.");
  cached = { token: json.access_token, exp: now + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

export async function siigoGet<T>(path: string): Promise<T> {
  const token = await siigoToken();
  const { partnerId } = siigoConfig();
  const res = await fetch(`${SIIGO_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Partner-Id": partnerId,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Siigo ${path} [${res.status}]: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}
