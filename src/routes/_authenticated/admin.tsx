import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/admin")({
  component: () => (
    <div>
      <h1 className="text-xl font-semibold">Administración</h1>
      <p className="mt-1 text-sm text-muted-foreground">PUC, terceros, reglas e impuestos (en construcción).</p>
    </div>
  ),
});