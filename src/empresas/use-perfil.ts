import { useCompanies } from "@/components/app-shell";
import { useActiveCompany } from "@/lib/active-company";
import { type FuncionId } from "@/empresas/global";
import { funcionActiva, moduloActivo, perfilDeEmpresa } from "@/empresas/registro";
import type { ModuloId } from "@/empresas/tipos";

/** Perfil de la empresa activa y consultas de alcance para las pantallas. */
export function usePerfilActivo() {
  const companyId = useActiveCompany();
  const { data: companies } = useCompanies();
  const nit = companies?.find((c) => c.id === companyId)?.nit ?? null;
  return {
    nit,
    perfil: perfilDeEmpresa(nit),
    modulo: (m: ModuloId) => moduloActivo(nit, m),
    funcion: (f: FuncionId) => funcionActiva(nit, f),
  };
}
