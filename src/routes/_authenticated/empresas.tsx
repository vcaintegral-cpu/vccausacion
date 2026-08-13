import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { createCompanyWithDefaults } from "@/lib/seed";
import { setActiveCompany, useActiveCompany } from "@/lib/active-company";
import { clearCostCenterPolicyCache } from "@/lib/cost-center-config";
import { clearPayableCache, isPayableCode } from "@/lib/payable-account";
import { clearIvaConfigCache, type IvaCompanyConfig } from "@/lib/iva-treatment";
import { useCompanies } from "@/components/app-shell";
import { Link } from "@tanstack/react-router";
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

/** Configuración contable de la empresa: ¿maneja centros de costos? */
function CostCenterConfig({ company }: { company: { id: string; uses_cost_centers?: boolean | null } }) {
  const queryClient = useQueryClient();
  const guardado = (company.uses_cost_centers ?? null) as boolean | null;
  const [valor, setValor] = useState<boolean | null>(guardado);
  const [saving, setSaving] = useState(false);

  async function guardar() {
    if (valor === null) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("companies").update({ uses_cost_centers: valor }).eq("id", company.id);
      if (error) throw error;
      clearCostCenterPolicyCache(company.id);
      await queryClient.invalidateQueries({ queryKey: ["companies"] });
      await queryClient.invalidateQueries({ queryKey: ["cost-center-policy", company.id] });
      toast.success(valor ? "La empresa maneja centros de costos." : "La empresa no maneja centros de costos.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible guardar la configuración.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Configuración contable</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-sm">¿Esta empresa maneja centros de costos?</span>
        <Button size="sm" variant={valor === true ? "default" : "outline"} onClick={() => setValor(true)}>Sí</Button>
        <Button size="sm" variant={valor === false ? "default" : "outline"} onClick={() => setValor(false)}>No</Button>
        <Button size="sm" disabled={saving || valor === null || valor === guardado} onClick={() => void guardar()}>
          Guardar
        </Button>
        <span className="text-xs text-muted-foreground">
          Estado: {guardado === true ? "Activo" : guardado === false ? "No utiliza" : "Pendiente de configurar"}
        </span>
      </div>
      {guardado === null && (
        <p className="mt-2 text-xs text-destructive">Configure si esta empresa maneja centros de costos.</p>
      )}
      {guardado === true && (
        <p className="mt-2 text-xs">
          <Button asChild size="sm" variant="outline" onClick={() => setActiveCompany(company.id)}>
            <Link to="/admin">Administrar centros de costos</Link>
          </Button>
          <span className="ml-2 text-muted-foreground">
            Sincroniza con Siigo, consulta código y nombre, y activa o desactiva centros.
          </span>
        </p>
      )}
    </div>
  );
}

/** Cuenta genérica de cuentas por pagar de la empresa (se usa solo si el proveedor no tiene histórico). */
function PayableAccountConfig({ company }: { company: { id: string; default_payable_account?: string | null } }) {
  const queryClient = useQueryClient();
  const guardado = (company.default_payable_account ?? "") as string;
  const [valor, setValor] = useState(guardado);
  const [saving, setSaving] = useState(false);
  const valido = valor.trim() === "" || isPayableCode(valor);

  async function guardar() {
    if (!valido) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("companies")
        .update({ default_payable_account: valor.trim() || null })
        .eq("id", company.id);
      if (error) throw error;
      clearPayableCache(company.id);
      await queryClient.invalidateQueries({ queryKey: ["companies"] });
      await queryClient.invalidateQueries({ queryKey: ["payable-account"] });
      toast.success("Cuenta genérica de cuentas por pagar actualizada.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No fue posible guardar la cuenta.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cuenta por pagar</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`pay-${company.id}`} className="text-xs">
            Cuenta genérica de cuentas por pagar
          </Label>
          <Input
            id={`pay-${company.id}`}
            className="w-40 font-mono"
            placeholder="220505"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
          />
        </div>
        <Button size="sm" disabled={saving || !valido || valor === guardado} onClick={() => void guardar()}>
          Guardar
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Solo se usa cuando el proveedor no tiene histórico en esta empresa. Debe ser una cuenta de pasivo de los
        grupos 22 o 23 (nunca bancos, caja, impuestos ni retenciones).
      </p>
      {!valido && <p className="mt-1 text-xs text-destructive">La cuenta debe empezar por 22 o 23 y no ser de impuestos ni retenciones.</p>}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/empresas")({
  head: () => ({
  head: () => ({
    meta: [
      { title: "Empresas y configuración contable" },
      { name: "description", content: "Administra tus empresas, la cuenta por pagar genérica, los centros de costo y el tratamiento contable del IVA en compras." },
      { property: "og:title", content: "Empresas y configuración contable" },
      { property: "og:description", content: "Configuración multiempresa: PUC, centros de costo, cuenta por pagar y tratamiento del IVA." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
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
          <li key={c.id} className="px-5 py-3">
            <div className="flex items-center justify-between">
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
            </div>
            <CostCenterConfig company={c} />
            <PayableAccountConfig company={c} />
          </li>
        ))}
        {(companies ?? []).length === 0 && (
          <li className="px-5 py-6 text-sm text-muted-foreground">Aún no has creado empresas.</li>
        )}
      </ul>
    </div>
  );
}