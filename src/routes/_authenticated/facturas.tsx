import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/facturas")({
  component: () => (
    <div>
      <h1 className="text-xl font-semibold">Historial</h1>
      <p className="mt-1 text-sm text-muted-foreground">Facturas causadas (en construcción).</p>
    </div>
  ),
});