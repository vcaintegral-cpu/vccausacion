import { createServerFn } from "@tanstack/react-start";
import { validarCuenta } from "@/lib/puc-hierarchy";
import { mensajeSiigoAmigable } from "@/lib/siigo-errors";
import { checkInvoiceCompany, motivoBloqueoEmpresa } from "./company-validation";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizeItemType } from "@/lib/item-type";
import type { Json } from "@/integrations/supabase/types";

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
    const { siigoConfig, siigoGet, loadSiigoOverrides } = await import("./siigo.server");
    await loadSiigoOverrides(true);
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
      source: "siigo",
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
    const { rebuildPucHierarchy } = await import("./puc-sync.server");
    const jerarquia = await rebuildPucHierarchy(context.supabase, data.companyId);
    return { imported: insertedCount, total: jerarquia.total, movimiento: jerarquia.movimiento };
  });

/** Recalcula la jerarquía del PUC (nivel, padre, hijas, cuentas de movimiento) por empresa. */
export const pucRebuildHierarchy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { rebuildPucHierarchy } = await import("./puc-sync.server");
    return rebuildPucHierarchy(context.supabase, data.companyId);
  });

/** Cuentas del PUC de la empresa con su jerarquía, para la tabla de control de Integraciones. */
export const pucAccountsOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const out: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: rows, error } = await context.supabase
        .from("puc_accounts")
        .select("code, name, level, parent_code, has_children, is_movement, active, siigo_id, siigo_code, synced_at")
        .eq("company_id", data.companyId)
        .order("code")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const chunk = rows ?? [];
      out.push(...chunk);
      if (chunk.length < 1000) break;
    }
    return out;
  });

export type SiigoPurchase = {
  id: string;
  number: string;
  date: string;
  supplier: string;
  total: number;
};

/** Importa centros de costo desde Siigo sin pisar los creados manualmente o por Excel. */
export const siigoImportCostCenters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { siigoGet } = await import("./siigo.server");
    type CC = { id?: number | string; code?: string | number; name?: string; active?: boolean };
    const res = await siigoGet<CC[] | { results?: CC[] }>("/v1/cost-centers");
    const list = Array.isArray(res) ? res : (res.results ?? []);
    const rows = list
      .map((c) => ({
        company_id: data.companyId,
        code: String(c.code ?? c.id ?? "").trim(),
        name: String(c.name ?? "").trim() || `Centro ${c.code ?? c.id}`,
        source: "siigo",
      }))
      .filter((r) => r.code);
    if (rows.length === 0) return { imported: 0, skipped: 0 };

    const { data: existing } = await context.supabase
      .from("cost_centers")
      .select("code, source")
      .eq("company_id", data.companyId);
    const protectedCodes = new Set((existing ?? []).filter((e) => e.source !== "siigo").map((e) => e.code));
    const toUpsert = rows.filter((r) => !protectedCodes.has(r.code));
    if (toUpsert.length === 0) return { imported: 0, skipped: rows.length };

    const { error } = await context.supabase
      .from("cost_centers")
      .upsert(toUpsert, { onConflict: "company_id,code" });
    if (error) throw new Error(error.message);
    return { imported: toUpsert.length, skipped: rows.length - toUpsert.length };
  });

/** Importa impuestos y retenciones desde Siigo sin pisar los definidos manualmente. */
export const siigoImportTaxes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { siigoGet } = await import("./siigo.server");
    type Tax = {
      id?: number | string;
      name?: string;
      type?: string;
      percentage?: number;
      active?: boolean;
      // Siigo devuelve la cuenta contable con nombres distintos según el tipo de impuesto.
      account?: { code?: string | number; name?: string } | string | number;
      accounting_account?: { code?: string | number; name?: string } | string | number;
      account_code?: string | number;
      account_id?: string | number;
    };
    const res = await siigoGet<Tax[] | { results?: Tax[] }>("/v1/taxes");
    const list = Array.isArray(res) ? res : (res.results ?? []);
    console.log("[siigo][taxes] respuesta cruda:", JSON.stringify(res).slice(0, 4000));

    // Cuentas del PUC de la empresa, para resolver la cuenta contable por código o por nombre.
    const { data: puc } = await context.supabase
      .from("puc_accounts")
      .select("code, name")
      .eq("company_id", data.companyId);
    const pucCodes = new Set((puc ?? []).map((a) => a.code));

    const readAccount = (v: Tax["account"]): { code: string | null; name: string | null } => {
      if (v == null) return { code: null, name: null };
      if (typeof v === "object") {
        return {
          code: v.code != null ? String(v.code).trim() : null,
          name: v.name ? String(v.name).trim() : null,
        };
      }
      const s = String(v).trim();
      return { code: /^\d+$/.test(s) ? s : null, name: /^\d+$/.test(s) ? null : s };
    };

    const resolveAccount = (t: Tax): { code: string | null; name: string | null } => {
      for (const candidate of [t.account, t.accounting_account, t.account_code, t.account_id]) {
        const parsed = readAccount(candidate as Tax["account"]);
        if (parsed.code || parsed.name) {
          // Si el código no existe en el PUC pero sí el nombre, intenta emparejar por nombre.
          if (parsed.code && pucCodes.has(parsed.code)) return parsed;
          if (parsed.name) {
            const byName = (puc ?? []).find((a) => a.name.toLowerCase() === parsed.name!.toLowerCase());
            if (byName) return { code: byName.code, name: byName.name };
          }
          if (parsed.code) return parsed;
        }
      }
      // Búsqueda en el PUC por nombre del impuesto.
      const nombre = String(t.name ?? "").toLowerCase().trim();
      if (nombre) {
        const match = (puc ?? []).find((a) => a.name.toLowerCase().includes(nombre));
        if (match) return { code: match.code, name: match.name };
      }
      // Asignación automática desde el PUC según el tipo de impuesto (prefijos PUC estándar).
      const kind = `${t.type ?? ""} ${t.name ?? ""}`.toLowerCase();
      const grupos: { test: RegExp; prefijos: string[]; palabras: string[] }[] = [
        { test: /reteiva|rete iva|retencion.*iva/, prefijos: ["2367"], palabras: ["iva"] },
        { test: /reteica|rete ica|\bica\b/, prefijos: ["2368"], palabras: ["ica", "industria"] },
        { test: /retefuente|rete fuente|retencion|withholding|\brte\b/, prefijos: ["2365"], palabras: ["fuente", "renta"] },
        { test: /iva|impuesto al valor/, prefijos: ["621008", "6210", "2408"], palabras: ["iva"] },
        { test: /consumo|impoconsumo/, prefijos: ["2412"], palabras: ["consumo"] },
      ];
      const grupo = grupos.find((g) => g.test.test(kind));
      if (grupo) {
        const candidatas = (puc ?? []).filter((a) => grupo.prefijos.some((p) => a.code.startsWith(p)));
        const conPalabra = candidatas.find((a) =>
          grupo.palabras.some((w) => a.name.toLowerCase().includes(w)),
        );
        const elegida = conPalabra ?? candidatas.sort((a, b) => a.code.localeCompare(b.code))[0];
        if (elegida) return { code: elegida.code, name: elegida.name };
      }
      return { code: null, name: null };
    };

    const rows = list
      .map((t) => {
        const account = resolveAccount(t);
        const syncedAt = new Date().toISOString();
        return {
          company_id: data.companyId,
          kind: String(t.type ?? "IVA").toLowerCase(),
          name: String(t.name ?? "").trim(),
          rate: Number(t.percentage ?? 0),
          account_code: account.code,
          active: t.active !== false,
          source: "siigo",
          siigo_id: t.id != null ? String(t.id) : null,
          siigo_name: String(t.name ?? "").trim() || null,
          siigo_code: t.id != null ? String(t.id) : null,
          siigo_synced_at: syncedAt,
        };
      })
      .filter((r) => r.name);
    console.log(
      "[siigo][taxes] impuestos con cuenta contable:",
      rows.filter((r) => r.account_code).length,
      "de",
      rows.length,
    );
    if (rows.length === 0) return { imported: 0, skipped: 0 };

    const { data: existing } = await context.supabase
      .from("tax_rates")
      .select("kind, name, source")
      .eq("company_id", data.companyId);
    const protectedKeys = new Set(
      (existing ?? []).filter((e) => e.source !== "siigo").map((e) => `${e.kind}|${e.name}`),
    );
    // Los impuestos manuales conservan su cuenta contable, pero sí reciben el
    // identificador real de Siigo cuando coinciden tipo y nombre.
    for (const r of rows) {
      if (!protectedKeys.has(`${r.kind}|${r.name}`) || !r.siigo_id) continue;
      await context.supabase
        .from("tax_rates")
        .update({
          siigo_id: r.siigo_id,
          siigo_name: r.siigo_name,
          siigo_code: r.siigo_code,
          siigo_synced_at: r.siigo_synced_at,
          rate: r.rate,
          active: r.active,
        })
        .eq("company_id", data.companyId)
        .eq("kind", r.kind)
        .eq("name", r.name);
    }
    const toUpsert = rows.filter((r) => !protectedKeys.has(`${r.kind}|${r.name}`));
    if (toUpsert.length === 0) return { imported: 0, skipped: rows.length };

    const { error } = await context.supabase
      .from("tax_rates")
      .upsert(toUpsert, { onConflict: "company_id,kind,name" });
    if (error) throw new Error(error.message);
    return { imported: toUpsert.length, skipped: rows.length - toUpsert.length };
  });

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

export type SyncedTax = {
  id: string;
  kind: string;
  name: string;
  rate: number;
  siigoId: string | null;
  accountCode: string | null;
  active: boolean;
  syncedAt: string | null;
};

/** Impuestos sincronizados con Siigo para la empresa activa. */
export const siigoSyncedTaxes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }): Promise<SyncedTax[]> => {
    const { data: rows, error } = await context.supabase
      .from("tax_rates")
      .select("id, kind, name, rate, siigo_id, siigo_synced_at, account_code, active")
      .eq("company_id", data.companyId)
      .order("kind")
      .order("rate");
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      rate: Number(r.rate ?? 0),
      siigoId: r.siigo_id ?? null,
      accountCode: r.account_code ?? null,
      active: r.active !== false,
      syncedAt: r.siigo_synced_at ?? null,
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
    const {
      siigoGet,
      siigoPost,
      siigoPurchaseDocumentId,
      siigoPurchasePaymentTypeId,
      siigoCostCenterId,
      calculateSiigoPurchaseTotals,
      buildSiigoPurchasePayload,
    } = await import("./siigo.server");
    const supabase = context.supabase;

    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .select(
        "id, company_id, prefix, number, issue_date, due_date, provider_nit, provider_name, buyer_nit, buyer_name, notes, total, iva, subtotal, retefuente, reteiva, reteica, cost_center, payment_form, status, siigo_status, siigo_id, siigo_number, siigo_document_url, siigo_synced_at",
      )
      .eq("id", data.invoiceId)
      .single();
    if (invErr || !inv) throw new Error(invErr?.message ?? "Factura no encontrada.");

    // Barrera de seguridad: la factura solo puede causarse en la empresa cuyo NIT coincide
    // con el NIT del comprador/adquiriente de la factura.
    const { data: empresa } = await supabase
      .from("companies")
      .select("id, name, nit")
      .eq("id", inv.company_id)
      .maybeSingle();
    const chequeoEmpresa = checkInvoiceCompany(empresa, inv);
    const mensaje = motivoBloqueoEmpresa(chequeoEmpresa);
    if (mensaje) {
      await supabase
        .from("invoices")
        .update({ siigo_status: "error", siigo_error: `RECHAZADA — EMPRESA INCORRECTA. ${mensaje}` })
        .eq("id", inv.id);
      throw new Error(mensaje);
    }

    // Protección contra doble envío: si ya está sincronizada o ya tiene consecutivo real
    // devuelto por Siigo, no se vuelve a crear otro comprobante.
    if (inv.siigo_status === "sincronizada" || inv.status === "sincronizada" || inv.siigo_id || inv.siigo_number) {
      return {
        ok: true,
        siigoId: inv.siigo_id ?? null,
        siigoNumber: inv.siigo_number ?? null,
        documentUrl: inv.siigo_document_url ?? null,
        syncedAt: inv.siigo_synced_at ?? null,
        status: "sincronizada",
        error: `Esta factura ya fue causada en Siigo. Consecutivo: ${inv.siigo_number ?? inv.siigo_id}`,
      };
    }

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
      .select("code, name, active, has_children, is_movement, siigo_id, siigo_code")
      .eq("company_id", inv.company_id)
      .order("code");
    if (accountsErr) throw new Error(`No fue posible validar el PUC de Siigo: ${accountsErr.message}`);

    const availableCodes = new Set((companyAccounts ?? []).map((account) => account.code));
    const accounts = companyAccounts ?? [];
    /** Una cuenta es de grupo (no de movimiento) si el PUC tiene auxiliares que dependen de ella. */
    const hijasDe = (code: string) =>
      accounts
        .filter((account) => account.code.startsWith(code) && account.code.length > code.length)
        .sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
    /** Baja hasta la auxiliar final, prefiriendo la que coincida con las palabras dadas. */
    const auxiliarDe = (code: string, palabras: string[] = []): string | null => {
      let actual = code;
      for (let i = 0; i < 6; i += 1) {
        const hijas = hijasDe(actual);
        if (hijas.length === 0) return availableCodes.has(actual) ? actual : null;
        const preferida =
          palabras.length > 0
            ? hijas.find((h) => palabras.some((p) => h.name.toLowerCase().includes(p)))
            : undefined;
        actual = (preferida ?? hijas[0]!).code;
      }
      return availableCodes.has(actual) ? actual : null;
    };

    const findEquivalent = (baseCode: string) => {
      if (baseCode === "621008") {
        // 621008 (IVA de Costo) es transaccional en Siigo: se envía tal cual,
        // exista o no en el PUC importado.
        return "621008";
      }
      if (baseCode === "240801") {
        const directo = (companyAccounts ?? []).find((account) => account.code === "621008");
        if (directo) return directo.code;
        const porNombre = (companyAccounts ?? []).find((account) => {
          const name = account.name.toLowerCase();
          return account.code.startsWith("2408") && name.includes("iva") && name.includes("descontable") && !name.includes("devoluci");
        })?.code;
        return auxiliarDe(porNombre ?? "240810", ["iva", "descontable"]) ?? porNombre ?? baseCode;
      }
      if (baseCode.startsWith("2205")) {
        return (
          auxiliarDe("220505", ["nacional", "proveedor"]) ?? auxiliarDe("2205", ["proveedor", "nacional"]) ?? baseCode
        );
      }
      // Siigo solo acepta cuentas de movimiento (auxiliares). Si la cuenta del
      // asiento tiene auxiliares dependientes, se baja hasta la auxiliar final.
      // Si el PUC importado no aporta información, se envía la cuenta tal cual
      // y es Siigo quien valida.
      return auxiliarDe(baseCode) ?? baseCode;
    };

    const resolvedJournal = journal.map((line) => {
      const resolvedCode = findEquivalent(line.account_code);
      if (!resolvedCode) {
        throw new Error(
          `La cuenta ${line.account_code} no es una cuenta de movimiento en Siigo y no se encontró una auxiliar equivalente en el PUC importado. ` +
            "Cambia la cuenta del renglón por una auxiliar (por ejemplo 51959501) o importa el PUC desde Integraciones antes de volver a causar.",
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
      // Trazabilidad: queda registro de la cuenta sugerida, la utilizada y el motivo.
      await supabase.from("account_resolutions").insert(
        replacements.map((line, index) => ({
          company_id: inv.company_id,
          invoice_id: inv.id,
          suggested_code: journal.find((j) => j.id === line.id)?.account_code ?? line.account_code,
          used_code: line.account_code,
          reason: `La cuenta ${journal.find((j) => j.id === line.id)?.account_code ?? ""} tiene cuentas auxiliares activas y no permite movimiento.`,
          siigo_id: companyAccounts?.find((a) => a.code === line.account_code)?.siigo_id ?? null,
          siigo_code: companyAccounts?.find((a) => a.code === line.account_code)?.siigo_code ?? line.account_code,
        })),
      );
      const updates = await Promise.all(
        replacements.map((line) =>
          supabase.from("journal_lines").update({ account_code: line.account_code }).eq("id", line.id),
        ),
      );
      const updateError = updates.find((result) => result.error)?.error;
      if (updateError) throw new Error(`No fue posible guardar las cuentas equivalentes: ${updateError.message}`);
    }

    // Validación contable bloqueante: toda cuenta enviada a Siigo debe ser de movimiento,
    // activa y pertenecer al PUC de esta empresa. Solo se exceptúa 621008 (IVA del costo),
    // que Siigo maneja como cuenta transaccional aunque no venga en el PUC importado.
    if ((companyAccounts ?? []).length > 0) {
      const problemas: string[] = [];
      for (const line of resolvedJournal) {
        if (line.account_code === "621008") continue;
        const check = validarCuenta(companyAccounts ?? [], line.account_code);
        if (!check.ok && check.problema) problemas.push(check.problema);
      }
      if (problemas.length > 0) {
        const mensajeCuentas =
          "NO SE PUEDE CAUSAR EN SIIGO.\n" +
          problemas.join("\n") +
          "\nAcción: seleccione una cuenta auxiliar activa en la pantalla de causación.";
        await supabase
          .from("invoices")
          .update({ siigo_status: "error", siigo_error: mensajeCuentas })
          .eq("id", inv.id);
        throw new Error(mensajeCuentas);
      }
    }

    await supabase
      .from("invoices")
      .update({ siigo_status: "sincronizando", siigo_last_attempt_at: new Date().toISOString() })
      .eq("id", data.invoiceId);

    let siigoAttemptTrace: Record<string, unknown> = {
      invoice_id: data.invoiceId,
      company_id: inv.company_id,
      iniciado_at: new Date().toISOString(),
      resultado: "preparando",
    };
    try {
      const documentId = await siigoPurchaseDocumentId();
      type SiigoTax = {
        id?: number | string;
        name?: string;
        type?: string;
        percentage?: number;
        active?: boolean;
        account?: { code?: string | number } | string | number;
        accounting_account?: { code?: string | number } | string | number;
        account_code?: string | number;
      };
      const ivaLineIndex = resolvedJournal.findIndex((line) => {
        const name = String(line.account_name ?? "").toLowerCase();
        return Number(line.debit ?? 0) > 0 && (name.includes("iva") || line.account_code.startsWith("2408") || line.account_code.startsWith("621008"));
      });
      let ivaTaxId: number | string | null = null;
      let ivaTaxRate = 0;
      let ivaTaxName: string | null = null;
      if (Number(inv.iva ?? 0) > 0 && ivaLineIndex >= 0) {
        const ivaAccountLine = resolvedJournal[ivaLineIndex]?.account_code ?? "";
        const rateFactura = Number(inv.total ?? 0) > Number(inv.iva ?? 0)
          ? Math.round((Number(inv.iva) / (Number(inv.total) - Number(inv.iva))) * 10000) / 100
          : 0;
        // 1) Identificador real guardado por empresa al sincronizar impuestos.
        const { data: localTaxes } = await supabase
          .from("tax_rates")
          .select("kind, name, rate, active, siigo_id, siigo_name, account_code")
          .eq("company_id", inv.company_id)
          .eq("active", true)
          .not("siigo_id", "is", null);
        const esIva = (t: { kind: string | null; name: string | null }) =>
          /iva|impuesto al valor/i.test(`${t.kind ?? ""} ${t.name ?? ""}`) &&
          !/rete/i.test(`${t.kind ?? ""} ${t.name ?? ""}`);
        const candidatasLocales = (localTaxes ?? []).filter(
          (t) => esIva(t) && Math.abs(Number(t.rate ?? 0) - rateFactura) < 0.01,
        );
        const localElegida =
          candidatasLocales.find((t) => /compra.*costo|costo.*compra/i.test(t.name ?? "")) ??
          candidatasLocales.find((t) => /costo|compra/i.test(t.name ?? "")) ??
          candidatasLocales.find((t) => t.account_code === ivaAccountLine) ??
          candidatasLocales[0];
        if (localElegida?.siigo_id) {
          ivaTaxId = localElegida.siigo_id;
          ivaTaxRate = Number(localElegida.rate ?? rateFactura);
          ivaTaxName = localElegida.siigo_name ?? localElegida.name ?? null;
          console.log("[siigo][iva] impuesto local:", {
            cuenta: ivaAccountLine,
            porcentaje: rateFactura,
            siigo_id: localElegida.siigo_id,
            nombre: localElegida.siigo_name ?? localElegida.name,
            activo: true,
          });
        }
        const response = ivaTaxId != null
          ? { results: [] as SiigoTax[] }
          : await siigoGet<SiigoTax[] | { results?: SiigoTax[] }>("/v1/taxes");
        const taxes = (Array.isArray(response) ? response : (response.results ?? [])).filter(
          (tax) => tax.active !== false && tax.id != null && /iva|value.added/i.test(`${tax.type ?? ""} ${tax.name ?? ""}`),
        );
        const readCode = (value: SiigoTax["account"]): string => {
          if (value == null) return "";
          if (typeof value === "object") return String(value.code ?? "").trim();
          return String(value).trim();
        };
        const ivaAccount = ivaAccountLine;
        const invoiceRate = rateFactura;
        const tax =
          taxes.find((candidate) =>
            Number(candidate.percentage ?? 0) === invoiceRate && /compra.*costo|costo.*compra/i.test(candidate.name ?? ""),
          ) ??
          taxes.find((candidate) =>
            Number(candidate.percentage ?? 0) === invoiceRate && /costo|compra/i.test(candidate.name ?? ""),
          ) ??
          taxes.find((candidate) =>
            [candidate.account, candidate.accounting_account, candidate.account_code]
              .map((value) => readCode(value as SiigoTax["account"]))
              .includes(ivaAccount),
          ) ??
          taxes.find((candidate) => Number(candidate.percentage ?? 0) === invoiceRate);
        if (ivaTaxId == null) {
          if (!tax?.id) {
            throw new Error(
              `No se encontró en Siigo el impuesto correspondiente para esta empresa y tarifa (IVA ${invoiceRate}%). Sincronice nuevamente los impuestos desde Integraciones.`,
            );
          }
          ivaTaxId = tax.id;
          ivaTaxRate = invoiceRate;
          ivaTaxName = tax.name ?? null;
          console.log("[siigo][iva] impuesto tomado de /v1/taxes:", {
            cuenta: ivaAccount,
            porcentaje: invoiceRate,
            siigo_id: tax.id,
            nombre: tax.name,
            activo: tax.active !== false,
          });
          // Se vincula el ID real a la configuración de impuestos de ESTA empresa.
          await supabase
            .from("tax_rates")
            .update({
              siigo_id: String(tax.id),
              siigo_name: tax.name ?? null,
              siigo_code: String(tax.id),
              siigo_synced_at: new Date().toISOString(),
            })
            .eq("company_id", inv.company_id)
            .eq("kind", "iva")
            .eq("rate", invoiceRate);
        }
      }
      if (!inv.provider_nit) throw new Error("La factura no tiene NIT de proveedor; Siigo lo exige para la factura de compra.");

      // Renglones de la factura de compra: se usan las cuentas de gasto/costo
      // seleccionadas por la IA (líneas del detalle) y, si no existen, los
      // débitos del asiento excluyendo impuestos y proveedores.
      const { data: invoiceLines } = await supabase
        .from("invoice_lines")
        .select("code, description, quantity, unit_value, discount, iva, account_code, account_name, item_type, position")
        .eq("invoice_id", data.invoiceId)
        .order("position");

      const esCuentaFiscal = (code: string) => /^(2205|2365|2367|2368|2408|621008)/.test(code);
      // La cuenta definida en la causación manda: si existe en el PUC de la
      // empresa se envía exactamente igual, sin recalcular equivalencias.
      const cuentaDelRenglon = (code: string) => (availableCodes.has(code) ? code : findEquivalent(code) || code);

      // Catálogo local de productos: la cuenta PUC y el código de producto son
      // campos distintos y nunca se intercambian.
      const { data: catalogo } = await supabase
        .from("products")
        .select("id, code, name, active, category_id, category, account_code, account_name")
        .eq("company_id", inv.company_id)
        .range(0, 19999);
      const porCodigo = new Map((catalogo ?? []).map((p) => [String(p.code ?? "").trim(), p]));

      // Si un renglón de producto no está en el catálogo local, se consulta
      // directamente en Siigo y se crea/actualiza automáticamente.
      const faltantes = Array.from(
        new Set(
          (invoiceLines ?? [])
            .filter((l) => {
              const t = normalizeItemType(l.item_type);
              return t === "producto" || t === "servicio";
            })
            .map((l) => String(l.code ?? "").trim())
            .filter((code) => code && !porCodigo.has(code)),
        ),
      );
      if (faltantes.length > 0) {
        const { fetchSiigoProductByCode, upsertSiigoProducts } = await import("./siigo-products.server");
        const encontrados = [];
        for (const code of faltantes) {
          try {
            const p = await fetchSiigoProductByCode(code);
            if (p) encontrados.push(p);
          } catch (e) {
            console.log("[siigo][productos] Error consultando producto", code, e);
          }
        }
        if (encontrados.length > 0) {
          await upsertSiigoProducts(supabase, inv.company_id, encontrados);
          const { data: recargado } = await supabase
            .from("products")
            .select("id, code, name, active, category_id, category, account_code, account_name")
            .eq("company_id", inv.company_id)
            .in("code", faltantes);
          for (const p of recargado ?? []) porCodigo.set(String(p.code ?? "").trim(), p);
        }
      }

      type Renglon = {
        type: "Product" | "Account";
        code: string;
        account_code: string;
        description: string;
        quantity: number;
        price: number;
        discount: number;
        tax_ids: Array<number | string>;
        item_type: string;
      };

      const items: Renglon[] = (invoiceLines ?? []).length
        ? (invoiceLines ?? []).map((l, i) => {
            const tipo = normalizeItemType(l.item_type);
            const cuenta = cuentaDelRenglon(l.account_code ?? "");
            const esProducto = tipo === "producto" || tipo === "servicio";
            const productCode = String(l.code ?? "").trim();
            if (esProducto) {
              if (!productCode) {
                throw new Error(
                  `Renglón ${i + 1}: el producto no tiene código válido de Siigo. Sincronice los productos con Siigo antes de causar.`,
                );
              }
              const prod = porCodigo.get(productCode);
              if (!prod) {
                throw new Error(
                  `Renglón ${i + 1}: el producto ${productCode} no existe en Siigo. Debe sincronizar o crear el producto en Siigo antes de causar.`,
                );
              }
              if (prod.active === false) {
                throw new Error(`Renglón ${i + 1}: el producto ${productCode} está inactivo en Siigo.`);
              }
              if (!cuenta) {
                throw new Error(`Renglón ${i + 1}: falta la cuenta contable interna del producto ${productCode}.`);
              }
            } else if (!cuenta) {
              throw new Error(`Renglón ${i + 1}: falta la cuenta contable.`);
            }
            return {
              type: esProducto ? "Product" : "Account",
              // Producto → código real del producto. Cuenta/gasto/activo → cuenta PUC.
              code: esProducto ? productCode : cuenta,
              account_code: cuenta,
              description: (l.description ?? l.account_name ?? `Cuenta ${cuenta}`) as string,
              quantity: Number(l.quantity ?? 1) || 1,
              price: Number(l.unit_value ?? 0),
              discount: Number(l.discount ?? 0),
              tax_ids: Number(l.iva ?? 0) > 0 && ivaTaxId != null ? [ivaTaxId] : [],
              // El tipo de ítem elegido en la revisión se conserva sin cambios.
              item_type: tipo,
            };
          })
        : resolvedJournal
            .filter((l) => Number(l.debit ?? 0) > 0 && !esCuentaFiscal(l.account_code))
            .map((l): Renglon => ({
              type: "Account",
              code: l.account_code,
              account_code: l.account_code,
              description: (l.account_name ?? `Cuenta ${l.account_code}`) as string,
              quantity: 1,
              price: Number(l.debit ?? 0),
              discount: 0,
              tax_ids: ivaTaxId != null ? [ivaTaxId] : [],
              item_type: "gasto",
            }));

      if (items.length === 0) throw new Error("La factura no tiene renglones de gasto/costo para enviar a Siigo.");

      // Centro de costo: se envía el ID real de Siigo, nunca el nombre ni el código interno.
      const costCenterId = await siigoCostCenterId(inv.cost_center);
      if (inv.cost_center && costCenterId == null) {
        throw new Error(
          `El centro de costo "${inv.cost_center}" no existe o no está activo en Siigo. Verifícalo antes de causar.`,
        );
      }

      // Todas las compras se causan siempre a crédito en Siigo, aunque la factura diga contado.
      const formaPago = "crédito";
      const paymentId = await siigoPurchasePaymentTypeId(formaPago);
      const retencionesPorTipo = [
        {
          kind: "retefuente",
          label: "Retefuente",
          amount: Number(inv.retefuente ?? 0),
          accountPrefix: "2365",
          // Se envía con el ID REAL del impuesto en Siigo (nunca la cuenta PUC 2365xx).
          enviarEnRetentions: true,
        },
        {
          kind: "reteiva",
          label: "ReteIVA",
          amount: Number(inv.reteiva ?? 0),
          accountPrefix: "2367",
          enviarEnRetentions: true,
        },
        {
          kind: "reteica",
          label: "ReteICA",
          amount: Number(inv.reteica ?? 0),
          accountPrefix: "2368",
          enviarEnRetentions: true,
        },
      ].filter((retention) => retention.amount > 0);
      const retenciones = retencionesPorTipo.reduce(
        (sum, retention) => sum + retention.amount,
        0,
      );

      const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
      // Subtotal e IVA: se prefieren los valores de la factura y, si vienen en 0,
      // se recalculan desde los renglones que se envían a Siigo.
      const subtotalItems = items.reduce(
        (acc, it) => acc + Number(it.quantity || 1) * Number(it.price || 0) - Number(it.discount || 0),
        0,
      );
      const ivaLineas = (invoiceLines ?? []).reduce((acc, l) => acc + Number(l.iva ?? 0), 0);
      const subtotal = r2(Number(inv.subtotal ?? 0) > 0 ? Number(inv.subtotal) : subtotalItems);
      const iva = r2(Number(inv.iva ?? 0) > 0 ? Number(inv.iva) : ivaLineas);
      // El total de la compra permanece bruto. Siigo exige que payments concilie
      // contra ese total y contabiliza las retenciones enviadas por separado.
      const impoconsumo = r2(
        (invoiceLines ?? []).reduce(
          (acc, l) => acc + Number((l as unknown as { impoconsumo?: number }).impoconsumo ?? 0),
          0,
        ),
      );
      const totalesSiigo = calculateSiigoPurchaseTotals({
        subtotal,
        taxes: iva + impoconsumo,
        retentions: retenciones,
      });
      const totalFactura = totalesSiigo.totalFactura;
      const netoAPagar = totalesSiigo.netoAPagar;
      const netoSiigo = Math.round(netoAPagar);

      if (totalFactura <= 0) {
        throw new Error(
          "El total calculado de la factura es 0. Revisa los valores de los renglones (cantidad y valor unitario) antes de causar en Siigo.",
        );
      }
      if (paymentId == null) {
        throw new Error(
          "No fue posible obtener la forma de pago de compras desde Siigo. Sincroniza la conexión e intenta nuevamente.",
        );
      }

      // Retenciones: resolver siempre el ID real configurado en Siigo. La cuenta
      // contable del asiento se usa como criterio de selección, pero no se modifica.
      const retencionesSiigo: Array<{ id: number | string; value: number; tipo: string; kind: string }> = [];
      const retencionesTrace: Array<{
        tipo: string;
        cuenta: string;
        tarifa: number;
        valor: number;
        siigo_id: string | null;
        nombre: string | null;
      }> = [];
      // Un ID de impuesto de Siigo es numérico; una cuenta PUC (2365xx, 2367xx…) nunca lo es.
      const esIdSiigoValido = (value: unknown, accountCode: string) => {
        const id = String(value ?? "").trim();
        if (!id || !/^\d+$/.test(id)) return false;
        if (id === accountCode) return false;
        if (id.length >= 6 && /^23/.test(id)) return false;
        return true;
      };
      const retencionesAEnviar = retencionesPorTipo.filter((r) => r.enviarEnRetentions);
      if (retencionesAEnviar.length > 0) {
        // Reglas tributarias configuradas por empresa: la tarifa oficial sale de aquí,
        // nunca se infiere desde el valor monetario redondeado de la retención.
        const { data: reglasRetencion } = await supabase
          .from("tax_rates")
          .select("kind, name, rate, active, siigo_id, siigo_name, account_code")
          .eq("company_id", inv.company_id)
          .eq("active", true);
        let allTaxes: SiigoTax[] = [];
        let taxesCargados = false;
        const cargarTaxes = async () => {
          if (taxesCargados) return allTaxes;
          const response = await siigoGet<SiigoTax[] | { results?: SiigoTax[] }>("/v1/taxes");
          allTaxes = (Array.isArray(response) ? response : (response.results ?? [])).filter(
            (tax) => tax.active !== false && tax.id != null,
          );
          taxesCargados = true;
          return allTaxes;
        };
        const normalize = (value: string) =>
          value
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
        const readTaxCode = (tax: SiigoTax) => {
          for (const value of [tax.account, tax.accounting_account, tax.account_code]) {
            if (value == null) continue;
            const code = typeof value === "object" ? value.code : value;
            if (code != null && String(code).trim()) return String(code).trim();
          }
          return "";
        };

        for (const retention of retencionesAEnviar) {
          const journalLine = resolvedJournal.find(
            (line) =>
              Number(line.credit ?? 0) > 0 &&
              line.account_code.startsWith(retention.accountPrefix),
          );
          const accountCode = journalLine?.account_code ?? retention.accountPrefix;
          const base = retention.kind === "reteiva" ? iva : subtotal;
          // Sólo se usa como criterio de desempate entre reglas configuradas.
          const tarifaAproximada =
            base > 0 ? (retention.amount / base) * 100 : 0;
          const kindPattern =
            retention.kind === "reteiva"
              ? /rete\s*iva|retencion.*iva/
              : retention.kind === "reteica"
                ? /rete\s*ica|retencion.*ica/
                : /rete\s*fuente|retencion.*fuente|renta/;
          const reglasDelTipo = (reglasRetencion ?? []).filter(
            (r) =>
              kindPattern.test(normalize(`${r.kind ?? ""} ${r.name ?? ""}`)) &&
              Number(r.rate ?? 0) > 0,
          );
          const reglasMismaCuenta = reglasDelTipo.filter(
            (r) => (r.account_code ?? "") === accountCode,
          );
          const universoReglas =
            reglasMismaCuenta.length > 0 ? reglasMismaCuenta : reglasDelTipo;
          // Regla cuya tarifa configurada explica el valor calculado (tolerancia de redondeo).
          const regla =
            universoReglas
              .slice()
              .sort(
                (a, b) =>
                  Math.abs(Number(a.rate ?? 0) - tarifaAproximada) -
                  Math.abs(Number(b.rate ?? 0) - tarifaAproximada),
              )[0] ?? null;
          // Tarifa OFICIAL configurada (ej. 2.5), no la derivada del monto redondeado.
          const configuredRate = regla ? Number(regla.rate) : 0;

          // 1) ID real de Siigo ya vinculado a la regla de esta empresa.
          if (regla?.siigo_id && esIdSiigoValido(regla.siigo_id, accountCode)) {
            console.log("[siigo][retencion] ID desde regla local:", {
              tipo: retention.label,
              cuenta: accountCode,
              tarifa_configurada: configuredRate,
              valor: retention.amount,
              siigo_id: regla.siigo_id,
              nombre: regla.siigo_name ?? regla.name,
            });
            if (!retencionesSiigo.some((r) => String(r.id) === String(regla.siigo_id)))
              retencionesSiigo.push({
                id: regla.siigo_id,
                value: retention.amount,
                tipo: retention.label,
                kind: retention.kind,
              });
            retencionesTrace.push({
              tipo: retention.label,
              cuenta: accountCode,
              tarifa: configuredRate,
              valor: retention.amount,
              siigo_id: String(regla.siigo_id),
              nombre: regla.siigo_name ?? regla.name ?? null,
            });
            continue;
          }

          const taxes = await cargarTaxes();
          const typePattern =
            retention.kind === "reteiva"
              ? /rete\s*iva|retencion.*iva|withholding.*iva/
              : retention.kind === "reteica"
                ? /rete\s*ica|retencion.*ica|withholding.*ica/
                : /rete\s*fuente|retencion.*fuente|withholding|renta/;
          const candidates = taxes.filter((tax) =>
            typePattern.test(normalize(`${tax.type ?? ""} ${tax.name ?? ""}`)),
          );
          // 2) Búsqueda en Siigo por la TARIFA CONFIGURADA (no la inferida).
          const mismaTarifa = (candidate: SiigoTax) =>
            configuredRate > 0 &&
            Math.abs(Number(candidate.percentage ?? 0) - configuredRate) < 0.01;
          const tax =
            candidates.find(
              (candidate) => mismaTarifa(candidate) && readTaxCode(candidate) === accountCode,
            ) ??
            candidates.find(mismaTarifa) ??
            candidates.find((candidate) => readTaxCode(candidate) === accountCode) ??
            (configuredRate > 0
              ? undefined
              : candidates.find((candidate) =>
                  readTaxCode(candidate).startsWith(retention.accountPrefix),
                ));
          if (tax?.id == null || !esIdSiigoValido(tax.id, accountCode)) {
            throw new Error(
              `No se encontró un impuesto de ${retention.label} válido en Siigo para esta tarifa` +
                (configuredRate > 0 ? ` (${configuredRate}%)` : "") +
                `. Sincroniza los impuestos de esta empresa desde Integraciones.`,
            );
          }
          console.log("[siigo][retencion] ID desde /v1/taxes:", {
            tipo: retention.label,
            cuenta: accountCode,
            tarifa_configurada: configuredRate,
            valor: retention.amount,
            siigo_id: tax.id,
            nombre: tax.name,
          });
          // Se vincula el ID real a la regla de ESTA empresa para próximas causaciones.
          if (regla) {
            await supabase
              .from("tax_rates")
              .update({
                siigo_id: String(tax.id),
                siigo_name: tax.name ?? null,
                siigo_code: String(tax.id),
                siigo_synced_at: new Date().toISOString(),
              })
              .eq("company_id", inv.company_id)
              .eq("kind", regla.kind)
              .eq("name", regla.name);
          }
          if (!retencionesSiigo.some((r) => String(r.id) === String(tax.id)))
            retencionesSiigo.push({
              id: tax.id,
              value: retention.amount,
              tipo: retention.label,
              kind: retention.kind,
            });
          retencionesTrace.push({
            tipo: retention.label,
            cuenta: accountCode,
            tarifa: configuredRate || Number(tax.percentage ?? 0),
            valor: retention.amount,
            siigo_id: String(tax.id),
            nombre: tax.name ?? null,
          });
        }
      }

      // Retenciones que sólo son contables (Retefuente): quedan en el asiento y en el
      // neto al proveedor, pero NO viajan en retentions[] ni usan la cuenta PUC como ID.
      for (const retention of retencionesPorTipo.filter((r) => !r.enviarEnRetentions)) {
        const journalLine = resolvedJournal.find(
          (line) => Number(line.credit ?? 0) > 0 && line.account_code.startsWith(retention.accountPrefix),
        );
        const accountCode = journalLine?.account_code ?? retention.accountPrefix;
        console.log("[siigo][retencion] Sólo contable (no va en retentions[]):", {
          tipo: retention.label,
          cuenta: accountCode,
          valor: retention.amount,
        });
        retencionesTrace.push({
          tipo: retention.label,
          cuenta: accountCode,
          tarifa: 0,
          valor: retention.amount,
          siigo_id: null,
          nombre: null,
        });
      }

      const esCredito = formaPago === "crédito";

      // Validación bloqueante: toda retención con valor debe tener su ID real de Siigo.
      if (retencionesPorTipo.length > 0) {
        const sinId = retencionesTrace.filter((r) => !r.siigo_id);
        if (sinId.length > 0 || retencionesSiigo.length === 0) {
          throw new Error(
            "No se encontró un impuesto de Retefuente válido en Siigo para esta tarifa. Sincroniza los impuestos de esta empresa desde Integraciones.",
          );
        }
      }

      // Validación final contra /v1/taxes: cada ID enviado debe existir, estar activo
      // y corresponder al tipo de retención esperado. CUENTA CONTABLE ≠ ID DE IMPUESTO.
      if (retencionesSiigo.length > 0) {
        const respTaxes = await siigoGet<SiigoTax[] | { results?: SiigoTax[] }>("/v1/taxes");
        const listaTaxes = (Array.isArray(respTaxes) ? respTaxes : (respTaxes.results ?? [])).filter(
          (t) => t.id != null,
        );
        const normTax = (v: string) => v.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        for (const r of retencionesSiigo) {
          const tax = listaTaxes.find((t) => String(t.id) === String(r.id));
          const patron =
            r.kind === "reteiva"
              ? /rete\s*iva|retencion.*iva|withholding.*iva/
              : r.kind === "reteica"
                ? /rete\s*ica|retencion.*ica|withholding.*ica/
                : /rete\s*fuente|retencion.*fuente|withholding|renta/;
          const tipoOk = tax ? patron.test(normTax(`${tax.type ?? ""} ${tax.name ?? ""}`)) : false;
          if (!tax || tax.active === false || !tipoOk) {
            console.error("[siigo][retencion] ID inválido en /v1/taxes:", {
              tipo: r.tipo,
              id_enviado: r.id,
              encontrado: tax ?? null,
            });
            throw new Error(
              `El impuesto de ${r.tipo} seleccionado no está correctamente configurado en Siigo. Sincroniza nuevamente los impuestos.`,
            );
          }
        }
      }
      console.log("[siigo][retenciones] Diagnóstico:", {
        empresa: inv.company_id,
        factura: [inv.prefix, inv.number].filter(Boolean).join("-"),
        subtotal,
        iva,
        retenciones: retencionesTrace.map((r) => ({
          tipo: r.tipo,
          tarifa: r.tarifa,
          cuenta_contable: r.cuenta,
          siigo_tax_id: r.siigo_id,
          valor: r.valor,
        })),
        total_antes_de_retencion: totalFactura,
        total_despues_de_retencion: netoAPagar,
      });
      const fechaDoc = inv.issue_date ?? new Date().toISOString().slice(0, 10);
      const dueDate = esCredito ? (inv.due_date ?? fechaDoc) : fechaDoc;
      // La API de esta cuenta rechaza Retefuente en retentions[] y la acepta como
      // impuesto de renglón; en esa estructura payments concilia contra el neto.
      const sumaRetencionesEnviadas = r2(retencionesSiigo.reduce((acc, r) => acc + r.value, 0));
      const payments = [{ id: paymentId, value: netoSiigo, due_date: dueDate }];
      const sumaPagos = r2(payments.reduce((acc, p) => acc + p.value, 0));
      const totalesValidados = calculateSiigoPurchaseTotals({
        subtotal,
        taxes: iva + impoconsumo,
        retentions: sumaRetencionesEnviadas,
        payments: sumaPagos,
      });
      const diferencia = totalesValidados.diferencia;
      if (Math.abs(diferencia) > 0.009) {
        console.log("[siigo][causacion] ⚠ Payments no coincide con el total conciliable de Siigo");
        console.log("[siigo][causacion] Suma de payments:", sumaPagos, "Neto Siigo:", netoSiigo);
        throw new Error(
          `La suma de los pagos (${sumaPagos}) no coincide con el total conciliable (${netoSiigo}).`,
        );
      }

      console.log("[siigo][causacion] Diagnóstico previo:", {
        subtotal,
        IVA: iva,
        total_compra: totalFactura,
        total_retenciones: retenciones,
        neto_a_pagar: netoAPagar,
        valor_payments: sumaPagos,
        diferencia,
        retenciones_siigo: retencionesSiigo,
      });
      console.log("[siigo][causacion] Payments enviados:", JSON.stringify(payments, null, 2));

      const providerNit = String(inv.provider_nit);
      // Retefuente usa el ID real validado en /v1/taxes dentro de items[].taxes.
      // ReteIVA/ReteICA conservan el arreglo documental cuando estén presentes.
      const retencionesEnItem = retencionesSiigo.filter((r) => r.kind === "retefuente");
      const retencionesEnDocumento = retencionesSiigo.filter((r) => r.kind !== "retefuente");
      const itemsConRetencion = items.map((item) => ({
        ...item,
        tax_ids: [
          ...item.tax_ids,
          ...retencionesEnItem
            .map((retention) => retention.id)
            .filter((id) => !item.tax_ids.some((taxId) => String(taxId) === String(id))),
        ],
      }));
      const totalDocumentoSiigo = totalFactura;

      // Validaciones obligatorias previas al POST.
      const totalEsperado = r2(subtotal + iva + impoconsumo);
      if (Math.abs(r2(totalFactura - totalEsperado)) > 0.009) {
        throw new Error(
          `El total de la factura (${totalFactura}) no corresponde a Subtotal + IVA (${totalEsperado}).`,
        );
      }
      if (Math.abs(r2(netoAPagar - (totalFactura - retenciones))) > 0.009) {
        throw new Error(
          `El neto a pagar (${netoAPagar}) no corresponde a Total factura − Retenciones (${r2(totalFactura - retenciones)}).`,
        );
      }
      const totalDebitos = r2(resolvedJournal.reduce((acc, l) => acc + Number(l.debit ?? 0), 0));
      const totalCreditos = r2(resolvedJournal.reduce((acc, l) => acc + Number(l.credit ?? 0), 0));
      if (Math.abs(r2(totalDebitos - totalCreditos)) > 0.009) {
        throw new Error(
          `El asiento contable no está cuadrado: débitos ${totalDebitos} vs créditos ${totalCreditos}.`,
        );
      }
      console.log("[siigo][validacion] Subtotal:", subtotal);
      console.log("[siigo][validacion] IVA:", iva);
      console.log("[siigo][validacion] Total factura:", totalFactura);
      console.log("[siigo][validacion] Retenciones:", retenciones);
      console.log("[siigo][validacion] Neto proveedor:", netoAPagar);
      console.log("[siigo][validacion] Débitos:", totalDebitos, "Créditos:", totalCreditos);
      for (const r of retencionesSiigo) {
        console.log("SIIGO TAX ID RETEFUENTE:", r.id);
        console.log("CUENTA CONTABLE RETEFUENTE:", retencionesTrace.find((t) => t.tipo === r.tipo)?.cuenta ?? null);
        console.log("VALOR RETEFUENTE:", r.value);
      }
      console.log("PAYMENT:", netoSiigo);
      const construirPayload = (totalDocumento: number) =>
        buildSiigoPurchasePayload({
        documentId,
        date: fechaDoc,
        providerNit,
        invoicePrefix: inv.prefix,
        invoiceNumber: inv.number,
        observations: `Factura ${[inv.prefix, inv.number].filter(Boolean).join("-")} · ${
          inv.provider_name ?? ""
        } ${inv.notes ?? ""}`.trim(),
        costCenterId,
        items: itemsConRetencion,
        paymentId,
        purchaseTotal: totalDocumento,
        paymentValue: netoSiigo,
        paymentDueDate: dueDate,
        retentions: retencionesEnDocumento.map((r) => ({ id: r.id, value: r.value })),
        });
      const payload = construirPayload(totalDocumentoSiigo);
      siigoAttemptTrace = {
        ...siigoAttemptTrace,
        resultado: "listo_para_enviar",
        impuesto_siigo: retencionesTrace.map((r) => ({
          id: r.siigo_id,
          nombre: r.nombre,
          porcentaje: r.tarifa,
          cuenta_contable_local: r.cuenta,
          valor: r.valor,
        })),
        medio_pago_siigo: { id: paymentId, valor: netoSiigo },
        valores: {
          subtotal,
          iva,
          impoconsumo,
          total_factura: totalFactura,
          retenciones,
          neto_a_pagar: netoAPagar,
          total_payments: sumaPagos,
          diferencia,
        },
        payload,
        intento_at: new Date().toISOString(),
      };
      console.log(
        "[siigo][causacion] purchase total:",
        netoAPagar,
        "| retention value:",
        sumaRetencionesEnviadas,
        "| payment value:",
        totalFactura,
        "| neto contable proveedor:",
        netoAPagar,
      );
      console.log("========== CAUSACIÓN ANTES DE ENVIAR ==========");
      items.forEach((it, i) => {
        const prod = it.type === "Product" ? porCodigo.get(it.code) : undefined;
        console.log(`Renglón ${i + 1}:`, {
          product_name: prod?.name ?? it.description,
          product_code: it.type === "Product" ? it.code : null,
          item_type: it.type,
          account_code: it.account_code,
          category: prod?.category ?? null,
          siigo_cost_center_id: costCenterId,
          siigo_payment_id: paymentId,
          quantity: it.quantity,
          price: it.price,
          subtotal,
          iva,
          total: totalFactura,
        });
      });
      console.log("===============================================");
      console.log("========== PAYLOAD SIIGO ==========");
      console.log(JSON.stringify(payload, null, 2));
      console.log("===================================");

      type SiigoPurchaseResponse = {
        id?: string;
        number?: number | string;
        name?: string;
        total?: number;
        retentions?: unknown;
        payments?: unknown;
        metadata?: { created?: string };
        _links?: { self?: { href?: string } };
      };
      const payloadEnviado: unknown = payload;
      // NO se reintenta alterando el total de la compra: el total siempre es Subtotal + IVA.
      const res: SiigoPurchaseResponse = await siigoPost<SiigoPurchaseResponse>("/v1/purchases", payload);
      siigoAttemptTrace = { ...siigoAttemptTrace, resultado: "aceptado", response: res };
      console.log("[siigo][causacion] Respuesta completa de Siigo:", JSON.stringify(res, null, 2));
      // Verificación posterior obligatoria: se consulta el documento creado en Siigo.
      let verificacion: unknown = null;
      if (!res.id) {
        throw new Error("Siigo respondió sin el ID de la factura de compra creada.");
      }
      verificacion = await siigoGet<unknown>(`/v1/purchases/${res.id}`);
          const doc = verificacion as {
            total?: number;
            balance?: number;
            payments?: Array<{ value?: number }>;
            retentions?: Array<{ id?: number | string; value?: number }>;
            items?: Array<{ taxes?: Array<{ id?: number | string; type?: string; value?: number }> }>;
          };
          const pagoSiigo = r2((doc.payments ?? []).reduce((acc, p) => acc + Number(p.value ?? 0), 0));
          const retSiigo = r2(
            (doc.retentions ?? []).reduce((acc, x) => acc + Number(x.value ?? 0), 0) +
              (doc.items ?? []).reduce(
                (sum, item) =>
                  sum +
                  (item.taxes ?? [])
                    .filter((tax) => retencionesEnItem.some((retention) => String(retention.id) === String(tax.id)))
                    .reduce((taxSum, tax) => taxSum + Number(tax.value ?? 0), 0),
                0,
              ),
          );
          console.log("[siigo][verificacion] GET /v1/purchases/" + res.id, {
            total_siigo: doc.total,
            saldo_siigo: doc.balance,
            payment_siigo: pagoSiigo,
            retencion_aplicada_siigo: retSiigo,
            total_factura_local: totalFactura,
            neto_local: netoAPagar,
            retenciones_local: retenciones,
          });
          if (Math.abs(r2(pagoSiigo - netoSiigo)) > 0.009) {
            throw new Error("El payment devuelto por Siigo no coincide con el total conciliable de la compra.");
          }
          if (retencionesSiigo.length > 0 && retSiigo <= 0) {
            throw new Error("Siigo creó la compra pero no registró la retención enviada.");
          }
      // Verificación posterior: la retención debe quedar realmente aplicada en Siigo.
      const verificacionDoc = verificacion as {
        retentions?: Array<{ id?: number | string; value?: number }>;
        items?: Array<{ taxes?: Array<{ id?: number | string; value?: number }> }>;
      };
      const retencionesRespuesta = Array.isArray(verificacionDoc.retentions) ? verificacionDoc.retentions : [];
      // Las retenciones deben aparecer en el arreglo de retenciones del documento.
      const itemsRespuesta = Array.isArray(verificacionDoc.items)
        ? (verificacionDoc.items ?? [])
        : [];
      const retencionesAplicadasEnRenglon = itemsRespuesta.flatMap((item) =>
        (item.taxes ?? []).filter((tax) =>
          retencionesEnItem.some((retention) => String(retention.id) === String(tax.id)),
        ),
      );
      const aplicadas = retencionesRespuesta.length + retencionesAplicadasEnRenglon.length;
      if (retencionesSiigo.length > 0 && aplicadas === 0) {
        throw new Error("Siigo creó la compra pero la verificación no encontró la retención aplicada.");
      }

      const syncedAt = new Date().toISOString();
      const siigoId = res.id ? String(res.id) : null;
      const siigoNumber = res.name ? String(res.name) : res.number != null ? String(res.number) : null;
      const documentUrl = res._links?.self?.href ?? null;

      const trace = {
        company_id: inv.company_id,
        factura: [inv.prefix, inv.number].filter(Boolean).join("-"),
        proveedor: { nit: inv.provider_nit, nombre: inv.provider_name ?? null },
        renglones: items.map((it) => ({
          descripcion: it.description,
          tipo_item: it.item_type,
          cuenta_puc: it.account_code,
          codigo: it.type === "Product" ? it.code : null,
          cantidad: it.quantity,
          precio: it.price,
          tax_ids: itemsConRetencion.find((x) => x.code === it.code)?.tax_ids ?? it.tax_ids,
        })),
        iva: { siigo_id: ivaTaxId != null ? String(ivaTaxId) : null, nombre: ivaTaxName, tarifa: ivaTaxRate, valor: iva },
        retenciones: retencionesTrace,
        centro_costo: { nombre: inv.cost_center ?? null, siigo_id: costCenterId ?? null },
        valores: {
          subtotal,
          iva,
          impoconsumo,
          total: totalFactura,
          retenciones: retenciones,
          neto_a_pagar: netoAPagar,
        },
        siigo_request: payloadEnviado,
        siigo_respuesta: res,
        siigo_verificacion: verificacion,
        siigo_documento_id: siigoId,
        siigo_documento_numero: siigoNumber,
        retenciones_aplicadas_en_siigo: [...retencionesRespuesta, ...retencionesAplicadasEnRenglon],
        enviado_at: syncedAt,
        resultado: "sincronizada",
      } as unknown as Json;

      await supabase
        .from("invoices")
        .update({
          siigo_status: "sincronizada",
          status: "sincronizada",
          siigo_id: siigoId,
          siigo_number: siigoNumber,
          siigo_document_url: documentUrl,
          siigo_synced_at: syncedAt,
          siigo_synced_by: context.userId,
          siigo_error: null,
          siigo_trace: trace,
        })
        .eq("id", data.invoiceId);

      return { ok: true, siigoId, siigoNumber, documentUrl, syncedAt, status: "sincronizada", error: null };
    } catch (e) {
      const raw = e instanceof Error ? e.message : JSON.stringify(e);
      const message = mensajeSiigoAmigable(raw);
      console.error("[siigo][causacion] error:", message);
      const failedTrace = {
        ...siigoAttemptTrace,
        resultado: "rechazado",
        error: message,
        error_raw: raw,
        fallo_at: new Date().toISOString(),
      } as unknown as Json;
      await supabase
        .from("invoices")
        .update({
          siigo_trace: failedTrace,
        })
        .eq("id", data.invoiceId);
      await supabase
        .from("invoices")
        // Si Siigo falla, la factura queda en estado Error para revisarla y reenviarla.
        .update({ siigo_status: "error", siigo_error: message, siigo_synced_by: context.userId, status: "error" })
        .eq("id", data.invoiceId);
      return { ok: false, siigoId: null, siigoNumber: null, documentUrl: null, syncedAt: null, status: "error", error: message };
    }
  });

export type SiigoProduct = { id: string; code: string; name: string };

/** Importa productos y servicios desde Siigo (catálogo local con cuenta contable). */
export const siigoImportProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => {
    if (!input?.companyId) throw new Error("companyId requerido");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { fetchAllSiigoProducts, upsertSiigoProducts } = await import("./siigo-products.server");
    const list = await fetchAllSiigoProducts();
    // La sincronización siempre se ejecuta contra la empresa activa.
    const stats = await upsertSiigoProducts(context.supabase, data.companyId, list);
    console.log("[siigo][productos] Sincronización:", JSON.stringify(stats));
    return stats;
  });

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

/** Diagnóstico autenticado de catálogos que intervienen en Facturas de Compra. */
export const siigoPurchaseCatalogDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { siigoGet } = await import("./siigo.server");
    const [taxes, paymentTypes, purchases] = await Promise.all([
      siigoGet<Json>("/v1/taxes"),
      siigoGet<Json>("/v1/payment-types?document_type=FC"),
      siigoGet<Json>("/v1/purchases?page=1&page_size=100"),
    ]);
    return { taxes, paymentTypes, purchases };
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

// ---------------------------------------------------------------------------
// Credenciales de Siigo administradas desde la aplicación.
// ---------------------------------------------------------------------------

export const siigoSaveCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { username: string; accessKey: string; partnerId: string }) => {
    if (!input?.username?.trim()) throw new Error("El usuario API es obligatorio.");
    if (!input?.accessKey?.trim()) throw new Error("La clave de API (Access Key) es obligatoria.");
    return {
      username: input.username.trim(),
      accessKey: input.accessKey.trim(),
      partnerId: (input.partnerId ?? "").trim(),
    };
  })
  .handler(async ({ data }) => {
    const { saveSiigoOverrides, siigoGet } = await import("./siigo.server");
    await saveSiigoOverrides(data);
    try {
      await siigoGet("/v1/users");
      return { ok: true, error: null as string | null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
