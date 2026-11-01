// Importador de las fuentes de documentos (Google Drive u OneDrive/SharePoint).
//
// Cada empresa elige una carpeta de COMPRAS y una de EGRESOS. En cada revisión:
// - Si la carpeta tiene subcarpetas por año y/o por mes ("2026", "10. OCTUBRE",
//   "OCTUBRE"), se toma el mes actual y el anterior por el nombre; si no, se
//   toman los archivos de la carpeta directamente.
// - COMPRAS: cada PDF nuevo y cada documento nuevo del Excel RECIBIDOS entran a
//   la MISMA carga masiva de "Causar factura" (bulk_uploads / bulk_upload_items,
//   estado "pending"); la lectura y la causación las hace el motor existente
//   (bulk-runner), que se retoma solo al abrir la app.
// - EGRESOS: soportes de pago y extractos se guardan en Storage y quedan en la
//   bandeja payment_documents para cruzarlos con las facturas.
// Nunca se causa ni se envía nada a Siigo desde aquí, y nada se modifica en la
// carpeta de origen.
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  esCarpetaDeAnio,
  esCarpetaAnio,
  etiquetaPeriodo,
  mesDeCarpeta,
  mismoNombre,
  nombreSeguro,
  periodosARevisar,
  pistaDePago,
  tipoDeArchivo,
  type Proposito,
} from "@/lib/drive-sync";
import { excelDocKey, excelDocLabel } from "@/lib/excel-invoice-adapter";
import type { FileNode, FileProvider, ProveedorArchivos } from "@/lib/file-providers";
import { parsePurchaseWorkbook } from "@/lib/purchase-excel";

/** Archivos nuevos por revisión (DOCUMENT_SYNC_MAX_FILES); el resto se toma en la siguiente. */
export function limitePorEjecucion(): number {
  const n = Number(process.env["DOCUMENT_SYNC_MAX_FILES"] ?? "");
  return Number.isInteger(n) && n > 0 ? n : 20;
}

export type DocumentSource = {
  id: string;
  company_id: string;
  purpose: Proposito;
  provider: ProveedorArchivos;
  folder_id: string;
  drive_id: string | null;
  month_subfolder: string | null;
};

export type SyncResult = {
  sourceId: string;
  companyId: string;
  purpose: Proposito;
  periodos: string[];
  modo: "por_mes" | "carpeta_directa";
  encontrados: number;
  facturasEncoladas: number;
  documentosExcel: number;
  egresosRecibidos: number;
  duplicados: number;
  renombrados: number;
  pendientesProximaEjecucion: number;
  uploadIds: string[];
  advertencias: string[];
  errores: string[];
};

type Archivo = {
  node: FileNode;
  ruta: string;
  periodo: string | null;
  tipo: NonNullable<ReturnType<typeof tipoDeArchivo>>;
};
type Descargado = Archivo & { bytes: Uint8Array; huella: string };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Objetivo = { id: string; ruta: string; periodo: string | null };

/** Carpetas a recorrer: las del mes actual y el anterior, o la carpeta completa si no está organizada por meses. */
async function carpetasObjetivo(
  provider: FileProvider,
  source: DocumentSource,
  ahora: Date,
  result: SyncResult,
): Promise<Objetivo[]> {
  const raiz = await provider.listChildren(source.folder_id);
  const anios = raiz.filter((n) => n.isFolder && esCarpetaDeAnio(n.name));
  const tieneMeses = (nodos: FileNode[]) =>
    nodos.some((n) => n.isFolder && mesDeCarpeta(n.name) !== null);

  if (!anios.length && !tieneMeses(raiz)) {
    result.modo = "carpeta_directa";
    result.periodos = [];
    return [{ id: source.folder_id, ruta: "", periodo: null }];
  }

  const objetivos: Objetivo[] = [];
  for (const p of periodosARevisar(ahora)) {
    const etiqueta = etiquetaPeriodo(p);
    let nodos = raiz;
    let ruta = "";
    if (anios.length) {
      const anio = anios.find((n) => esCarpetaAnio(n.name, p.anio));
      if (!anio) {
        result.advertencias.push(`No existe la carpeta del año ${p.anio}.`);
        continue;
      }
      nodos = await provider.listChildren(anio.id);
      ruta = anio.name;
    }
    const meses = nodos.filter((n) => n.isFolder && mesDeCarpeta(n.name) === p.mes);
    if (meses.length !== 1) {
      result.advertencias.push(
        meses.length === 0
          ? `No existe la carpeta de ${etiqueta}.`
          : `Hay ${meses.length} carpetas para ${etiqueta}; no se importó ese mes para no adivinar.`,
      );
      continue;
    }
    let destino = meses[0]!;
    ruta = ruta ? `${ruta}/${destino.name}` : destino.name;
    const sub = source.month_subfolder?.trim();
    if (sub) {
      const hija = (await provider.listChildren(destino.id)).find(
        (n) => n.isFolder && mismoNombre(n.name, sub),
      );
      if (!hija) {
        result.advertencias.push(`${ruta} no tiene la subcarpeta "${sub}".`);
        continue;
      }
      destino = hija;
      ruta = `${ruta}/${hija.name}`;
    }
    objetivos.push({ id: destino.id, ruta, periodo: etiqueta });
  }
  return objetivos;
}

/** Archivos útiles bajo una carpeta (incluidas subcarpetas de proveedor), listando por niveles. */
async function archivosBajo(
  provider: FileProvider,
  o: Objetivo,
  proposito: Proposito,
): Promise<Archivo[]> {
  const out: Archivo[] = [];
  let nivel = new Map<string, string>([[o.id, o.ruta]]);
  for (let profundidad = 0; nivel.size > 0 && profundidad < 6; profundidad++) {
    const siguiente = new Map<string, string>();
    for (const n of await provider.listChildrenMany([...nivel.keys()])) {
      const rutaPadre = n.parentId ? nivel.get(n.parentId) : undefined;
      if (rutaPadre === undefined) continue;
      if (n.isFolder) {
        siguiente.set(n.id, rutaPadre ? `${rutaPadre}/${n.name}` : n.name);
        continue;
      }
      const tipo = tipoDeArchivo(proposito, n.name, n.mimeType);
      if (tipo) out.push({ node: n, ruta: rutaPadre, periodo: o.periodo, tipo });
    }
    nivel = siguiente;
  }
  return out;
}

function filaArchivo(source: DocumentSource, a: Archivo) {
  const pista = pistaDePago(a.node.name);
  return {
    company_id: source.company_id,
    purpose: source.purpose,
    provider: source.provider,
    external_id: a.node.id,
    name: a.node.name,
    folder_path: a.ruta,
    period: a.periodo,
    file_type: a.tipo,
    mime_type: a.node.mimeType,
    size_bytes: a.node.size,
    external_modified_at: a.node.modifiedAt,
    payment_sources: pista?.medios ?? null,
    payment_day: pista?.dia ?? null,
    updated_at: new Date().toISOString(),
  };
}

const contentType = (a: Archivo) =>
  a.tipo === "factura_pdf" || (a.tipo !== "recibidos_excel" && /\.pdf$/i.test(a.node.name))
    ? "application/pdf"
    : (a.node.mimeType ?? "application/octet-stream");

/** Huellas ya registradas en una tabla de la empresa (por lotes). */
async function huellasExistentes(
  admin: SupabaseClient,
  tabla: "bulk_upload_items" | "payment_documents",
  companyId: string,
  huellas: string[],
) {
  const out = new Map<string, { id: string; status: string; upload_id?: string }>();
  for (let i = 0; i < huellas.length; i += 200) {
    const { data, error } = await admin
      .from(tabla)
      .select(
        tabla === "bulk_upload_items"
          ? "id, status, upload_id, fingerprint"
          : "id, status, fingerprint",
      )
      .eq("company_id", companyId)
      .in("fingerprint", huellas.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as unknown as Array<{
      id: string;
      status: string;
      upload_id?: string;
      fingerprint: string;
    }>) {
      out.set(r.fingerprint, r);
    }
  }
  return out;
}

export async function syncSource(
  admin: SupabaseClient,
  source: DocumentSource,
  opts: {
    provider: FileProvider;
    userId?: string | null | undefined;
    ahora?: Date;
    limite?: number;
  },
): Promise<SyncResult> {
  const limite = opts.limite ?? limitePorEjecucion();
  const ahora = opts.ahora ?? new Date();
  const result: SyncResult = {
    sourceId: source.id,
    companyId: source.company_id,
    purpose: source.purpose,
    periodos: periodosARevisar(ahora).map(etiquetaPeriodo),
    modo: "por_mes",
    encontrados: 0,
    facturasEncoladas: 0,
    documentosExcel: 0,
    egresosRecibidos: 0,
    duplicados: 0,
    renombrados: 0,
    pendientesProximaEjecucion: 0,
    uploadIds: [],
    advertencias: [],
    errores: [],
  };

  try {
    const { data: company, error: companyError } = await admin
      .from("companies")
      .select("created_by, nit")
      .eq("id", source.company_id)
      .single();
    if (companyError) throw new Error(companyError.message);
    const empresa = company as { created_by: string; nit: string | null };
    const ownerId = opts.userId ?? empresa.created_by;

    const provider = opts.provider;
    const archivos: Archivo[] = [];
    for (const o of await carpetasObjetivo(provider, source, ahora, result)) {
      archivos.push(...(await archivosBajo(provider, o, source.purpose)));
    }
    result.encontrados = archivos.length;

    // Archivos ya vistos por ID de la fuente.
    const vistos = new Map<string, { name: string; modified: string | null; status: string }>();
    const ids = archivos.map((a) => a.node.id);
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await admin
        .from("document_source_files")
        .select("external_id, name, external_modified_at, status")
        .eq("company_id", source.company_id)
        .eq("provider", source.provider)
        .in("external_id", ids.slice(i, i + 300));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{
        external_id: string;
        name: string;
        external_modified_at: string | null;
        status: string;
      }>) {
        vistos.set(r.external_id, {
          name: r.name,
          modified: r.external_modified_at,
          status: r.status,
        });
      }
    }

    const filas = new Map<string, Record<string, unknown>>();
    const aProcesar: Archivo[] = [];
    for (const a of archivos) {
      const previo = vistos.get(a.node.id);
      const mismoMomento = (x: string | null, y: string | null) =>
        !!x && !!y && new Date(x).getTime() === new Date(y).getTime();
      if (!previo) aProcesar.push(a);
      // El Excel RECIBIDOS se reemplaza durante el mes: si cambió, se vuelve a leer
      // (solo entran los documentos nuevos; los ya cargados se reconocen por CUFE).
      else if (a.tipo === "recibidos_excel" && !mismoMomento(previo.modified, a.node.modifiedAt))
        aProcesar.push(a);
      else if (previo.name !== a.node.name) {
        // La usuaria agrega "Corriente16 - ..." al pagar: se actualiza la pista de pago.
        filas.set(a.node.id, filaArchivo(source, a));
        result.renombrados += 1;
      }
    }
    result.pendientesProximaEjecucion = Math.max(0, aProcesar.length - limite);

    const descargados: Descargado[] = [];
    for (const a of aProcesar.slice(0, limite)) {
      try {
        const bytes = await provider.download(a.node);
        descargados.push({ ...a, bytes, huella: await sha256Hex(bytes) });
      } catch (e) {
        // No se registra: se reintenta en la próxima revisión.
        result.errores.push(
          `${a.ruta}/${a.node.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const pagos: Array<Record<string, unknown> & { external_id: string }> = [];

    if (source.purpose === "compras") {
      await comprasPdf(
        admin,
        source,
        ownerId,
        descargados.filter((d) => d.tipo === "factura_pdf"),
        filas,
        result,
      );
      for (const d of descargados.filter((x) => x.tipo === "recibidos_excel")) {
        await comprasExcel(admin, source, ownerId, empresa.nit ?? "", d, filas, result);
      }
    } else {
      const previos = await huellasExistentes(
        admin,
        "payment_documents",
        source.company_id,
        descargados.map((d) => d.huella),
      );
      const enLote = new Set<string>();
      for (const d of descargados) {
        if (previos.has(d.huella) || enLote.has(d.huella)) {
          filas.set(d.node.id, {
            ...filaArchivo(source, d),
            fingerprint: d.huella,
            status: "duplicate",
            message: previos.has(d.huella)
              ? "El mismo archivo ya está en la bandeja de egresos."
              : "Archivo repetido en la carpeta.",
          });
          result.duplicados += 1;
          continue;
        }
        enLote.add(d.huella);
        const path = `${ownerId}/${source.company_id}/egresos/${source.id}/${d.huella.slice(0, 16)}-${nombreSeguro(d.node.name)}`;
        const { error } = await admin.storage
          .from("facturas")
          .upload(path, d.bytes, { upsert: true, contentType: contentType(d) });
        if (error) {
          result.errores.push(`${d.ruta}/${d.node.name}: ERROR_SUBIDA ${error.message}`);
          continue;
        }
        filas.set(d.node.id, {
          ...filaArchivo(source, d),
          fingerprint: d.huella,
          status: "received",
        });
        pagos.push({
          external_id: d.node.id,
          company_id: source.company_id,
          kind: d.tipo === "extracto" ? "extracto" : "soporte_pago",
          file_name: d.node.name,
          folder_path: d.ruta,
          period: d.periodo,
          storage_path: path,
          mime_type: contentType(d),
          size_bytes: d.bytes.byteLength,
          fingerprint: d.huella,
        });
      }
    }

    // Registro de archivos vistos (insert o actualización por ID de la fuente).
    const idPorExterno = new Map<string, string>();
    if (filas.size) {
      const { data, error } = await admin
        .from("document_source_files")
        .upsert([...filas.values()], { onConflict: "company_id,provider,external_id" })
        .select("id, external_id");
      if (error) result.errores.push(`No se registraron los archivos: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; external_id: string }>)
        idPorExterno.set(r.external_id, r.id);
    }
    if (pagos.length) {
      const { error } = await admin.from("payment_documents").insert(
        pagos.map(({ external_id, ...p }) => ({
          ...p,
          source_file_id: idPorExterno.get(external_id) ?? null,
        })),
      );
      if (error) result.errores.push(`No se guardaron los egresos en la bandeja: ${error.message}`);
      else result.egresosRecibidos = pagos.length;
    }
  } catch (e) {
    result.errores.push(e instanceof Error ? e.message : String(e));
  }

  await admin
    .from("document_sources")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: result.errores.length ? "con_errores" : "ok",
      last_result: result,
    })
    .eq("id", source.id);
  return result;
}

/** PDF de compras → una carga masiva con una tarea pendiente por PDF (igual que el ZIP). */
async function comprasPdf(
  admin: SupabaseClient,
  source: DocumentSource,
  ownerId: string,
  pdfs: Descargado[],
  filas: Map<string, Record<string, unknown>>,
  result: SyncResult,
) {
  if (!pdfs.length) return;
  // La huella es única por empresa: un PDF ya cargado (ZIP, individual o fuente)
  // no se vuelve a encolar; si esa carga quedó en error se reintenta desde allí.
  const previos = await huellasExistentes(
    admin,
    "bulk_upload_items",
    source.company_id,
    pdfs.map((d) => d.huella),
  );
  const nuevos: Descargado[] = [];
  const enLote = new Set<string>();
  for (const d of pdfs) {
    const previo = previos.get(d.huella);
    if (previo || enLote.has(d.huella)) {
      filas.set(d.node.id, {
        ...filaArchivo(source, d),
        fingerprint: d.huella,
        status: "duplicate",
        upload_id: previo?.upload_id ?? null,
        bulk_item_id: previo?.id ?? null,
        message: previo
          ? `El mismo PDF ya se había cargado (estado: ${previo.status}).`
          : "Archivo repetido en la carpeta.",
      });
      result.duplicados += 1;
    } else {
      enLote.add(d.huella);
      nuevos.push(d);
    }
  }
  if (!nuevos.length) return;

  const { data: up, error: upError } = await admin
    .from("bulk_uploads")
    .insert({
      company_id: source.company_id,
      created_by: ownerId,
      file_name: `Fuente automática · PDF · ${result.periodos.join(" / ") || "carpeta"} · ${new Date().toISOString().slice(0, 10)}`,
      size_bytes: nuevos.reduce((t, d) => t + d.bytes.byteLength, 0),
      status: "extracting",
      doc_kind: "compra",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (upError) throw new Error(upError.message);
  const uploadId = (up as { id: string }).id;
  result.uploadIds.push(uploadId);

  const items: Array<Record<string, unknown>> = [];
  const subidos: Descargado[] = [];
  for (const d of nuevos) {
    const path = `${ownerId}/${source.company_id}/fuentes/${uploadId}/${items.length}-${nombreSeguro(d.node.name)}`;
    const { error } = await admin.storage
      .from("facturas")
      .upload(path, d.bytes, { upsert: true, contentType: "application/pdf" });
    if (error) {
      result.errores.push(`${d.ruta}/${d.node.name}: ERROR_SUBIDA_PDF ${error.message}`);
      continue;
    }
    items.push({
      upload_id: uploadId,
      company_id: source.company_id,
      file_name: d.node.name,
      storage_path: path,
      size_bytes: d.bytes.byteLength,
      fingerprint: d.huella,
      status: "pending",
      position: items.length,
    });
    subidos.push(d);
  }

  let idPorHuella = new Map<string, string>();
  if (items.length) {
    const { data, error } = await admin
      .from("bulk_upload_items")
      .insert(items)
      .select("id, fingerprint");
    if (error) throw new Error(error.message);
    idPorHuella = new Map(
      ((data ?? []) as Array<{ id: string; fingerprint: string }>).map((r) => [
        r.fingerprint,
        r.id,
      ]),
    );
    result.facturasEncoladas += subidos.length;
  }
  for (const d of subidos) {
    filas.set(d.node.id, {
      ...filaArchivo(source, d),
      fingerprint: d.huella,
      status: "queued",
      upload_id: uploadId,
      bulk_item_id: idPorHuella.get(d.huella) ?? null,
    });
  }
  await admin
    .from("bulk_uploads")
    .update({
      status: items.length ? "processing" : "failed",
      files_found: items.length,
      pdf_found: items.length,
      ...(items.length
        ? {}
        : {
            error_message: "No se pudo guardar ningún PDF.",
            finished_at: new Date().toISOString(),
          }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", uploadId);
}

/** Excel RECIBIDOS → una carga masiva con una tarea por documento nuevo (igual que la carga manual del Excel). */
async function comprasExcel(
  admin: SupabaseClient,
  source: DocumentSource,
  ownerId: string,
  companyNit: string,
  d: Descargado,
  filas: Map<string, Record<string, unknown>>,
  result: SyncResult,
) {
  let docs;
  try {
    docs = parsePurchaseWorkbook(d.bytes.slice().buffer, companyNit);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Error permanente del archivo (otro formato u otra empresa): no se reintenta hasta que cambie.
    filas.set(d.node.id, {
      ...filaArchivo(source, d),
      fingerprint: d.huella,
      status: "error",
      message,
    });
    result.advertencias.push(
      `${d.ruta}/${d.node.name}: no es un Excel RECIBIDOS de la empresa (${message})`,
    );
    return;
  }

  const claves = docs.map((doc) => `excel:${excelDocKey(doc)}`);
  const previos = await huellasExistentes(admin, "bulk_upload_items", source.company_id, claves);
  const nuevos = docs
    .map((doc, i) => ({ doc, clave: claves[i]! }))
    .filter((x) => !previos.has(x.clave));
  result.duplicados += docs.length - nuevos.length;
  if (!nuevos.length) {
    filas.set(d.node.id, {
      ...filaArchivo(source, d),
      fingerprint: d.huella,
      status: "duplicate",
      message: `Los ${docs.length} documentos del Excel ya estaban cargados.`,
    });
    return;
  }

  const { data: up, error: upError } = await admin
    .from("bulk_uploads")
    .insert({
      company_id: source.company_id,
      created_by: ownerId,
      file_name: d.node.name,
      size_bytes: d.bytes.byteLength,
      status: "extracting",
      doc_kind: "compra",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (upError) throw new Error(upError.message);
  const uploadId = (up as { id: string }).id;
  result.uploadIds.push(uploadId);

  const excelPath = `${ownerId}/${source.company_id}/excel/${uploadId}-${nombreSeguro(d.node.name)}`;
  const { error: stError } = await admin.storage
    .from("facturas")
    .upload(excelPath, d.bytes, { upsert: true, contentType: contentType(d) });
  if (stError) throw new Error(`ERROR_SUBIDA_EXCEL: ${stError.message}`);

  const { error: itemsError } = await admin.from("bulk_upload_items").insert(
    nuevos.map(({ doc, clave }, position) => ({
      upload_id: uploadId,
      company_id: source.company_id,
      file_name: excelDocLabel(doc),
      storage_path: excelPath,
      size_bytes: 0,
      fingerprint: clave,
      status: "pending",
      mime_type: "excel_document",
      provider_name: doc.header.provider_name || null,
      provider_nit: doc.header.provider_nit || null,
      buyer_name: doc.header.buyer_name || null,
      buyer_nit: doc.header.buyer_nit || null,
      invoice_number: [doc.header.prefix, doc.header.number].filter(Boolean).join("-") || null,
      issue_date: doc.header.issue_date || null,
      position,
    })),
  );
  if (itemsError) throw new Error(itemsError.message);
  await admin
    .from("bulk_uploads")
    .update({
      storage_path: excelPath,
      status: "processing",
      files_found: nuevos.length,
      pdf_found: nuevos.length,
      updated_at: new Date().toISOString(),
    })
    .eq("id", uploadId);

  result.documentosExcel += nuevos.length;
  filas.set(d.node.id, {
    ...filaArchivo(source, d),
    fingerprint: d.huella,
    status: "queued",
    upload_id: uploadId,
    message: `${nuevos.length} documento(s) nuevos; ${docs.length - nuevos.length} ya estaban cargados.`,
  });
}
