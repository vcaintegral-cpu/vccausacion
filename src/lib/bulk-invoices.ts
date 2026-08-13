import { unzipSync } from "fflate";
import { supabase } from "@/integrations/supabase/client";
import { companyUsesCostCenters, costCenterForCompany, costCentersEnabled } from "@/lib/cost-center-config";
import { prepareInvoiceFile } from "@/lib/invoice-file";
import type { ExtractedInvoice } from "@/lib/extract.functions";
import {
  applyEngineToLines,
  emptyKnowledge,
  fetchCompanyKnowledge,
  knowledgeForProvider,
  type CompanyKnowledge,
} from "@/lib/causacion-engine";
import { findExistingInvoice, mensajeDuplicado } from "@/lib/invoice-duplicates";
import { checkInvoiceCompany, motivoBloqueoEmpresa } from "@/lib/company-validation";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";
import {
  buildJournal,
  computeRetenciones,
  type Line,
  type Rule,
  type TaxRate,
} from "@/lib/accounting";

const ALLOWED = /\.pdf$/i;

const mimeFor = (name: string) => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
};

/** Expande archivos comprimidos (.zip) y devuelve la lista plana de facturas soportadas. */
export async function expandInvoiceFiles(input: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const file of input) {
    const isZip = file.name.toLowerCase().endsWith(".zip") || file.type.includes("zip");
    if (!isZip) {
      if (ALLOWED.test(file.name)) out.push(file);
      continue;
    }
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    for (const [path, bytes] of Object.entries(entries)) {
      const name = path.split("/").pop() ?? path;
      if (!name || name.startsWith(".") || path.includes("__MACOSX/")) continue;
      if (!ALLOWED.test(name) || bytes.length === 0) continue;
      out.push(new File([new Uint8Array(bytes)], name, { type: mimeFor(name) }));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export type BulkConfig = {
  accounts: PucAccount[];
  rules: Rule[];
  taxes: TaxRate[];
  products: {
    code: string;
    name: string;
    kind: string;
    category: string | null;
    category_id?: string | null;
    account_code: string | null;
    account_name: string | null;
  }[];
  categories: { id?: string | null; name: string; kind: string; account_code: string | null; account_name: string | null }[];
  /** Conocimiento contable de la empresa (se lee una sola vez para todo el lote). */
  knowledge?: CompanyKnowledge;
};

type ExtractFn = (args: { data: { fileName: string; mimeType: string } & Record<string, unknown> }) => Promise<unknown>;

/** Caché de extracciones ya realizadas (por huella del archivo) para no volver a llamar a la IA. */
const extraccionCache = new Map<string, ExtractedInvoice>();

/**
 * Documentos ya tomados en este lote (CUFE, o NIT + prefijo + número): evita que
 * el mismo documento en dos archivos distintos (XML y PDF) se procese dos veces.
 */
const documentosDelLote = new Set<string>();

/** Reinicia el control de duplicados dentro de un lote. Llamar antes de procesar un ZIP. */
export function resetBulkBatch() {
  documentosDelLote.clear();
}

const claveDocumento = (h: { cufe?: string | null; provider_nit?: string | null; prefix?: string | null; number?: string | null }) => {
  const cufe = (h.cufe ?? "").trim().toLowerCase();
  if (cufe) return `cufe:${cufe}`;
  const numero = (h.number ?? "").trim();
  if (!numero) return "";
  return `num:${(h.provider_nit ?? "").trim()}|${(h.prefix ?? "").trim()}|${numero}`.toLowerCase();
};

async function fileFingerprint(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${file.name}:${file.size}`;
}

const norm = (s?: string | null) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/** Lee una factura con IA y la guarda como borrador con su comprobante contable. */
export async function processInvoiceFile(params: {
  file: File;
  companyId: string;
  config: BulkConfig;
  extract: ExtractFn;
  knowledge?: CompanyKnowledge;
}): Promise<{ invoiceId: string; numero: string; total: number; score: number; needsReview: boolean; reason: string }> {
  const { file, companyId, config, extract } = params;
  const huella = await fileFingerprint(file);
  let data = extraccionCache.get(huella);
  if (!data) {
    // Lectura optimizada: XML y PDF con texto digital no pasan por OCR/visión.
    const content = await prepareInvoiceFile(file);
    data = (await extract({
      data: { fileName: file.name, mimeType: file.type || "application/octet-stream", ...content },
    })) as ExtractedInvoice;
    extraccionCache.set(huella, data);
  }
  const { lines: extracted, ...header } = data;

  // Cada factura del ZIP se valida individualmente: si el NIT del comprador no es el de la
  // empresa activa (o no se pudo leer), se rechaza y NO se crea borrador.
  const { data: empresa } = await supabase
    .from("companies").select("id, name, nit").eq("id", companyId).maybeSingle();
  const bloqueo = motivoBloqueoEmpresa(
    checkInvoiceCompany(empresa, { buyer_nit: header.buyer_nit, buyer_name: header.buyer_name }),
  );
  if (bloqueo) throw new Error(bloqueo);

  // Mismo documento en dos archivos del ZIP: se procesa una sola vez.
  const clave = claveDocumento(header);
  if (clave) {
    if (documentosDelLote.has(clave)) {
      throw new Error("Documento repetido dentro del comprimido: ya se procesó desde otro archivo.");
    }
    documentosDelLote.add(clave);
  }

  // Control de duplicados por empresa: CUFE, o NIT + prefijo + número.
  const existente = await findExistingInvoice(companyId, {
    cufe: header.cufe,
    provider_nit: header.provider_nit,
    prefix: header.prefix,
    number: header.number,
  });
  if (existente) throw new Error(mensajeDuplicado(existente));

  let provider = null;
  if (header.provider_nit) {
    const { data: p } = await supabase
      .from("providers").select("*").eq("company_id", companyId).eq("nit", header.provider_nit).maybeSingle();
    provider = p;
  }

  const conCatalogo: Line[] = extracted.map((l) => {
    const base: Line = {
      description: l.description ?? "",
      quantity: Number(l.quantity || 0),
      unit_value: Number(l.unit_value || 0),
      discount: Number(l.discount || 0),
      iva: Number(l.iva || 0),
      retention: Number(l.retention || 0),
      impoconsumo: Number(l.impoconsumo || 0),
      total: Number(l.total || 0),
      account_code: "",
      account_name: "",
      item_type: "gasto",
      code: l.code ?? null,
    } as Line;
    const prod =
      config.products.find((p) => base.code && norm(p.code) === norm(String(base.code))) ??
      config.products.find((p) => norm(p.name) === norm(base.description));
    return prod ? { ...base, item_type: prod.kind ?? "gasto" } : base;
  });

  // Mismo motor inteligente que la causación individual.
  // Conocimiento base (reglas) + histórico resumido del proveedor de ESTA factura.
  const base = params.knowledge ?? config.knowledge ?? (await fetchCompanyKnowledge(companyId)) ?? emptyKnowledge();
  const conocimiento = await knowledgeForProvider(companyId, header.provider_nit, base);
  const { lines, decisions } = applyEngineToLines(conCatalogo, {
    providerNit: header.provider_nit,
    knowledge: conocimiento,
    products: config.products,
    categories: config.categories,
    rules: config.rules,
    puc: config.accounts,
    provider,
  });
  // Nivel de confianza del lote: manda la decisión más débil de la factura.
  const tomadas = Object.values(decisions);
  const peor = tomadas.sort((a, b) => a.score - b.score)[0];
  const score = tomadas.length === 0 ? 1 : (peor?.score ?? 0);
  const reason = tomadas.length === 0 ? "Cuentas tomadas del catálogo o del borrador." : (peor?.reason ?? "");
  const baseGravable = lines.reduce(
    (s, l) => s + Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0),
    0,
  );
  const ivaLineas = lines.reduce((s, l) => s + Number(l.iva || 0), 0);
  const ivaTotal = ivaLineas > 0 ? ivaLineas : Number(header.iva || 0);
  const retenciones = computeRetenciones(baseGravable, ivaTotal, config.taxes);
  // La empresa define si maneja centros de costo; si no, nunca se guarda ninguno.
  const costPolicy = await companyUsesCostCenters(companyId);
  const centroFactura = costCenterForCompany(costPolicy, header.cost_center);
  const journal = buildJournal({
    lines,
    iva: ivaTotal,
    impoconsumo: Number(header.impoconsumo || 0),
    retenciones,
    costCenter: centroFactura,
  });
  const operationalJournal = journal.map((line) => {
    // Renglones sin cuenta (por ejemplo el IVA aún sin impuesto seleccionado) se guardan
    // tal cual: el borrador exige elegir el impuesto exacto antes de causar.
    if (!line.account_code) return line;
    const resolution = resolveOperationalAccount(config.accounts, line.account_code);
    if (!resolution.valid || !resolution.operationalAccount) {
      throw new Error(resolution.message ?? `La cuenta ${line.account_code} no es operativa en Siigo.`);
    }
    return {
      ...line,
      account_code: resolution.operationalAccount,
      account_name: resolution.operational?.name ?? line.account_name,
    };
  });

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  let filePath: string | null = null;
  if (userId) {
    const path = `${userId}/${companyId}/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
    const { error: upErr } = await supabase.storage.from("facturas").upload(path, file);
    if (!upErr) filePath = path;
  }

  if (header.provider_nit) {
    await supabase.from("providers").upsert(
      {
        company_id: companyId,
        nit: header.provider_nit,
        name: header.provider_name || header.provider_nit,
        address: header.provider_address,
        city: header.provider_city,
        phone: header.provider_phone,
        email: header.provider_email,
      },
      { onConflict: "company_id,nit", ignoreDuplicates: true },
    );
  }

  const total = baseGravable + ivaTotal + Number(header.impoconsumo || 0);
  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      company_id: companyId,
      prefix: header.prefix,
      number: header.number,
      issue_date: header.issue_date || null,
      due_date: header.due_date || null,
      provider_nit: header.provider_nit,
      provider_name: header.provider_name,
      provider_address: header.provider_address,
      provider_city: header.provider_city,
      provider_phone: header.provider_phone,
      provider_email: header.provider_email,
      buyer_nit: header.buyer_nit,
      buyer_name: header.buyer_name,
      cufe: header.cufe,
      // Todas las causaciones quedan a crédito, sin importar lo que diga la factura.
      payment_form: "Crédito",
      payment_method: header.payment_method,
      currency: header.currency || "COP",
      cost_center: centroFactura,
      notes: header.notes,
      subtotal: baseGravable,
      discount: Number(header.discount || 0),
      iva: ivaTotal,
      impoconsumo: Number(header.impoconsumo || 0),
      retefuente: retenciones.retefuente,
      reteiva: retenciones.reteiva,
      reteica: retenciones.reteica,
      total,
      status: "borrador",
      dian_status: header.cufe ? "con CUFE" : "sin CUFE",
      file_path: filePath,
      file_name: file.name,
    })
    .select()
    .single();
  if (error) throw error;

  await Promise.all([
    supabase.from("invoice_lines").insert(
      lines.map((l, i) => ({
        invoice_id: inv.id,
        company_id: companyId,
        code: l.code ?? null,
        description: l.description,
        quantity: Number(l.quantity || 0),
        unit_value: Number(l.unit_value || 0),
        discount: Number(l.discount || 0),
        iva: Number(l.iva || 0),
        retention: Number(l.retention || 0),
        impoconsumo: Number(l.impoconsumo || 0),
        total: Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0),
        account_code: l.account_code ?? null,
        account_name: l.account_name ?? null,
        item_type: l.item_type ?? "gasto",
        position: i,
      })),
    ),
    supabase.from("journal_lines").insert(
      operationalJournal.map((j, i) => ({
        invoice_id: inv.id,
        company_id: companyId,
        account_code: j.account_code,
        account_name: j.account_name,
        debit: j.debit,
        credit: j.credit,
        cost_center: costCentersEnabled(costPolicy) ? (j.cost_center ?? null) : null,
        position: i,
      })),
    ),
  ]);

  return {
    invoiceId: inv.id as string,
    numero: [header.prefix, header.number].filter(Boolean).join("-") || file.name,
    total,
    score,
    // 95% o más: automática. 80–94%: sugerida y marcada para revisión. Menos de 80%: revisión obligatoria.
    needsReview: score < 0.95,
    reason,
  };
}
