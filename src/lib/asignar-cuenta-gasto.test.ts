import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  inv: {
    id: "f1",
    status: "borrador",
    raw_extraction: {
      ia: { lines: [{}, {}, {}] },
      account_decisions: { "0": { code: "621020", origin: "HISTORIAL" } },
    },
  } as Record<string, unknown>,
  lineas: [
    { position: 0, account_code: "621020" },
    { position: 1, account_code: "" },
    { position: 2, account_code: "130505" },
  ],
  actualizado: null as unknown,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabla: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: estado.inv, error: null }),
          order: () =>
            Promise.resolve({ data: tabla === "invoice_lines" ? estado.lineas : [], error: null }),
        }),
      }),
      update: (v: unknown) => ({
        eq: () => {
          estado.actualizado = v;
          return Promise.resolve({ error: null });
        },
      }),
    }),
  },
}));
vi.mock("@/lib/bulk-invoices", () => ({
  recalcularCuentasBorrador: () => Promise.resolve({ ok: true, message: "ok" }),
}));

import { asignarCuentaGasto } from "./asignar-cuenta-gasto";

describe("asignar cuenta de gasto en borradores", () => {
  beforeEach(() => {
    estado.actualizado = null;
  });

  it("solo completa los renglones pendientes y los marca como cuenta manual", async () => {
    const r = await asignarCuentaGasto("f1", { code: "621033", name: "Ferretería" }, {} as never);
    expect(r.ok).toBe(true);
    expect(r.renglones).toBe(2);
    const dec = (
      estado.actualizado as {
        raw_extraction: { account_decisions: Record<string, { code: string; origin: string }> };
      }
    ).raw_extraction.account_decisions;
    expect(dec["0"]).toMatchObject({ code: "621020", origin: "HISTORIAL" });
    expect(dec["1"]).toMatchObject({ code: "621033", origin: "MANUAL" });
    expect(dec["2"]).toMatchObject({ code: "621033", origin: "MANUAL" });
  });

  it("con la opción «todos» reemplaza también los que ya tenían cuenta", async () => {
    const r = await asignarCuentaGasto("f1", { code: "621033", name: null }, {} as never, {
      todos: true,
    });
    expect(r.renglones).toBe(3);
  });

  it("rechaza una cuenta que no es de gasto, costo o inventario", async () => {
    const r = await asignarCuentaGasto("f1", { code: "220505", name: null }, {} as never);
    expect(r.ok).toBe(false);
    expect(estado.actualizado).toBeNull();
  });
});
