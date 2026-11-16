import { describe, expect, it } from "vitest";
import { procesarGastosBancarios } from "./piloto-gastos.server";

// Cliente falso: la consulta devuelve las filas dadas (datos ficticios).
const dbCon = (filas: unknown[]) => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "like"]) q[m] = () => q;
  q["limit"] = async () => ({ data: filas, error: null });
  return { from: () => q } as never;
};

const fila = (
  id: string,
  grupo: string,
  estado: string,
  valor: number,
  motivos: string[] = [],
) => ({
  id,
  valor,
  estado,
  propuesta: { grupo },
  motivos,
  siigo_id: null,
});

describe("procesarGastosBancarios", () => {
  it("agrupa por banco y reporta lo que falta sin enviar (modo prueba)", async () => {
    const r = await procesarGastosBancarios(
      dbCon([
        fila("1", "bancario|CORRIENTE", "listo", 1000),
        fila("2", "bancario|CORRIENTE", "por_revisar", 500, ["Falta la cuenta débito"]),
        fila("3", "bancario|AHORROS", "aprobado", 200),
      ]),
      "c1",
      { periodo: "2026-11", tope: 5_000_000, enviar: false, cierre: true },
    );
    expect(r.grupos).toHaveLength(2);
    const cte = r.grupos.find((g) => g.banco === "CORRIENTE")!;
    expect(cte.movimientos).toBe(2);
    expect(cte.valor).toBe(1500);
    expect(cte.listos).toBe(1);
    expect(cte.faltante).toBe("Falta la cuenta débito");
    expect(r.grupos.find((g) => g.banco === "AHORROS")!.faltante).toBeNull();
    expect(r.enviados).toBe(0);
  });

  it("sin gastos bancarios devuelve la lista vacía", async () => {
    const r = await procesarGastosBancarios(dbCon([]), "c1", {
      periodo: "2026-11",
      tope: 1,
      enviar: true,
      cierre: false,
    });
    expect(r.grupos).toEqual([]);
  });
});
