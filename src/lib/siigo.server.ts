// Cliente server-only para la API de Siigo (https://api.siigo.com).
// Autenticación vigente: POST /auth  { username, access_key }  + header Partner-Id.
// Devuelve { access_token, expires_in, token_type }.

const SIIGO_BASE = "https://api.siigo.com";

let cached: { token: string; exp: number } | null = null;

/** Credenciales guardadas por el usuario desde la app (tienen prioridad sobre las variables de entorno). */
let overrides: { username: string; accessKey: string; partnerId: string } | null = null;
let overridesLoaded = false;

export async function loadSiigoOverrides(force = false) {
  if (overridesLoaded && !force) return overrides;
  overridesLoaded = true;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("siigo_credentials")
      .select("username, access_key, partner_id")
      .eq("id", "default")
      .maybeSingle();
    overrides = data
      ? {
          username: (data.username ?? "").trim(),
          accessKey: (data.access_key ?? "").trim(),
          partnerId: (data.partner_id ?? "").trim(),
        }
      : null;
  } catch (e) {
    console.error("[siigo] no se pudieron cargar credenciales guardadas:", e);
    overrides = null;
  }
  return overrides;
}

export async function saveSiigoOverrides(input: { username: string; accessKey: string; partnerId: string }) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("siigo_credentials").upsert(
    {
      id: "default",
      username: input.username.trim(),
      access_key: input.accessKey.trim(),
      partner_id: input.partnerId.trim() || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);
  overrides = {
    username: input.username.trim(),
    accessKey: input.accessKey.trim(),
    partnerId: input.partnerId.trim(),
  };
  overridesLoaded = true;
  siigoResetTokenCache();
}

export type SiigoConfig = {
  username: string;
  accessKey: string;
  partnerId: string;
  missing: string[];
  /** Avisos no bloqueantes (p. ej. Partner-Id sin configurar). */
  warnings: string[];
};

export function siigoConfig(): SiigoConfig {
  const username = (overrides?.username || process.env["SIIGO_USERNAME"] || "").trim();
  const accessKey = (overrides?.accessKey || process.env["SIIGO_ACCESS_KEY"] || "").trim();
  // Sin valor por defecto. Es opcional: si no existe, no se envía el header Partner-Id.
  const partnerId = (overrides?.partnerId || process.env["SIIGO_PARTNER_ID"] || "").trim();

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
  await loadSiigoOverrides();
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
    "Content-Type": "application/json",
  };
  if (partnerId) headers["Partner-Id"] = partnerId;

  console.log("[siigo]", method, url, "headers:", logHeaders(headers));

  const bodyString = payload !== undefined ? JSON.stringify(payload) : undefined;
  console.log("[siigo] ===== REQUEST =====");
  console.log("[siigo] URL:", url);
  console.log("[siigo] METHOD:", method);
  console.log("[siigo] HEADERS:", JSON.stringify(logHeaders(headers), null, 2));
  if (payload !== undefined) {
    console.log("[siigo] BODY:");
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("[siigo] BODY: (sin cuerpo)");
  }

  let res: Response;
  try {
    const init: RequestInit = { method, headers };
    if (bodyString !== undefined) init.body = bodyString;
    if (path === "/v1/purchases" && payload !== undefined) {
      console.log("SIIGO PURCHASE PAYLOAD", JSON.stringify(payload, null, 2));
      console.log("TOTAL FACTURA:", (payload as Record<string, unknown>)["total"]);
      console.log("PAYMENTS:", (payload as Record<string, unknown>)["payments"]);
      const purchasePayload = payload as Record<string, unknown>;
      const paymentsArr = Array.isArray(purchasePayload["payments"])
        ? purchasePayload["payments"]
        : [];
      const paymentsTotal = paymentsArr.reduce(
        (a, p) => a + Number((p as Record<string, unknown>)["value"] || 0),
        0,
      );
      console.log("SUMA PAYMENTS", paymentsTotal);
      const totalFactura = Number(purchasePayload["total"] || 0);
      // No corregir payments contra el total bruto: cuando hay retenciones,
      // Siigo espera allí el saldo neto que queda por pagar al proveedor.
      console.log("SIIGO FINAL PAYLOAD", JSON.stringify(payload, null, 2));
      console.log("========== SIIGO REQUEST ==========");
      console.log(JSON.stringify(payload, null, 2));
      console.log("===================================");
    }
    res = await fetch(url, init);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[siigo] fallo de red en", url, detail);
    throw new SiigoError({ status: 0, url, body: detail, message: `No se pudo contactar a Siigo: ${detail}` });
  }

  const text = await res.text();
  if (path === "/v1/purchases") {
    console.log("STATUS:", res.status);
    console.log("RESPONSE:");
    console.log(text);
  }
  console.log("[siigo] ===== RESPONSE =====");
  console.log("[siigo] URL:", url, "STATUS:", res.status, res.statusText);
  console.log("[siigo] RESPONSE HEADERS:", JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));
  console.log("[siigo] RESPONSE BODY (completa):");
  console.log(text);

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

// ---------------------------------------------------------------------------
// Causación: construcción y envío del comprobante contable a Siigo.
// El comprobante se registra en /v1/journals usando las cuentas del asiento
// ya generado por el motor contable de la aplicación.
// ---------------------------------------------------------------------------

export type SiigoJournalLine = {
  account_code: string;
  account_name: string | null;
  debit: number;
  credit: number;
  cost_center: string | null;
  tax_id?: number | string | null;
};

export async function siigoJournalDocumentId(): Promise<number> {
  // Permite fijar el comprobante manualmente si la empresa tiene varios.
  const forced = (process.env["SIIGO_JOURNAL_DOCUMENT_ID"] ?? "").trim();
  if (forced && /^\d+$/.test(forced)) return Number(forced);

  type DocType = { id?: number; code?: string; name?: string; type?: string; active?: boolean };
  // Siigo espera códigos de tipo de documento, no la palabra "Journal".
  // "CC" = Comprobante Contable. Se prueban candidatos y se cae al listado completo.
  const candidates = ["/v1/document-types?type=CC", "/v1/document-types"];
  const errors: string[] = [];

  for (const path of candidates) {
    try {
      const res = await siigoGet<DocType[] | { results?: DocType[] }>(path);
      const list: DocType[] = Array.isArray(res) ? res : (res?.results ?? []);
      const journals = list.filter((t) => {
        const kind = String(t.type ?? "").toUpperCase();
        return !kind || kind === "CC" || kind === "JOURNAL";
      });
      const pick =
        journals.find((t) => t.active !== false && t.id) ?? journals[0] ?? list.find((t) => t.id);
      if (pick?.id) return pick.id;
      errors.push(`${path}: sin tipos de comprobante contable (${JSON.stringify(list).slice(0, 500)})`);
    } catch (e) {
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new SiigoError({
    status: 0,
    url: "/v1/document-types",
    body: errors.join(" | "),
    message:
      "No fue posible obtener el tipo de comprobante contable (CC) en Siigo. " +
      "Verifica que la empresa tenga un comprobante contable activo o configura SIIGO_JOURNAL_DOCUMENT_ID. Detalle: " +
      errors.join(" | "),
  });
}

export function buildSiigoJournalPayload(params: {
  documentId: number;
  date: string;
  providerNit: string | null;
  observations: string | null;
  lines: SiigoJournalLine[];
  /** Referencia de la factura para el vencimiento de cuentas de cartera/proveedores. */
  duePrefix?: string | null;
  dueConsecutive?: string | number | null;
  dueDate?: string | null;
}) {
  const { documentId, date, providerNit, observations, lines } = params;
  const consecutiveDigits = String(params.dueConsecutive ?? "").replace(/\D/g, "");
  const due = {
    prefix: (params.duePrefix ?? "").toString().trim() || "FC",
    consecutive: consecutiveDigits ? Number(consecutiveDigits) : 1,
    quote: 1,
    date: params.dueDate ?? date,
  };
  // Siigo exige "due" en cuentas que manejan vencimiento (cartera y proveedores).
  const requiereVencimiento = (code: string) => /^(13|22|23)/.test(code);
  return {
    document: { id: documentId },
    date,
    observations: observations ?? "",
    items: lines.map((l) => {
      const isDebit = Number(l.debit || 0) > 0;
      // Siigo rechaza el comprobante si algún renglón va sin descripción.
      const description =
        [l.account_name, observations, l.account_code ? `Cuenta ${l.account_code}` : ""]
          .map((v) => (v ?? "").toString().trim())
          .find((v) => v.length > 0) ?? "Causación de factura de compra";
      const item: Record<string, unknown> = {
        account: { code: l.account_code, movement: isDebit ? "Debit" : "Credit" },
        description: description.slice(0, 500),
        value: Math.abs(isDebit ? Number(l.debit) : Number(l.credit)),
      };
      if (providerNit) item["customer"] = { identification: providerNit, branch_office: 0 };
      if (l.cost_center && /^\d+$/.test(l.cost_center)) item["cost_center"] = Number(l.cost_center);
      if (l.tax_id != null && String(l.tax_id).trim()) item["tax"] = { id: l.tax_id };
      if (requiereVencimiento(l.account_code)) item["due"] = due;
      return item;
    }),
  };
}

// ---------------------------------------------------------------------------
// Factura de compra (FC): POST /v1/purchases
// Las compras se registran como Factura de Compra, no como comprobante contable.
// ---------------------------------------------------------------------------

export type SiigoPurchaseItem = {
  /** Naturaleza del renglón en Siigo: producto/servicio del catálogo o cuenta contable. */
  type: "Product" | "Account";
  /** Código que Siigo recibe: código real del producto (Product) o cuenta PUC (Account). */
  code: string;
  /** Cuenta contable interna (solo para el asiento y los logs; nunca se envía como code). */
  account_code?: string | null;
  description: string;
  quantity: number;
  price: number;
  discount?: number;
  tax_ids?: Array<number | string>;
  /** Tipo de ítem definido en la causación (producto | servicio | gasto | activo). Nunca se modifica. */
  item_type?: string;
  /** ID de centro de costo de Siigo para el renglón, si difiere del documento. */
  cost_center_id?: number | null;
};

/** Tipo de documento de Factura de Compra (FC) configurado en Siigo. */
export async function siigoPurchaseDocumentId(): Promise<number> {
  const forced = (process.env["SIIGO_PURCHASE_DOCUMENT_ID"] ?? "").trim();
  if (forced && /^\d+$/.test(forced)) return Number(forced);

  type DocType = { id?: number; code?: string; name?: string; type?: string; active?: boolean };
  const errors: string[] = [];
  for (const path of ["/v1/document-types?type=FC", "/v1/document-types"]) {
    try {
      const res = await siigoGet<DocType[] | { results?: DocType[] }>(path);
      const list: DocType[] = Array.isArray(res) ? res : (res?.results ?? []);
      const fc = list.filter((t) => String(t.type ?? "").toUpperCase() === "FC" || !t.type);
      const pick = fc.find((t) => t.active !== false && t.id) ?? fc.find((t) => t.id);
      if (pick?.id) return pick.id;
      errors.push(`${path}: sin tipos de factura de compra (${JSON.stringify(list).slice(0, 400)})`);
    } catch (e) {
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new SiigoError({
    status: 0,
    url: "/v1/document-types?type=FC",
    body: errors.join(" | "),
    message:
      "No fue posible obtener el tipo de documento de Factura de Compra (FC) en Siigo. " +
      "Verifica que la empresa tenga un tipo FC activo o configura SIIGO_PURCHASE_DOCUMENT_ID. Detalle: " +
      errors.join(" | "),
  });
}

/** Forma de pago de compras: intenta coincidir con la forma de pago de la factura. */
export async function siigoPurchasePaymentTypeId(preferido?: string | null): Promise<number | null> {
  const forced = (process.env["SIIGO_PURCHASE_PAYMENT_ID"] ?? "").trim();
  if (forced && /^\d+$/.test(forced)) return Number(forced);

  type PayType = { id?: number; name?: string; active?: boolean; type?: string };
  try {
    const res = await siigoGet<PayType[] | { results?: PayType[] }>("/v1/payment-types?document_type=FC");
    const list = (Array.isArray(res) ? res : (res?.results ?? [])).filter((p) => p.id && p.active !== false);
    if (list.length === 0) return null;
    const clave = (preferido ?? "").toLowerCase();
    const esCredito = clave.includes("cr");
    const porNombre = clave ? list.find((p) => (p.name ?? "").toLowerCase().includes(clave.slice(0, 6))) : undefined;
    const porTipo = esCredito
      ? list.find((p) => /cr[eé]dito/i.test(p.name ?? ""))
      : list.find((p) => /contado|efectivo/i.test(p.name ?? ""));
    const match = porNombre ?? porTipo;
    return (match ?? list[0])!.id ?? null;
  } catch {
    return null;
  }
}

/** Centro de costo de Siigo: devuelve el ID real a partir del código o nombre interno. */
export async function siigoCostCenterId(value: string | null | undefined): Promise<number | null> {
  const clean = (value ?? "").toString().trim();
  if (!clean) return null;
  type CC = { id?: number; code?: string | number; name?: string; active?: boolean };
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  try {
    const res = await siigoGet<CC[] | { results?: CC[] }>("/v1/cost-centers");
    const list = (Array.isArray(res) ? res : (res?.results ?? [])).filter((c) => c.id != null && c.active !== false);
    const match =
      list.find((c) => String(c.id) === clean) ??
      list.find((c) => String(c.code ?? "").trim() === clean) ??
      list.find((c) => norm(String(c.name ?? "")) === norm(clean));
    return match?.id ?? null;
  } catch (e) {
    console.warn("[siigo] no fue posible consultar los centros de costo:", e instanceof Error ? e.message : e);
    return null;
  }
}

export function buildSiigoPurchasePayload(params: {
  documentId: number;
  date: string;
  providerNit: string;
  providerBranch?: number;
  invoicePrefix: string | null;
  invoiceNumber: string | null;
  observations: string | null;
  /** ID real del centro de costo en Siigo (nunca el código interno ni el nombre). */
  costCenterId?: number | null;
  items: SiigoPurchaseItem[];
  paymentId: number | null;
  /** Total bruto de la compra (base + impuestos, antes de retenciones). */
  purchaseTotal: number;
  /** Saldo neto por pagar al proveedor (total bruto - retenciones). */
  paymentValue: number;
  paymentDueDate: string | null;
  /** Retenciones aplicadas al documento (ids de Siigo). */
  retentionIds?: Array<number | string>;
}) {
  const total = Math.round(Number(params.purchaseTotal));
  const paymentValue = Math.round(Number(params.paymentValue));
  const payload: Record<string, unknown> = {
    document: { id: params.documentId },
    date: params.date,
    supplier: { identification: params.providerNit, branch_office: params.providerBranch ?? 0 },
    provider_invoice: {
      prefix: (params.invoicePrefix ?? "").toString().trim() || "FC",
      number: String(params.invoiceNumber ?? "").replace(/\D/g, "") || "1",
    },
    discount_type: "Value",
    supplier_by_item: false,
    tax_included: false,
    total,
    observations: (params.observations ?? "").slice(0, 500),
    items: params.items.map((item) => {
      const line: Record<string, unknown> = {
        type: item.type,
        code: item.code,
        description: (item.description || `${item.type} ${item.code}`).slice(0, 500),
        quantity: item.quantity > 0 ? item.quantity : 1,
        price: item.price,
      };
      if (item.discount && item.discount > 0) line["discount"] = item.discount;
      if (item.tax_ids && item.tax_ids.length > 0) {
        line["taxes"] = item.tax_ids.map((id) => ({ id }));
      }
      // Centro de costo: siempre el ID real de Siigo.
      const centro = item.cost_center_id ?? params.costCenterId ?? null;
      if (centro != null) line["cost_center"] = Number(centro);
      return line;
    }),
    payments: [
      {
        ...(params.paymentId != null ? { id: params.paymentId } : {}),
        value: paymentValue,
        due_date: params.paymentDueDate ?? params.date,
      },
    ],
  };
  if (params.costCenterId != null) payload["cost_center"] = Number(params.costCenterId);
  if (params.retentionIds && params.retentionIds.length > 0) {
    payload["retentions"] = params.retentionIds.map((id) => ({ id }));
  }
  return payload;
}
