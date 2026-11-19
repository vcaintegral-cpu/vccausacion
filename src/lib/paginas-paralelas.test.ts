import { describe, expect, it } from "vitest";
import { leerPaginas } from "./paginas-paralelas";

const tabla = (n: number) => async (desde: number, hasta: number) => ({
  data: Array.from(
    { length: Math.max(0, Math.min(hasta, n - 1) - desde + 1) },
    (_, i) => desde + i,
  ),
  error: null,
});

describe("leerPaginas", () => {
  it("devuelve todas las filas en orden, sin repetir ni saltar, con cualquier tamaño", async () => {
    for (const n of [0, 1, 999, 1000, 1001, 5999, 6000, 6001, 13250]) {
      const r = await leerPaginas<number>(tabla(n), { pagina: 1000, paralelo: 6 });
      expect(r).toHaveLength(n);
      if (n > 0) expect(r[n - 1]).toBe(n - 1);
      expect(new Set(r).size).toBe(n);
    }
  });
  it("propaga el error de una página", async () => {
    await expect(
      leerPaginas(async () => ({ data: null, error: { message: "falló" } })),
    ).rejects.toThrow("falló");
  });
  it("respeta el máximo", async () => {
    const r = await leerPaginas<number>(tabla(50000), { maximo: 3000 });
    expect(r.length).toBeGreaterThanOrEqual(3000);
    expect(r.length).toBeLessThan(50000);
  });
});
