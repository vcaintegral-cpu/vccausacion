import { describe, expect, it } from "vitest";

import { enParalelo } from "./concurrencia";

describe("enParalelo", () => {
  it("respeta el límite, conserva el orden y no se detiene por un fallo manejado", async () => {
    let enCurso = 0;
    let maximo = 0;
    const r = await enParalelo([5, 1, 4, 2, 3, 0], 3, async (n, i) => {
      enCurso += 1;
      maximo = Math.max(maximo, enCurso);
      await new Promise((ok) => setTimeout(ok, n * 3));
      enCurso -= 1;
      return i === 2 ? "fallo" : n * 10;
    });
    expect(maximo).toBe(3);
    expect(r).toEqual([50, 10, "fallo", 20, 30, 0]);
    expect(await enParalelo([], 4, async () => 1)).toEqual([]);
  });
});
