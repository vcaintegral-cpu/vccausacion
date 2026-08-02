import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/causar")({
  component: () => (
    <div>
      <h1 className="text-xl font-semibold">Causar factura</h1>
      <p className="mt-1 text-sm text-muted-foreground">Carga y procesamiento de facturas (en construcción).</p>
    </div>
  ),
});