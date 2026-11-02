import { AlertTriangle, Building2, Globe2, Layers } from "lucide-react";

import { useCompanies } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FUNCIONES } from "@/empresas/global";
import {
  PERFILES,
  diferenciasConGlobal,
  perfilDeEmpresa,
  validarRegistro,
} from "@/empresas/registro";

/**
 * Mapa de alcance: empresas registradas en la app y si cada una usa solo el
 * núcleo global o tiene un perfil específico (src/empresas/<empresa>/perfil.ts).
 */
export function EmpresasAlcancePanel() {
  const { data: companies, isLoading } = useCompanies();
  const lista = companies ?? [];
  const conPerfil = lista.filter((c) => perfilDeEmpresa(c.nit));
  const perfilesSinEmpresa = PERFILES.filter(
    (p) => !lista.some((c) => perfilDeEmpresa(c.nit) === p),
  );
  const errores = validarRegistro();
  const funcionesDefinidas = Object.keys(FUNCIONES).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Resumen
          icono={Building2}
          titulo="Empresas registradas"
          valor={isLoading ? "…" : String(lista.length)}
        />
        <Resumen
          icono={Layers}
          titulo="Con perfil específico"
          valor={isLoading ? "…" : String(conPerfil.length)}
        />
        <Resumen
          icono={Globe2}
          titulo="Funciones con alcance por empresa"
          valor={String(funcionesDefinidas)}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Todas las empresas comparten el núcleo global; sus datos (PUC, terceros, reglas, Siigo)
        están aislados por empresa. Un perfil específico guarda solo lo que esa empresa tiene
        distinto. Se listan las empresas a las que perteneces.
      </p>

      {errores.length ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {errores.map((e) => (
            <p key={e} className="flex items-start gap-1">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {e}
            </p>
          ))}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Empresa</TableHead>
              <TableHead>NIT en la app</TableHead>
              <TableHead>Alcance</TableHead>
              <TableHead>Diferencias con el núcleo global</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lista.map((c, i) => {
              const perfil = perfilDeEmpresa(c.nit);
              const diferencias = perfil ? diferenciasConGlobal(perfil) : [];
              return (
                <TableRow key={c.id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.nit ?? "—"}</TableCell>
                  <TableCell>
                    {perfil ? (
                      <Badge variant="secondary" title={`src/empresas/${perfil.carpeta}/perfil.ts`}>
                        Perfil específico · {perfil.carpeta}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Solo núcleo global</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {diferencias.length === 0
                      ? "Ninguna: usa todo lo global."
                      : diferencias.map((d) => (
                          <p key={d.clave}>
                            {d.tipo} {d.nombre}: {d.empresa ? "encendido" : "apagado"} (global:{" "}
                            {d.global ? "encendido" : "apagado"})
                          </p>
                        ))}
                  </TableCell>
                </TableRow>
              );
            })}
            {!isLoading && lista.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  No hay empresas registradas.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      {perfilesSinEmpresa.length ? (
        <p className="text-xs text-muted-foreground">
          Perfiles registrados en el código que no aparecen en tus empresas:{" "}
          {perfilesSinEmpresa.map((p) => `${p.nombre} (${p.nit}-${p.dv})`).join(", ")}. Revisa que
          el NIT guardado en la app coincida.
        </p>
      ) : null}
    </div>
  );
}

function Resumen({
  icono: Icono,
  titulo,
  valor,
}: {
  icono: typeof Building2;
  titulo: string;
  valor: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <Icono className="size-5 text-muted-foreground" />
      <div>
        <p className="text-xs text-muted-foreground">{titulo}</p>
        <p className="text-lg font-semibold">{valor}</p>
      </div>
    </div>
  );
}
