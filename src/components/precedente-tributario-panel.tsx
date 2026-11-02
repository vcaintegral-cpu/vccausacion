// Vista del precedente tributario aprendido de Siigo: por proveedor, el IVA usado,
// las retenciones practicadas (impuesto, tarifa, veces) y su condición confirmada.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import {
  MOTIVO_LABEL,
  RETENCIONES,
  condicionDePerfil,
  nitBase,
  type ImpuestoConfigurado,
  type UsoImpuesto,
} from "@/lib/precedente-tributario";
import { cargarPrecedentes, invalidarPrecedentes } from "@/lib/precedente-tributario.data";
import { RET_SHORT } from "@/lib/retenciones-multi";

export function PrecedenteTributarioPanel({ companyId }: { companyId: string }) {
  const [filtro, setFiltro] = useState("");
  const [soloSinCondicion, setSoloSinCondicion] = useState(false);

  const datos = useQuery({
    queryKey: ["precedente-panel", companyId],
    queryFn: async () => {
      const [taxes, providers] = await Promise.all([
        supabase.from("tax_rates").select("*").eq("company_id", companyId),
        supabase
          .from("providers")
          .select("nit, name, purchase_tax_profile")
          .eq("company_id", companyId)
          .limit(5000),
      ]);
      if (taxes.error) throw taxes.error;
      const impuestos = (taxes.data ?? []) as unknown as ImpuestoConfigurado[];
      const precedentes = await cargarPrecedentes(companyId, impuestos);
      return { impuestos, precedentes, providers: providers.data ?? [] };
    },
  });

  const filas = useMemo(() => {
    if (!datos.data) return [];
    const porNit = new Map(datos.data.providers.map((p) => [nitBase(p.nit), p]));
    const q = filtro.trim().toLowerCase();
    return [...datos.data.precedentes.values()]
      .map((p) => {
        const prov = porNit.get(p.nit);
        return {
          p,
          nombre: prov?.name ?? "",
          condicion: condicionDePerfil(prov?.purchase_tax_profile),
        };
      })
      .filter(({ p, nombre }) => !q || p.nit.includes(q) || nombre.toLowerCase().includes(q))
      .filter(
        ({ p, condicion }) =>
          !soloSinCondicion || (!condicion && p.retenciones.retefuente.length === 0),
      )
      .sort(
        (a, b) => b.p.documentosSiigo - a.p.documentosSiigo || a.nombre.localeCompare(b.nombre),
      );
  }, [datos.data, filtro, soloSinCondicion]);

  const nombreTax = (u: UsoImpuesto) =>
    (u.taxId && datos.data?.impuestos.find((t) => String(t.id) === u.taxId)?.name) ||
    (u.cuenta ? `cuenta ${u.cuenta}` : "—");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Precedente tributario por proveedor</h2>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Aprendido de los documentos sincronizados con Siigo y del auxiliar histórico. Es lo que
            usa la causación para elegir el IVA y decidir las retenciones. Entre paréntesis, cuántas
            veces se usó.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder="Buscar NIT o nombre"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={soloSinCondicion}
              onChange={(e) => setSoloSinCondicion(e.target.checked)}
            />
            Solo sin retención ni condición
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              invalidarPrecedentes(companyId);
              void datos.refetch();
            }}
          >
            <RefreshCw className="size-4" /> Actualizar
          </Button>
        </div>
      </div>

      {datos.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Aprendiendo de lo sincronizado con Siigo…
        </p>
      ) : datos.error ? (
        <p className="text-sm text-destructive">
          {datos.error instanceof Error ? datos.error.message : "No se pudo cargar."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proveedor</TableHead>
                <TableHead className="text-right">Docs. Siigo</TableHead>
                <TableHead>IVA usado</TableHead>
                <TableHead>Retenciones practicadas</TableHead>
                <TableHead>Condición confirmada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filas.map(({ p, nombre, condicion }) => (
                <TableRow key={p.nit}>
                  <TableCell>
                    <p className="font-medium">{nombre || "—"}</p>
                    <p className="text-xs text-muted-foreground">{p.nit}</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.documentosSiigo}</TableCell>
                  <TableCell className="text-xs">
                    {p.iva.length
                      ? p.iva.map((u) => `${nombreTax(u)} (${u.veces})`).join(" · ")
                      : "—"}
                  </TableCell>
                  <TableCell className="space-y-0.5 text-xs">
                    {RETENCIONES.map((k) =>
                      p.retenciones[k].length ? (
                        <p key={k}>
                          <Badge variant="secondary" className="mr-1">
                            {RET_SHORT[k]}
                          </Badge>
                          {p.retenciones[k]
                            .map(
                              (u) =>
                                `${nombreTax(u)}${u.tarifa != null ? ` ${u.tarifa}%` : ""} (${u.veces})`,
                            )
                            .join(" · ")}
                        </p>
                      ) : null,
                    )}
                    {RETENCIONES.every((k) => !p.retenciones[k].length) ? (
                      <span className="text-muted-foreground">
                        Nunca
                        {p.sinRetencion.retefuente
                          ? ` (sin retención en ${p.sinRetencion.retefuente})`
                          : ""}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    {condicion ? (
                      <>
                        {Object.entries(condicion.sinRetencion ?? {}).map(([k, v]) => (
                          <p key={k}>
                            Sin {RET_SHORT[k as keyof typeof RET_SHORT]}: {MOTIVO_LABEL[v!.motivo]}
                          </p>
                        ))}
                        {Object.keys(condicion.retenerCon ?? {}).map((k) => (
                          <p key={k}>Retener {RET_SHORT[k as keyof typeof RET_SHORT]} siempre</p>
                        ))}
                      </>
                    ) : p.retenciones.retefuente.length ? (
                      <span className="text-muted-foreground">Por precedente</span>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">Por confirmar</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {filas.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    {datos.data?.precedentes.size
                      ? "Ningún proveedor coincide con el filtro."
                      : "Aún no hay documentos sincronizados con Siigo ni auxiliar histórico importado en esta empresa."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
