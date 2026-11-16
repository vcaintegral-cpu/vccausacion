import { describe, expect, it } from "vitest";

import { tareaMuerta } from "./document-sync.server";

describe("tareas que la revisión de carpetas vuelve a encolar", () => {
  it("una tarea cancelada o completada sin factura está muerta y se vuelve a encolar", () => {
    expect(tareaMuerta({ status: "cancelled" })).toBe(true);
    expect(tareaMuerta({ status: "completed", invoice_id: null })).toBe(true);
    expect(tareaMuerta({ status: "completed", invoice_id: "f1" })).toBe(false);
    expect(tareaMuerta({ status: "pending" })).toBe(false);
  });

  it("lo que el piloto apartó por no ser del mes NO se vuelve a encolar (evita leerlo con IA cada noche)", () => {
    expect(tareaMuerta({ status: "cancelled", stage: "fuera_de_mes" })).toBe(false);
    expect(tareaMuerta({ status: "cancelled", stage: "otra" })).toBe(true);
  });
});
