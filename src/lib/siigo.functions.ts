import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SiigoStatus = {
  configured: boolean;
  connected: boolean;
  user: string | null;
  partnerId: string | null;
  missing: string[];
  warnings: string[];
  error: string | null;
  checkedAt: string;
};

export const siigoStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<SiigoStatus> => {
    const { siigoConfig, siigoGet } = await import("./siigo.server");
    const cfg = siigoConfig();
    const checkedAt = new Date().toISOString();
    if (cfg.missing.length > 0) {
      return {
        configured: false,
        connected: false,
        user: cfg.username || null,
        partnerId: cfg.partnerId || null,
        missing: cfg.missing,
        warnings: cfg.warnings,
        error: `Faltan variables de entorno: ${cfg.missing.join(", ")}.`,
        checkedAt,
      };
    }
    try {
      await siigoGet("/v1/users");
      return {
        configured: true,
        connected: true,
        user: cfg.username,
        partnerId: cfg.partnerId,
        missing: [],
        warnings: cfg.warnings,
        error: null,
        checkedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e);
      console.error("[siigo] verificación de conexión fallida:", message);
      return {
        configured: true,
        connected: false,
        user: cfg.username,
        partnerId: cfg.partnerId,
        missing: [],
        warnings: cfg.warnings,
        error: message,
        checkedAt,
      };
    }
  });

export const siigoImportProviders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { siigoGet } = await import("./siigo.server");
    type Customer = {
      identification?: string;
      name?: string[] | string;
      commercial_name?: string;
      address?: { address?: string; city?: { city_name?: string } };
      phones?: { number?: string }[];
      contacts?: { email?: string }[];
    };
    const res = await siigoGet<{ results?: Customer[] }>("/v1/customers?page_size=100");
    const rows = (res.results ?? []).map((c) => ({
      company_id: data.companyId,
      nit: String(c.identification ?? "").trim(),
      name: (Array.isArray(c.name) ? c.name.join(" ") : c.name) || c.commercial_name || "Sin nombre",
      address: c.address?.address ?? null,
      city: c.address?.city?.city_name ?? null,
      phone: c.phones?.[0]?.number ?? null,
      email: c.contacts?.[0]?.email ?? null,
    })).filter((r) => r.nit);

    if (rows.length === 0) return { imported: 0 };

    const { error } = await context.supabase
      .from("providers")
      .upsert(rows, { onConflict: "company_id,nit", ignoreDuplicates: false });
    if (error) throw new Error(error.message);
    return { imported: rows.length };
  });

export const siigoImportPuc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { siigoGet } = await import("./siigo.server");
    // El catálogo del PUC en la API actual de Siigo está en /v1/accounts.
    // /v1/account-groups sólo devuelve los grupos contables (no las cuentas),
    // por eso se intenta primero /v1/accounts y se deja el otro como respaldo.
    const candidates = ["/v1/accounts", "/v1/account-groups"];

    /** Extrae un arreglo de objetos desde cualquier forma de respuesta conocida. */
    const toArray = (res: unknown): Record<string, unknown>[] => {
      if (Array.isArray(res)) return res as Record<string, unknown>[];
      if (res && typeof res === "object") {
        const obj = res as Record<string, unknown>;
        for (const key of ["results", "data", "items", "accounts", "value"]) {
          if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
        }
        // Objeto único con forma de cuenta
        if (obj["code"] || obj["Code"] || obj["account_code"]) return [obj];
      }
      return [];
    };

    const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
      for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
      }
      return null;
    };

    let list: Record<string, unknown>[] = [];
    let usedPath = "";
    let lastError: unknown = null;

    for (const path of candidates) {
      console.log("[siigo][puc] consultando", `https://api.siigo.com${path}`, "companyId:", data.companyId);
      try {
        // siigoGet ya registra URL, código HTTP y respuesta completa.
        const res = await siigoGet<unknown>(path);
        console.log("[siigo][puc] JSON exacto devuelto por", path, ":", JSON.stringify(res));
        const parsed = toArray(res);
        console.log(
          "[siigo][puc] tipo de respuesta:",
          Array.isArray(res) ? "array" : typeof res,
          "| registros detectados:",
          parsed.length,
          "| claves del primer registro:",
          parsed[0] ? JSON.stringify(Object.keys(parsed[0])) : "n/a",
        );
        if (parsed.length > 0) {
          list = parsed;
          usedPath = path;
          break;
        }
        console.warn("[siigo][puc] respuesta sin registros en", path, "— se intenta el siguiente endpoint.");
      } catch (e) {
        lastError = e;
        const detail = e instanceof Error ? e.message : JSON.stringify(e);
        console.error("[siigo][puc] error consultando", path, detail);
      }
    }

    if (list.length === 0 && lastError) throw lastError;

    console.log("[siigo][puc] endpoint usado:", usedPath, "| registros obtenidos de Siigo:", list.length);

    const seen = new Set<string>();
    const rows = list
      .map((a) => {
        const code = pick(a, ["code", "Code", "account_code", "codigo"]);
        if (!code) return null;
        const name = pick(a, ["name", "Name", "description", "nombre"]) ?? code;
        const natureRaw = (pick(a, ["nature", "Nature", "naturaleza", "type"]) ?? "").toLowerCase();
        return {
          company_id: data.companyId,
          code,
          name,
          nature: natureRaw.startsWith("cr") ? "credito" : "debito",
        };
      })
      .filter((r): r is NonNullable<typeof r> => {
        if (!r) return false;
        if (seen.has(r.code)) return false;
        seen.add(r.code);
        return true;
      });
    console.log("[siigo][puc] registros válidos para insertar:", rows.length, "de", list.length);
    if (rows.length === 0) {
      console.warn("[siigo][puc] no hay registros con 'code'; no se inserta nada en puc_accounts.");
      return { imported: 0 };
    }

    const { data: inserted, error } = await context.supabase
      .from("puc_accounts")
      .upsert(rows, { onConflict: "company_id,code", ignoreDuplicates: true })
      .select("id");
    if (error) {
      console.error("[siigo][puc] error de Supabase al insertar:", JSON.stringify(error));
      throw new Error(
        `Supabase puc_accounts [${error.code ?? "sin código"}]: ${error.message}` +
          (error.details ? ` | detalles: ${error.details}` : "") +
          (error.hint ? ` | hint: ${error.hint}` : ""),
      );
    }
    const insertedCount = inserted?.length ?? 0;
    console.log(
      "[siigo][puc] filas insertadas en puc_accounts:",
      insertedCount,
      "(enviadas:",
      rows.length,
      ", duplicadas ignoradas:",
      rows.length - insertedCount,
      ")",
    );
    return { imported: insertedCount };
  });

export type SiigoPurchase = {
  id: string;
  number: string;
  date: string;
  supplier: string;
  total: number;
};

export const siigoListPurchases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<SiigoPurchase[]> => {
    const { siigoGet } = await import("./siigo.server");
    type P = {
      id?: string;
      name?: string;
      number?: number | string;
      date?: string;
      total?: number;
      supplier?: { identification?: string; branch_office?: number };
    };
    const res = await siigoGet<{ results?: P[] }>("/v1/purchases?page_size=25");
    return (res.results ?? []).map((p) => ({
      id: String(p.id ?? p.number ?? crypto.randomUUID()),
      number: String(p.name ?? p.number ?? "—"),
      date: p.date ?? "",
      supplier: p.supplier?.identification ?? "—",
      total: Number(p.total ?? 0),
    }));
  });
