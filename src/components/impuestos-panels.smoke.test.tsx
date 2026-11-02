// Prueba de humo: las pantallas nuevas de impuestos se dibujan sin errores con una
// empresa sin datos todavía (antes de cargar la información).
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/bulk-runner", () => ({ invalidateBulkDeps: () => undefined }));

const { BasesMinimasPanel } = await import("./bases-minimas-panel");
const { PrecedenteTributarioPanel } = await import("./precedente-tributario-panel");
const { CondicionTributariaPanel } = await import("./condicion-tributaria-panel");
const { emptyRetBlocks } = await import("@/lib/retenciones-multi");

const render = (node: React.ReactNode) =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  ).replace(/<!-- -->/g, "");

describe("pantallas de impuestos", () => {
  it("Bases mínimas", () => {
    const html = render(<BasesMinimasPanel companyId="c1" />);
    expect(html).toContain("Tabla de bases mínimas (todas las empresas)");
    expect(html).toContain("Concepto de cada retención de la empresa");
    expect(html).toContain("Importar Excel");
  });

  it("Precedente tributario", () => {
    expect(render(<PrecedenteTributarioPanel companyId="c1" />)).toContain(
      "Precedente tributario por proveedor",
    );
  });

  it("Condición tributaria del proveedor (sin precedente: pide confirmar)", () => {
    const html = render(
      <CondicionTributariaPanel
        companyId="c1"
        nit="900047217"
        nombre="MEGA LUCES"
        fecha="2026-10-20"
        baseGravable={1000000}
        ivaTotal={190000}
        taxes={[
          {
            id: "rf",
            kind: "retefuente",
            name: "Compras 2,5%",
            rate: 2.5,
            account_code: "23654001",
          },
        ]}
        puc={[]}
        blocks={emptyRetBlocks()}
        onApply={() => undefined}
      />,
    );
    expect(html).toContain("Condición tributaria del proveedor");
    expect(html).toContain("Proveedor sin precedente en Siigo");
    expect(html).toContain("No se le retiene…");
    expect(html).toContain("Retenerle siempre con…");
  });

  it("sin NIT no muestra el panel", () => {
    const html = render(
      <CondicionTributariaPanel
        companyId="c1"
        nit=""
        nombre=""
        fecha={null}
        baseGravable={0}
        ivaTotal={0}
        taxes={[]}
        puc={[]}
        blocks={emptyRetBlocks()}
        onApply={() => undefined}
      />,
    );
    expect(html).toBe("");
  });
});
