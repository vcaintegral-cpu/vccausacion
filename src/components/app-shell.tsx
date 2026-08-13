import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Brain, Building2, FileUp, FolderOpen, LayoutDashboard, ListChecks, ListTree, LogOut, Plug, Settings2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { setActiveCompany, setCompanyLocked, useActiveCompany, useCompanyLocked } from "@/lib/active-company";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const NAV = [
  { to: "/panel", label: "Panel", icon: LayoutDashboard },
  { to: "/causar", label: "Causar factura", icon: FileUp },
  { to: "/procesos", label: "Procesos", icon: ListTree },
  { to: "/facturas", label: "Historial", icon: ListChecks },
  { to: "/documentos", label: "Documentos", icon: FolderOpen },
  { to: "/aprendizaje", label: "Aprendizaje contable", icon: Brain },
  { to: "/integraciones", label: "Integraciones", icon: Plug },
  { to: "/admin", label: "Administración", icon: Settings2 },
  { to: "/empresas", label: "Empresas", icon: Building2 },
] as const;

export function useCompanies() {
  return useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase.from("companies").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = useActiveCompany();
  const locked = useCompanyLocked();
  const { data: companies } = useCompanies();

  useEffect(() => {
    if (!locked && companies && companies.length > 0 && !companies.some((c) => c.id === active)) {
      setActiveCompany(companies[0]!.id);
    }
  }, [companies, active, locked]);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    setActiveCompany(null);
    setCompanyLocked(false);
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <div className="border-b border-sidebar-border px-5 py-5">
          <p className="text-xs uppercase tracking-[0.18em] text-sidebar-foreground/60">Causación</p>
          <p className="mt-1 text-base font-semibold text-sidebar-accent-foreground">Asistente Inteligente</p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground font-medium" }}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-3">
          <Button variant="ghost" onClick={signOut} className="w-full justify-start text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <LogOut className="size-4" /> Cerrar sesión
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-5 py-3">
          <div className="flex items-center gap-2 overflow-x-auto lg:hidden">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground"
                activeProps={{ className: "bg-secondary text-secondary-foreground font-medium" }}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Empresa</span>
            <Select {...(active ? { value: active } : {})} onValueChange={(v) => setActiveCompany(v)} disabled={locked}>
              <SelectTrigger className="w-56 bg-background" title={locked ? "Sesión iniciada con el NIT de esta empresa. Cierra sesión para cambiar de empresa." : undefined}>
                <SelectValue placeholder="Sin empresas" />
              </SelectTrigger>
              <SelectContent>
                {(companies ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" onClick={signOut} className="lg:hidden">
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}

export function EmptyCompany() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
      <h2 className="text-lg font-semibold">Aún no tienes empresas</h2>
      <p className="mt-1 text-sm text-muted-foreground">Crea tu primera empresa para comenzar a causar facturas.</p>
      <Button asChild className="mt-4">
        <Link to="/empresas">Crear empresa</Link>
      </Button>
    </div>
  );
}
