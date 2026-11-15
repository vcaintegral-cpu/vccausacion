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
    { position: 0, account_code: "621020", account_name: "Maderas" },
    { position: 1, account_code: "", account_name: null },
    { position: 2, account_code: "130505", account_name: "Clientes" },
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

  it("una cuenta de IVA de costo puesta como gasto cuenta como pendiente", async () => {
    estado.lineas = [
      { position: 0, account_code: "621008", account_name: "IVA de Costo" },
      { position: 1, account_code: "621020", account_name: "Maderas" },
    ];
    estado.inv = { id: "f1", status: "borrador", raw_extraction: { ia: { lines: [{}, {}] } } };
    const r = await asignarCuentaGasto("f1", { code: "621033", name: "Ferretería" }, {
      taxes: [{ kind: "iva", account_code: "621008" }],
    } as never);
    expect(r.renglones).toBe(1);
    const dec = (
      estado.actualizado as {
        raw_extraction: { account_decisions: Record<string, { code: string }> };
      }
    ).raw_extraction.account_decisions;
    expect(dec["0"]?.code).toBe("621033");
    expect(dec["1"]).toBeUndefined();
  });

  it("elección explícita sobre una factura sin pendientes detectados: se aplica a todos los renglones", async () => {
    estado.lineas = [
      { position: 0, account_code: "621020", account_name: "Maderas" },
      { position: 1, account_code: "621020", account_name: "Maderas" },
    ];
    estado.inv = { id: "f1", status: "borrador", raw_extraction: { ia: { lines: [{}, {}] } } };
    const sin = await asignarCuentaGasto("f1", { code: "621033", name: null }, {} as never);
    expect(sin.renglones).toBe(0);
    const explicita = await asignarCuentaGasto("f1", { code: "621033", name: null }, {} as never, {
      siNingunoTodos: true,
    });
    expect(explicita.renglones).toBe(2);
  });
});
