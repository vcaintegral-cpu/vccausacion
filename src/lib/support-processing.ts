// Carga masiva de documentos soporte: Excel (sin IA) o PDF/ZIP (IA), 5 en paralelo.
// Cada documento pasa por la MISMA función de causación de compras (saveExtractedInvoice)
// y luego se marca como documento soporte con los datos del vendedor.
import { supabase } from "@/integrations/supabase/client";
import { expandInvoiceFiles, resetBulkBatch, saveExtractedInvoice } from "@/lib/bulk-invoices";
import { loadDeps } from "@/lib/bulk-runner";
import { extractInvoice, type ExtractedInvoice } from "@/lib/extract.functions";
import { prepareInvoiceFile } from "@/lib/invoice-file";
import { readSheetIndexed } from "@/lib/spreadsheet";
import type { Json } from "@/integrations/supabase/types";
import {
  DS_PREFIX, fillVendorFromCompany, isNaturalPerson, missingIdentity, parseSupportRows, siigoIdType,
  supportDocToExtracted, type CompanyParams, type RowError, type VendorIdType,
} from "@/lib/support-docs";

export type SupportProgress = { done: number; total: number; ok: number; errors: number; startedAt: number; messages: string[] };

type Task = { label: string; build: () => Promise<{ data: ExtractedInvoice; idType: VendorIdType | null; file?: File; fuente: string; texto?: string }> };

export async function processSupportUpload(params: {
  companyId: string;
  files: File[];
  onProgress: (p: SupportProgress) => void;
}): Promise<{ rowErrors: RowError[]; progress: SupportProgress }> {
  const { companyId } = params;
  resetBulkBatch();
  const deps = await loadDeps(companyId);
  const company = deps.config.batch!.company;
  const { data: cp } = await supabase.from("company_parameters").select("*").eq("company_id", companyId).maybeSingle();
  const companyParams: CompanyParams = cp ?? {};

  const excel = params.files.filter((f) => /\.xlsx?$/i.test(f.name));
  const others = params.files.filter((f) => !/\.xlsx?$/i.test(f.name));
  const pdfs = others.length ? await expandInvoiceFiles(others) : [];
  const rowErrors: RowError[] = [];
  const tasks: Task[] = [];

  for (const file of excel) {
    const parsed = parseSupportRows(await readSheetIndexed(file));
    rowErrors.push(...parsed.errors);
    for (const doc of parsed.docs) {
      tasks.push({
        label: `${doc.number} · ${doc.name || doc.idNumber}`,
        build: async () => ({ data: supportDocToExtracted(doc, { nit: company.nit, name: company.name }), idType: doc.idType, fuente: "excel_soporte" }),
      });
    }
  }
  for (const file of pdfs) {
    tasks.push({
      label: file.name,
      build: async () => {
        const content = await prepareInvoiceFile(file);
        const raw = (await extractInvoice({ data: { fileName: file.name, mimeType: file.type || "application/pdf", ...content, kind: "soporte" } })) as ExtractedInvoice & { provider_id_type?: string | null };
        return {
          data: { ...raw, prefix: DS_PREFIX, buyer_nit: company.nit, buyer_name: company.name, cufe: null, notes: raw.notes ?? "Documento soporte" },
          idType: siigoIdType(raw.provider_id_type) ?? (String(raw.provider_nit ?? "").replace(/\D/g, "").length >= 9 ? "31" : null),
          file,
          fuente: "pdf_soporte",
          texto: content.text ?? "",
        };
      },
    });
  }

  const userId = deps.config.batch!.userId;
  const { data: upload } = await supabase.from("bulk_uploads").insert({
    company_id: companyId, created_by: userId, doc_kind: "soporte",
    file_name: params.files.map((f) => f.name).join(", ").slice(0, 300), size_bytes: params.files.reduce((a, f) => a + f.size, 0),
    status: "processing", files_found: tasks.length, pdf_found: pdfs.length, skipped_files: rowErrors.length, started_at: new Date().toISOString(),
  }).select("id").single();

  const progress: SupportProgress = { done: 0, total: tasks.length, ok: 0, errors: 0, startedAt: Date.now(), messages: [] };
  params.onProgress({ ...progress });

  const runTask = async (t: Task) => {
    try {
      const built = await t.build();
      const { vendor, filled } = fillVendorFromCompany(
        { address: built.data.provider_address, city: built.data.provider_city, phone: built.data.provider_phone, email: built.data.provider_email },
        companyParams,
      );
      const data: ExtractedInvoice = { ...built.data, provider_address: vendor.address ?? null, provider_city: vendor.city ?? null, provider_phone: vendor.phone ?? null, provider_email: vendor.email ?? null };
      const idNumber = String(data.provider_nit ?? "");
      const missing = missingIdentity({ idNumber, idType: built.idType, name: data.provider_name });
      const sinNumero = !String(data.number ?? "").trim();
      const saved = await saveExtractedInvoice({
        data, fileName: built.file?.name ?? t.label, file: built.file ?? null, companyId, config: deps.config, knowledge: deps.knowledge,
        readMode: "texto", texto: built.texto ?? "", rawExtraction: { fuente: built.fuente, documento: "soporte" },
      });
      // CxP del documento soporte: prioridad al historial del vendedor; si no hay, la cuenta por defecto configurada.
      const cxpDefault = (companyParams as { ds_payable_account?: string } | null)?.ds_payable_account ?? "23359501";
      const { data: reglaCxp } = idNumber
        ? await supabase.from("learning_rules").select("id").eq("company_id", companyId).eq("provider_nit", idNumber).not("payable_account", "is", null).limit(1)
        : { data: null };
      if (!reglaCxp?.length) {
        await supabase.from("invoices").update({ payable_account: cxpDefault, payable_source: "parametro_ds" }).eq("id", saved.invoiceId);
        await supabase.from("journal_lines").update({ account_code: cxpDefault }).eq("invoice_id", saved.invoiceId)
          .gte("account_code", "22000000").lt("account_code", "23600000");
      }
      const notas = [missing.length ? `Incompleto: falta ${missing.join(", ")} del vendedor.` : "", sinNumero ? "Falta número de cuenta de cobro." : ""].filter(Boolean).join(" ");
      await supabase.from("invoices").update({
        doc_kind: "soporte",
        vendor_id_type: built.idType,
        vendor_is_natural: isNaturalPerson(built.idType, idNumber),
        vendor_filled: filled as unknown as Json,
        ...(missing.length || sinNumero ? { status: "incompleto", notes: notas } : {}),
      }).eq("id", saved.invoiceId);
      progress.ok += 1;
    } catch (e) {
      progress.errors += 1;
      progress.messages.push(`${t.label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.done += 1;
      params.onProgress({ ...progress, messages: [...progress.messages] });
    }
  };

  // Pool de 5 documentos simultáneos.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(5, tasks.length) }, async () => {
    while (next < tasks.length) await runTask(tasks[next++]!);
  }));

  if (upload?.id)
    await supabase.from("bulk_uploads").update({
      status: progress.errors ? "completed_with_errors" : "completed", processed_count: progress.ok, error_count: progress.errors + rowErrors.length,
      error_message: [...rowErrors.map((r) => `Fila ${r.row}: ${r.message}`), ...progress.messages].join("\n").slice(0, 8000) || null,
      finished_at: new Date().toISOString(),
    }).eq("id", upload.id);
  return { rowErrors, progress };
}
