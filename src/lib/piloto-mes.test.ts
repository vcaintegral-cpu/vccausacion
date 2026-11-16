import { describe, expect, it } from "vitest";

import {
  etiquetaMes,
  mesDeTrabajo,
  primerDiaDeMes,
  rangoDelMes,
  siguienteMes,
  ubicacionEnMes,
} from "./piloto";

describe("mes de trabajo del piloto", () => {
  it("usa el mes guardado o, si no hay, el mes actual de Colombia", () => {
    expect(mesDeTrabajo("2026-11-15", new Date("2026-12-01T03:00:00Z"))).toBe("2026-11-01");
    expect(mesDeTrabajo(null, new Date("2026-11-16T17:00:00Z"))).toBe("2026-11-01");
    // 1 de diciembre 02:00 UTC = 30 de noviembre 21:00 en Colombia: sigue siendo noviembre.
    expect(mesDeTrabajo(null, new Date("2026-12-01T02:00:00Z"))).toBe("2026-11-01");
  });

  it("calcula rango, mes siguiente y etiqueta", () => {
    expect(primerDiaDeMes("2026-11-16")).toBe("2026-11-01");
    expect(rangoDelMes("2026-11-01")).toEqual({ desde: "2026-11-01", hasta: "2026-11-30" });
    expect(rangoDelMes("2028-02-01")).toEqual({ desde: "2028-02-01", hasta: "2028-02-29" });
    expect(siguienteMes("2026-11-01")).toBe("2026-12-01");
    expect(siguienteMes("2026-12-01")).toBe("2027-01-01");
    expect(etiquetaMes("2026-11-01")).toBe("noviembre de 2026");
  });

  it("ubica una fecha respecto del mes de trabajo", () => {
    expect(ubicacionEnMes("2026-11-30", "2026-11-01")).toBe("dentro");
    expect(ubicacionEnMes("2026-10-31", "2026-11-01")).toBe("anterior");
    expect(ubicacionEnMes("2026-12-01", "2026-11-01")).toBe("posterior");
    expect(ubicacionEnMes(null, "2026-11-01")).toBe("sin_fecha");
    expect(ubicacionEnMes("14/11/2026", "2026-11-01")).toBe("sin_fecha");
  });
});
