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
import {
  checkInvoiceCompany,
  motivoBloqueoEmpresa,
  sameNit,
} from "@/lib/company-validation";
import { resolveOperationalAccount, type PucAccount } from "@/lib/puc-hierarchy";
import { applyPucToPayable, fetchPayableAccount } from "@/lib/payable-account";
import {
  buildJournal,
*** placeholder
  computeRetenciones,
  type Line,
  type Rule,
  type TaxRate,
} from "@/lib/accounting";

const ALLOWED = /\.pdf$/i;
const IS_ZIP = (name: string, type = "") => /\.zip$/i.test(name) || type.includes("zip");

const mimeFor = (name: string) => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
};

/** Expande archivos comprimidos (.zip) y devuelve la lista plana de facturas soportadas. */
export async function expandInvoiceFiles(input: File[]): Promise<File[]> {
  const { pdfs } = await readZipContents(input);
  return pdfs;
}

export type ZipContents = {
  /** Facturas PDF encontradas dentro del comprimido. */
  pdfs: File[];
  /** Archivos ignorados por no ser PDF (no detienen el proceso). */
  skipped: string[];
  /** Total de archivos (sin carpetas) encontrados. */
  filesFound: number;
};

/** Abre un .zip (o una selección de archivos sueltos) y separa PDFs de archivos no compatibles. */
export async function readZipContents(input: File[]): Promise<ZipContents> {
  const pdfs: File[] = [];
  const skipped: string[] = [];
  let filesFound = 0;
  // Cola de comprimidos: los proveedores suelen enviar un ZIP que contiene otros ZIP
  // (uno por factura, con el PDF y el XML adentro). Se recorren todos los niveles.
  const pendientes: File[] = [...input];
  const vistos = new Set<string>();
  let nivel = 0;
  while (pendientes.length > 0 && nivel < 5000) {
    nivel += 1;
    const file = pendientes.shift()!;
    if (!IS_ZIP(file.name, file.type)) {
      filesFound += 1;
      if (ALLOWED.test(file.name)) pdfs.push(file);
      else skipped.push(file.name);
      continue;
    }
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    } catch {
      throw new Error(`El archivo ${file.name} no es un comprimido ZIP válido.`);
    }
    for (const [path, bytes] of Object.entries(entries)) {
      const name = path.split("/").pop() ?? path;
      // Carpetas y metadatos del sistema no cuentan como archivos.
      if (!name || name.startsWith(".") || path.endsWith("/") || path.includes("__MACOSX/")) continue;
      if (IS_ZIP(name)) {
        // Comprimido anidado: se abre en la siguiente vuelta y no se cuenta como archivo final.
        if (bytes.length > 0) pendientes.push(new File([new Uint8Array(bytes)], name, { type: "application/zip" }));
        continue;
      }
      filesFound += 1;
      if (!ALLOWED.test(name) || bytes.length === 0) {
        skipped.push(name);
        continue;
      }
      // Un mismo PDF puede venir repetido en varios niveles del comprimido.
      const clave = `${name}:${bytes.length}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      pdfs.push(new File([new Uint8Array(bytes)], name, { type: mimeFor(name) }));
    }
  }
  pdfs.sort((a, b) => a.name.localeCompare(b.name, "es"));
  return { pdfs, skipped, filesFound };
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

export type InvoiceReadTrace = {
  providerName: string | null;
  providerNit: string | null;
  buyerName: string | null;
  buyerNit: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  text: string | null;
  readMode: "texto" | "imagen";
};

export class BulkInvoiceStageError extends Error {
  readonly stage: "reading" | "extracting_data" | "validating_company";
  readonly trace: InvoiceReadTrace | undefined;
  readonly requiresReview: boolean;

  constructor(message: string, stage: BulkInvoiceStageError["stage"], trace?: InvoiceReadTrace, requiresReview = false) {
    super(message);
    this.name = "BulkInvoiceStageError";
    this.stage = stage;
    this.trace = trace;
    this.requiresReview = requiresReview;
  }
}

/** Caché de extracciones ya realizadas (por huella del archivo) para no volver a llamar a la IA. */
const extraccionCache = new Map<string, { data: ExtractedInvoice; texto: string; lectura: "texto" | "imagen" }>();

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
  /** Ruta del PDF ya guardado en Storage: evita subir el archivo dos veces. */
  storagePath?: string | null;
  onStage?: (stage: "reading" | "ocr" | "extracting_data" | "validating_company" | "ready_for_accounting", trace?: InvoiceReadTrace) => Promise<void>;
}): Promise<{
  invoiceId: string;
  numero: string;
  total: number;
  score: number;
  needsReview: boolean;
  reason: string;
  providerName: string | null;
  providerNit: string | null;
  buyerName: string | null;
  buyerNit: string | null;
  issueDate: string | null;
  readMode: "texto" | "imagen";
}> {
  const { file, companyId, config, extract } = params;
  const huella = await fileFingerprint(file);
  let cached = extraccionCache.get(huella);
  if (!cached) {
    // Lectura optimizada: XML y PDF con texto digital no pasan por OCR/visión.
    await params.onStage?.("reading");
    let content;
    try {
      content = await prepareInvoiceFile(file);
    } catch (error) {
      throw new BulkInvoiceStageError(error instanceof Error ? error.message : "ERROR_NO_SE_PUDO_LEER_PDF", "reading");
    }
    if (!content.text && !content.images?.length && !content.dataUrl) {
      throw new BulkInvoiceStageError("ERROR_NO_SE_PUDO_LEER_PDF: no se obtuvo texto ni imagen legible.", "reading");
    }
    await params.onStage?.(content.text ? "extracting_data" : "ocr");
    let extraida: ExtractedInvoice;
    try {
      extraida = (await extract({
        data: { fileName: file.name, mimeType: file.type || "application/octet-stream", ...content },
      })) as ExtractedInvoice;
    } catch (error) {
      throw new BulkInvoiceStageError(
        error instanceof Error ? error.message : "No fue posible extraer los datos de la factura.",
        "extracting_data",
      );
    }
    cached = {
      data: extraida,
      texto: content.text ?? "",
      lectura: content.text ? "texto" : "imagen",
    };
    extraccionCache.set(huella, cached);
  }
  const { lines: extracted, ...header } = cached.data;
  const textoDocumento = cached.texto;

  const trace: InvoiceReadTrace = {
    providerName: header.provider_name ?? null,
    providerNit: header.provider_nit ?? null,
    buyerName: header.buyer_name ?? null,
    buyerNit: header.buyer_nit ?? null,
    invoiceNumber: [header.prefix, header.number].filter(Boolean).join("-") || null,
    issueDate: header.issue_date ?? null,
    text: textoDocumento ? textoDocumento.slice(0, 20000) : null,
    readMode: cached.lectura,
  };
  await params.onStage?.("validating_company", trace);

  // Cada factura del ZIP se valida individualmente: si el NIT del comprador no es el de la
  // empresa activa (o no se pudo leer), se rechaza y NO se crea borrador.
  const { data: empresa } = await supabase
    .from("companies").select("id, name, nit").eq("id", companyId).maybeSingle();

  if (!header.buyer_nit || !header.buyer_name) {
    throw new BulkInvoiceStageError(
      "No fue posible identificar el comprador de la factura.",
      "validating_company",
      trace,
      true,
    );
  }

  const bloqueo = motivoBloqueoEmpresa(
    checkInvoiceCompany(empresa, { buyer_nit: header.buyer_nit, buyer_name: header.buyer_name }),
  );
  if (bloqueo) throw new BulkInvoiceStageError(bloqueo, "validating_company", trace);
  if (!sameNit(header.buyer_nit, empresa?.nit)) {
    throw new BulkInvoiceStageError("Comprador diferente a la empresa activa.", "validating_company", trace);
  }
  await params.onStage?.("ready_for_accounting", trace);

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
  // Contrapartida: obligación por pagar según el histórico de esta empresa con este proveedor.
  const payable = applyPucToPayable(await fetchPayableAccount(companyId, header.provider_nit), config.accounts);
  // Tratamiento contable del IVA de esta factura (descontable / gasto / costo).
  // No altera el cálculo del impuesto, solo la cuenta donde queda registrado.
  const ivaDecision =
    ivaTotal > 0
      ? resolveIvaTreatment({
          config: await fetchIvaConfig(companyId),
          evidence: await fetchIvaEvidence(companyId, header.provider_nit),
          providerNit: header.provider_nit,
          expenseAccounts: [...new Set(lines.map((l) => String(l.account_code ?? "").trim()).filter(Boolean))],
          concepts: lines.map((l) => l.description ?? ""),
          puc: config.accounts,
          taxAccount: null,
        })
      : null;
  // El IVA que no es descontable se registra SIEMPRE como una línea independiente por el total.
  const ivaDetalle =
    ivaDecision && ivaDecision.treatment !== "descontable"
      ? applyIvaTreatment([{ account_code: "", account_name: "IVA", amount: ivaTotal }], ivaDecision)
      : undefined;
  const journal = buildJournal({
    lines,
    iva: ivaTotal,
    impoconsumo: Number(header.impoconsumo || 0),
    retenciones,
    costCenter: centroFactura,
    ...(ivaDetalle ? { ivaDetalle } : {}),
    payableAccount: payable,
  });
  const unresolvedAccounts: string[] = [];
  const operationalJournal = journal.map((line) => {
    // Renglones sin cuenta (por ejemplo el IVA aún sin impuesto seleccionado) se guardan
    // tal cual: el borrador exige elegir el impuesto exacto antes de causar.
    if (!line.account_code) return line;
    const resolution = resolveOperationalAccount(config.accounts, line.account_code);
    if (!resolution.valid || !resolution.operationalAccount) {
      // Igual que en la causación individual: una cuenta padre o ambigua no impide
      // guardar el borrador. Se conserva para que el usuario seleccione el auxiliar
      // exacto durante la revisión; únicamente la aprobación/exportación la bloquea.
      unresolvedAccounts.push(
        resolution.message ?? `La cuenta ${line.account_code} requiere revisión antes de aprobar.`,
      );
      return line;
    }
    return {
      ...line,
      account_code: resolution.operationalAccount,
      account_name: resolution.operational?.name ?? line.account_name,
    };
  });

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  let filePath: string | null = params.storagePath ?? null;
  if (!filePath && userId) {
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
      // Trazabilidad de lectura: lo que devolvió la IA y el texto extraído del documento.
      raw_extraction: {
        ia: cached.data,
        lectura: cached.lectura,
        texto: textoDocumento ? textoDocumento.slice(0, 20000) : null,
        archivo: file.name,
      } as never,
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
    needsReview: score < 0.95 || unresolvedAccounts.length > 0,
    reason: unresolvedAccounts.length > 0
      ? `${reason}${reason ? " " : ""}${unresolvedAccounts.join(" ")}`
      : reason,
    providerName: header.provider_name ?? null,
    providerNit: header.provider_nit ?? null,
    buyerName: header.buyer_name ?? null,
    buyerNit: header.buyer_nit ?? null,
    issueDate: header.issue_date || null,
    readMode: cached.lectura,
  };
}
