import { describe, expect, it, vi } from "vitest";

// Cliente falso: una factura con 2 renglones; el primero corregido a mano (cuenta distinta a la propuesta).
const llamadas: Array<Record<string, unknown>> = [];
vi.mock("./learning-rules", () => ({
  aprenderDeCausacion: async (p: Record<string, unknown>) => {
    llamadas.push(p);
  },
}));

const tabla = (datos: unknown[]) => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lte", "is", "order", "update"]) q[m] = () => q;
  q["limit"] = async () => ({ data: datos, error: null });
  (q as { then?: unknown }).then = undefined;
  q["order"] = async () => ({ data: datos, error: null });
  return q;
};

describe("aprenderDeBorradoresManuales", () => {
  it("aprende solo lo corregido a mano y no repite el mismo estado", async () => {
    const { aprenderDeBorradoresManuales } = await import("./aprender-borradores");
    const factura = {
      id: "f1",
      provider_nit: "900111222",
      provider_name: "PROVEEDOR PRUEBA",
      cost_center: null,
      raw_extraction: {
        account_decisions: {
          "0": { code: "51952501", origin: "HISTORIAL" },
          "1": { code: "51055101", origin: "HISTORIAL" },
        },
      },
    };
    const lineas = [
      {
        position: 0,
        description: "Resma de papel",
        item_type: "gasto",
        account_code: "51959501",
        account_name: "Implementos",
        iva: 0,
      },
      {
        position: 1,
        description: "Dotación",
        item_type: "gasto",
        account_code: "51055101001",
        account_name: "Dotación",
        iva: 0,
      },
    ];
    const db = {
      from: (t: string) => (t === "invoices" ? tabla([factura]) : tabla(lineas)),
    } as never;
    const n = await aprenderDeBorradoresManuales(
      db,
      "c1",
      { desde: "2026-11-01", hasta: "2026-11-30" },
      "u1",
    );
    expect(n).toBe(1);
    expect(llamadas).toHaveLength(1);
    const l = (llamadas[0] as { lines: Array<{ account_code: string; item_type: string }> }).lines;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ account_code: "51959501", item_type: "gasto" });
    // Sin usuario no aprende nada.
    expect(await aprenderDeBorradoresManuales(db, "c1", { desde: "a", hasta: "b" }, null)).toBe(0);
  });
});
