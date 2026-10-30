import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Drive simulado con la estructura real de LED LIGHTS.
// ---------------------------------------------------------------------------
const FOLDER = "application/vnd.google-apps.folder";
type Nodo = { id: string; name: string; mimeType: string; parent: string; content?: string };
let drive: Nodo[] = [];
const descargas: string[] = [];

vi.mock("@/lib/google-drive.server", () => ({
  FOLDER_MIME: "application/vnd.google-apps.folder",
  accessTokenForCompany: vi.fn(async () => "token"),
  listChildren: vi.fn(async (_t: string, id: string) => drive.filter((n) => n.parent === id)),
  listChildrenMany: vi.fn(async (_t: string, ids: string[]) =>
    drive.filter((n) => ids.includes(n.parent)).map((n) => ({ ...n, parents: [n.parent] })),
  ),
  downloadFile: vi.fn(async (_t: string, id: string) => {
    descargas.push(id);
    return new TextEncoder().encode(drive.find((n) => n.id === id)!.content ?? id);
  }),
}));

const { syncDriveCompany } = await import("./drive-sync.server");

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
    const ejecutar = () => {
      if (op === "insert") {
        const nuevas = payload.map((p) => ({ id: `${tabla}-${++seq}`, ...p }));
        filas().push(...nuevas);
        return nuevas;
      }
      if (op === "upsert") {
        for (const p of payload) {
          const existente = filas().find((f) => conflicto.every((k) => f[k] === p[k]));
          if (existente) Object.assign(existente, p);
          else filas().push({ id: `${tabla}-${++seq}`, ...p });
        }
        return payload;
      }
      const sel = filas().filter((f) => filtros.every((fn) => fn(f)));
      if (op === "update") sel.forEach((f) => Object.assign(f, patch));
      return sel.map((f) =>
        tabla === "drive_sync_sources"
          ? { ...f, company: tablas["companies"]!.find((c) => c["id"] === f["company_id"]) }
          : f,
      );
    };
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => (filtros.push((f) => f[k] === v), b),
      in: (k: string, vs: unknown[]) => (filtros.push((f) => vs.includes(f[k])), b),
      limit: () => b,
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
    from: () => ({
      upload: async (path: string) => {
        subidas.push(path);
        return { error: null };
      },
    }),
  };
  return { client: { from, storage } as unknown as SupabaseClient, tablas, subidas };
}

const EMPRESA = "c0ffee00-0000-4000-8000-000000000001";
const DUENO = "u0000000-0000-4000-8000-000000000001";
const AHORA = new Date("2026-10-30T23:00:00Z");

function estructuraLedLights() {
  drive = [
    { id: "y2026", name: "2026", mimeType: FOLDER, parent: "raiz" },
    { id: "y2025", name: "2025", mimeType: FOLDER, parent: "raiz" },
    { id: "oct", name: "10. OCTUBRE", mimeType: FOLDER, parent: "y2026" },
    { id: "sep", name: "9. SEPTIEMBRE", mimeType: FOLDER, parent: "y2026" },
    { id: "jun", name: "6. JUNIO", mimeType: FOLDER, parent: "y2026" },
    { id: "octFact", name: "FACTURAS", mimeType: FOLDER, parent: "oct" },
    { id: "octCC", name: "CUENTAS DE COBRO", mimeType: FOLDER, parent: "oct" },
    { id: "sepFact", name: "FACTURAS", mimeType: FOLDER, parent: "sep" },
    { id: "mega", name: "MEGA LUCES S.A.S", mimeType: FOLDER, parent: "octFact" },
    { id: "tcc", name: "1. PEND. - TCC SAS", mimeType: FOLDER, parent: "octFact" },
    { id: "tccCli", name: "De Clientes", mimeType: FOLDER, parent: "tcc" },
    {
      id: "f1",
      name: "Corriente16 - fv090004721702826FECT00274124.pdf",
      mimeType: "application/pdf",
      parent: "mega",
    },
    {
      id: "f2",
      name: "Efectivo+Corriente01 - fv090004721702826FECT00271600.pdf",
      mimeType: "application/pdf",
      parent: "mega",
    },
    {
      id: "f3",
      name: "ad086001664002726566920261028175206607.pdf",
      mimeType: "application/pdf",
      parent: "tcc",
    },
    { id: "f4", name: "guia.pdf", mimeType: "application/pdf", parent: "tccCli" },
    { id: "xml", name: "factura.xml", mimeType: "text/xml", parent: "mega" },
    { id: "cc1", name: "cuenta de cobro.pdf", mimeType: "application/pdf", parent: "octCC" },
    {
      id: "s1",
      name: "Efectivo05 - fe-septiembre.pdf",
      mimeType: "application/pdf",
      parent: "sepFact",
    },
    { id: "j1", name: "junio.pdf", mimeType: "application/pdf", parent: "jun" },
  ];
}

function baseDatos(extra: Record<string, Fila[]> = {}) {
  return fakeDb({
    companies: [{ id: EMPRESA, created_by: DUENO }],
    drive_sync_sources: [{ company_id: EMPRESA, root_folder_id: "raiz", enabled: true }],
    drive_sync_files: [],
    bulk_uploads: [],
    bulk_upload_items: [],
    ...extra,
  });
}

beforeEach(() => {
  estructuraLedLights();
  descargas.length = 0;
});

describe("syncDriveCompany", () => {
  it("encola los PDF de FACTURAS del mes actual y el anterior, incluidas subcarpetas", async () => {
    const db = baseDatos();
    const r = await syncDriveCompany(db.client, EMPRESA, { ahora: AHORA });

    expect(r.errores).toEqual([]);
    expect(r.periodos).toEqual(["OCTUBRE 2026", "SEPTIEMBRE 2026"]);
    // f1, f2, f3, f4 (octubre, con subcarpetas "1. PEND." y "De Clientes") + s1 (septiembre).
    expect(r.encontrados).toBe(5);
    expect(r.encolados).toBe(5);
    expect(descargas.sort()).toEqual(["f1", "f2", "f3", "f4", "s1"]);
    // No toca CUENTAS DE COBRO, XML ni meses fuera del rango.
    expect(descargas).not.toContain("cc1");
    expect(descargas).not.toContain("xml");
    expect(descargas).not.toContain("j1");

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
    // La ruta permite leer el PDF a cualquier miembro de la empresa (política "facturas read company").
    expect(
      db.subidas.every((p) => p.startsWith(`${DUENO}/${EMPRESA}/drive/${upload!["id"]}/`)),
    ).toBe(true);

    const f1 = db.tablas["drive_sync_files"]!.find((f) => f["drive_file_id"] === "f1")!;
    expect(f1).toMatchObject({
      status: "queued",
      payment_sources: ["corriente"],
      payment_day: 16,
      period: "OCTUBRE 2026",
    });
    const f2 = db.tablas["drive_sync_files"]!.find((f) => f["drive_file_id"] === "f2")!;
    expect(f2["payment_sources"]).toEqual(["efectivo", "corriente"]);
    const f4 = db.tablas["drive_sync_files"]!.find((f) => f["drive_file_id"] === "f4")!;
    expect(f4["folder_path"]).toBe("2026/10. OCTUBRE/FACTURAS/1. PEND. - TCC SAS/De Clientes");
    expect(db.tablas["drive_sync_sources"]![0]).toMatchObject({ last_status: "ok" });
  });

  it("la segunda ejecución no vuelve a descargar y solo registra el renombre por pago", async () => {
    const db = baseDatos();
    await syncDriveCompany(db.client, EMPRESA, { ahora: AHORA });
    descargas.length = 0;
    drive.find((n) => n.id === "f3")!.name =
      "Efectivo27 - ad086001664002726566920261028175206607.pdf";

    const r = await syncDriveCompany(db.client, EMPRESA, { ahora: AHORA });
    expect(descargas).toEqual([]);
    expect(r.encolados).toBe(0);
    expect(r.renombrados).toBe(1);
    expect(db.tablas["bulk_uploads"]).toHaveLength(1);
    const f3 = db.tablas["drive_sync_files"]!.find((f) => f["drive_file_id"] === "f3")!;
    expect(f3).toMatchObject({ payment_sources: ["efectivo"], payment_day: 27, status: "queued" });
  });

  it("no encola un PDF que ya se cargó antes por ZIP (misma huella) ni repetidos en la carpeta", async () => {
    drive.find((n) => n.id === "f2")!.content = "mismo contenido";
    drive.find((n) => n.id === "f3")!.content = "mismo contenido";
    const huellaF1 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("f1"))),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const db = baseDatos({
      bulk_upload_items: [
        {
          id: "zip-item",
          upload_id: "zip",
          company_id: EMPRESA,
          fingerprint: huellaF1,
          status: "completed",
        },
      ],
    });

    const r = await syncDriveCompany(db.client, EMPRESA, { ahora: AHORA });
    expect(r.duplicados).toBe(2);
    expect(r.encolados).toBe(3);
    const f1 = db.tablas["drive_sync_files"]!.find((f) => f["drive_file_id"] === "f1")!;
    expect(f1).toMatchObject({ status: "duplicate", bulk_item_id: "zip-item" });
    const nuevos = db.tablas["bulk_upload_items"]!.filter((i) => i["upload_id"] !== "zip");
    expect(new Set(nuevos.map((i) => i["fingerprint"])).size).toBe(nuevos.length);
  });

  it("respeta el límite por ejecución y deja el resto para la siguiente", async () => {
    const db = baseDatos();
    const r1 = await syncDriveCompany(db.client, EMPRESA, { ahora: AHORA, limite: 2 });
    expect(r1.encolados).toBe(2);
    expect(r1.pendientesProximaEjecucion).toBe(3);
    const r2 = await syncDriveCompany(db.client, EMPRESA, { ahora: AHORA, limite: 10 });
    expect(r2.encolados).toBe(3);
    expect(r2.pendientesProximaEjecucion).toBe(0);
  });

  it("si falta la carpeta del mes lo advierte sin inventar otra", async () => {
    drive = drive.filter((n) => n.id !== "sep" && n.parent !== "sep" && n.parent !== "sepFact");
    const db = baseDatos();
    const r = await syncDriveCompany(db.client, EMPRESA, { ahora: AHORA });
    expect(r.advertencias).toEqual(["No existe la carpeta de SEPTIEMBRE 2026."]);
    expect(r.encolados).toBe(4);
  });
});
