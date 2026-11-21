import { describe, expect, it } from "vitest";
import { errorComoTexto } from "./bulk-invoices";

describe("errorComoTexto", () => {
  it("convierte errores de Supabase (objetos planos) a texto con código", () => {
    expect(errorComoTexto({ message: "duplicate key value", details: "Key (x)=(1)", code: "23505" })).toBe(
      "duplicate key value · Key (x)=(1) (código 23505)",
    );
  });
  it("respeta Error y texto", () => {
    expect(errorComoTexto(new Error("hola"))).toBe("hola");
    expect(errorComoTexto("x")).toBe("x");
  });
});
