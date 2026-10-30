// Importador de compras desde Google Drive.
//
// Recorre <raíz>/<año>/<N. MES>/FACTURAS/** del mes actual y el anterior, y
// mete cada PDF nuevo en la MISMA cola de carga masiva que usa "Causar factura"
// (bulk_uploads / bulk_upload_items, estado "pending"). No lee facturas, no
// causa y no envía nada a Siigo: el procesamiento lo hace el motor existente
// (bulk-runner → processInvoiceFile), que se retoma solo al abrir la aplicación.
//
// El servidor corre en Cloudflare Workers, con tope de llamadas externas por
// ejecución: las carpetas se listan en grupos y las escrituras van en lote.
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  esCarpetaAnio,
  esCarpetaFacturas,
  esPdf,
  etiquetaPeriodo,
  mesDeCarpeta,
  nombreSeguro,
  periodosARevisar,
  pistaDePago,
  type Periodo,
} from "@/lib/drive-sync";
import {
  FOLDER_MIME,
  accessTokenForCompany,
  downloadFile,
  listChildren,
  listChildrenMany,
  type DriveItem,
} from "@/lib/google-drive.server";

/** PDF nuevos por ejecución (DRIVE_SYNC_MAX_FILES); el resto se toma en la siguiente. */
export function limitePorEjecucion(): number {
  const n = Number(process.env["DRIVE_SYNC_MAX_FILES"] ?? "");
  return Number.isInteger(n) && n > 0 ? n : 20;
}

export type DriveSyncResult = {
  companyId: string;
  periodos: string[];
  encontrados: number;
  encolados: number;
  duplicados: number;
  renombrados: number;
  pendientesProximaEjecucion: number;
  errores: string[];
  uploadId: string | null;
  advertencias: string[];
};

type PdfEnDrive = { item: DriveItem; ruta: string; periodo: string };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Todos los PDF bajo una carpeta (incluidas subcarpetas de proveedor), listando por niveles. */
async function pdfsRecursivos(
  token: string,
  raiz: DriveItem,
  ruta: string,
  periodo: string,
): Promise<PdfEnDrive[]> {
  const out: PdfEnDrive[] = [];
  let nivel = new Map<string, string>([[raiz.id, ruta]]);
  for (let profundidad = 0; nivel.size > 0 && profundidad < 6; profundidad++) {
    const siguiente = new Map<string, string>();
    for (const hijo of await listChildrenMany(token, [...nivel.keys()])) {
      const padre = (hijo.parents ?? []).find((p) => nivel.has(p));
      if (!padre) continue;
      const rutaPadre = nivel.get(padre)!;
      if (hijo.mimeType === FOLDER_MIME) siguiente.set(hijo.id, `${rutaPadre}/${hijo.name}`);
      else if (esPdf(hijo.name, hijo.mimeType)) out.push({ item: hijo, ruta: rutaPadre, periodo });
    }
    nivel = siguiente;
  }
  return out;
}

async function carpetaFacturasDelPeriodo(
  token: string,
  raiz: DriveItem[],
  p: Periodo,
  advertencias: string[],
): Promise<{ carpeta: DriveItem; ruta: string } | null> {
  const anio = raiz.find((f) => f.mimeType === FOLDER_MIME && esCarpetaAnio(f.name, p.anio));
  if (!anio) {
    advertencias.push(`No existe la carpeta del año ${p.anio}.`);
    return null;
  }
  const meses = (await listChildren(token, anio.id)).filter(
    (f) => f.mimeType === FOLDER_MIME && mesDeCarpeta(f.name) === p.mes,
  );
  if (meses.length !== 1) {
    advertencias.push(
      meses.length === 0
        ? `No existe la carpeta de ${etiquetaPeriodo(p)}.`
        : `Hay ${meses.length} carpetas para ${etiquetaPeriodo(p)}; no se importó ese mes para no adivinar.`,
    );
    return null;
  }
  const mes = meses[0]!;
  const facturas = (await listChildren(token, mes.id)).find(
    (f) => f.mimeType === FOLDER_MIME && esCarpetaFacturas(f.name),
  );
  if (!facturas) {
    advertencias.push(`${anio.name}/${mes.name} no tiene carpeta FACTURAS.`);
    return null;
  }
  return { carpeta: facturas, ruta: `${anio.name}/${mes.name}/${facturas.name}` };
}

function filaArchivo(companyId: string, p: PdfEnDrive) {
  const pista = pistaDePago(p.item.name);
  return {
    company_id: companyId,
    drive_file_id: p.item.id,
    name: p.item.name,
    folder_path: p.ruta,
    period: p.periodo,
    mime_type: p.item.mimeType,
    size_bytes: p.item.size ? Number(p.item.size) : null,
    drive_modified_at: p.item.modifiedTime ?? null,
    payment_sources: pista?.medios ?? null,
    payment_day: pista?.dia ?? null,
    updated_at: new Date().toISOString(),
  };
}

export async function syncDriveCompany(
  admin: SupabaseClient,
  companyId: string,
  opts: { userId?: string | null; ahora?: Date; limite?: number } = {},
): Promise<DriveSyncResult> {
  const limite = opts.limite ?? limitePorEjecucion();
  const periodos = periodosARevisar(opts.ahora ?? new Date());
  const result: DriveSyncResult = {
    companyId,
    periodos: periodos.map(etiquetaPeriodo),
    encontrados: 0,
    encolados: 0,
    duplicados: 0,
    renombrados: 0,
    pendientesProximaEjecucion: 0,
    errores: [],
    uploadId: null,
    advertencias: [],
  };

  const { data: source, error: sourceError } = await admin
    .from("drive_sync_sources")
    .select("root_folder_id, company:companies(created_by)")
    .eq("company_id", companyId)
    .maybeSingle();
  if (sourceError) throw new Error(sourceError.message);
  const src = source as { root_folder_id: string; company: { created_by: string } | null } | null;
  if (!src) throw new Error("La empresa no tiene carpeta de Google Drive configurada.");
  const ownerId = opts.userId ?? src.company?.created_by;
  if (!ownerId) throw new Error("No se encontró el usuario responsable de la empresa.");

  try {
    const token = await accessTokenForCompany(admin, companyId);
    const raiz = await listChildren(token, src.root_folder_id);

    const pdfs: PdfEnDrive[] = [];
    for (const p of periodos) {
      const f = await carpetaFacturasDelPeriodo(token, raiz, p, result.advertencias);
      if (f) pdfs.push(...(await pdfsRecursivos(token, f.carpeta, f.ruta, etiquetaPeriodo(p))));
    }
    result.encontrados = pdfs.length;

    // Archivos ya vistos: no se vuelven a traer. Si cambió el nombre (la usuaria
    // agrega "Corriente16 - ..." al pagar) se actualiza la pista de pago.
    const vistos = new Map<string, string>();
    const ids = pdfs.map((p) => p.item.id);
    for (let i = 0; i < ids.length; i += 300) {
      const { data, error } = await admin
        .from("drive_sync_files")
        .select("drive_file_id, name")
        .eq("company_id", companyId)
        .in("drive_file_id", ids.slice(i, i + 300));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ drive_file_id: string; name: string }>)
        vistos.set(r.drive_file_id, r.name);
    }
    const renombrados = pdfs.filter(
      (p) => vistos.has(p.item.id) && vistos.get(p.item.id) !== p.item.name,
    );
    if (renombrados.length) {
      const { error } = await admin.from("drive_sync_files").upsert(
        renombrados.map((p) => filaArchivo(companyId, p)),
        { onConflict: "company_id,drive_file_id" },
      );
      if (error) result.errores.push(`No se actualizaron nombres: ${error.message}`);
      else result.renombrados = renombrados.length;
    }

    const nuevos = pdfs.filter((p) => !vistos.has(p.item.id));
    result.pendientesProximaEjecucion = Math.max(0, nuevos.length - limite);

    // 1) Descarga y huella de cada PDF nuevo.
    const descargados: Array<PdfEnDrive & { bytes: Uint8Array; huella: string }> = [];
    for (const p of nuevos.slice(0, limite)) {
      try {
        const bytes = await downloadFile(token, p.item.id);
        descargados.push({ ...p, bytes, huella: await sha256Hex(bytes) });
      } catch (e) {
        // No se registra: se reintenta en la próxima ejecución.
        result.errores.push(
          `${p.ruta}/${p.item.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (!descargados.length) return await cerrar(admin, result);

    // 2) Mismo PDF ya cargado antes (ZIP, individual o Drive). La huella es única
    //    por empresa: no se vuelve a encolar; si esa carga quedó en error se
    //    reintenta desde la carga original.
    const previos = new Map<string, { id: string; status: string; upload_id: string }>();
    const { data: prev, error: prevError } = await admin
      .from("bulk_upload_items")
      .select("id, status, upload_id, fingerprint")
      .eq("company_id", companyId)
      .in(
        "fingerprint",
        descargados.map((d) => d.huella),
      );
    if (prevError) throw new Error(prevError.message);
    for (const r of (prev ?? []) as Array<{
      id: string;
      status: string;
      upload_id: string;
      fingerprint: string;
    }>) {
      previos.set(r.fingerprint, r);
    }

    const filasArchivos: Array<Record<string, unknown>> = [];
    const aEncolar: typeof descargados = [];
    const huellasLote = new Set<string>();
    for (const d of descargados) {
      const previo = previos.get(d.huella);
      if (previo || huellasLote.has(d.huella)) {
        filasArchivos.push({
          ...filaArchivo(companyId, d),
          fingerprint: d.huella,
          status: "duplicate",
          upload_id: previo?.upload_id ?? null,
          bulk_item_id: previo?.id ?? null,
          message: previo
            ? `El mismo PDF ya se había cargado (estado: ${previo.status}).`
            : "Archivo repetido dentro de la misma carpeta.",
        });
        result.duplicados += 1;
      } else {
        huellasLote.add(d.huella);
        aEncolar.push(d);
      }
    }

    // 3) Carga masiva con los PDF nuevos, guardados en Storage como hace el ZIP.
    if (aEncolar.length) {
      const { data: up, error: upError } = await admin
        .from("bulk_uploads")
        .insert({
          company_id: companyId,
          created_by: ownerId,
          file_name: `Google Drive · ${result.periodos.join(" / ")} · ${new Date().toISOString().slice(0, 10)}`,
          size_bytes: aEncolar.reduce((t, d) => t + d.bytes.byteLength, 0),
          status: "extracting",
          doc_kind: "compra",
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (upError) throw new Error(upError.message);
      const uploadId = (up as { id: string }).id;
      result.uploadId = uploadId;

      const items: Array<Record<string, unknown>> = [];
      const subidos: typeof aEncolar = [];
      for (const d of aEncolar) {
        const path = `${ownerId}/${companyId}/drive/${uploadId}/${items.length}-${nombreSeguro(d.item.name)}`;
        const { error } = await admin.storage
          .from("facturas")
          .upload(path, d.bytes, { upsert: true, contentType: "application/pdf" });
        if (error) {
          result.errores.push(`${d.ruta}/${d.item.name}: ERROR_SUBIDA_PDF ${error.message}`);
          continue;
        }
        items.push({
          upload_id: uploadId,
          company_id: companyId,
          file_name: d.item.name,
          storage_path: path,
          size_bytes: d.bytes.byteLength,
          fingerprint: d.huella,
          status: "pending",
          position: items.length,
        });
        subidos.push(d);
      }

      if (items.length) {
        const { data: creados, error: itemsError } = await admin
          .from("bulk_upload_items")
          .insert(items)
          .select("id, fingerprint");
        if (itemsError) throw new Error(itemsError.message);
        const idPorHuella = new Map(
          ((creados ?? []) as Array<{ id: string; fingerprint: string }>).map((c) => [
            c.fingerprint,
            c.id,
          ]),
        );
        for (const d of subidos) {
          filasArchivos.push({
            ...filaArchivo(companyId, d),
            fingerprint: d.huella,
            status: "queued",
            upload_id: uploadId,
            bulk_item_id: idPorHuella.get(d.huella) ?? null,
          });
        }
        result.encolados = subidos.length;
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

    if (filasArchivos.length) {
      const { error } = await admin.from("drive_sync_files").insert(filasArchivos);
      if (error) result.errores.push(`No se registraron los archivos importados: ${error.message}`);
    }
  } catch (e) {
    result.errores.push(e instanceof Error ? e.message : String(e));
  }

  return cerrar(admin, result);
}

async function cerrar(admin: SupabaseClient, result: DriveSyncResult): Promise<DriveSyncResult> {
  await admin
    .from("drive_sync_sources")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: result.errores.length ? "con_errores" : "ok",
      last_result: result,
    })
    .eq("company_id", result.companyId);
  return result;
}
