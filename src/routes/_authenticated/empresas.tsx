import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { createCompanyWithDefaults } from "@/lib/seed";
import { setActiveCompany } from "@/lib/active-company";
import { useCompanies } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/empresas")({
  component: Empresas,
});

function Empresas() {
  const queryClient = useQueryClient();
  const { data: companies } = useCompanies();
  const [name, setName] = useState("");
  const [nit, setNit] = useState("");
  const [loading, setLoading] = useState(false);

  async function crear(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      const company = await createCompanyWithDefaults({ name, nit }, data.user.id);
      setActiveCompany(company.id);
      setName("");
      setNit("");
      await queryClient.invalidateQueries({ queryKey: ["companies"] });
      toast.success("Empresa creada con PUC, impuestos y reglas base.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible crear la empresa.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Empresas</h1>
        <p className="mt-1 text-sm text-muted-foreground">Cada empresa tiene su propio PUC, terceros e impuestos.</p>
      </div>

      <form onSubmit={crear} className="grid gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="cname">Razón social</Label>
          <Input id="cname" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cnit">NIT</Label>
          <Input id="cnit" required value={nit} onChange={(e) => setNit(e.target.value)} />
        </div>
        <Button type="submit" disabled={loading}>
          Crear
        </Button>
      </form>

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {(companies ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between px-5 py-3">
            <div>
              <p className="text-sm font-medium">{c.name}</p>
              <p className="font-mono text-xs text-muted-foreground">NIT {c.nit}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setActiveCompany(c.id)}>
              Activar
            </Button>
          </li>
        ))}
        {(companies ?? []).length === 0 && (
          <li className="px-5 py-6 text-sm text-muted-foreground">Aún no has creado empresas.</li>
        )}
      </ul>
    </div>
  );
}