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

export type SiigoSyncResult = {
  ok: boolean;
  siigoId: string | null;
  siigoNumber: string | null;
  documentUrl: string | null;
  syncedAt: string | null;
  status: string;
  error: string | null;
};

/** Envía a Siigo el comprobante contable ya aprobado de una factura. */
export const siigoSyncInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { invoiceId: string }) => {
    if (!input?.invoiceId) throw new Error("invoiceId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<SiigoSyncResult> => {
    const { siigoPost, siigoJournalDocumentId, buildSiigoJournalPayload } = await import("./siigo.server");
    const supabase = context.supabase;

    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .select("id, company_id, prefix, number, issue_date, provider_nit, provider_name, notes, total")
      .eq("id", data.invoiceId)
      .single();
    if (invErr || !inv) throw new Error(invErr?.message ?? "Factura no encontrada.");

    const { data: journal, error: jErr } = await supabase
      .from("journal_lines")
      .select("id, account_code, account_name, debit, credit, cost_center")
      .eq("invoice_id", data.invoiceId)
      .order("position");
    if (jErr) throw new Error(jErr.message);
    if (!journal || journal.length === 0) throw new Error("La factura no tiene asiento contable generado.");

    // Las cuentas base del PUC colombiano pueden no existir con el mismo nivel
    // de detalle en Siigo. Antes de enviar, cambia únicamente esos códigos base
    // por la cuenta equivalente que ya fue importada desde esta empresa.
    const { data: companyAccounts, error: accountsErr } = await supabase
      .from("puc_accounts")
      .select("code, name")
      .eq("company_id", inv.company_id)
      .order("code");
    if (accountsErr) throw new Error(`No fue posible validar el PUC de Siigo: ${accountsErr.message}`);

    const availableCodes = new Set((companyAccounts ?? []).map((account) => account.code));
    const findEquivalent = (baseCode: string) => {
      if (availableCodes.has(baseCode)) return baseCode;
      if (baseCode === "240801") {
        return (companyAccounts ?? []).find((account) => {
          const name = account.name.toLowerCase();
          return account.code.startsWith("2408") && name.includes("iva") && (name.includes("servicio") || name.includes("gasto"));
        })?.code ?? null;
      }
      if (baseCode === "220505") {
        return (companyAccounts ?? []).find((account) => {
          const name = account.name.toLowerCase();
          return account.code.startsWith("2205") && name.includes("proveedor");
        })?.code ?? (companyAccounts ?? []).find((account) => account.code.startsWith("220505"))?.code ?? null;
      }
      return baseCode;
    };

    const resolvedJournal = journal.map((line) => {
      const resolvedCode = findEquivalent(line.account_code);
      if (!resolvedCode) {
        throw new Error(
          `La cuenta base ${line.account_code} no existe en Siigo y no se encontró una equivalente en el PUC importado. ` +
            "Importa el PUC desde Integraciones o configura la cuenta del proveedor antes de volver a causar.",
        );
      }
      return { ...line, account_code: resolvedCode };
    });

    const replacements = resolvedJournal.filter((line, index) => line.account_code !== journal[index]?.account_code);
    if (replacements.length > 0) {
      console.log(
        "[siigo][causacion] cuentas base reemplazadas:",
        replacements.map((line) => ({ id: line.id, account_code: line.account_code })),
      );
      const updates = await Promise.all(
        replacements.map((line) =>
          supabase.from("journal_lines").update({ account_code: line.account_code }).eq("id", line.id),
        ),
      );
      const updateError = updates.find((result) => result.error)?.error;
      if (updateError) throw new Error(`No fue posible guardar las cuentas equivalentes: ${updateError.message}`);
    }

    await supabase
      .from("invoices")
      .update({ siigo_status: "sincronizando", siigo_last_attempt_at: new Date().toISOString() })
      .eq("id", data.invoiceId);

    try {
      const documentId = await siigoJournalDocumentId();
      const payload = buildSiigoJournalPayload({
        documentId,
        date: inv.issue_date ?? new Date().toISOString().slice(0, 10),
        providerNit: inv.provider_nit,
        observations: `Factura ${[inv.prefix, inv.number].filter(Boolean).join("-")} · ${inv.provider_name ?? ""} ${inv.notes ?? ""}`.trim(),
        lines: resolvedJournal.map((l) => ({
          account_code: l.account_code,
          account_name: l.account_name,
          debit: Number(l.debit ?? 0),
          credit: Number(l.credit ?? 0),
          cost_center: l.cost_center,
        })),
      });
      console.log("[siigo][causacion] payload:", JSON.stringify(payload).slice(0, 4000));

      const res = await siigoPost<{ id?: string; number?: number | string; name?: string; metadata?: { created?: string }; _links?: { self?: { href?: string } } }>(
        "/v1/journals",
        payload,
      );

      const syncedAt = new Date().toISOString();
      const siigoId = res.id ? String(res.id) : null;
      const siigoNumber = res.name ? String(res.name) : res.number != null ? String(res.number) : null;
      const documentUrl = res._links?.self?.href ?? null;

      await supabase
        .from("invoices")
        .update({
          siigo_status: "sincronizada",
          siigo_id: siigoId,
          siigo_number: siigoNumber,
          siigo_document_url: documentUrl,
          siigo_synced_at: syncedAt,
          siigo_synced_by: context.userId,
          siigo_error: null,
        })
        .eq("id", data.invoiceId);

      return { ok: true, siigoId, siigoNumber, documentUrl, syncedAt, status: "sincronizada", error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : JSON.stringify(e);
      console.error("[siigo][causacion] error:", message);
      await supabase
        .from("invoices")
        .update({ siigo_status: "error", siigo_error: message, siigo_synced_by: context.userId })
        .eq("id", data.invoiceId);
      return { ok: false, siigoId: null, siigoNumber: null, documentUrl: null, syncedAt: null, status: "error", error: message };
    }
  });

export type SiigoProduct = { id: string; code: string; name: string };

/** Busca un producto en Siigo por código o nombre (para renglones de inventario). */
export const siigoFindProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { query: string }) => {
    if (!input?.query) throw new Error("query requerido");
    return input;
  })
  .handler(async ({ data }): Promise<SiigoProduct[]> => {
    const { siigoGet } = await import("./siigo.server");
    type P = { id?: string; code?: string; name?: string };
    const res = await siigoGet<{ results?: P[] }>(`/v1/products?page_size=25&code=${encodeURIComponent(data.query)}`);
    const results = res.results ?? [];
    if (results.length > 0) {
      return results.map((p) => ({ id: String(p.id ?? ""), code: String(p.code ?? ""), name: String(p.name ?? "") }));
    }
    const byName = await siigoGet<{ results?: P[] }>(`/v1/products?page_size=25&name=${encodeURIComponent(data.query)}`);
    return (byName.results ?? []).map((p) => ({ id: String(p.id ?? ""), code: String(p.code ?? ""), name: String(p.name ?? "") }));
  });

/** Crea un producto en Siigo. Solo se ejecuta con autorización explícita del usuario. */
export const siigoCreateProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { code: string; name: string; accountGroup?: number }) => {
    if (!input?.code || !input?.name) throw new Error("code y name requeridos");
    return input;
  })
  .handler(async ({ data }): Promise<SiigoProduct> => {
    const { siigoGet, siigoPost } = await import("./siigo.server");
    let group = data.accountGroup;
    if (!group) {
      const groups = await siigoGet<{ id?: number; active?: boolean }[]>("/v1/account-groups");
      group = (Array.isArray(groups) ? groups : []).find((g) => g.active !== false && g.id)?.id;
    }
    if (!group) throw new Error("Siigo no devolvió grupos de inventario para crear el producto.");
    const res = await siigoPost<{ id?: string; code?: string; name?: string }>("/v1/products", {
      code: data.code,
      name: data.name,
      account_group: group,
      type: "Product",
      stock_control: true,
    });
    return { id: String(res.id ?? ""), code: String(res.code ?? data.code), name: String(res.name ?? data.name) };
  });
