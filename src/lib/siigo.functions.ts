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
    // Verificado contra la API real de Siigo (agosto 2026):
    //   /v1/accounts, /v1/chart-of-accounts, /v1/accounting-accounts... -> 404
    //   /v1/account-groups -> grupos de inventario (id/name/active), NO son cuentas del PUC
    // La API pública de Siigo no expone el catálogo del PUC. Las cuentas contables
    // sí aparecen dentro de los comprobantes contables: /v1/journals -> results[].items[].account
    //   { "code": "51350502", "movement": "Debit" }
    // Por eso el PUC se reconstruye a partir de las cuentas realmente usadas.
    type JournalItem = { account?: { code?: string | number; movement?: string; name?: string }; description?: string };
    type Journal = { items?: JournalItem[] };
    type JournalPage = { pagination?: { page?: number; page_size?: number; total_results?: number }; results?: Journal[] };

    const pageSize = 100;
    const maxPages = 40; // hasta 4.000 comprobantes
    const found = new Map<string, { name: string; nature: string }>();
    let scanned = 0;

    for (let page = 1; page <= maxPages; page++) {
      const path = `/v1/journals?page=${page}&page_size=${pageSize}`;
      console.log("[siigo][puc] consultando", `https://api.siigo.com${path}`, "companyId:", data.companyId);
      let res: JournalPage;
      try {
        // siigoGet ya registra URL, código HTTP y cuerpo de la respuesta.
        res = await siigoGet<JournalPage>(path);
      } catch (e) {
        console.error("[siigo][puc] error consultando", path, e instanceof Error ? e.message : JSON.stringify(e));
        if (page === 1) throw e;
        break;
      }
      const results = res.results ?? [];
      if (page === 1) {
        console.log(
          "[siigo][puc] estructura de la respuesta:",
          JSON.stringify({ pagination: res.pagination, primerRegistro: results[0] ?? null }).slice(0, 2000),
        );
      }
      scanned += results.length;
      for (const j of results) {
        for (const it of j.items ?? []) {
          const code = String(it.account?.code ?? "").trim();
          if (!code) continue;
          const nature = (it.account?.movement ?? "").toLowerCase().startsWith("cr") ? "credito" : "debito";
          const name = (it.account?.name ?? it.description ?? `Cuenta ${code}`).trim() || `Cuenta ${code}`;
          if (!found.has(code)) found.set(code, { name, nature });
        }
      }
      const total = res.pagination?.total_results ?? 0;
      console.log("[siigo][puc] página", page, "comprobantes:", results.length, "| cuentas únicas acumuladas:", found.size);
      if (results.length < pageSize || scanned >= total) break;
    }

    console.log("[siigo][puc] comprobantes revisados:", scanned, "| cuentas únicas encontradas:", found.size);

    const rows = [...found.entries()].map(([code, v]) => ({
      company_id: data.companyId,
      code,
      name: v.name,
      nature: v.nature,
    }));
    console.log("[siigo][puc] registros válidos para insertar:", rows.length);
    if (rows.length === 0) {
      console.warn("[siigo][puc] no se encontraron cuentas en los comprobantes de Siigo; no se inserta nada.");
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
