import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Download, Loader2, Plug, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActiveCompany } from "@/lib/active-company";
import { fechaHora, moneda } from "@/lib/format";
import { siigoImportProviders, siigoImportPuc, siigoListPurchases, siigoStatus } from "@/lib/siigo.functions";

export const Route = createFileRoute("/_authenticated/integraciones")({
  head: () => ({
    meta: [
      { title: "Integraciones contables — Siigo, Loggro, Helisa, World Office" },
      {
        name: "description",
        content:
          "Conecta tu software contable y sincroniza facturas electrónicas, terceros y plan de cuentas desde la API de Siigo.",
      },
      { property: "og:title", content: "Integraciones contables" },
      { property: "og:description", content: "Conexión real con la API de Siigo: terceros, PUC y facturas de compra." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Integraciones,
});

const OTROS = [
  { id: "loggro", name: "Loggro", desc: "Integración por API en preparación." },
  { id: "helisa", name: "Helisa", desc: "Exportación de comprobantes en archivo plano." },
  { id: "world-office", name: "World Office", desc: "Importación de comprobantes en Excel." },
];

function Integraciones() {
  const companyId = useActiveCompany();
  const checkStatus = useServerFn(siigoStatus);
  const importProviders = useServerFn(siigoImportProviders);
  const importPuc = useServerFn(siigoImportPuc);
  const listPurchases = useServerFn(siigoListPurchases);
  const [purchases, setPurchases] = useState<Awaited<ReturnType<typeof siigoListPurchases>> | null>(null);

  const status = useQuery({
    queryKey: ["siigo-status"],
    queryFn: () => checkStatus({ data: undefined as never }),
  });

  const provs = useMutation({
    mutationFn: () => importProviders({ data: { companyId: companyId! } }),
    onSuccess: (r) => toast.success(`${r.imported} terceros importados desde Siigo.`),
    onError: (e: Error) => toast.error(e.message),
  });
  const puc = useMutation({
    mutationFn: () => importPuc({ data: { companyId: companyId! } }),
    onSuccess: (r) => toast.success(`${r.imported} cuentas del PUC importadas.`),
    onError: (e: Error) => toast.error(e.message),
  });
  const compras = useMutation({
    mutationFn: () => listPurchases({ data: undefined as never }),
    onSuccess: (r) => {
      setPurchases(r);
      toast.success(`${r.length} facturas de compra traídas de Siigo.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = status.data;
  const connected = !!s?.connected;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Integraciones</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Conecta tu software contable para sincronizar facturas electrónicas, terceros y plan de cuentas.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <Plug className="size-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Siigo Nube · API</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sincroniza terceros, plan de cuentas y facturas de compra en tiempo real.
              </p>
            </div>
          </div>
          {status.isPending ? (
            <Badge variant="secondary">
              <Loader2 className="size-3 animate-spin" /> Verificando
            </Badge>
          ) : connected ? (
            <Badge className="bg-success text-success-foreground hover:bg-success">
              <CheckCircle2 className="size-3" /> Conectado
            </Badge>
          ) : s?.configured ? (
            <Badge variant="destructive">
              <XCircle className="size-3" /> Error de conexión
            </Badge>
          ) : (
            <Badge variant="secondary">Sin credenciales</Badge>
          )}
        </div>

        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-3 rounded-md border border-border px-3 py-2">
            <dt className="text-muted-foreground">Usuario API</dt>
            <dd className="truncate font-mono text-xs">{s?.user ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-3 rounded-md border border-border px-3 py-2">
            <dt className="text-muted-foreground">Última verificación</dt>
            <dd className="font-mono text-xs">{s?.checkedAt ? fechaHora(s.checkedAt) : "—"}</dd>
          </div>
        </dl>

        {!s?.configured && !status.isPending ? (
          <div className="mt-4 flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Faltan las credenciales de Siigo. Genera tu Access Key en{" "}
              <span className="font-medium text-foreground">Siigo Nube → Configuración → Integraciones → API</span> con
              el usuario administrador y guárdalas de forma segura en el proyecto.
            </span>
          </div>
        ) : null}

        {s?.error ? (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive">
            {s.error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => status.refetch()} disabled={status.isFetching}>
            {status.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Probar conexión
          </Button>
          <Button onClick={() => provs.mutate()} disabled={!connected || !companyId || provs.isPending}>
            {provs.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Importar terceros
          </Button>
          <Button onClick={() => puc.mutate()} disabled={!connected || !companyId || puc.isPending}>
            {puc.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Importar PUC
          </Button>
          <Button variant="secondary" onClick={() => compras.mutate()} disabled={!connected || compras.isPending}>
            {compras.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Ver facturas de compra
          </Button>
        </div>
        {connected && !companyId ? (
          <p className="mt-2 text-xs text-muted-foreground">Selecciona una empresa activa para importar datos.</p>
        ) : null}
      </div>

      {purchases ? (
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">Facturas de compra en Siigo</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>NIT proveedor</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchases.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    Sin facturas de compra.
                  </TableCell>
                </TableRow>
              ) : (
                purchases.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.number}</TableCell>
                    <TableCell className="font-mono text-xs">{p.date}</TableCell>
                    <TableCell className="font-mono text-xs">{p.supplier}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{moneda(p.total)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        {OTROS.map((o) => (
          <div key={o.id} className="flex flex-col rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-9 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                <Plug className="size-4" />
              </div>
              <Badge variant="secondary">No conectado</Badge>
            </div>
            <h2 className="mt-3 text-sm font-semibold">{o.name}</h2>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">{o.desc}</p>
            <Button className="mt-4 w-full" variant="outline" disabled>
              Próximamente
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
