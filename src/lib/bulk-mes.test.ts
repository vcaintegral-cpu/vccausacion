import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { FueraDeMesError, verificarMes } from "./bulk-invoices";

const mes = { desde: "2026-11-01", hasta: "2026-11-30", etiqueta: "noviembre de 2026" };

describe("filtro por mes de trabajo en la causación", () => {
  it("sin mes de trabajo no filtra nada (navegador)", () => {
    expect(() => verificarMes("2020-01-01", undefined)).not.toThrow();
  });

  it("deja pasar los documentos del mes", () => {
    expect(() => verificarMes("2026-11-01", mes)).not.toThrow();
    expect(() => verificarMes("2026-11-30", mes)).not.toThrow();
  });

  it("aparta los de meses anteriores (cerrados) y posteriores (se retoman luego)", () => {
    try {
      verificarMes("2026-10-31", mes);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FueraDeMesError);
      expect((e as FueraDeMesError).ubicacion).toBe("anterior");
      expect((e as FueraDeMesError).fecha).toBe("2026-10-31");
    }
    try {
      verificarMes("2026-12-01", mes);
      expect.unreachable();
    } catch (e) {
      expect((e as FueraDeMesError).ubicacion).toBe("posterior");
    }
  });

  it("un documento sin fecha legible no se causa a ciegas", () => {
    expect(() => verificarMes(null, mes)).toThrow(FueraDeMesError);
    expect(() => verificarMes("11/2026", mes)).toThrow(/Sin fecha legible/);
  });
});
