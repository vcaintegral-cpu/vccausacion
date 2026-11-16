import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db-contextual", () => ({ supabase: {} }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { motivosNoVerde, type EntradaVerde } from "./piloto-verde";

const base: EntradaVerde = {
  alertas: [{ level: "ok", message: "Recomendación completa." }],
  tareaSinRevision: true,
  confianzas: ["ALTA", "ALTA"],
  total: 1_000_000,
  tope: 5_000_000,
};

describe("semáforo del piloto: ¿se envía a Siigo sin preguntar?", () => {
  it("una factura sin alertas, con cuentas de confianza alta y bajo el tope es verde", () => {
    expect(motivosNoVerde(base)).toEqual([]);
  });

  it("cualquier error de la revisión la deja por revisar", () => {
    const m = motivosNoVerde({
      ...base,
      alertas: [{ level: "error", message: "Pendiente de cuenta de gasto/costo." }],
    });
    expect(m).toEqual(["Pendiente de cuenta de gasto/costo."]);
  });

  it("una advertencia la deja por revisar, salvo «periodo anterior» (el mes de trabajo ya lo controla)", () => {
    expect(
      motivosNoVerde({
        ...base,
        alertas: [{ level: "warn", message: "Posible gasto de periodo anterior: la fecha…" }],
      }),
    ).toEqual([]);
    expect(
      motivosNoVerde({
        ...base,
        alertas: [{ level: "warn", message: "Confirmar cruce de anticipo" }],
      }),
    ).toHaveLength(1);
  });

  it("una cuenta de confianza media o baja pide validar", () => {
    const m = motivosNoVerde({ ...base, confianzas: ["ALTA", "MEDIA", "BAJA"] });
    expect(m).toEqual(["2 renglón(es) con cuenta de confianza media o baja: valide la cuenta."]);
  });

  it("supera el tope o la tarea fue marcada para revisión", () => {
    expect(motivosNoVerde({ ...base, total: 6_000_000 })[0]).toMatch(/Supera el tope/);
    expect(motivosNoVerde({ ...base, tareaSinRevision: false })[0]).toMatch(/marcó para revisión/);
    expect(motivosNoVerde({ ...base, total: 0 })[0]).toMatch(/total inválido/);
  });
});
