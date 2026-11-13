import { describe, expect, it } from "vitest";

import {
  correoDecisionesHtml,
  enlaceRespuesta,
  nocheDe,
  pasosParaReintentar,
  registrarPaso,
  siguientePaso,
  type PasoRegistro,
} from "./piloto";

// Horas en UTC: Colombia es UTC−5.
const utc = (s: string) => new Date(`${s}Z`);

describe("ventana nocturna", () => {
  it("de 7 p. m. a 7 a. m. hora de Colombia, con la fecha de la noche en que empezó", () => {
    expect(nocheDe(utc("2026-11-13T23:59:00"), 19)).toBeNull(); // 6:59 p. m.: aún no
    expect(nocheDe(utc("2026-11-14T00:00:00"), 19)).toBe("2026-11-13"); // 7:00 p. m.
    expect(nocheDe(utc("2026-11-14T08:30:00"), 19)).toBe("2026-11-13"); // 3:30 a. m.
    expect(nocheDe(utc("2026-11-14T12:00:00"), 19)).toBeNull(); // 7:00 a. m.: terminó
    expect(nocheDe(utc("2026-11-14T17:00:00"), 19)).toBeNull(); // mediodía
  });
});

describe("pasos de la noche", () => {
  const r = (id: PasoRegistro["id"], estado: PasoRegistro["estado"]): PasoRegistro => ({
    id,
    estado,
    inicio: "",
    fin: "",
    detalle: "",
  });
  it("en orden, reintenta un paso con error hasta 3 veces y termina con el reporte", () => {
    expect(siguientePaso([])).toBe("drive");
    let p = registrarPaso([], r("drive", "error"));
    expect(siguientePaso(p)).toBe("drive");
    p = registrarPaso(p, r("drive", "error"));
    p = registrarPaso(p, r("drive", "error"));
    expect(p[0]!.intentos).toBe(3);
    expect(siguientePaso(p)).toBe("borradores");
    for (const id of [
      "borradores",
      "siigo_compras",
      "egresos",
      "gastos_bancarios",
      "conciliacion",
    ] as const)
      p = registrarPaso(p, r(id, "omitido"));
    expect(siguientePaso(p)).toBe("reporte");
    p = registrarPaso(p, r("reporte", "hecho"));
    expect(siguientePaso(p)).toBeNull();
    // Después de publicar una corrección: se reintenta lo que falló y se repite el reporte.
    const re = pasosParaReintentar(p);
    expect(re.map((x) => x.id)).not.toContain("drive");
    expect(siguientePaso(re)).toBe("drive");
  });
});

describe("correo de decisiones", () => {
  it("cada opción es un enlace firmado a la respuesta", () => {
    const c = correoDecisionesHtml({
      empresa: "EMPRESA EJEMPLO",
      base: "https://app.ejemplo.com/",
      decisiones: [
        {
          titulo: "Proveedor nuevo",
          pregunta: "¿Con qué cuenta?",
          opciones: [{ id: "a", etiqueta: "Gasto <5135>" }],
          token: "ab12",
        },
      ],
    });
    expect(c.asunto).toContain("1 pregunta");
    expect(c.html).toContain(
      enlaceRespuesta("https://app.ejemplo.com/", "ab12", "a").replace(/&/g, "&amp;"),
    );
    expect(c.html).toContain("Gasto &lt;5135&gt;");
  });
});
