import { funcionActiva } from "@/empresas/registro";
import { estadoFacturaAfectada, facturaReferidaEnTexto, facturaReferidaEnValor, mensajeNotaCredito, pareceNotaCredito } from "@/lib/nota-credito";
import { unzipSync } from "fflate";
import { supabase } from "@/lib/db-contextual";
import { companyUsesCostCenters, costCenterForCompany, costCentersEnabled } from "@/lib/cost-center-config";
import { prepareInvoiceFile } from "@/lib/invoice-file";
import { captureSource, sourceErrors, sourceFromRaw, alignJournalToSource } from "@/lib/source-values";
import { roundCOP, sumCOP } from "@/lib/money";
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
import { buildIvaGroups, resolveImpoconsumoAccount, resolveTaxAccount, taxTrace, type TaxRecord } from "@/lib/tax-selection";
import {
  RETENCIONES,
  condicionDePerfil,
  decidirRetenciones,
  elegirIva,
  precedenteDe,
  esIvaDescontable,
  type ImpuestoConfigurado,
  type PrecedentesEmpresa,
  type PrecedenteProveedor,
  type TablaBases,
} from "@/lib/precedente-tributario";
import { cargarHistorialCompras, cargarPrecedentes, cargarTablasBases } from "@/lib/precedente-tributario.data";
import { cuentaGastoHistorica, diferenciasConPrecedente, MIN_COMPRAS_RECIENTES, perfilDe, type PerfilHistorico } from "@/lib/auxiliar-historico";
import { buscarProducto, codigoProductoNuevo, type ProductoCatalogo } from "@/lib/producto-coincidencia";
import { aplicarRepartoExtraido, motivoReparto, repartirCargos, repartoDeFuente } from "@/lib/cargos-en-items";
import { cuadrarIvaDeLineas, diagnosticarIva } from "@/lib/cuadre-lectura";
import { applyPucToPayable, fetchPayableAccount } from "@/lib/payable-account";
import {
  buildJournal,
  isPayableCode,
  type Line,
  type Rule,
  type TaxRate,
} from "@/lib/accounting";
import { resolverRetenciones, retencionesReportadas } from "@/lib/retenciones";
import {
  applyIvaTreatment,
  fetchIvaConfig,
  fetchIvaEvidence,
  resolveIvaTreatment,
} from "@/lib/iva-treatment";
import {
  ajusteAlPeso,
  applyProviderRuleToLines,
  fetchProviderRulesCached,
  headerRule,
  ivaDetalleDesdeRegla,
  marcarUsoRegla,
  retencionDesdeRegla,
  isValidExpenseAccount,
  isValidPurchaseAccount,
  type ProviderRule,
} from "@/lib/provider-rules";
import { totals as totalesJournal } from "@/lib/accounting";

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

/** Versión de la lógica de causación: el piloto recalcula una vez los borradores guardados con otra versión. */
export const MOTOR_VERSION = "2026-11-19.1";

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
  /** Precedente tributario por proveedor (IVA y retenciones sincronizados con Siigo), una vez por lote. */
  precedentes?: PrecedentesEmpresa;
  /** Tablas de bases mínimas de retención (UVT y conceptos por año). */
  tablasBases?: TablaBases[];
  /** Perfil de cada proveedor aprendido del auxiliar histórico de Siigo, una vez por lote. */
  perfilesHistoricos?: Map<string, PerfilHistorico>;
  /** Perfil de cada proveedor aprendido solo de sus compras recientes (perfil de empresa «precedenteDesde»). */
  perfilesRecientes?: Map<string, PerfilHistorico>;
  batch?: {
    company: { id: string; name: string; nit: string | null; uses_cost_centers: boolean | null; default_payable_account: string | null };
    providers: Record<string, { nit: string; default_expense_account: string | null; default_payable_account: string | null; default_iva_account: string | null; purchase_tax_profile?: unknown }>;
    providerRules: ProviderRule[];
    userId: string;
  };
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

/**
 * El documento no es del mes de trabajo del piloto automático: no se causa. Si es de un mes anterior ya
 * está cerrado; si es de uno posterior queda apartado y se retoma cuando el piloto llegue a ese mes.
 */
export class FueraDeMesError extends Error {
  readonly fecha: string | null;
  readonly ubicacion: "anterior" | "posterior" | "sin_fecha";

  constructor(message: string, fecha: string | null, ubicacion: FueraDeMesError["ubicacion"]) {
    super(message);
    this.name = "FueraDeMesError";
    this.fecha = fecha;
    this.ubicacion = ubicacion;
  }
}

/** Rango de fechas del mes de trabajo (AAAA-MM-DD). */
export type RangoMes = { desde: string; hasta: string; etiqueta: string };

export function verificarMes(fecha: string | null | undefined, mes?: RangoMes) {
  if (!mes) return;
  const f = String(fecha ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f))
    throw new FueraDeMesError(`Sin fecha legible: no se puede ubicar en ${mes.etiqueta}; revísela en la aplicación.`, null, "sin_fecha");
  if (f < mes.desde)
    throw new FueraDeMesError(`Es del ${f}, de un mes anterior a ${mes.etiqueta}: ya está cerrado, no se causó.`, f, "anterior");
  if (f > mes.hasta)
    throw new FueraDeMesError(`Es del ${f}, posterior a ${mes.etiqueta}: queda apartada hasta que el piloto llegue a ese mes.`, f, "posterior");
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

export type ProcessedInvoice = {
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
};

type StageCallback = (stage: "reading" | "ocr" | "extracting_data" | "validating_company" | "ready_for_accounting", trace?: InvoiceReadTrace) => Promise<void>;

/** Lee una factura con IA y la guarda como borrador con su comprobante contable. */
export async function processInvoiceFile(params: {
  file: File;
  companyId: string;
  config: BulkConfig;
  extract: ExtractFn;
  knowledge?: CompanyKnowledge;
  batch?: {
    company: { id: string; name: string; nit: string | null; uses_cost_centers: boolean | null; default_payable_account: string | null };
    providers: Record<string, { nit: string; default_expense_account: string | null; default_payable_account: string | null; default_iva_account: string | null; purchase_tax_profile?: unknown }>;
    providerRules: ProviderRule[];
    userId: string;
  };
  /** Ruta del PDF ya guardado en Storage: evita subir el archivo dos veces. */
  storagePath?: string | null;
  onStage?: StageCallback;
  /** Preparación del archivo (por defecto la del navegador; el piloto usa la del servidor). */
  preparar?: (file: File) => Promise<Awaited<ReturnType<typeof prepareInvoiceFile>>>;
  /** Mes de trabajo del piloto: una factura de otro mes no se causa. */
  mes?: RangoMes;
}): Promise<ProcessedInvoice> {
  const { file, extract } = params;
  const huella = await fileFingerprint(file);
  let cached = extraccionCache.get(huella);
  if (!cached) {
    // Lectura optimizada: XML y PDF con texto digital no pasan por OCR/visión.
    await params.onStage?.("reading");
    let content;
    try {
      content = await (params.preparar ?? prepareInvoiceFile)(file);
    } catch (error) {
      throw new BulkInvoiceStageError(error instanceof Error ? error.message : "ERROR_NO_SE_PUDO_LEER_PDF", "reading");
    }
    if (!content.text && !content.images?.length && !content.dataUrl && !content.pdfBase64) {
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
  verificarMes(cached.data.issue_date, params.mes);
  return saveExtractedInvoice({
    data: cached.data,
    fileName: file.name,
    file,
    companyId: params.companyId,
    config: params.config,
    knowledge: params.knowledge,
    storagePath: params.storagePath,
    readMode: cached.lectura,
    texto: cached.texto,
    onStage: params.onStage,
  });
}

/**
 * Guarda como borrador una factura ya extraída (por IA desde PDF o por el
 * adaptador del Excel RECIBIDOS). Es UNA SOLA función de causación: el Excel
 * entrega sus datos en la misma estructura ExtractedInvoice y pasa por aquí,
 * con exactamente los mismos parámetros, reglas y resultados que el PDF.
 */
type JournalLineOut = ReturnType<typeof buildJournal>[number];

export type DraftAccounting = {
  lines: Line[];
  journal: JournalLineOut[];
  payable: { code: string; name: string | null; source: string; confidence: number };
  retenciones: {
    retefuente: number;
    reteiva: number;
    reteica: number;
    autorretencion: number;
    detalle: unknown[];
  };
  baseGravable: number;
  ivaTotal: number;
  centroFactura: string | null;
  costCentersEnabled: boolean;
  score: number;
  reason: string;
  unresolvedAccounts: string[];
  alertas: string[];
  decisions: import("@/lib/causacion-engine").LineDecisions;
  /** IVA exacto elegido para cada renglón (tarifa del documento + precedente del proveedor). */
  ivaPorLinea: Array<{ tax: ImpuestoConfigurado; motivo: string } | null>;
  /** Pide confirmar la condición tributaria del proveedor (retención sin precedente). */
  confirmarCondicion: string | null;
  /** Por qué el precedente reciente del proveedor no subió la confianza de la cuenta (para el motivo de revisión). */
  precedenteMotivo?: string | null;
  /** Productos que no existen en el catálogo y se crearán en Siigo al causar (por renglón). */
  productosNuevos: Record<number, ProductoNuevo>;
};

/** Producto que se crea en Siigo al causar (función "productos_inventario"). */
export type ProductoNuevo = { codigo: string; nombre: string; tipo: "producto" | "servicio"; grupo: string | null; cuenta: string };

// Evidencia de IVA por proveedor: una lectura por proveedor y empresa cada 5 minutos,
// también en la carga masiva (antes el lote la omitía y decidía sin historial).
const evidenciaIva = new Map<string, { hasta: number; promesa: ReturnType<typeof fetchIvaEvidence> }>();
function evidenciaIvaDe(companyId: string, nit: string | null | undefined) {
  const clave = `${companyId}|${nit ?? ""}`;
  const previa = evidenciaIva.get(clave);
  if (previa && previa.hasta > Date.now()) return previa.promesa;
  const promesa = fetchIvaEvidence(companyId, nit ?? null);
  evidenciaIva.set(clave, { hasta: Date.now() + 5 * 60 * 1000, promesa });
  promesa.catch(() => evidenciaIva.delete(clave));
  return promesa;
}

/**
 * Núcleo contable compartido: toma la extracción (de la IA o del adaptador
 * Excel) y produce las líneas con cuenta, el comprobante operativo, las
 * retenciones, la CxP y las alertas. Lo usan la causación inicial
 * (saveExtractedInvoice) y el botón "Recalcular cuentas" de Borradores, de
 * modo que ambos aplican EXACTAMENTE las mismas reglas.
 */
const nitsEmpresa = new Map<string, Promise<string | null>>();
/** NIT de la empresa (del lote si está cargado; si no, una consulta guardada en memoria). */
async function nitDeEmpresa(companyId: string, config: BulkConfig): Promise<string | null> {
  if (config.batch?.company?.nit) return config.batch.company.nit;
  let p = nitsEmpresa.get(companyId);
  if (!p) {
    p = Promise.resolve(
      supabase.from("companies").select("nit").eq("id", companyId).maybeSingle(),
    ).then((r) => (r.data as { nit: string | null } | null)?.nit ?? null);
    nitsEmpresa.set(companyId, p);
    p.catch(() => nitsEmpresa.delete(companyId));
  }
  return p;
}

export async function computeDraftAccounting(params: {
  companyId: string;
  config: BulkConfig;
  header: Omit<ExtractedInvoice, "lines">;
  extracted: ExtractedInvoice["lines"];
  knowledge?: CompanyKnowledge | undefined;
  /** IVA ya elegido por la usuaria en cada renglón (al recalcular): se respeta. */
  ivaFijado?: Array<string | null> | undefined;
}): Promise<DraftAccounting> {
  const { companyId, config, header, extracted } = params;

  let provider = null;
  if (config.batch) {
    provider = config.batch.providers[header.provider_nit ?? ""] ?? null;
  } else if (header.provider_nit) {
    const { data: p } = await supabase
      .from("providers").select("*").eq("company_id", companyId).eq("nit", header.provider_nit).maybeSingle();
    provider = p;
  }

  const conCatalogo: Line[] = extracted.map((l) => {
    const base: Line = {
      description: l.description ?? "",
      quantity: Number(l.quantity || 0),
      subtotal: l.subtotal ?? l.total,
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

  // P1/P2: reglas por proveedor (NIT + palabra clave, luego "(todas)"). Una cuenta
  // fuera de los grupos de gasto válidos se descarta y la línea sigue al motor.
  const providerRules = config.batch?.providerRules ?? await fetchProviderRulesCached(companyId);
  const conReglaProveedor = applyProviderRuleToLines(conCatalogo, providerRules, header.provider_nit);
  let reglaProveedor = headerRule(providerRules, header.provider_nit) ?? conReglaProveedor.rule;

  // Mismo motor inteligente que la causación individual.
  // Conocimiento base (reglas) + histórico resumido del proveedor de ESTA factura.
  const base = params.knowledge ?? config.knowledge ?? (await fetchCompanyKnowledge(companyId)) ?? emptyKnowledge();
  const conocimiento = await knowledgeForProvider(companyId, header.provider_nit, base);
  const profile = conocimiento.profiles?.find((p) => sameNit(p.provider_nit, header.provider_nit));
  // Precedente del auxiliar histórico (compras completas reconstruidas) y tributario.
  const perfilesHistoricos =
    config.perfilesHistoricos ?? (await cargarHistorialCompras(companyId).then((h) => h.perfiles).catch(() => new Map<string, PerfilHistorico>()));
  const perfilHistorico = perfilDe(perfilesHistoricos, header.provider_nit);
  // Precedente reciente del proveedor (p. ej. desde abril de 2026): cuenta de gasto, IVA y retenciones de sus últimas compras.
  const perfilRecienteBruto = perfilDe(config.perfilesRecientes, header.provider_nit);
  const perfilReciente = perfilRecienteBruto && perfilRecienteBruto.compras >= MIN_COMPRAS_RECIENTES ? perfilRecienteBruto : null;
  const desdeReciente = new Set<number>();
  const impuestosPrevios = config.taxes as unknown as ImpuestoConfigurado[];
  const precedentesPrevios =
    config.precedentes ?? (await cargarPrecedentes(companyId, impuestosPrevios).catch(() => new Map() as PrecedentesEmpresa));
  // Si el precedente identifica el impuesto exacto de Retefuente (cuenta + tarifa del
  // auxiliar), la retención la decide ese precedente con su base mínima, y no la regla
  // sintética armada con la última compra.
  const retefuentePrecisa = !!precedenteDe(precedentesPrevios, header.provider_nit)?.retenciones.retefuente.some((u) => u.taxId);
  if (!reglaProveedor && profile) {
    reglaProveedor = {
      id: "", company_id: companyId, provider_nit: header.provider_nit ?? "", provider_name: null,
      keyword: "(todas)", expense_account: null, expense_account_name: null,
      iva_treatment: profile.iva_account === "51157001" ? "asumido" : "descontable",
      iva_account: profile.iva_account, inc_account: null,
      retention_account: retefuentePrecisa ? null : profile.retention_account,
      retention_rate: !retefuentePrecisa && profile.retention_rate ? Number(profile.retention_rate.replace(",", ".")) : null,
      retention_base: profile.aiu ? "AIU" : "Subtotal", payable_account: profile.payable_account,
      source: "historial", times_used: 0, last_used_at: null, active: true,
    };
  }
  const { lines, decisions } = applyEngineToLines(conReglaProveedor.lines, {
    providerNit: header.provider_nit,
    knowledge: conocimiento,
    products: config.products,
    categories: config.categories,
    rules: config.rules,
    puc: config.accounts,
    provider,
  });
  // Auxiliar histórico: cuenta de gasto/costo del propio proveedor (por palabras de la
  // descripción, o la que usa en casi todas sus compras) para renglones sin cuenta o
  // resueltos solo por descripciones de OTROS proveedores. Nunca reemplaza una regla.
  if (perfilHistorico || perfilReciente) {
    const nitHist = await nitDeEmpresa(companyId, config);
    const confianzaPorConcepto = funcionActiva(nitHist, "historial_confianza_concepto");
    const productoDelHistorial = funcionActiva(nitHist, "producto_del_historial");
    const valida = (c: string) =>
      isValidExpenseAccount(c) && (config.accounts.length === 0 || resolveOperationalAccount(config.accounts, c).valid);
    lines.forEach((l, i) => {
      const d = decisions[i];
      if (d && d.origin !== "NINGUNA" && d.origin !== "HISTORIAL_DESCRIPCION") return;
      const hReciente = perfilReciente ? cuentaGastoHistorica(perfilReciente, l.description ?? "", valida) : null;
      const h = hReciente ?? cuentaGastoHistorica(perfilHistorico, l.description ?? "", valida);
      if (!h) return;
      if (hReciente) desdeReciente.add(i);
      const op = config.accounts.length ? resolveOperationalAccount(config.accounts, h.cuenta) : null;
      const code = op?.operationalAccount ?? h.cuenta;
      lines[i] = { ...l, account_code: code, account_name: op?.operational?.name ?? h.nombre };
      // Con la función de la empresa, solo hay confianza ALTA si el concepto coincide con compras
      // anteriores; la cuenta dominante del proveedor sin coincidencia de concepto pide validación.
      const debil = confianzaPorConcepto && !h.porConcepto;
      // Función «producto_del_historial»: si el proveedor suele causar esta cuenta con el nombre de un
      // producto del catálogo (en Siigo la descripción del renglón es el producto), se propone ese producto.
      let notaProducto = "";
      if (productoDelHistorial && h.descripcion) {
        const clave = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
        const prod = (config.products as ProductoCatalogo[]).find((p) => p.active !== false && clave(p.name) === clave(h.descripcion!));
        if (prod && lines[i]!.item_type !== "producto") {
          notaProducto = ` Producto ${prod.code} · ${prod.name} según el historial del proveedor; descripción original: «${String(l.description ?? "").trim()}».`;
          lines[i] = { ...lines[i]!, item_type: "producto", code: prod.code, description: prod.name };
        }
      }
      decisions[i] = {
        code,
        name: lines[i]!.account_name ?? "",
        origin: "HISTORIAL",
        reason: debil
          ? `Historial Siigo: el proveedor usó ${h.cuenta} en ${h.veces} de ${h.compras} compras, pero el concepto de este renglón no coincide con ninguna anterior. VALIDAR la cuenta.${notaProducto}`
          : h.motivo + notaProducto,
        confidence: debil ? "MEDIA" : "ALTA",
        score: debil ? 0.6 : 0.9,
        error: null,
      };
    });
  }
  // Función «producto_del_historial»: proveedores que en Siigo se causan con PRODUCTOS genéricos (p. ej. «Madera»,
  // «Pisos y cerámicas», «Tuberías», «Sanitarios»). Si por el historial el proveedor es de productos, cada renglón
  // con cuenta de gasto/costo pasa a tipo «producto» con el producto del catálogo: el que el proveedor suele usar
  // para esa cuenta o, si la cuenta tiene un único producto en el catálogo, ese. Corre aunque la cuenta la haya
  // resuelto el motor (antes solo cuando la resolvía el bloque del auxiliar y no se aplicaba a los demás renglones).
  if (funcionActiva(await nitDeEmpresa(companyId, config), "producto_del_historial")) {
    const clave = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const catalogoP = (config.products as ProductoCatalogo[]).filter((p) => p.active !== false);
    const habitual = (g: { descripciones?: Record<string, number> }) => Object.entries(g.descripciones ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const porNombre = (nombre: string | null) => {
      if (!nombre) return undefined;
      const n = clave(nombre);
      return catalogoP.find((p) => clave(p.name) === n);
    };
    const operativaDe = (c: string) => (config.accounts.length ? resolveOperationalAccount(config.accounts, c).operationalAccount ?? c : c);
    // ¿El historial del proveedor lo muestra causando con productos del catálogo?
    const proveedorDeProductos = !!perfilHistorico && perfilHistorico.gastos.some((g) => !!porNombre(habitual(g)));
    if (proveedorDeProductos) {
      lines.forEach((l, i) => {
        const cuenta = String(l.account_code ?? "").trim();
        if (!cuenta || l.item_type === "producto" || !isValidExpenseAccount(cuenta)) return;
        // 1) el producto con que el proveedor suele causar esa cuenta; 2) el único producto del catálogo de esa cuenta.
        const gasto = perfilHistorico!.gastos.find((g) => operativaDe(g.cuenta) === cuenta || g.cuenta === cuenta);
        let prod = gasto ? porNombre(habitual(gasto)) : undefined;
        if (!prod) {
          const deCuenta = catalogoP.filter((p) => p.account_code && operativaDe(String(p.account_code)) === cuenta);
          if (deCuenta.length === 1) prod = deCuenta[0];
        }
        if (!prod) return;
        const original = String(l.description ?? "").trim();
        lines[i] = { ...l, item_type: "producto", code: prod.code, description: prod.name };
        const d = decisions[i];
        if (d) decisions[i] = { ...d, reason: `${d.reason} Producto ${prod.code} · ${prod.name} según el historial del proveedor; descripción original: «${original}».` };
      });
    }
  }
  // Inventario (función por empresa "productos_inventario"): renglones de proveedores que
  // en el historial van a la 14, o cuya descripción coincide claramente con un producto
  // del catálogo, pasan a «producto» con su producto y su cuenta 14. Si el proveedor es de
  // inventario y no hay producto parecido, se propone crearlo en Siigo al causar.
  const nitEmpresa = await nitDeEmpresa(companyId, config);
  const inventario = funcionActiva(nitEmpresa, "productos_inventario");
  const productosNuevos: Record<number, ProductoNuevo> = {};
  if (inventario) {
    const catalogo = config.products as ProductoCatalogo[];
    const cuentas14 = (perfilHistorico?.gastos ?? []).filter((g) => /^14/.test(g.cuenta));
    const vecesInventario = cuentas14.reduce((s, g) => s + g.veces, 0);
    // Proveedor de inventario por historial, o confirmado por la usuaria (pregunta por correo).
    const confirmadoInventario = !!(provider as { purchase_tax_profile?: { es_inventario?: boolean } | null } | null)?.purchase_tax_profile?.es_inventario;
    // También cuando la usuaria ya le enseñó una regla con cuenta de inventario (14) a este proveedor.
    const nitProv = String(header.provider_nit ?? "").replace(/\D/g, "");
    const aprendidoInventario = !!nitProv && ((config.knowledge?.learning ?? []) as Array<{ active?: boolean; provider_nit?: string | null; account_code?: string }>).some((r) => r.active !== false && String(r.provider_nit ?? "").replace(/\D/g, "") === nitProv && /^14/.test(String(r.account_code ?? "")));
    const proveedorInventario = confirmadoInventario || aprendidoInventario || (!!perfilHistorico && vecesInventario > 0 && vecesInventario >= perfilHistorico.compras / 2);
    // Cuenta 14 de la empresa más usada (para productos sin cuenta propia ni precedente del proveedor).
    const cuenta14Empresa = (() => {
      const uso = new Map<string, number>();
      for (const p of perfilesHistoricos.values())
        for (const g of p.gastos) if (/^14/.test(g.cuenta)) uso.set(g.cuenta, (uso.get(g.cuenta) ?? 0) + g.veces);
      return [...uso].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    })();
    const operativa = (c: string | null | undefined) => {
      if (!c || !/^14\d+$/.test(c)) return null;
      const r = config.accounts.length ? resolveOperationalAccount(config.accounts, c) : null;
      return r ? (r.valid && r.operationalAccount ? { code: r.operationalAccount, name: r.operational?.name ?? null } : null) : { code: c, name: null };
    };
    // La cuenta 14 del proveedor que más se parece al renglón (1435 mercancías, 1498…).
    const cuenta14Proveedor = (descripcion: string) =>
      operativa(cuentaGastoHistorica(perfilHistorico, descripcion, (c) => /^14/.test(c))?.cuenta ?? cuentas14[0]?.cuenta);
    const usados = new Set(catalogo.map((p) => String(p.code ?? "").toLowerCase()));
    lines.forEach((l, i) => {
      const d = decisions[i];
      if (d?.origin === "REGLA") return; // la regla del proveedor manda
      const r = buscarProducto(l.description ?? "", catalogo, { codigo: l.code ?? null, tipos: ["producto", "servicio"] });
      // Un renglón que ya trae cuenta 14 (por regla aprendida o por historial) también se cruza con el catálogo.
      if (!r.elegido && !proveedorInventario && !/^14/.test(String(l.account_code ?? ""))) return;
      if (r.elegido) {
        const prod = r.elegido.producto;
        const cuenta =
          operativa(prod.account_code) ?? cuenta14Proveedor(l.description ?? "") ?? operativa(cuenta14Empresa);
        if (!cuenta) return;
        lines[i] = { ...l, item_type: prod.kind === "servicio" ? "servicio" : "producto", code: prod.code, account_code: cuenta.code, account_name: cuenta.name ?? prod.account_name ?? prod.name };
        decisions[i] = { code: cuenta.code, name: lines[i]!.account_name ?? "", origin: "PRODUCTO", reason: `Producto ${prod.code} · ${prod.name} (${r.elegido.motivo}).`, confidence: "ALTA", score: Math.max(0.8, r.elegido.puntaje), error: null };
        return;
      }
      // Proveedor de inventario sin producto parecido: se crea en Siigo al causar.
      const cuenta = cuenta14Proveedor(l.description ?? "") ?? operativa(cuenta14Empresa);
      if (!cuenta) return;
      const codigo = codigoProductoNuevo(l.description ?? "", usados);
      usados.add(codigo.toLowerCase());
      const grupo = r.candidatos[0]?.producto.category ?? null;
      productosNuevos[i] = { codigo, nombre: String(l.description ?? "").trim().slice(0, 100), tipo: "producto", grupo, cuenta: cuenta.code };
      lines[i] = { ...l, item_type: "producto", code: codigo, account_code: cuenta.code, account_name: cuenta.name ?? "Inventario" };
      decisions[i] = {
        code: cuenta.code,
        name: lines[i]!.account_name ?? "",
        origin: "PRODUCTO",
        reason: `Producto nuevo ${codigo}: no hay uno parecido en el catálogo; se creará en Siigo al causar${grupo ? ` (grupo ${grupo})` : ""}${confirmadoInventario || aprendidoInventario ? " (proveedor de inventario confirmado o enseñado por la usuaria)" : ""}.${r.candidatos.length ? ` Más parecidos: ${r.candidatos.slice(0, 3).map((c) => c.producto.name).join(" · ")}.` : ""}`,
        confidence: confirmadoInventario || aprendidoInventario ? "ALTA" : "MEDIA",
        score: confirmadoInventario || aprendidoInventario ? 0.9 : 0.7,
        error: null,
      };
    });
  }
  // Nivel de confianza del lote: manda la decisión más débil de la factura.
  const tomadas = Object.values(decisions);
  const peor = tomadas.sort((a, b) => a.score - b.score)[0];
  const score = tomadas.length === 0 ? 1 : (peor?.score ?? 0);
  const reason = tomadas.length === 0 ? "Cuentas tomadas del catálogo o del borrador." : (peor?.reason ?? "");
  const baseGravable = roundCOP(
    lines.reduce(
      (s, l) => s + roundCOP(l.subtotal ?? Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)),
      0,
    ),
  );
  const ivaLineas = roundCOP(lines.reduce((s, l) => s + roundCOP(l.iva), 0));
  const ivaTotal = roundCOP(header.iva);
  // Las retenciones salen ÚNICAMENTE de lo retenido en ESTA factura y se
  // resuelven desde cero por tipo (retefuente / reteiva / reteica). Una factura
  // sin retención no genera líneas 2365 / 2367 / 2368 ni valida esas cuentas.
  const retencionLineas = roundCOP(lines.reduce((s, l) => s + roundCOP(Number(l.retention || 0)), 0));
  const reportado = retencionesReportadas({
    header,
    lineRetention: retencionLineas,
    baseGravable,
    ivaTotal,
    taxes: config.taxes,
  });
  const resueltas = resolverRetenciones({
    reportado,
    baseGravable,
    ivaTotal,
    taxes: config.taxes,
    puc: config.accounts,
  });
  let { retenciones } = resueltas;
  const erroresRetencion = [...resueltas.errores];
  const alertas: string[] = [];
  // Regla del proveedor: la retención se calcula con SU cuenta, tarifa y base
  // (Subtotal o AIU). Si difiere de lo retenido en el documento, se alerta sin bloquear.
  const retRegla = retencionDesdeRegla(reglaProveedor, lines);
  if (retRegla) {
    // La regla define solo la Retefuente: la ReteIVA y la ReteICA que trae el documento se conservan.
    const conservaOtras = roundCOP(reportado.reteiva) > 0 || roundCOP(reportado.reteica) > 0;
    if (!conservaOtras) erroresRetencion.length = 0;
    retenciones = {
      retefuente: retRegla.amount,
      reteiva: conservaOtras ? retenciones.reteiva : 0,
      reteica: conservaOtras ? retenciones.reteica : 0,
      autorretencion: 0,
      detalle: [
        ...(conservaOtras ? (retenciones.detalle ?? []).filter((d) => d.kind === "reteiva" || d.kind === "reteica") : []),
        {
          kind: "retefuente",
          name: retRegla.name,
          rate: retRegla.rate,
          base: retRegla.base,
          amount: retRegla.amount,
          account_code: retRegla.account_code,
        },
      ],
    };
    const delDocumento = roundCOP(reportado.retefuente);
    if (delDocumento > 0 && Math.abs(delDocumento - retRegla.amount) >= 0.005) {
      alertas.push(
        `Retención difiere del documento: calculada $${retRegla.amount.toLocaleString("es-CO")}, documento $${delDocumento.toLocaleString("es-CO")}.`,
      );
    }
  }
  // Precedente tributario del proveedor (lo sincronizado con Siigo): IVA exacto
  // por renglón y retenciones que el documento no trae. La regla por proveedor y
  // lo retenido en el documento mandan sobre el precedente.
  const impuestos = impuestosPrevios;
  const precedente = precedenteDe(precedentesPrevios, header.provider_nit);
  // Precedente de IVA de toda la empresa (todos sus proveedores): se usa solo cuando el
  // proveedor no tiene precedente propio que decida el IVA del renglón.
  const precedenteIvaEmpresa = (() => {
    const usos = new Map<string, PrecedenteProveedor["iva"][number]>();
    for (const p of precedentesPrevios.values())
      for (const u of p.iva) {
        const k = u.taxId ?? `cuenta:${u.cuenta}`;
        const previo = usos.get(k);
        if (previo) previo.veces += u.veces;
        else usos.set(k, { ...u });
      }
    return {
      ...(precedente ?? { nit: "", documentosSiigo: 0, movimientosHistoricos: 0, comprasHistoricas: 0, retenciones: { retefuente: [], reteiva: [], reteica: [] }, sinRetencion: { retefuente: 0, reteiva: 0, reteica: 0 }, sinRetencionBaseMax: { retefuente: 0, reteiva: 0, reteica: 0 } }),
      iva: [...usos.values()].sort((a, b) => b.veces - a.veces),
    } as PrecedenteProveedor;
  })();

  // Retención que informa el documento sin tarifa configurada que coincida: se usa el
  // impuesto (o la cuenta) que el historial le aplica a este proveedor. Si el historial
  // muestra que NO se le retiene (bases iguales o mayores sin retención), el valor del
  // documento es informativo (p. ej. autorretenedor) y no se registra.
  for (const kind of RETENCIONES) {
    const det = (retenciones.detalle ?? []).find((d) => d.kind === kind && !d.account_code && Number(d.amount) > 0);
    if (!det) continue;
    const quitarError = () => {
      for (let i = erroresRetencion.length - 1; i >= 0; i--)
        if (erroresRetencion[i]!.includes("ninguna tarifa configurada coincide") || erroresRetencion[i]!.includes("revisar tarifa"))
          erroresRetencion.splice(i, 1);
    };
    const uso = precedente?.retenciones[kind].find((u) => u.taxId);
    const tax = uso ? impuestos.find((t) => String(t.id) === String(uso.taxId) && t.active !== false) : undefined;
    const cuentaHist = perfilHistorico?.retenciones[kind][0]?.cuenta ?? precedente?.retenciones[kind].find((u) => u.cuenta)?.cuenta ?? null;
    if (tax || cuentaHist) {
      const resolucion = tax
        ? resolveTaxAccount(tax as TaxRecord, config.accounts)
        : (() => {
            const r = config.accounts.length ? resolveOperationalAccount(config.accounts, cuentaHist!) : null;
            return { code: r?.valid && r.operationalAccount ? r.operationalAccount : cuentaHist!, name: r?.operational?.name ?? null, error: null as string | null };
          })();
      if (!resolucion.error && resolucion.code) {
        det.account_code = resolucion.code;
        det.name = resolucion.name ?? tax?.name ?? det.name;
        if (tax) det.rate = Number(tax.rate);
        quitarError();
        alertas.push(`${tax?.name ?? "Retención"}: valor del documento (${Number(det.amount).toLocaleString("es-CO")}) registrado en ${resolucion.code}, la cuenta que el historial le aplica al proveedor.`);
        continue;
      }
    }
    const baseSin = kind === "reteiva" ? ivaTotal : baseGravable;
    const sinHistorialDeRetencion = (precedente?.retenciones[kind].length ?? 0) === 0 && !(perfilHistorico?.retenciones[kind].length);
    const vecesSin = Math.max(precedente?.sinRetencion[kind] ?? 0, perfilHistorico?.sinRetencion[kind].veces ?? 0);
    const baseMaxSin = Math.max(precedente?.sinRetencionBaseMax[kind] ?? 0, perfilHistorico?.sinRetencion[kind].baseMax ?? 0);
    if (sinHistorialDeRetencion && vecesSin >= 1 && baseMaxSin >= baseSin) {
      retenciones = {
        ...retenciones,
        [kind]: roundCOP(Number(retenciones[kind] ?? 0) - Number(det.amount)),
        detalle: (retenciones.detalle ?? []).filter((d) => d !== det),
      };
      quitarError();
      alertas.push(`La factura informa ${kind} de ${Number(det.amount).toLocaleString("es-CO")}, que no coincide con ninguna tarifa; en Siigo nunca se le ha retenido a este proveedor (${vecesSin} compra(s) con bases de hasta ${baseMaxSin.toLocaleString("es-CO")}), así que no se registra.`);
    }
  }

  // Función por empresa "iva_solo_descontable": el IVA va siempre a una cuenta 2408.
  const soloDescontable = funcionActiva(await nitDeEmpresa(companyId, config), "iva_solo_descontable");
  const ivaPorLinea: DraftAccounting["ivaPorLinea"] = lines.map((l, i) => {
    const fijado = params.ivaFijado?.[i];
    const elegido = fijado ? impuestos.find((t) => String(t.id) === String(fijado)) : undefined;
    // Un IVA ya elegido que no es descontable (p. ej. 621008 IVA del costo) se reemplaza.
    if (elegido && (!soloDescontable || esIvaDescontable(elegido.account_code)))
      return { tax: elegido, motivo: "IVA seleccionado en el borrador." };
    const e = elegirIva({
      taxes: impuestos,
      linea: {
        iva: roundCOP(Number(l.iva || 0)),
        iva_rate: extracted[i]?.iva_rate ?? null,
        base: roundCOP(l.subtotal ?? Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)),
      },
      precedente,
      soloDescontable,
    });
    if (e.tax) return { tax: e.tax, motivo: e.motivo };
    // Sin precedente del proveedor: el IVA que más usa la empresa con esa tarifa (o que
    // cuadra al peso con el renglón cuando el documento no trae tarifa).
    const empresa = elegirIva({
      taxes: impuestos,
      linea: {
        iva: roundCOP(Number(l.iva || 0)),
        iva_rate: extracted[i]?.iva_rate ?? null,
        base: roundCOP(l.subtotal ?? Number(l.quantity || 0) * Number(l.unit_value || 0) - Number(l.discount || 0)),
      },
      precedente: precedenteIvaEmpresa,
      soloDescontable,
    });
    return empresa.tax
      ? { tax: empresa.tax, motivo: `${empresa.tax.name}: el IVA que más usa la empresa con esa tarifa (el proveedor no tiene precedente propio).` }
      : null;
  });
  let confirmarCondicion: string | null = null;
  {
    // Con regla por proveedor, la Retefuente ya está decidida: el precedente decide las demás.
    const decision = decidirRetenciones({
      kinds: RETENCIONES.filter((k) => !(roundCOP(reportado[k]) > 0) && !(retRegla && k === "retefuente")),
      precedente,
      condicion: condicionDePerfil((provider as { purchase_tax_profile?: unknown } | null)?.purchase_tax_profile),
      taxes: impuestos,
      baseGravable,
      ivaTotal,
      fecha: header.issue_date ?? null,
      tablas: config.tablasBases ?? (await cargarTablasBases()),
    });
    for (const r of decision.aplicar) {
      const cuenta = resolveTaxAccount(r.tax as TaxRecord, config.accounts);
      if (cuenta.error) erroresRetencion.push(cuenta.error);
      retenciones = {
        ...retenciones,
        [r.kind]: roundCOP(Number(retenciones[r.kind] ?? 0) + r.amount),
        detalle: [
          ...(retenciones.detalle ?? []),
          { kind: r.kind, name: cuenta.name ?? r.tax.name, rate: Number(r.tax.rate), base: r.base, amount: r.amount, account_code: cuenta.code || null },
        ],
      };
      alertas.push(`${r.tax.name}: ${r.amount.toLocaleString("es-CO")} sobre base ${r.base.toLocaleString("es-CO")}, por ${r.origen}.`);
    }
    alertas.push(...decision.avisos);
    confirmarCondicion = decision.confirmar;
    if (confirmarCondicion) alertas.push(`Confirmar condición del proveedor: ${confirmarCondicion}`);
  }
  // La empresa define si maneja centros de costo; si no, nunca se guarda ninguno.
  const costPolicy = config.batch ? config.batch.company.uses_cost_centers : await companyUsesCostCenters(companyId);
  // Sin centro de costo en el documento: el que el proveedor usa en sus compras de Siigo.
  const centroHistorico = !header.cost_center && costPolicy ? perfilHistorico?.centros[0]?.centro ?? null : null;
  const centroFactura = costCenterForCompany(costPolicy, header.cost_center || centroHistorico);
  if (centroHistorico && centroFactura) alertas.push(`Centro de costo ${centroFactura} tomado del historial del proveedor en Siigo.`);
  // Contrapartida: primero la cuenta CxP de la regla del proveedor; si no hay,
  // el histórico de esta empresa con este proveedor.
  const cxpAuxiliar = perfilHistorico?.cuentasPorPagar.find((c) => isPayableCode(c.cuenta)) ?? null;
  const payableHistorico = config.batch
    ? provider?.default_payable_account
      ? { code: provider.default_payable_account, name: null, source: "proveedor", confidence: 0.8 }
      : cxpAuxiliar
        ? applyPucToPayable(
            {
              code: cxpAuxiliar.cuenta,
              name: cxpAuxiliar.nombre,
              origin: "HISTORIAL",
              source: "historical",
              reason: `Cuenta por pagar usada en ${cxpAuxiliar.veces} compra(s) del proveedor en Siigo.`,
              confidence: 0.9,
            },
            config.accounts,
          )
        : { code: config.batch.company.default_payable_account || "22050501", name: null, source: "fallback", confidence: 0.4 }
    : applyPucToPayable(await fetchPayableAccount(companyId, header.provider_nit), config.accounts);
  const payable =
    reglaProveedor?.payable_account && isPayableCode(reglaProveedor.payable_account)
      ? { code: reglaProveedor.payable_account.trim(), name: null, source: "regla por proveedor", confidence: 1 }
      : payableHistorico;
  // Tratamiento contable del IVA: primero la regla del proveedor (descontable /
  // asumido / capitalizado / N-A); sin regla, la decisión por histórico de siempre.
  // Con "iva_solo_descontable": una regla del proveedor solo manda en el IVA si es una
  // decisión explícita (regla guardada) y, siendo descontable, con cuenta 2408; el
  // tratamiento por historial (asumido, costo) no se aplica: el IVA va al 2408.
  const reglaIva =
    soloDescontable && reglaProveedor
      ? !reglaProveedor.id
        ? null
        : reglaProveedor.iva_treatment === "descontable" && reglaProveedor.iva_account && !esIvaDescontable(reglaProveedor.iva_account)
          ? { ...reglaProveedor, iva_account: null }
          : reglaProveedor
      : reglaProveedor;
  const ivaDetalleRegla = reglaIva ? ivaDetalleDesdeRegla(reglaIva, lines, ivaTotal) : null;
  const ivaDecision =
    !ivaDetalleRegla && ivaTotal > 0 && !soloDescontable
      ? resolveIvaTreatment({
          config: await fetchIvaConfig(companyId),
          evidence: await evidenciaIvaDe(companyId, header.provider_nit),
          providerNit: header.provider_nit,
          expenseAccounts: [...new Set(lines.map((l) => String(l.account_code ?? "").trim()).filter(Boolean))],
          concepts: lines.map((l) => l.description ?? ""),
          puc: config.accounts,
          taxAccount: null,
        })
      : null;
  // El IVA que no es descontable se registra SIEMPRE como una línea independiente por el total.
  // IVA descontable: si cada renglón con IVA tiene su impuesto exacto, el asiento
  // sale con la cuenta de cada impuesto (igual que lo arma la revisión).
  const ivaPorImpuesto = (() => {
    if (!(ivaTotal > 0)) return undefined;
    const entradas = lines.flatMap((l, i) =>
      roundCOP(Number(l.iva || 0)) > 0 ? [{ tax: ivaPorLinea[i]?.tax ?? null, amount: roundCOP(Number(l.iva || 0)) }] : [],
    );
    if (!entradas.length || entradas.some((e) => !e.tax)) return undefined;
    const { groups, errors } = buildIvaGroups(entradas as never, config.accounts);
    if (errors.length || Math.abs(roundCOP(groups.reduce((s, g) => s + g.amount, 0)) - ivaTotal) > 0.01) return undefined;
    return groups.map((g) => ({ account_code: g.account_code, account_name: g.account_name, amount: g.amount }));
  })();
  let ivaDetalle =
    ivaDetalleRegla ??
    (ivaDecision && ivaDecision.treatment !== "descontable"
      ? applyIvaTreatment([{ account_code: "", account_name: "IVA", amount: ivaTotal }], ivaDecision)
      : ivaPorImpuesto);
  // "iva_solo_descontable": si el IVA quedó en una cuenta que no es 2408 (p. ej. porque el
  // único IVA configurado de esa tarifa es el «IVA general 19 %» → 621008), el asiento usa
  // la cuenta 2408 que el proveedor usa en Siigo, la más usada por la empresa o la del PUC.
  if (soloDescontable && ivaDetalle?.some((d) => d.amount && !esIvaDescontable(d.account_code))) {
    const operativa = (c: string | null | undefined) => {
      if (!c || !esIvaDescontable(c)) return null;
      const r = config.accounts.length ? resolveOperationalAccount(config.accounts, c) : null;
      return r ? (r.valid && r.operationalAccount ? { code: r.operationalAccount, name: r.operational?.name ?? null } : null) : { code: c, name: null };
    };
    const usoEmpresa = new Map<string, number>();
    for (const p of perfilesHistoricos.values()) for (const u of p.iva) if (esIvaDescontable(u.cuenta)) usoEmpresa.set(u.cuenta, (usoEmpresa.get(u.cuenta) ?? 0) + u.veces);
    const delPuc = config.accounts.find(
      (a) => esIvaDescontable(a.code) && /iva/i.test(String(a.name ?? "")) && /compra/i.test(String(a.name ?? "")) && resolveOperationalAccount(config.accounts, a.code).valid,
    )?.code;
    const cuenta2408 =
      operativa(perfilHistorico?.iva.find((u) => esIvaDescontable(u.cuenta))?.cuenta) ??
      operativa([...usoEmpresa].sort((a, b) => b[1] - a[1])[0]?.[0]) ??
      operativa(delPuc);
    if (cuenta2408) {
      ivaDetalle = ivaDetalle.map((d) => (d.amount && !esIvaDescontable(d.account_code) ? { ...d, account_code: cuenta2408.code, account_name: cuenta2408.name ?? "IVA descontable" } : d));
      alertas.push(`IVA descontable en ${cuenta2408.code}: el IVA configurado para esta tarifa no es 2408; revisa en Administración → Retenciones que exista un IVA con cuenta 2408.`);
    }
  }
  // Recargo global del documento: mayor valor de lo facturado en la cuenta del ítem principal.
  const recargo = roundCOP(Number((header as { surcharge?: number }).surcharge ?? 0));
  if (recargo > 0)
    alertas.push(`Recargo del documento de ${recargo.toLocaleString("es-CO")} pesos sumado a la cuenta del ítem de mayor valor.`);
  let journal = buildJournal({
    lines,
    recargo,
    permitirInventario: inventario,
    iva: ivaTotal,
    impoconsumo: Number(header.impoconsumo || 0),
    // Perfil de la empresa: el INC se suma al gasto/costo en lugar de causarse aparte.
    impoconsumoAlGasto: funcionActiva(await nitDeEmpresa(companyId, config), "impoconsumo_al_gasto"),
    retenciones,
    costCenter: centroFactura,
    ...(ivaDetalle !== undefined && ivaDetalle !== null ? { ivaDetalle } : {}),
    payableAccount: payable,
    // El impoconsumo va a la cuenta de la regla del proveedor o a la auxiliar
    // configurada, nunca a una cuenta mayor.
    impoconsumoAccount: reglaProveedor?.inc_account
      ? { code: reglaProveedor.inc_account, name: "Impuesto al consumo" }
      : resolveImpoconsumoAccount(config.taxes as never, config.accounts),
  });
  journal = alignJournalToSource(journal, captureSource({ ...header, lines: extracted }, "pdf"), sumCOP(retenciones.retefuente, retenciones.reteiva, retenciones.reteica));
  // Cuadre: diferencias de $1 o menos (centavos del XML o recargo global) van a
  // 42958101 Ajuste al peso; una diferencia mayor deja el borrador "No cuadra".
  const cuadre = totalesJournal(journal);
  const ajuste = ajusteAlPeso(cuadre.debito, cuadre.credito);
  if (ajuste.linea) journal.push({ ...ajuste.linea, cost_center: centroFactura ?? null });
  if (reglaProveedor?.id && !config.batch) void marcarUsoRegla(reglaProveedor.id);
  const unresolvedAccounts: string[] = lines.flatMap((l, i) => isValidPurchaseAccount(l.account_code, inventario) ? [] : [`Pendiente de cuenta: línea ${i + 1}.`]);
  unresolvedAccounts.push(...erroresRetencion);
  if (ajuste.descuadre)
    unresolvedAccounts.push(
      `No cuadra: la diferencia entre débitos y créditos es $${Math.abs(ajuste.descuadre).toLocaleString("es-CO")}, mayor a $1.`,
    );
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

  // Verificación con el precedente reciente: si la cuenta de gasto viene del historial del proveedor y su IVA y
  // retenciones coinciden con sus compras recientes, la confianza sube (cuenta, IVA y retenciones según proveedor).
  let scoreFinal = score;
  let reasonFinal = reason;
  let precedenteMotivo: string | null = null;
  if (!perfilRecienteBruto && config.perfilesRecientes && Object.values(decisions).some((d) => d.origin === "HISTORIAL"))
    precedenteMotivo = "el proveedor no tiene compras FC/DS desde abril en el auxiliar importado (su historial es anterior o usa otro tipo de comprobante)";
  if (!perfilReciente && perfilRecienteBruto && Object.values(decisions).some((d) => d.origin === "HISTORIAL"))
    precedenteMotivo = `precedente reciente insuficiente: ${perfilRecienteBruto.compras} compra(s) del proveedor desde abril (mínimo ${MIN_COMPRAS_RECIENTES})`;
  if (perfilReciente) {
    // Decisiones de historial (ALTA o MEDIA): el precedente reciente del proveedor las confirma o no.
    const candidatas = Object.entries(decisions).filter(([, d]) => d.origin === "HISTORIAL");
    const validaCuenta = (c: string) => isValidExpenseAccount(c) && (config.accounts.length === 0 || resolveOperationalAccount(config.accounts, c).valid);
    if (candidatas.length) {
      // Solo se compara el IVA que NO salió del propio proveedor: el elegido por su precedente, por una selección ya
      // hecha o por ser el único de la tarifa coincide por construcción; el genérico de la empresa sí se verifica.
      const cuentasIva = ivaPorLinea.flatMap((x, i) =>
        (lines[i]?.iva ?? 0) > 0 && (!x?.tax || /que más usa la empresa/i.test(x.motivo ?? ""))
          ? [x?.tax ? resolveTaxAccount(x.tax as TaxRecord, config.accounts).code || null : null]
          : [],
      );
      const dif = diferenciasConPrecedente(perfilReciente, {
        cuentasIva,
        hayIva: ivaTotal > 0,
        retenciones: { retefuente: Number(retenciones.retefuente) > 0, reteiva: Number(retenciones.reteiva) > 0, reteica: Number(retenciones.reteica) > 0 },
        baseRetencion: { retefuente: baseGravable, reteiva: ivaTotal, reteica: baseGravable },
        // Lo que la usuaria ya confirmó del proveedor (no se le retiene / se le retiene con X) manda sobre el historial.
        confirmadas: (() => {
          const c = condicionDePerfil((provider as { purchase_tax_profile?: unknown } | null)?.purchase_tax_profile);
          const kinds = ["retefuente", "reteiva", "reteica"] as const;
          return Object.fromEntries(kinds.map((k) => [k, !!(c?.sinRetencion?.[k] || c?.retenerCon?.[k])]));
        })(),
      });
      if (dif.length) {
        alertas.push(`Difiere del precedente reciente del proveedor: ${dif.join("; ")}.`);
        precedenteMotivo = `difiere del precedente reciente: ${dif.join("; ")}`;
      } else {
        for (const [k, d] of candidatas) {
          // La cuenta de la decisión debe ser la que el proveedor usa en sus compras recientes (≥ 80 % o por concepto).
          const hr = cuentaGastoHistorica(perfilReciente, lines[Number(k)]?.description ?? "", validaCuenta);
          const enReciente = !!hr && (hr.cuenta === d.code || String(d.code).startsWith(hr.cuenta) || hr.cuenta.startsWith(String(d.code)));
          if (!enReciente && !desdeReciente.has(Number(k))) {
            precedenteMotivo = hr
              ? `la cuenta ${d.code} no es la que el proveedor usa en sus compras recientes (usa ${hr.cuenta})`
              : `el proveedor no tiene una cuenta dominante en sus ${perfilReciente.compras} compras recientes (la cuenta ${d.code} queda por validar)`;
            continue;
          }
          decisions[Number(k)] = { ...d, confidence: "ALTA", score: Math.max(d.score, 0.95), reason: `${d.reason} Verificado con ${perfilReciente.compras} compra(s) recientes del proveedor: cuenta, IVA y retenciones coinciden.` };
        }
        const todas = Object.values(decisions);
        scoreFinal = todas.length === 0 ? 1 : Math.min(...todas.map((d) => d.score));
        reasonFinal = todas.sort((a, b) => a.score - b.score)[0]?.reason ?? reason;
      }
    }
  }

  return {
    productosNuevos,
    lines,
    journal: operationalJournal,
    payable,
    retenciones: retenciones as DraftAccounting["retenciones"],
    baseGravable,
    ivaTotal,
    centroFactura,
    costCentersEnabled: costCentersEnabled(costPolicy),
    score: scoreFinal,
    reason: reasonFinal,
    unresolvedAccounts,
    alertas,
    decisions,
    ivaPorLinea,
    confirmarCondicion,
    precedenteMotivo,
  };
}

/**
 * Recalcula las cuentas de un borrador existente con el motor actual (reglas
 * por proveedor, aprendizaje, histórico) sin borrar sus datos: conserva la
 * extracción original (raw_extraction.ia) y reemplaza solo el comprobante
 * contable y la CxP sugerida. Devuelve el motivo/alertas del nuevo cálculo.
 */
/**
 * Recalcula TODOS los borradores de compra de la empresa (estado Borrador o Error, sin
 * documento en Siigo) con el conocimiento actual: se usa al terminar de aprender del
 * auxiliar histórico. Respeta lo manual (cuentas, IVA elegido, cuenta por pagar) y no
 * toca lo aprobado, causado ni sincronizado.
 */
export async function recalcularBorradoresEmpresa(
  companyId: string,
  config: BulkConfig,
  onAvance?: (hechas: number, total: number) => void,
): Promise<{ total: number; ok: number; fallidas: Array<{ id: string; message: string }> }> {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("invoices")
      .select("id")
      .eq("company_id", companyId)
      .eq("doc_kind", "compra")
      .in("status", ["borrador", "error"])
      .is("siigo_id", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ id: string }>;
    ids.push(...page.map((r) => r.id));
    if (page.length < 1000) break;
  }
  let hechas = 0;
  let ok = 0;
  const fallidas: Array<{ id: string; message: string }> = [];
  onAvance?.(0, ids.length);
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(
      ids.slice(i, i + 5).map(async (id) => {
        try {
          const r = await recalcularCuentasBorrador(id, config);
          if (r.ok) ok += 1;
          else fallidas.push({ id, message: r.message });
        } catch (e) {
          fallidas.push({ id, message: e instanceof Error ? e.message : String(e) });
        } finally {
          hechas += 1;
          onAvance?.(hechas, ids.length);
        }
      }),
    );
  }
  return { total: ids.length, ok, fallidas };
}

export async function recalcularCuentasBorrador(
  invoiceId: string,
  config: BulkConfig,
): Promise<{ ok: boolean; message: string; needsReview?: boolean }> {
  const { data: inv, error } = await supabase
    .from("invoices")
    .select("id, company_id, status, raw_extraction, source_override, payable_manual, payable_account")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!inv) return { ok: false, message: "La factura no existe." };
  if (inv.status !== "borrador" && inv.status !== "error")
    return { ok: false, message: "Solo se pueden recalcular facturas en borrador." };
  const raw = (inv.raw_extraction ?? null) as { ia?: ExtractedInvoice } | null;
  let data = raw?.ia;
  if (!data || !Array.isArray(data.lines))
    return { ok: false, message: "Esta factura no conserva la extracción original; no se puede recalcular." };

  let source = (inv.source_override as ReturnType<typeof sourceFromRaw>) ?? sourceFromRaw(raw);
  // Función por empresa "cargos_en_items": un borrador que aún tiene INC, recargo o descuento
  // global se normaliza con la corrección autorizada (queda en el historial de cambios con
  // su motivo), igual que la corrección manual.
  let normalizado: string | null = null;
  // Todas las empresas: el recargo y el descuento global pasan a los ítems; el INC solo con «cargos_en_items».
  if (source) {
    const incluirInc = funcionActiva(await nitDeEmpresa(inv.company_id as string, config), "cargos_en_items");
    const n = repartoDeFuente(source, { incluirInc });
    if (n) {
      const motivo = motivoReparto(n.reparto);
      const { error: corrErr } = await supabase.rpc("correct_invoice_source_values", {
        _invoice_id: invoiceId,
        _values: n.valores as never,
        _reason: motivo,
      });
      if (corrErr) return { ok: false, message: `No se pudo repartir INC/recargo/descuento en los ítems: ${corrErr.message}` };
      source = n.valores;
      normalizado = motivo;
    }
  }
  // Cuadre del IVA de los renglones leídos (igual que al guardar): si el encabezado cuadra y una sola combinación
  // de tarifas explica el IVA del documento, se corrigen los IVA de los renglones y el valor de origen.
  let cuadreIva: string | null = null;
  {
    // Se evalúa sobre los valores de ORIGEN vigentes (incluida una corrección anterior), no sobre la lectura original:
    // si el IVA de los renglones de origen ya suma el del encabezado no se toca nada (el recálculo es estable).
    const base = source
      ? {
          ...data,
          subtotal: source.subtotal / 100,
          discount: source.discount / 100,
          surcharge: source.surcharge / 100,
          iva: source.iva / 100,
          impoconsumo: source.impoconsumo / 100,
          total: source.total / 100,
          lines: data.lines.map((l, i) => ({
            ...l,
            subtotal: (source!.lines[i]?.subtotal ?? 0) / 100,
            total: (source!.lines[i]?.subtotal ?? 0) / 100,
            iva: (source!.lines[i]?.iva ?? 0) / 100,
            iva_rate: source!.lines[i]?.iva_rate ?? l.iva_rate ?? null,
          })),
        }
      : data;
    const cuadre = cuadrarIvaDeLineas({ ...base, surcharge: base.surcharge ?? 0, lines: base.lines.map((l) => ({ ...l, subtotal: l.subtotal ?? l.total })) });
    if (cuadre) {
      let aplicado = true;
      if (source) {
        const valores = { ...source, lines: source.lines.map((l, i) => ({ ...l, iva: Math.round((cuadre.data.lines[i]?.iva ?? l.iva / 100) * 100), iva_rate: cuadre.data.lines[i]?.iva_rate ?? l.iva_rate, iva_base: Math.round((cuadre.data.lines[i]?.iva_base ?? (l.iva_base ?? 0) / 100) * 100) })) };
        const { error: corrErr } = await supabase.rpc("correct_invoice_source_values", { _invoice_id: invoiceId, _values: valores as never, _reason: cuadre.motivo });
        if (corrErr) aplicado = false;
        else source = valores;
      }
      if (aplicado) {
        data = { ...data, lines: data.lines.map((l, i) => ({ ...l, iva: cuadre.data.lines[i]!.iva, iva_rate: cuadre.data.lines[i]!.iva_rate ?? 0, iva_base: cuadre.data.lines[i]!.iva_base ?? 0 })) };
        cuadreIva = cuadre.motivo;
      }
    }
  }
  // Si el IVA de los renglones sigue sin cuadrar, el motivo dice por qué (para el semáforo del piloto y la revisión).
  const motivoIva = cuadreIva
    ? null
    : diagnosticarIva(
        source
          ? {
              subtotal: source.subtotal / 100,
              discount: source.discount / 100,
              surcharge: source.surcharge / 100,
              iva: source.iva / 100,
              impoconsumo: source.impoconsumo / 100,
              total: source.total / 100,
              lines: source.lines.map((l) => ({ total: l.subtotal / 100, subtotal: l.subtotal / 100, iva: l.iva / 100, iva_rate: l.iva_rate })),
            }
          : { ...data, surcharge: data.surcharge ?? 0, lines: data.lines.map((l) => ({ ...l, subtotal: l.subtotal ?? l.total })) },
      );
  const fuente = source;
  if (fuente) data = { ...data, subtotal: fuente.subtotal / 100, iva: fuente.iva / 100, impoconsumo: fuente.impoconsumo / 100, total: fuente.total / 100, discount: fuente.discount / 100, surcharge: fuente.surcharge / 100, lines: data.lines.map((l, i) => ({ ...l, iva: fuente.lines[i] ? fuente.lines[i]!.iva / 100 : l.iva, iva_rate: fuente.lines[i]?.iva_rate ?? l.iva_rate ?? 0, iva_base: fuente.lines[i]?.iva_base != null ? fuente.lines[i]!.iva_base! / 100 : l.iva_base ?? 0, subtotal: (fuente.lines[i]?.subtotal ?? 0) / 100, total: (fuente.lines[i]?.subtotal ?? 0) / 100, impoconsumo: (fuente.lines[i]?.impoconsumo ?? Math.round(Number(l.impoconsumo || 0) * 100)) / 100, discount: fuente.source === "excel" ? 0 : l.discount })) };
  const { lines, ...header } = data;
  // Las cuentas elegidas manualmente por el usuario nunca se recalculan.
  const manuales = Object.entries(((raw as Record<string, unknown> | null)?.["account_decisions"] ?? {}) as Record<string, { code?: string; origin?: string; itemType?: string; productCode?: string; productName?: string }>)
    .filter(([, d]) => d?.origin === "MANUAL" && d.code);
  // El IVA ya elegido en cada renglón se respeta; los que no tienen se resuelven con el precedente.
  const { data: ivaActual } = await supabase
    .from("invoice_lines")
    .select("position, iva_tax_id, account_code, account_name, item_type, code")
    .eq("invoice_id", invoiceId)
    .order("position");
  const ivaFijado = lines.map((_, i) => (ivaActual ?? []).find((l) => l.position === i)?.iva_tax_id ?? null);
  const acc = await computeDraftAccounting({
    companyId: inv.company_id as string,
    config,
    header,
    extracted: lines,
    ivaFijado,
  });

  for (const [k, d] of manuales) {
    const i = Number(k);
    const anterior = acc.lines[i]?.account_code;
    if (!acc.lines[i] || !d.code || anterior === d.code) continue;
    // Cuenta manual de gasto: el renglón vuelve a «gasto» y no se crea producto en Siigo.
    // Si la usuaria clasificó el renglón como PRODUCTO (con su producto del catálogo), esa clasificación se conserva.
    const comoProducto = d.itemType === "producto" && !!d.productCode;
    const manualGasto = !/^14/.test(d.code) && !comoProducto;
    acc.lines[i] = {
      ...acc.lines[i]!,
      account_code: d.code,
      account_name: (d as { name?: string }).name ?? acc.lines[i]!.account_name ?? null,
      ...(manualGasto && acc.lines[i]!.item_type === "producto" ? { item_type: "gasto" } : {}),
      ...(comoProducto ? { item_type: "producto", code: d.productCode!, ...(d.productName ? { description: d.productName } : {}) } : {}),
    };
    if (manualGasto || comoProducto) delete acc.productosNuevos[i];
    acc.decisions[i] = d as never;
    const j = acc.journal.find((x) => x.account_code === anterior && x.debit > 0);
    if (j) { j.account_code = d.code; j.account_name = (d as { name?: string }).name ?? j.account_name; }
  }
  // Estabilidad: una cuenta ya asignada (por precedente, producto, regla o elección) NO se cambia sola. Solo se
  // reemplaza si la nueva decisión es válida y de confianza igual o mayor; nunca por una pendiente o más débil.
  {
    const rango = (c?: string) => (String(c ?? "").toUpperCase() === "ALTA" ? 3 : String(c ?? "").toUpperCase() === "MEDIA" ? 2 : 1);
    const previas = ((raw as Record<string, unknown> | null)?.["account_decisions"] ?? {}) as Record<string, { confidence?: string; code?: string }>;
    const inventarioEmpresa = funcionActiva(await nitDeEmpresa(inv.company_id as string, config), "productos_inventario");
    for (const l of ivaActual ?? []) {
      const i = Number(l.position);
      const actual = acc.lines[i];
      const E = String(l.account_code ?? "").trim();
      if (!actual || !E || !isValidPurchaseAccount(E, inventarioEmpresa)) continue;
      if (manuales.some(([k]) => Number(k) === i)) continue;
      const N = String(actual.account_code ?? "").trim();
      const previa = previas[String(i)];
      const nuevaDec = acc.decisions[i];
      const nuevaValida = !!N && isValidPurchaseAccount(N, inventarioEmpresa);
      const conservar = !nuevaValida || (N !== E && rango(nuevaDec?.confidence) < rango(previa?.confidence ?? "ALTA"));
      if (!conservar || N === E) continue;
      acc.lines[i] = { ...actual, account_code: E, account_name: (l.account_name as string | null) ?? actual.account_name ?? null, item_type: ((l.item_type as string | null) ?? actual.item_type ?? "gasto") as never, ...(l.code ? { code: l.code as string } : {}) };
      delete acc.productosNuevos[i];
      if (previa) acc.decisions[i] = { ...(previa as Record<string, unknown>), code: E } as never;
      const j = acc.journal.find((x) => x.account_code === N && x.debit > 0);
      if (j) { j.account_code = E; j.account_name = (l.account_name as string | null) ?? j.account_name; }
    }
  }
  if (inv.payable_manual && inv.payable_account) {
    acc.journal = acc.journal.map((j) => isPayableCode(j.account_code) && j.credit > 0 ? { ...j, account_code: inv.payable_account ?? j.account_code } : j);
  }
  // La CxP manual del usuario manda: el recálculo no la pisa.
  const payablePatch = inv.payable_manual
    ? {}
    : {
        payable_account: acc.payable.code,
        payable_suggested: acc.payable.code,
        payable_source: acc.payable.source,
        payable_confidence: acc.payable.confidence,
        payable_updated_at: new Date().toISOString(),
      };

  const { error: upErr } = await supabase
    .from("invoices")
    .update({
      cost_center: acc.centroFactura,
      retefuente: roundCOP(acc.retenciones.retefuente),
      reteiva: roundCOP(acc.retenciones.reteiva),
      reteica: roundCOP(acc.retenciones.reteica),
      ...(source ? { subtotal: source.subtotal / 100, iva: source.iva / 100, impoconsumo: source.impoconsumo / 100, total: source.total / 100, discount: source.discount / 100 } : {}),
      raw_extraction: { ...raw, account_decisions: acc.decisions, productos_nuevos: acc.productosNuevos, motor_version: MOTOR_VERSION } as never,
      ...payablePatch,
      ...(cuadreIva ? { posting_error: null } : {}),
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", invoiceId);
  if (upErr) return { ok: false, message: upErr.message };

  await supabase.from("journal_lines").delete().eq("invoice_id", invoiceId);
  const { error: insErr } = await supabase.from("journal_lines").insert(
    acc.journal.map((j, i) => ({
      invoice_id: invoiceId,
      company_id: inv.company_id as string,
      account_code: j.account_code,
      account_name: j.account_name,
      debit: roundCOP(j.debit),
      credit: roundCOP(j.credit),
      cost_center: acc.costCentersEnabled ? (j.cost_center ?? null) : null,
      position: i,
    })),
  );
  if (insErr) return { ok: false, message: insErr.message };

  // Las cuentas sugeridas por línea también se refrescan (sin tocar valores).
  const { data: lineasDb } = await supabase
    .from("invoice_lines")
    .select("id, position, iva_tax_id")
    .eq("invoice_id", invoiceId)
    .order("position");
  for (const l of lineasDb ?? []) {
    const nueva = acc.lines[l.position as number];
    if (!nueva) continue;
    // IVA del precedente solo en renglones que aún no lo tienen elegido.
    const ivaNuevo = !l.iva_tax_id ? (acc.ivaPorLinea[l.position as number]?.tax as TaxRecord | undefined) : undefined;
    const ivaTrace = ivaNuevo ? taxTrace(ivaNuevo, resolveTaxAccount(ivaNuevo, config.accounts).code || null) : null;
    await supabase
      .from("invoice_lines")
      .update({
        account_code: nueva.account_code,
        account_name: nueva.account_name ?? null,
        // Tipo y producto del catálogo (inventario) también se refrescan.
        item_type: nueva.item_type ?? "gasto",
        ...(nueva.item_type === "producto" || nueva.item_type === "servicio" ? { code: nueva.code ?? null } : {}),
        ...(source ? { total: nueva.subtotal ?? nueva.total, iva: nueva.iva, impoconsumo: nueva.impoconsumo } : {}),
        ...(ivaTrace
          ? {
              iva_tax_id: ivaTrace.tax_id,
              iva_tax_name: ivaTrace.tax_name,
              iva_tax_rate: ivaTrace.tax_rate,
              iva_account_code: ivaTrace.account_code,
              iva_operational_account: ivaTrace.operational_account,
              iva_siigo_id: ivaTrace.siigo_id,
              iva_siigo_name: ivaTrace.siigo_name,
            }
          : {}),
      } as never)
      .eq("id", l.id);
  }

  const motivo = [normalizado, cuadreIva, motivoIva, acc.reason, ...acc.unresolvedAccounts, ...acc.alertas].filter(Boolean).join(" ");
  // Mismo criterio que al guardar la factura, pero con las decisiones finales (incluidas las manuales).
  // Para el piloto: necesita revisión si algún renglón no tiene cuenta, la decisión no es de confianza ALTA
  // (precedente del proveedor, regla o producto) o hay una condición del proveedor por confirmar.
  const dudosa = Object.values(acc.decisions as Record<string, { confidence?: string } | undefined>).some((d) => !!d?.confidence && String(d.confidence).toUpperCase() !== "ALTA");
  const sinCuenta = acc.lines.some((l) => !l.account_code);
  // La causa va primero para que el reporte diga POR QUÉ necesita revisión.
  const causas = [
    sinCuenta ? "hay renglones sin cuenta de gasto/costo" : "",
    dudosa ? `${Object.values(acc.decisions as Record<string, { confidence?: string } | undefined>).filter((d) => !!d?.confidence && String(d.confidence).toUpperCase() !== "ALTA").length} renglón(es) con cuenta de confianza media/baja` : "",
    acc.confirmarCondicion ? `confirmar condición del proveedor (${acc.confirmarCondicion})` : "",
    acc.precedenteMotivo ? `precedente: ${acc.precedenteMotivo}` : "",
  ].filter(Boolean);
  const necesitaRevision = dudosa || sinCuenta || !!acc.confirmarCondicion;
  const mensajeFinal = (causas.length ? `${causas.join("; ")} — ` : "") + (motivo || "Cuentas recalculadas.");
  // La marca de la tarea de la carga masiva sigue al recálculo (también el manual desde Borradores): el semáforo
  // del piloto la lee y debe reflejar el estado actual del borrador.
  await supabase
    .from("bulk_upload_items")
    .update({ needs_review: necesitaRevision, user_message: necesitaRevision ? mensajeFinal.slice(0, 700) : null } as never)
    .eq("invoice_id", invoiceId)
    .eq("status", "completed");
  return {
    ok: true,
    message: mensajeFinal,
    needsReview: necesitaRevision,
  };
}

export async function saveExtractedInvoice(params: {
  data: ExtractedInvoice;
  fileName: string;
  /** Archivo original a conservar en Storage (PDF). El Excel no adjunta archivo. */
  file?: File | null;
  companyId: string;
  config: BulkConfig;
  knowledge?: CompanyKnowledge | undefined;
  storagePath?: string | null | undefined;
  readMode: "texto" | "imagen";
  texto?: string;
  /** Trazabilidad adicional para raw_extraction (por ejemplo la fila del Excel). */
  rawExtraction?: Record<string, unknown>;
  onStage?: StageCallback | undefined;
}): Promise<ProcessedInvoice> {
  // Función por empresa "cargos_en_items": INC, recargo y descuento global del documento se
  // reparten en los ítems antes de guardar (la nota crédito se revisa igual, más abajo).
  // Cuadre del IVA de los renglones leídos: si el encabezado cuadra y una sola combinación de tarifas explica su IVA,
  // se corrigen los IVA de los renglones (la IA a veces los lee mal) para que la factura cuadre con el documento.
  {
    const cuadre = cuadrarIvaDeLineas({ ...params.data, surcharge: params.data.surcharge ?? 0, lines: params.data.lines.map((l) => ({ ...l, subtotal: l.subtotal ?? l.total })) });
    if (cuadre)
      params = {
        ...params,
        data: { ...params.data, lines: params.data.lines.map((l, i) => ({ ...l, iva: cuadre.data.lines[i]!.iva, iva_rate: cuadre.data.lines[i]!.iva_rate ?? 0, iva_base: cuadre.data.lines[i]!.iva_base ?? 0 })) },
        rawExtraction: { ...(params.rawExtraction ?? {}), cuadre_iva: cuadre.motivo },
      };
  }
  // Todas las empresas: recargo y descuento global van a los ítems; el INC solo con «cargos_en_items» (LED).
  {
    const incluirInc = funcionActiva(await nitDeEmpresa(params.companyId, params.config), "cargos_en_items");
    const d = params.data;
    const reparto = repartirCargos(
      { subtotal: d.subtotal, iva: d.iva, impoconsumo: d.impoconsumo, discount: d.discount, surcharge: d.surcharge ?? 0, total: d.total },
      d.lines.map((l) => ({ subtotal: l.subtotal ?? l.total, iva: l.iva, impoconsumo: l.impoconsumo })),
      { incluirInc },
    );
    if (reparto)
      params = {
        ...params,
        data: aplicarRepartoExtraido(d as ExtractedInvoice & { surcharge: number }, reparto),
        rawExtraction: { ...(params.rawExtraction ?? {}), cargos_en_items: { ...reparto.detalle, ajustes: reparto.ajustes, motivo: motivoReparto(reparto) } },
      };
  }
  const { companyId, config } = params;
  const fileName = params.fileName;
  const { lines: extracted, ...header } = params.data;
  const textoDocumento = params.texto ?? "";

  const trace: InvoiceReadTrace = {
    providerName: header.provider_name ?? null,
    providerNit: header.provider_nit ?? null,
    buyerName: header.buyer_name ?? null,
    buyerNit: header.buyer_nit ?? null,
    invoiceNumber: [header.prefix, header.number].filter(Boolean).join("-") || null,
    issueDate: header.issue_date ?? null,
    text: textoDocumento ? textoDocumento.slice(0, 20000) : null,
    readMode: params.readMode,
  };
  await params.onStage?.("validating_company", trace);

  // Cada factura del ZIP se valida individualmente: si el NIT del comprador no es el de la
  // empresa activa (o no se pudo leer), se rechaza y NO se crea borrador.
  const empresa = config.batch?.company ?? (await supabase
    .from("companies").select("id, name, nit").eq("id", companyId).maybeSingle()).data;

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
  // Una nota crédito nunca se causa ni se envía a Siigo: se registra manualmente en Siigo
  // sobre la factura de compra ya causada (la API de Siigo no crea notas crédito de compra).
  if (
    pareceNotaCredito({
      documentType: header.document_type ?? null,
      texto: textoDocumento,
      archivo: fileName,
      total: header.total,
      tipoDocumento: typeof params.rawExtraction?.["tipo_documento"] === "string" ? params.rawExtraction["tipo_documento"] : null,
    })
  ) {
    const referida = facturaReferidaEnValor(header.referenced_invoice) ?? facturaReferidaEnTexto(header.referenced_invoice) ?? facturaReferidaEnTexto(header.notes) ?? facturaReferidaEnTexto(textoDocumento);
    const estado = await estadoFacturaAfectada(supabase, companyId, header.provider_nit, referida);
    throw new BulkInvoiceStageError(
      mensajeNotaCredito({ numero: trace.invoiceNumber, proveedor: header.provider_name, nit: header.provider_nit, total: header.total, estado }),
      "validating_company",
      trace,
      true,
    );
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
  if (existente) {
    if (header.cufe) {
      const previous = await supabase.from("invoices").select("raw_extraction").eq("id", existente.id).maybeSingle();
      const original = sourceFromRaw(previous.data?.raw_extraction);
      if (original?.source === "excel" && params.rawExtraction?.["fuente"] !== "excel_recibidos") {
        const current = captureSource(params.data, "pdf");
        const differences = (["subtotal", "iva", "impoconsumo", "total"] as const).filter(field => current[field] !== original[field]).map(field => `${field}: Excel ${(original[field] / 100).toFixed(2)}, PDF ${(current[field] / 100).toFixed(2)}`);
        if (differences.length) throw new Error(`El mismo CUFE ya está en Excel. Diferencia con la fuente: ${differences.join("; ")}`);
      }
    }
    throw new Error(mensajeDuplicado(existente));
  }

  const acc = await computeDraftAccounting({
    companyId,
    config,
    header,
    extracted,
    knowledge: params.knowledge,
  });
  const { lines, baseGravable, ivaTotal, retenciones, centroFactura, payable, score, reason } = acc;
  const valoresOrigen = captureSource(params.data, params.rawExtraction?.["fuente"] === "excel_recibidos" ? "excel" : "pdf");
  const sourceProblems = sourceErrors(valoresOrigen);
  const unresolvedAccounts = [...acc.unresolvedAccounts, ...sourceProblems];
  const alertas = [...acc.alertas];
  const operationalJournal = acc.journal;

  const userId = config.batch?.userId ?? (await supabase.auth.getUser()).data.user?.id;
  let filePath: string | null = params.storagePath ?? null;
  if (!filePath && userId && params.file) {
    const path = `${userId}/${companyId}/${Date.now()}-${fileName.replace(/[^\w.-]/g, "_")}`;
    const { error: upErr } = await supabase.storage.from("facturas").upload(path, params.file);
    if (!upErr) filePath = path;
  }

  if (header.provider_nit && !config.batch) {
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

  const total = roundCOP(header.total);
  const invoiceRow = {
      id: crypto.randomUUID(),
      created_by: userId,
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
      subtotal: roundCOP(header.subtotal),
      discount: roundCOP(header.discount),
      iva: ivaTotal,
      impoconsumo: roundCOP(header.impoconsumo),
      retefuente: roundCOP(retenciones.retefuente),
      reteiva: roundCOP(retenciones.reteiva),
      reteica: roundCOP(retenciones.reteica),
      total,
      posting_error: sourceProblems.length ? (valoresOrigen.source === "pdf" ? "Revisar lectura del PDF. " : "") + sourceProblems.join(" ") : null,
      status: "borrador",
      dian_status: header.cufe ? "con CUFE" : "sin CUFE",
      // Cuenta por pagar asignada automáticamente por NIT + histórico contable.
      payable_account: payable.code,
      payable_suggested: payable.code,
      payable_source: payable.source,
      payable_manual: false,
      payable_confidence: payable.confidence,
      payable_updated_at: new Date().toISOString(),
      file_path: filePath,
      file_name: fileName,
      // Trazabilidad de lectura: lo que devolvió la IA (o el adaptador Excel) y el texto extraído.
      raw_extraction: {
        ia: params.data,
        valores_origen: valoresOrigen,
        source_errors: sourceProblems,
        account_decisions: acc.decisions,
        productos_nuevos: acc.productosNuevos,
        lectura: params.readMode,
        texto: textoDocumento ? textoDocumento.slice(0, 20000) : null,
        archivo: fileName,
        motor_version: MOTOR_VERSION,
        ...(params.rawExtraction ?? {}),
      } as never,
    };
  const lineRows = lines.map((l, i) => ({
        invoice_id: invoiceRow.id,
        company_id: companyId,
        code: l.code ?? null,
        description: l.description,
        quantity: Number(l.quantity || 0),
        unit_value: l.unit_value,
        discount: roundCOP(l.discount),
        iva: roundCOP(l.iva),
        retention: roundCOP(l.retention),
        impoconsumo: roundCOP(l.impoconsumo),
        total: roundCOP(l.subtotal ?? l.total),
        account_code: l.account_code ?? null,
        account_name: l.account_name ?? null,
        item_type: l.item_type ?? "gasto",
        position: i,
        ...(() => {
          // IVA exacto: tarifa del documento + precedente del proveedor en Siigo.
          const tax = acc.ivaPorLinea[i]?.tax as TaxRecord | undefined;
          if (!tax) return {};
          const trace = taxTrace(tax, resolveTaxAccount(tax, config.accounts).code || null);
          return {
            iva_tax_id: trace.tax_id, iva_tax_name: trace.tax_name, iva_tax_rate: trace.tax_rate,
            iva_account_code: trace.account_code, iva_operational_account: trace.operational_account,
            iva_siigo_id: trace.siigo_id, iva_siigo_name: trace.siigo_name,
          };
        })(),
      }));
  const journalRows = operationalJournal.map((j, i) => ({
        invoice_id: invoiceRow.id,
        company_id: companyId,
        account_code: j.account_code,
        account_name: j.account_name,
        debit: roundCOP(j.debit),
        credit: roundCOP(j.credit),
        cost_center: acc.costCentersEnabled ? (j.cost_center ?? null) : null,
        position: i,
      }));
  if (config.batch) {
    await enqueueDraft({ invoice: invoiceRow, lines: lineRows, journal: journalRows });
  } else {
    const { error } = await supabase.from("invoices").insert(invoiceRow as never);
    if (error) throw error;
    const results = await Promise.all([supabase.from("invoice_lines").insert(lineRows), supabase.from("journal_lines").insert(journalRows)]);
    for (const result of results) if (result.error) throw result.error;
  }

  return {
    invoiceId: invoiceRow.id,
    numero: [header.prefix, header.number].filter(Boolean).join("-") || fileName,
    total,
    score,
    // 95% o más: automática. 80–94%: sugerida y marcada para revisión. Menos de 80%: revisión obligatoria.
    // Empresas con precedente reciente (perfil «precedenteDesde»): la marca depende de la confianza real de cada
    // cuenta (ALTA = precedente del proveedor, regla o producto), igual que en el recálculo del piloto.
    needsReview: config.perfilesRecientes
      ? Object.values(acc.decisions).some((d) => !!d?.confidence && String(d.confidence).toUpperCase() !== "ALTA") || unresolvedAccounts.length > 0 || !!acc.confirmarCondicion
      : score < 0.95 || unresolvedAccounts.length > 0 || !!acc.confirmarCondicion,
    reason: [
      reason,
      ...unresolvedAccounts,
      // Alertas informativas (retención difiere del documento, etc.): no bloquean.
      ...alertas,
    ]
      .filter(Boolean)
      .join(" "),
    providerName: header.provider_name ?? null,
    providerNit: header.provider_nit ?? null,
    buyerName: header.buyer_name ?? null,
    buyerNit: header.buyer_nit ?? null,
    issueDate: header.issue_date || null,
    readMode: params.readMode,
  };
}

// Batch writes are isolated by company; callers resolve only after all child rows are stored.
type PendingDraft = { invoice: Record<string, unknown>; lines: Record<string, unknown>[]; journal: Record<string, unknown>[] };
const draftQueues = new Map<string, { rows: { draft: PendingDraft; resolve: () => void; reject: (error: unknown) => void }[]; timer: ReturnType<typeof setTimeout> }>();
function enqueueDraft(draft: PendingDraft): Promise<void> {
  return new Promise((resolve, reject) => {
    const company = String(draft.invoice['company_id']);
    let queue = draftQueues.get(company);
    if (!queue) {
      queue = { rows: [], timer: setTimeout(() => void flushDrafts(company), 100) };
      draftQueues.set(company, queue);
    }
    queue.rows.push({ draft, resolve, reject });
    if (queue.rows.length >= 5) void flushDrafts(company);
  });
}
async function flushDrafts(company: string) {
  const queue = draftQueues.get(company);
  if (!queue) return;
  clearTimeout(queue.timer);
  draftQueues.delete(company);
  let parentsInserted = false;
  try {
    const { error } = await supabase.from("invoices").insert(queue.rows.map((r) => r.draft.invoice) as never);
    if (error) throw error;
    parentsInserted = true;
    const results = await Promise.all([
      supabase.from("invoice_lines").insert(queue.rows.flatMap((r) => r.draft.lines) as never),
      supabase.from("journal_lines").insert(queue.rows.flatMap((r) => r.draft.journal) as never),
    ]);
    for (const result of results) if (result.error) throw result.error;
    for (const row of queue.rows) row.resolve();
  } catch (error) {
    if (parentsInserted) {
      const ids = queue.rows.map((r) => String(r.draft.invoice['id']));
      const cleanup = await supabase.from("invoices").delete().eq("company_id", company).eq("status", "borrador").in("id", ids);
      if (cleanup.error) console.error("No se pudo limpiar el grupo incompleto de borradores.");
    }
    for (const row of queue.rows) row.reject(error);
  }
}
