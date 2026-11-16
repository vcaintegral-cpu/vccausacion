import { describe, expect, it, vi } from "vitest";
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

describe("verificación con el extracto", () => {
  it("el grupo cuadra solo si los cargos del extracto suman el RP", async () => {
    vi.resetModules();
    vi.doMock("./conciliacion.functions", () => ({
      conciliacionFuentesCore: async () => ({
        pdfs: [{ etiqueta: "DAVIVIENDA" }],
        cuentas: [
          {
            etiqueta: "CORRIENTE",
            movimientos: [
              { valor: -1000, descripcion: "COMISION SERVICIO" },
              { valor: -500, descripcion: "GRAVAMEN 4X1000" },
              { valor: 300, descripcion: "RENDIMIENTOS FINANCIEROS" },
              { valor: -99999, descripcion: "PAGO PROVEEDOR" },
            ],
          },
          { etiqueta: "DAVIVIENDA", movimientos: [] },
        ],
      }),
    }));
    const { procesarGastosBancarios: proc } = await import("./piloto-gastos.server");
    const r = await proc(
      dbCon([
        fila("1", "bancario|CORRIENTE", "listo", 1000),
        fila("2", "bancario|CORRIENTE", "listo", 500),
        fila("3", "bancario|DAVIVIENDA", "listo", 700),
      ]),
      "c1",
      { periodo: "2026-11", tope: 5_000_000, enviar: false, cierre: true },
    );
    const cte = r.grupos.find((g) => g.banco === "CORRIENTE")!;
    expect(cte.extracto.cuadra).toBe(true);
    expect(cte.extracto.rendimientos).toBe(300);
    const dav = r.grupos.find((g) => g.banco === "DAVIVIENDA")!;
    expect(dav.extracto.cuadra).toBe(false);
    expect(dav.extracto.nota).toContain("PDF");
  });
});
