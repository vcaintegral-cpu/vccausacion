import { beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";

import { syncSource, type DocumentSource } from "./document-sync.server";
import type { FileNode, FileProvider } from "./file-providers";

// ---------------------------------------------------------------------------
// Fuente de archivos simulada (sirve igual para Google Drive y OneDrive).
// ---------------------------------------------------------------------------
type Nodo = {
  id: string;
  name: string;
  folder?: boolean;
  parent: string;
  content?: Uint8Array | string;
  modified?: string;
};
let arbol: Nodo[] = [];
const descargas: string[] = [];

const aNodo = (n: Nodo): FileNode => ({
  id: n.id,
  name: n.name,
  isFolder: !!n.folder,
  mimeType: n.folder ? null : /\.pdf$/i.test(n.name) ? "application/pdf" : null,
  size: 10,
  modifiedAt: n.modified ?? "2026-10-20T10:00:00Z",
  parentId: n.parent,
});
const provider: FileProvider = {
  listChildren: async (id) => arbol.filter((n) => n.parent === id).map(aNodo),
  listChildrenMany: async (ids) => arbol.filter((n) => ids.includes(n.parent)).map(aNodo),
  download: async (f) => {
    descargas.push(f.id);
    const c = arbol.find((n) => n.id === f.id)!.content ?? f.id;
    return typeof c === "string" ? new TextEncoder().encode(c) : c;
  },
};

// ---------------------------------------------------------------------------
// Supabase en memoria: solo las operaciones que usa el importador.
// ---------------------------------------------------------------------------
type Fila = Record<string, unknown>;
function fakeDb(tablas: Record<string, Fila[]>) {
  const subidas: string[] = [];
  let seq = 0;
  const from = (tabla: string) => {
    const filtros: Array<(f: Fila) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Fila[] = [];
    let patch: Fila = {};
    let conflicto: string[] = [];
    let unico = false;
    const filas = () => (tablas[tabla] ??= []);
    const ejecutar = (): Fila[] => {
      if (op === "insert") {
        const nuevas = payload.map((p) => ({ id: `${tabla}-${++seq}`, ...p }));
        filas().push(...nuevas);
        return nuevas;
      }
      if (op === "upsert") {
        return payload.map((p) => {
          const existente = filas().find((f) => conflicto.every((k) => f[k] === p[k]));
          if (existente) return Object.assign(existente, p);
          const nueva = { id: `${tabla}-${++seq}`, ...p };
          filas().push(nueva);
          return nueva;
        });
      }
      const sel = filas().filter((f) => filtros.every((fn) => fn(f)));
      if (op === "update") sel.forEach((f) => Object.assign(f, patch));
      return sel;
    };
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => (filtros.push((f) => f[k] === v), b),
      in: (k: string, vs: unknown[]) => (filtros.push((f) => vs.includes(f[k])), b),
      like: (k: string, patron: string) => (
        filtros.push((f) => new RegExp(`^${patron.replace(/%/g, ".*")}$`).test(String(f[k] ?? ""))),
        b
      ),
      gte: (k: string, v: unknown) => (filtros.push((f) => String(f[k] ?? "") >= String(v)), b),
      neq: (k: string, v: unknown) => (filtros.push((f) => f[k] !== v), b),
      // Solo la forma usada por el importador: "col.neq.valor,col.not.is.null".
      or: (expr: string) => (
        filtros.push((f) =>
          expr.split(",").some((cond) => {
            const [col, ...resto] = cond.split(".");
            const regla = resto.join(".");
            if (regla === "not.is.null") return f[col!] != null;
            if (regla.startsWith("neq.")) return f[col!] !== regla.slice(4);
            if (regla === "is.null") return f[col!] == null;
            if (regla.startsWith("eq.")) return f[col!] === regla.slice(3);
            return false;
          }),
        ),
        b
      ),
      range: () => b,
      insert: (p: Fila | Fila[]) => ((op = "insert"), (payload = Array.isArray(p) ? p : [p]), b),
      upsert: (p: Fila | Fila[], o: { onConflict: string }) => (
        (op = "upsert"),
        (payload = Array.isArray(p) ? p : [p]),
        (conflicto = o.onConflict.split(",")),
        b
      ),
      update: (p: Fila) => ((op = "update"), (patch = p), b),
      single: () => ((unico = true), b),
      maybeSingle: () => ((unico = true), b),
      then: (ok: (r: { data: unknown; error: null }) => unknown) => {
        const data = ejecutar();
        return Promise.resolve({ data: unico ? (data[0] ?? null) : data, error: null }).then(ok);
      },
    };
    return b;
  };
  const storage = {
    from: () => ({ upload: async (path: string) => (subidas.push(path), { error: null }) }),
  };
  return { client: { from, storage } as unknown as SupabaseClient, tablas, subidas };
}

const EMPRESA = "c0ffee00-0000-4000-8000-000000000001";
const DUENO = "u0000000-0000-4000-8000-000000000001";
const NIT = "800212838";
const AHORA = new Date("2026-10-30T23:00:00Z");
const PDF = (id: string, name: string, parent: string, extra: Partial<Nodo> = {}): Nodo => ({
  id,
  name,
  parent,
  ...extra,
});
const DIR = (id: string, name: string, parent: string): Nodo => ({
  id,
  name,
  parent,
  folder: true,
});

function base(extra: Record<string, Fila[]> = {}) {
  return fakeDb({
    companies: [{ id: EMPRESA, created_by: DUENO, nit: NIT }],
    document_sources: [],
    document_source_files: [],
    bulk_uploads: [],
    bulk_upload_items: [],
    payment_documents: [],
    ...extra,
  });
}

const fuente = (
  purpose: "compras" | "egresos",
  sub: string | null,
  provider: "google" | "microsoft" = "google",
): DocumentSource => ({
  id: `src-${purpose}`,
  company_id: EMPRESA,
  purpose,
  provider,
  folder_id: "raiz",
  drive_id: provider === "microsoft" ? "drive-1" : null,
  month_subfolder: sub,
});

/** Excel RECIBIDOS mínimo con las columnas que lee parsePurchaseWorkbook. */
function recibidos(docs: Array<{ numero: string; cufe: string }>, nit = NIT): Uint8Array {
  const w = XLSX.utils.book_new();
  const h = [
    "TIPO DOC EMITIDO",
    "NUMERO FACTURA COMPLETO",
    "CUFE",
    "NIT COMPRADOR",
    "NIT EMISOR",
    "PREFIJO",
    "NUMERO DE FACTURA",
    "SUBTOTAL FACTURA",
    "IVA",
    "TOTAL FACTURA",
  ];
  XLSX.utils.book_append_sheet(
    w,
    XLSX.utils.aoa_to_sheet([
      ["t"],
      ["r"],
      h,
      ...docs.map((d) => [
        "Factura electrónica",
        `FE${d.numero}`,
        d.cufe,
        nit,
        "890903407",
        "FE",
        d.numero,
        100000,
        19000,
        119000,
      ]),
    ]),
    "DOCUMENTOS",
  );
  XLSX.utils.book_append_sheet(
    w,
    XLSX.utils.aoa_to_sheet([
      ["t"],
      ["r"],
      [
        "TIPO DOC EMITIDO",
        "NUMERO FACTURA COMPLETO",
        "CUFE",
        "CANTIDAD",
        "SUBTOTAL DE LA FACTURA",
        "IVA",
      ],
      ...docs.map((d) => ["Factura electrónica", `FE${d.numero}`, d.cufe, 1, 100000, 19000]),
    ]),
    "DETALLE DE FACTURA",
  );
  return new Uint8Array(XLSX.write(w, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

beforeEach(() => {
  descargas.length = 0;
});

describe("LED LIGHTS: Google Drive año → mes → FACTURAS", () => {
  beforeEach(() => {
    arbol = [
      DIR("y2026", "2026", "raiz"),
      DIR("y2025", "2025", "raiz"),
      DIR("oct", "10. OCTUBRE", "y2026"),
      DIR("sep", "9. SEPTIEMBRE", "y2026"),
      DIR("jun", "6. JUNIO", "y2026"),
      DIR("octFact", "FACTURAS", "oct"),
      DIR("octCC", "CUENTAS DE COBRO", "oct"),
      DIR("sepFact", "FACTURAS", "sep"),
      DIR("mega", "MEGA LUCES S.A.S", "octFact"),
      DIR("tcc", "1. PEND. - TCC SAS", "octFact"),
      DIR("tccCli", "De Clientes", "tcc"),
      PDF("f1", "Corriente16 - fv090004721702826FECT00274124.pdf", "mega"),
      PDF("f2", "Efectivo+Corriente01 - fv090004721702826FECT00271600.pdf", "mega"),
      PDF("f3", "ad086001664002726566920261028175206607.pdf", "tcc"),
      PDF("f4", "guia.pdf", "tccCli"),
      PDF("xml", "factura.xml", "mega"),
      PDF("cc1", "cuenta de cobro.pdf", "octCC"),
      PDF("s1", "Efectivo05 - fe-septiembre.pdf", "sepFact"),
      PDF("j1", "junio.pdf", "jun"),
    ];
  });

  it("encola los PDF de FACTURAS del mes actual y el anterior, incluidas subcarpetas", async () => {
    const db = base();
    const r = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
    });
    expect(r.errores).toEqual([]);
    expect(r.modo).toBe("por_mes");
    expect(r.periodos).toEqual(["OCTUBRE 2026", "SEPTIEMBRE 2026"]);
    expect(r.encontrados).toBe(5);
    expect(r.facturasEncoladas).toBe(5);
    expect(descargas.sort()).toEqual(["f1", "f2", "f3", "f4", "s1"]);

    const [upload] = db.tablas["bulk_uploads"]!;
    expect(upload).toMatchObject({
      company_id: EMPRESA,
      created_by: DUENO,
      status: "processing",
      doc_kind: "compra",
    });
    const items = db.tablas["bulk_upload_items"]!;
    expect(items).toHaveLength(5);
    expect(items.every((i) => i["status"] === "pending" && i["upload_id"] === upload!["id"])).toBe(
      true,
    );
    expect(
      db.subidas.every((p) => p.startsWith(`${DUENO}/${EMPRESA}/fuentes/${upload!["id"]}/`)),
    ).toBe(true);

    const fila = (id: string) =>
      db.tablas["document_source_files"]!.find((f) => f["external_id"] === id)!;
    expect(fila("f1")).toMatchObject({
      status: "queued",
      payment_sources: ["corriente"],
      payment_day: 16,
      period: "OCTUBRE 2026",
    });
    expect(fila("f2")["payment_sources"]).toEqual(["efectivo", "corriente"]);
    expect(fila("f4")["folder_path"]).toBe(
      "2026/10. OCTUBRE/FACTURAS/1. PEND. - TCC SAS/De Clientes",
    );
  });

  it("la segunda revisión no vuelve a descargar y solo actualiza el renombre por pago", async () => {
    const db = base();
    await syncSource(db.client, fuente("compras", "FACTURAS"), { provider, ahora: AHORA });
    descargas.length = 0;
    arbol.find((n) => n.id === "f3")!.name =
      "Efectivo27 - ad086001664002726566920261028175206607.pdf";
    const r = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
    });
    expect(descargas).toEqual([]);
    expect(r.facturasEncoladas).toBe(0);
    expect(r.renombrados).toBe(1);
    expect(db.tablas["bulk_uploads"]).toHaveLength(1);
    expect(
      db.tablas["document_source_files"]!.find((f) => f["external_id"] === "f3"),
    ).toMatchObject({
      payment_sources: ["efectivo"],
      payment_day: 27,
      status: "queued",
    });
  });

  it("si se eliminaron las cargas masivas, la siguiente revisión vuelve a enviar los archivos", async () => {
    const db = base();
    const r1 = await syncSource(db.client, fuente("compras", "FACTURAS"), { provider, ahora: AHORA });
    expect(r1.facturasEncoladas).toBeGreaterThan(0);
    // Borrar la carga elimina sus tareas y deja sin carga el registro del archivo (ON DELETE SET NULL).
    db.tablas["bulk_uploads"] = [];
    db.tablas["bulk_upload_items"] = [];
    for (const f of db.tablas["document_source_files"]!) Object.assign(f, { upload_id: null, bulk_item_id: null });
    descargas.length = 0;
    const r2 = await syncSource(db.client, fuente("compras", "FACTURAS"), { provider, ahora: AHORA });
    expect(r2.facturasEncoladas).toBe(r1.facturasEncoladas);
    expect(r2.duplicados).toBe(0);
    expect(descargas.length).toBe(r1.facturasEncoladas);
  });

  it("si se eliminaron los borradores, se vuelven a enviar y se libera la huella; los vigentes no", async () => {
    const db = base();
    const r1 = await syncSource(db.client, fuente("compras", "FACTURAS"), { provider, ahora: AHORA });
    const tareas = db.tablas["bulk_upload_items"]!;
    // Todas procesadas; la primera conserva su borrador, las demás lo perdieron.
    tareas.forEach((t, i) => Object.assign(t, { status: "completed", invoice_id: i === 0 ? "inv-vigente" : null }));
    const r2 = await syncSource(db.client, fuente("compras", "FACTURAS"), { provider, ahora: AHORA });
    expect(r2.facturasEncoladas).toBe(r1.facturasEncoladas - 1);
    expect(r2.duplicados).toBe(0);
    // Las tareas muertas liberaron su huella para las nuevas (índice único por empresa).
    expect(tareas.slice(1, r1.facturasEncoladas).every((t) => t["fingerprint"] === null)).toBe(true);
    // Una tercera revisión no repite nada: las nuevas tareas están vivas.
    const r3 = await syncSource(db.client, fuente("compras", "FACTURAS"), { provider, ahora: AHORA });
    expect(r3.facturasEncoladas).toBe(0);
  });

  it("no encola un PDF ya cargado por ZIP ni repetidos en la carpeta", async () => {
    arbol.find((n) => n.id === "f2")!.content = "igual";
    arbol.find((n) => n.id === "f3")!.content = "igual";
    const h = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("f1"))),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const db = base({
      bulk_upload_items: [
        {
          id: "zip-item",
          upload_id: "zip",
          company_id: EMPRESA,
          fingerprint: h,
          status: "completed",
          invoice_id: "inv-zip",
        },
      ],
    });
    const r = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
    });
    expect(r.duplicados).toBe(2);
    expect(r.facturasEncoladas).toBe(3);
    expect(
      db.tablas["document_source_files"]!.find((f) => f["external_id"] === "f1"),
    ).toMatchObject({
      status: "duplicate",
      bulk_item_id: "zip-item",
    });
  });

  it("respeta el límite por revisión y deja el resto para la siguiente", async () => {
    const db = base();
    const r1 = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
      limite: 2,
    });
    expect([r1.facturasEncoladas, r1.pendientesProximaEjecucion]).toEqual([2, 3]);
    const r2 = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
      limite: 10,
    });
    expect([r2.facturasEncoladas, r2.pendientesProximaEjecucion]).toEqual([3, 0]);
  });

  it("si falta la carpeta del mes o la subcarpeta lo advierte sin inventar otra", async () => {
    arbol = arbol.filter((n) => n.id !== "sepFact" && n.parent !== "sepFact");
    const db = base();
    const r = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
    });
    expect(r.advertencias).toEqual(['2026/9. SEPTIEMBRE no tiene la subcarpeta "FACTURAS".']);
    expect(r.facturasEncoladas).toBe(4);
  });
});

describe("BALLET: OneDrive CONTABILIDAD → mes → COMPRAS / PAGOS", () => {
  beforeEach(() => {
    arbol = [
      DIR("oct", "OCTUBRE", "raiz"),
      DIR("sep", "SEPTIEMBRE", "raiz"),
      DIR("octCompras", "COMPRAS", "oct"),
      DIR("octPagos", "PAGOS", "oct"),
      DIR("sepPagos", "PAGOS", "sep"),
      PDF("fe1", "FE-105382 TELEVIGIA.pdf", "octCompras"),
      {
        id: "xls",
        name: "RECIBIDOS - BALLET octubre.xlsx",
        parent: "octCompras",
        content: recibidos([
          { numero: "1", cufe: "a" },
          { numero: "2", cufe: "b" },
        ]),
      },
      PDF("p1", "Transferencia TELEVIGIA.pdf", "octPagos"),
      PDF("p2", "Extracto Bancolombia octubre.pdf", "octPagos"),
      { id: "p3", name: "movimientos.xlsx", parent: "sepPagos" },
      PDF("p4", "Transferencia repetida.pdf", "sepPagos", { content: "p1" }),
    ];
  });

  it("compras: PDF a la carga masiva y cada documento del Excel RECIBIDOS como tarea propia", async () => {
    const db = base();
    const r = await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), {
      provider,
      ahora: AHORA,
    });
    expect(r.errores).toEqual([]);
    expect(r.advertencias).toEqual(['SEPTIEMBRE no tiene la subcarpeta "COMPRAS".']);
    expect(r.facturasEncoladas).toBe(1);
    expect(r.documentosExcel).toBe(2);
    const excelUpload = db.tablas["bulk_uploads"]!.find(
      (u) => u["file_name"] === "RECIBIDOS - BALLET octubre.xlsx",
    )!;
    expect(excelUpload["storage_path"]).toMatch(new RegExp(`^${DUENO}/${EMPRESA}/excel/`));
    const docs = db.tablas["bulk_upload_items"]!.filter(
      (i) => i["upload_id"] === excelUpload["id"],
    );
    expect(docs.map((d) => d["fingerprint"])).toEqual(["excel:FE1|a", "excel:FE2|b"]);
    expect(
      docs.every(
        (d) =>
          d["mime_type"] === "excel_document" && d["storage_path"] === excelUpload["storage_path"],
      ),
    ).toBe(true);
  });

  it("si el Excel RECIBIDOS se actualiza en el mes, solo entran los documentos nuevos", async () => {
    const db = base();
    await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), {
      provider,
      ahora: AHORA,
    });
    const xls = arbol.find((n) => n.id === "xls")!;
    xls.content = recibidos([
      { numero: "1", cufe: "a" },
      { numero: "2", cufe: "b" },
      { numero: "3", cufe: "c" },
    ]);
    xls.modified = "2026-10-29T10:00:00Z";
    const r = await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), {
      provider,
      ahora: AHORA,
    });
    expect(r.documentosExcel).toBe(1);
    expect(r.duplicados).toBe(2);
    expect(
      db.tablas["bulk_upload_items"]!.filter((i) => String(i["fingerprint"]).startsWith("excel:")),
    ).toHaveLength(3);
  });

  it("Excel RECIBIDOS: si se eliminaron sus borradores, se vuelve a leer y entran otra vez todos sus documentos", async () => {
    const db = base();
    await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), { provider, ahora: AHORA });
    // Tareas del Excel procesadas cuyos borradores la usuaria eliminó (el Excel no cambió).
    for (const t of db.tablas["bulk_upload_items"]!) Object.assign(t, { status: "completed", invoice_id: null });
    const r = await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), { provider, ahora: AHORA });
    expect(r.documentosExcel).toBe(2);
    expect(r.facturasEncoladas).toBe(1);
    expect(r.errores).toEqual([]);
  });

  it("Excel RECIBIDOS vigente (borradores existentes) no se vuelve a leer si no cambió", async () => {
    const db = base();
    await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), { provider, ahora: AHORA });
    for (const t of db.tablas["bulk_upload_items"]!) Object.assign(t, { status: "completed", invoice_id: "inv" });
    descargas.length = 0;
    const r = await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), { provider, ahora: AHORA });
    expect(r.documentosExcel).toBe(0);
    expect(r.facturasEncoladas).toBe(0);
    expect(descargas).toEqual([]);
  });

  it("un Excel de otra empresa no se carga y queda advertido", async () => {
    arbol.find((n) => n.id === "xls")!.content = recibidos(
      [{ numero: "9", cufe: "z" }],
      "900470166",
    );
    const db = base();
    const r = await syncSource(db.client, fuente("compras", "COMPRAS", "microsoft"), {
      provider,
      ahora: AHORA,
    });
    expect(r.documentosExcel).toBe(0);
    expect(r.advertencias.some((a) => a.includes("no es un Excel RECIBIDOS de la empresa"))).toBe(
      true,
    );
    expect(
      db.tablas["document_source_files"]!.find((f) => f["external_id"] === "xls"),
    ).toMatchObject({ status: "error" });
  });

  it("egresos: soportes y extractos a la bandeja, sin repetir el mismo archivo", async () => {
    const db = base();
    const r = await syncSource(db.client, fuente("egresos", "PAGOS", "microsoft"), {
      provider,
      ahora: AHORA,
    });
    expect(r.errores).toEqual([]);
    expect(r.egresosRecibidos).toBe(3);
    expect(r.duplicados).toBe(1);
    const bandeja = db.tablas["payment_documents"]!;
    expect(bandeja.map((p) => [p["file_name"], p["kind"], p["period"]])).toEqual(
      expect.arrayContaining([
        ["Transferencia TELEVIGIA.pdf", "soporte_pago", "OCTUBRE 2026"],
        ["Extracto Bancolombia octubre.pdf", "extracto", "OCTUBRE 2026"],
        ["movimientos.xlsx", "extracto", "SEPTIEMBRE 2026"],
      ]),
    );
    expect(
      bandeja.every((p) =>
        String(p["storage_path"]).startsWith(`${DUENO}/${EMPRESA}/egresos/src-egresos/`),
      ),
    ).toBe(true);
    expect(bandeja.every((p) => typeof p["source_file_id"] === "string")).toBe(true);
    // Los egresos no tocan la carga masiva de compras.
    expect(db.tablas["bulk_uploads"]).toHaveLength(0);
  });
});

describe("LED LIGHTS octubre: carpeta del mes + FACTURAS + RECIBIDOS (conciliación)", () => {
  // Proveedor del Excel de prueba: NIT 890903407, facturas FE1001 y FE1002.
  beforeEach(() => {
    arbol = [
      DIR("fact", "FACTURAS", "raiz"),
      DIR("cc", "CUENTAS DE COBRO", "raiz"),
      DIR("ext", "EXTRACTOS", "raiz"),
      PDF("cc1", "cuenta de cobro.pdf", "cc"),
      PDF("ex1", "Extracto Bancolombia.pdf", "ext"),
      DIR("prov", "PROVEEDOR XYZ", "fact"),
      // Misma factura FE-1001 subida por la empresa con el nombre de la DIAN.
      PDF("p1", "Corriente07 - fv089090340702826FE00001001.pdf", "prov"),
      // Factura que NO está en el token: se lee con IA.
      PDF("p2", "Efectivo08 - ad086001664002726566920261028175206607.pdf", "prov"),
      DIR("rec", "RECIBIDOS - LED LIGHTS SAS - 2026-10-01 a 2026-10-31", "fact"),
      {
        id: "x1",
        name: "RECIBIDOS - LED LIGHTS SAS - 2026-10-01 a 2026-10-31.xlsx",
        parent: "rec",
        content: recibidos([
          { numero: "1001", cufe: "a" },
          { numero: "1002", cufe: "b" },
        ]),
      },
      {
        id: "x2",
        name: "RECIBIDOS - LED LIGHTS SAS - 2026-10-01 a 2026-10-31 (2).xlsx",
        parent: "rec",
        content: recibidos([{ numero: "1002", cufe: "b" }]),
      },
      PDF("r1", "FE1001_890903407_PROVEEDOR XYZ.pdf", "rec"),
      PDF("r2", "FE1002_890903407_PROVEEDOR XYZ.pdf", "rec"),
      { id: "xml1", name: "FE1001_890903407_PROVEEDOR XYZ.xml", parent: "rec" },
    ];
  });

  it("toma solo FACTURAS, el Excel primero y no vuelve a cargar los PDF que ya están en el token", async () => {
    const db = base();
    const r = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
    });
    expect(r.errores).toEqual([]);
    expect(r.modo).toBe("carpeta_directa");
    // Ni CUENTAS DE COBRO, ni EXTRACTOS, ni XML.
    expect(descargas).not.toContain("cc1");
    expect(descargas).not.toContain("ex1");
    expect(descargas).not.toContain("xml1");
    // Excel: FE1001 y FE1002 una sola vez entre los dos archivos.
    expect(r.documentosExcel).toBe(2);
    expect(
      db.tablas["bulk_upload_items"]!.filter((i) =>
        String(i["fingerprint"]).startsWith("excel:"),
      ).map((i) => i["fingerprint"]),
    ).toEqual(["excel:FE1001|a", "excel:FE1002|b"]);
    // Los PDF de FE1001 y FE1002 (nombre DIAN y nombre RECIBIDOS) no se descargan ni se leen.
    expect(r.conciliados).toBe(3);
    for (const id of ["p1", "r1", "r2"]) {
      expect(descargas).not.toContain(id);
      expect(
        db.tablas["document_source_files"]!.find((f) => f["external_id"] === id),
      ).toMatchObject({ status: "duplicate" });
    }
    expect(
      db.tablas["document_source_files"]!.find((f) => f["external_id"] === "p1")!["message"],
    ).toContain("FE-1001 del NIT 890903407 ya está en el Excel RECIBIDOS");
    // Solo el PDF que no está en el token entra a la lectura con IA.
    expect(r.facturasEncoladas).toBe(1);
    expect(descargas.filter((d) => d.startsWith("p") || d.startsWith("r"))).toEqual(["p2"]);
  });

  it("un PDF de una factura ya causada en la app tampoco se vuelve a cargar", async () => {
    arbol = arbol.filter((n) => !["x1", "x2"].includes(n.id));
    const db = base({
      invoices: [
        {
          id: "i1",
          company_id: EMPRESA,
          provider_nit: "890903407",
          prefix: "FE",
          number: "1002",
          issue_date: "2026-10-05",
        },
      ],
    });
    const r = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
    });
    expect(descargas).not.toContain("r2");
    expect(
      db.tablas["document_source_files"]!.find((f) => f["external_id"] === "r2")!["message"],
    ).toContain("ya está en la app");
    expect(r.conciliados).toBe(1);
  });

  it("un Excel que quedó en error se vuelve a leer en la siguiente revisión", async () => {
    const db = base({
      document_source_files: [
        {
          id: "f-x1",
          company_id: EMPRESA,
          provider: "google",
          external_id: "x1",
          name: "RECIBIDOS - LED LIGHTS SAS - 2026-10-01 a 2026-10-31.xlsx",
          external_modified_at: "2026-10-20T10:00:00Z",
          status: "error",
        },
      ],
    });
    const r = await syncSource(db.client, fuente("compras", "FACTURAS"), {
      provider,
      ahora: AHORA,
    });
    expect(descargas).toContain("x1");
    expect(r.documentosExcel).toBe(2);
    expect(
      db.tablas["document_source_files"]!.find((f) => f["external_id"] === "x1"),
    ).toMatchObject({ status: "queued" });
  });

  it("si falta la subcarpeta no importa nada (nunca toma la carpeta completa)", async () => {
    const db = base();
    const r = await syncSource(db.client, fuente("compras", "COMPRAS"), { provider, ahora: AHORA });
    expect(descargas).toEqual([]);
    expect(r.advertencias[0]).toContain('no tiene la subcarpeta "COMPRAS"');
  });
});

describe("carpeta sin meses", () => {
  it("se revisa completa (modo carpeta directa)", async () => {
    arbol = [
      PDF("a", "a.pdf", "raiz"),
      DIR("prov", "PROVEEDOR X", "raiz"),
      PDF("b", "b.pdf", "prov"),
    ];
    const db = base();
    const r = await syncSource(db.client, fuente("compras", null), { provider, ahora: AHORA });
    expect(r.modo).toBe("carpeta_directa");
    expect(r.facturasEncoladas).toBe(2);
    expect(db.tablas["document_source_files"]!.every((f) => f["period"] === null)).toBe(true);
  });
});
