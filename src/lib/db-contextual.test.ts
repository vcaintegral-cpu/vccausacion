import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { origen: "navegador", from: () => "tabla-navegador", rpc: () => "rpc-navegador" },
}));

import { conClienteDeServicio, supabase } from "./db-contextual";

describe("cliente de base de datos contextual", () => {
  it("fuera del piloto usa el cliente del navegador", () => {
    expect((supabase as unknown as { origen: string }).origen).toBe("navegador");
    expect(supabase.from("x" as never)).toBe("tabla-navegador");
  });

  it("dentro del piloto usa el cliente de servicio y después vuelve al del navegador", async () => {
    const servicio = {
      origen: "servicio",
      from: () => "tabla-servicio",
      rpc: () => "rpc-servicio",
    };
    const dentro = await conClienteDeServicio(servicio, async () => [
      (supabase as unknown as { origen: string }).origen,
      supabase.from("x" as never),
      (supabase.rpc as unknown as (f: string) => string)("f"),
    ]);
    expect(dentro).toEqual(["servicio", "tabla-servicio", "rpc-servicio"]);
    expect((supabase as unknown as { origen: string }).origen).toBe("navegador");
  });

  it("no permite dos ejecuciones del piloto al mismo tiempo y libera el cliente si falla", async () => {
    const servicio = { origen: "servicio" };
    await expect(
      conClienteDeServicio(servicio, () => conClienteDeServicio(servicio, async () => 1)),
    ).rejects.toThrow(/en curso/);
    expect((supabase as unknown as { origen: string }).origen).toBe("navegador");
    await expect(
      conClienteDeServicio(servicio, async () => Promise.reject(new Error("falla"))),
    ).rejects.toThrow("falla");
    expect((supabase as unknown as { origen: string }).origen).toBe("navegador");
  });
});
