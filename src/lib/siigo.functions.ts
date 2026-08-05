import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SiigoStatus = {
  configured: boolean;
  connected: boolean;
  user: string | null;
  partnerId: string | null;
  missing: string[];
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
    type Account = { code?: string; name?: string; nature?: string };
    const res = await siigoGet<Account[]>("/v1/account-groups");
    const list = Array.isArray(res) ? res : [];
    const rows = list
      .filter((a) => a.code)
      .map((a) => ({
        company_id: data.companyId,
        code: String(a.code),
        name: a.name ?? String(a.code),
        nature: (a.nature ?? "").toLowerCase().startsWith("cr") ? "credito" : "debito",
      }));
    if (rows.length === 0) return { imported: 0 };
    const { error } = await context.supabase.from("puc_accounts").upsert(rows, {
      onConflict: "company_id,code",
      ignoreDuplicates: true,
    });
    if (error) throw new Error(error.message);
    return { imported: rows.length };
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
