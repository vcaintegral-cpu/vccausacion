import { describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  actualizado: null as {
    raw_extraction?: { account_decisions?: Record<string, Record<string, unknown>> };
  } | null,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabla: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: "f2",
                status: "borrador",
                raw_extraction: {
                  ia: {
                    lines: [
                      { description: "Tubería sanitaria 4 pulgadas" },
                      { description: "Cosa rara" },
                    ],
                  },
                },
              },
              error: null,
            }),
          order: () =>
            Promise.resolve({
              data:
                tabla === "invoice_lines"
                  ? [
                      { position: 0, account_code: "", account_name: null },
                      { position: 1, account_code: "", account_name: null },
                    ]
                  : [],
              error: null,
            }),
        }),
      }),
      update: (v: unknown) => ({
        eq: () => {
          estado.actualizado = v as typeof estado.actualizado;
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
import { diffSnapshots, type DraftSnapshot } from "./draft-sync";

const snap = (p: Partial<DraftSnapshot> = {}): DraftSnapshot => ({
  gastos: [],
  iva: [],
  retefuente: [],
  reteiva: [],
  reteica: [],
  otras: [],
  payable: [],
  cost_center: [],
  tipos: [],
  ...p,
});

describe("cuenta y clasificación para los demás borradores del proveedor", () => {
  it("una factura que estaba SIN cuenta y ahora la tiene es un cambio a sincronizar", () => {
    const c = diffSnapshots(
      snap({ tipos: ["gasto"] }),
      snap({ gastos: ["621033"], tipos: ["gasto"] }),
    );
    expect(c).toEqual([expect.objectContaining({ kind: "gasto", old: "", new: "621033" })]);
  });

  it("el cambio de clasificación (gasto → producto) también se detecta", () => {
    const c = diffSnapshots(
      snap({ gastos: ["621033"], tipos: ["gasto"] }),
      snap({ gastos: ["621033"], tipos: ["producto"] }),
    );
    expect(c).toEqual([expect.objectContaining({ kind: "tipo", old: "gasto", new: "producto" })]);
  });

  it("como producto: usa el del catálogo que coincide con la descripción y, si no, el de la factura de origen", async () => {
    estado.actualizado = null;
    const config = {
      products: [
        { code: "TUB-SAN", name: "Tubería sanitaria 4 pulgadas", kind: "producto", active: true },
      ],
    } as never;
    const r = await asignarCuentaGasto("f2", { code: "621033", name: "Ferretería" }, config, {
      tipo: "producto",
      producto: { code: "GENERICO", name: "Ferretería genérica" },
    });
    expect(r.ok).toBe(true);
    expect(r.renglones).toBe(2);
    const d =
      (
        estado.actualizado as {
          raw_extraction?: { account_decisions?: Record<string, Record<string, unknown>> };
        } | null
      )?.raw_extraction?.account_decisions ?? {};
    expect(d["0"]).toMatchObject({
      origin: "MANUAL",
      itemType: "producto",
      productCode: "TUB-SAN",
    });
    expect(d["1"]).toMatchObject({
      origin: "MANUAL",
      itemType: "producto",
      productCode: "GENERICO",
    });
  });
});
