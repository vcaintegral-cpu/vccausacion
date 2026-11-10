// Pausar / cancelar la carga masiva: las facturas en curso terminan y no se toma ninguna más.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Item = { id: string; upload_id: string; status: string; attempts: number; fingerprint: string | null; storage_path: string | null; file_name: string; needs_review?: boolean };

const db = vi.hoisted(() => ({
  items: [] as Item[],
  uploadStatus: [] as string[],
  procesadas: [] as string[],
  activas: [] as Array<{ id: string; file_name: string; status: string }>,
}));

// Cliente de base de datos de mentira: cualquier consulta encadenada devuelve vacío.
vi.mock("@/integrations/supabase/client", () => {
  const vacio = { data: [], error: null };
  const cadena: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (r: (v: unknown) => void) => r(vacio);
        if (prop === "single" || prop === "maybeSingle")
          return () => Promise.resolve({ data: { id: "c1", name: "EMPRESA", nit: "900000000" }, error: null });
        return () => cadena;
      },
    },
  );
  return {
    supabase: {
      from: () => cadena,
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } } }) },
    },
  };
});
vi.mock("@/lib/extract.functions", () => ({ extractInvoice: vi.fn() }));
vi.mock("@/lib/puc-data", () => ({ fetchCompanyPuc: () => Promise.resolve([]) }));
vi.mock("@/lib/causacion-engine", () => ({ fetchCompanyKnowledge: () => Promise.resolve({}) }));
vi.mock("@/lib/provider-rules", () => ({ fetchProviderRules: () => Promise.resolve([]) }));
vi.mock("@/lib/iva-treatment", () => ({ fetchIvaConfig: () => Promise.resolve() }));
vi.mock("@/lib/precedente-tributario.data", () => ({
  cargarPrecedentes: () => Promise.resolve(),
  cargarHistorialCompras: () => Promise.resolve({ compras: [], perfiles: new Map() }),
  cargarTablasBases: () => Promise.resolve(),
  invalidarPrecedentes: () => undefined,
  invalidarTablasBases: () => undefined,
}));
vi.mock("@/lib/bulk-invoices", () => ({
  BulkInvoiceStageError: class extends Error {},
  resetBulkBatch: () => undefined,
  saveExtractedInvoice: vi.fn(),
  // Cada factura tarda un poco, como la lectura con IA.
  processInvoiceFile: async ({ storagePath }: { storagePath: string }) => {
    await new Promise((r) => setTimeout(r, 20));
    db.procesadas.push(storagePath);
    return { invoiceId: storagePath, numero: storagePath, total: 1, score: 1, needsReview: false, readMode: "texto" };
  },
}));
vi.mock("@/lib/bulk-upload-store", () => {
  const PEND = ["pending", "downloading", "reading", "ocr", "extracting_data", "validating_company", "ready_for_accounting", "processing"];
  return {
    ACTIVE_STATUSES: ["uploaded", "extracting", "processing", "completed_with_errors"],
    fileFromStorage: async () => ({ file: {}, size: 1, mimeType: "application/pdf" }),
    listItems: async () => db.items.map((i) => ({ ...i })),
    listItemStatuses: async () => db.items.map((i) => ({ id: i.id, status: i.status, needs_review: false })),
    updateItems: async (ids: string[], patch: Partial<Item>) => {
      for (const it of db.items) if (ids.includes(it.id)) Object.assign(it, patch);
    },
    listUploads: async () => [],
    listActiveUploads: async () => db.activas,
    mensajeUsuario: (_f: string, e: string) => e,
    updateItem: async (id: string, patch: Partial<Item>) => {
      const it = db.items.find((i) => i.id === id);
      if (it) Object.assign(it, patch);
    },
    updateUpload: async (_id: string, patch: { status?: string }) => {
      if (patch.status) db.uploadStatus.push(patch.status);
    },
    cancelPendingItems: async () => {
      for (const i of db.items) if (i.status === "pending") i.status = "cancelled";
    },
    refreshUploadCounters: async (_id: string, items: Item[], fijo?: string) => {
      const pend = items.filter((i) => PEND.includes(i.status)).length;
      db.uploadStatus.push(fijo ?? (pend > 0 ? "processing" : "completed"));
      return fijo;
    },
  };
});

const { detenerCarga, getBulkProgress, resumeBackgroundUploads, startBackgroundUpload } = await import("./bulk-runner");

const esperar = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

function cargar(n: number) {
  db.items = Array.from({ length: n }, (_, k) => ({
    id: `i${k}`,
    upload_id: "up1",
    status: "pending",
    attempts: 0,
    fingerprint: null,
    storage_path: `f${k}`,
    file_name: `f${k}.pdf`,
  }));
  db.uploadStatus = [];
  db.procesadas = [];
}

const job = { uploadId: "up1", companyId: "c1", fileName: "octubre.zip" };

describe("detener la carga masiva", () => {
  beforeEach(async () => {
    await esperar(() => !getBulkProgress().running);
  });

  it("Pausar: terminan las 5 en curso, las demás quedan pendientes y Reanudar las completa", async () => {
    cargar(20);
    startBackgroundUpload(job);
    await esperar(() => db.items.some((i) => i.status === "downloading"));
    await detenerCarga("up1", "pausar");
    await esperar(() => !getBulkProgress().running);

    expect(db.procesadas.length).toBeLessThanOrEqual(5);
    expect(db.items.filter((i) => i.status === "pending").length).toBeGreaterThanOrEqual(15);
    expect(db.uploadStatus.at(-1)).toBe("paused");

    startBackgroundUpload(job); // Reanudar
    await esperar(() => !getBulkProgress().running && db.items.every((i) => i.status === "completed"));
    expect(db.items.every((i) => i.status === "completed")).toBe(true);
    expect(new Set(db.procesadas).size).toBe(20); // ninguna se procesó dos veces
    expect(db.procesadas.length).toBe(20);
  });

  it("Cancelar: las pendientes quedan canceladas y la carga no sigue sola", async () => {
    cargar(20);
    startBackgroundUpload(job);
    await esperar(() => db.items.some((i) => i.status === "downloading"));
    await detenerCarga("up1", "cancelar");
    await esperar(() => !getBulkProgress().running);
    await new Promise((r) => setTimeout(r, 60));

    expect(db.procesadas.length).toBeLessThanOrEqual(5);
    expect(db.items.filter((i) => i.status === "cancelled").length).toBeGreaterThanOrEqual(15);
    expect(db.items.some((i) => i.status === "pending")).toBe(false);
    expect(db.uploadStatus.at(-1)).toBe("cancelled");
  });
});

describe("cargas creadas por la revisión de carpetas", () => {
  beforeEach(async () => {
    await esperar(() => !getBulkProgress().running);
  });

  it("se procesan solas (sin Continuar procesamiento) y no se duplican si el aviso coincide", async () => {
    cargar(8);
    db.activas = [{ id: "up1", file_name: "Fuente automática · PDF", status: "processing" }];
    // El aviso periódico y el de "Revisar ahora" llegan a la vez.
    await Promise.all([resumeBackgroundUploads("c1"), resumeBackgroundUploads("c1")]);
    await resumeBackgroundUploads("c1"); // mientras ya está procesando, no se vuelve a encolar
    await esperar(() => !getBulkProgress().running && db.items.every((i) => i.status === "completed"));
    expect(db.items.every((i) => i.status === "completed")).toBe(true);
    expect(db.procesadas.length).toBe(8);
    expect(new Set(db.procesadas).size).toBe(8);
    db.activas = [];
  });

  it("sin facturas pendientes no inicia nada", async () => {
    cargar(3);
    for (const i of db.items) i.status = "completed";
    db.activas = [{ id: "up1", file_name: "x", status: "completed_with_errors" }];
    await resumeBackgroundUploads("c1");
    expect(getBulkProgress().running).toBe(false);
    expect(db.procesadas).toEqual([]);
    db.activas = [];
  });
});
