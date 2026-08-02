import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/panel")({
  component: () => (
    <div>
      <h1 className="text-xl font-semibold">Panel</h1>
      <p className="mt-1 text-sm text-muted-foreground">Indicadores de causación (en construcción).</p>
    </div>
  ),
});