import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { createCompanyWithDefaults } from "@/lib/seed";
import { setActiveCompany, useActiveCompany } from "@/lib/active-company";
import { useCompanies } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/empresas")({
  component: Empresas,
});

function Empresas() {
  const queryClient = useQueryClient();
  const { data: companies } = useCompanies();
  const active = useActiveCompany();
  const [name, setName] = useState("");
  const [nit, setNit] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function eliminar(id: string): Promise<void> {
    setDeleting(id);
    try {
      const { error } = await supabase.from("companies").delete().eq("id", id);
      if (error) throw error;
      if (active === id) setActiveCompany(null);
      await queryClient.invalidateQueries({ queryKey: ["companies"] });
      toast.success("Empresa eliminada junto con toda su información.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible eliminar la empresa.");
    } finally {
      setDeleting(null);
    }
  }

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
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setActiveCompany(c.id)}>
                Activar
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" disabled={deleting === c.id} aria-label={`Eliminar ${c.name}`}>
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Eliminar «{c.name}»?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Se eliminarán de forma permanente sus facturas, comprobantes, PUC, impuestos, terceros,
                      productos y reglas de aprendizaje. Esta acción no se puede deshacer.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void eliminar(c.id)}>Eliminar</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </li>
        ))}
        {(companies ?? []).length === 0 && (
          <li className="px-5 py-6 text-sm text-muted-foreground">Aún no has creado empresas.</li>
        )}
      </ul>
    </div>
  );
}