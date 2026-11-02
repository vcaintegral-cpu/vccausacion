import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/components/app-shell", () => ({
  useCompanies: () => ({
    isLoading: false,
    data: [
      { id: "1", name: "LED LIGHTS S.A.S.", nit: "900.470.166-4" },
      { id: "2", name: "CORPORACION BALLET FOLCLORICO DE ANTIOQUIA", nit: "800212838" },
      { id: "3", name: "EMPRESA NUEVA S.A.S.", nit: "901426172" },
    ],
  }),
}));

const { EmpresasAlcancePanel } = await import("./empresas-alcance-panel");

describe("Empresas y alcance", () => {
  it("lista cada empresa con su alcance: perfil específico o solo núcleo global", () => {
    const html = renderToString(<EmpresasAlcancePanel />).replace(/<!-- -->/g, "");
    expect(html).toContain("Empresas registradas");
    expect(html).toMatch(/Empresas registradas<\/p><p[^>]*>3</);
    expect(html).toMatch(/Con perfil específico<\/p><p[^>]*>2</);
    expect(html).toContain("Perfil específico · led-lights");
    expect(html).toContain("Perfil específico · ballet");
    expect(html).toContain("EMPRESA NUEVA S.A.S.");
    expect(html).toContain("Solo núcleo global");
    expect(html).toContain("Ninguna: usa todo lo global.");
    // Registro sin errores y sin perfiles huérfanos.
    expect(html).not.toContain("no aparecen en tus empresas");
    expect(html).not.toContain("text-destructive");
  });
});
