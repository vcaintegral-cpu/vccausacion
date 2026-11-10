import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderSync,
  Landmark,
  Loader2,
  ReceiptText,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyCompany } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import {
  egresosListar,
  egresosMarcar,
  fuentesConectar,
  fuentesDesconectar,
  fuentesEstado,
  fuentesGuardar,
  fuentesRevisarAhora,
  type ConexionEstado,
  type EgresoDoc,
  type FuenteEstado,
} from "@/lib/document-sources.functions";
import { interpretarEnlace, type Proposito } from "@/lib/drive-sync";
import { NOMBRE_PROVEEDOR } from "@/lib/file-providers";
import { fechaHora } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/fuentes")({
  head: () => ({
    meta: [
      { title: "Fuentes de documentos · Compras y egresos" },
      {
        name: "description",
        content:
          "Carpetas de Google Drive u OneDrive de donde se toman automáticamente las compras y los egresos del mes.",
      },
      { property: "og:title", content: "Fuentes de documentos" },
      {
        property: "og:description",
        content: "Carpetas de compras y egresos revisadas automáticamente.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Fuentes,
});

const PROPOSITO: Record<
  Proposito,
  { titulo: string; descripcion: string; icono: typeof ReceiptText; ejemploSub: string }
> = {
  compras: {
    titulo: "Compras",
    descripcion:
      "Facturas de compra en PDF y el Excel RECIBIDOS. Entran a la carga masiva y quedan como borrador para revisar y aprobar.",
    icono: ReceiptText,
    ejemploSub: "FACTURAS",
  },
  egresos: {
    titulo: "Egresos",
    descripcion:
      "Soportes de pago en PDF y extractos bancarios. Llegan a la bandeja de egresos para cruzarlos con las facturas.",
    icono: Landmark,
    ejemploSub: "PAGOS",
  },
};

function Fuentes() {
  const companyId = useActiveCompany();
  const getEstado = useServerFn(fuentesEstado);

  const estado = useQuery({
    queryKey: ["fuentes-estado", companyId],
    queryFn: () => getEstado({ data: { companyId: companyId! } }),
    enabled: !!companyId,
  });

  // Resultado del regreso desde Google / Microsoft (?conexion=ok|error&detalle=...).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const conexion = params.get("conexion");
    if (!conexion) return;
    if (conexion === "ok") toast.success("Cuenta conectada.");
    else toast.error(`No se pudo conectar la cuenta. ${params.get("detalle") ?? ""}`);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (!companyId) return <EmptyCompany />;
  const e = estado.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Fuentes de documentos</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Elige la carpeta de compras y la de egresos de esta empresa. La app las revisa todos los
          días a las 6:00 p. m. y trae solo lo nuevo. Si la carpeta tiene subcarpetas por año o por
          mes ("2026", "10. OCTUBRE"), toma el mes actual y el anterior. Nada se envía a Siigo sin
          tu aprobación y no se modifica nada en la carpeta de origen.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {(e?.conexiones ?? []).map((c) => (
          <TarjetaConexion
            key={c.provider}
            companyId={companyId}
            conexion={c}
            onChange={() => void estado.refetch()}
          />
        ))}
        {estado.isLoading ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {(["compras", "egresos"] as const).map((p) => (
          <TarjetaFuente
            key={p}
            companyId={companyId}
            proposito={p}
            fuente={e?.fuentes.find((f) => f.purpose === p) ?? null}
            conexiones={e?.conexiones ?? []}
            onChange={() => void estado.refetch()}
          />
        ))}
      </div>

      <BandejaEgresos companyId={companyId} />
    </div>
  );
}

function TarjetaConexion({
  companyId,
  conexion,
  onChange,
}: {
  companyId: string;
  conexion: ConexionEstado;
  onChange: () => void;
}) {
  const conectar = useServerFn(fuentesConectar);
  const desconectar = useServerFn(fuentesDesconectar);
  const iniciar = useMutation({
    mutationFn: () => conectar({ data: { companyId, provider: conexion.provider } }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "No fue posible iniciar la conexión."),
  });
  const quitar = useMutation({
    mutationFn: () => desconectar({ data: { companyId, provider: conexion.provider } }),
    onSuccess: () => {
      toast.success("Cuenta desconectada.");
      onChange();
    },
  });
  const sinConfigurar = conexion.missingEnv.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FolderSync className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{NOMBRE_PROVEEDOR[conexion.provider]}</span>
          {conexion.connected ? (
            <Badge variant="secondary">
              <CheckCircle2 className="size-3" /> {conexion.email ?? "Conectada"}
            </Badge>
          ) : (
            <Badge variant="outline">Sin conectar</Badge>
          )}
        </div>
        <div className="flex gap-2">
          {conexion.connected ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => quitar.mutate()}
              disabled={quitar.isPending}
            >
              Desconectar
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={conexion.connected ? "outline" : "default"}
            onClick={() => iniciar.mutate()}
            disabled={iniciar.isPending || sinConfigurar}
          >
            {iniciar.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {conexion.connected ? "Reconectar" : "Conectar"}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {sinConfigurar
          ? `Falta configurar en el servidor: ${conexion.missingEnv.join(", ")}.`
          : "Inicia sesión con la cuenta que tiene acceso a las carpetas. Solo se pide permiso de lectura."}
      </p>
    </div>
  );
}

function TarjetaFuente({
  companyId,
  proposito,
  fuente,
  conexiones,
  onChange,
}: {
  companyId: string;
  proposito: Proposito;
  fuente: FuenteEstado | null;
  conexiones: ConexionEstado[];
  onChange: () => void;
}) {
  const guardar = useServerFn(fuentesGuardar);
  const revisar = useServerFn(fuentesRevisarAhora);
  const info = PROPOSITO[proposito];
  const [url, setUrl] = useState("");
  const [sub, setSub] = useState("");
  const [activa, setActiva] = useState(true);

  useEffect(() => {
    setUrl(fuente?.folderUrl ?? "");
    setSub(fuente?.monthSubfolder ?? "");
    setActiva(fuente?.enabled ?? true);
  }, [fuente?.folderUrl, fuente?.monthSubfolder, fuente?.enabled]);

  const enlace = interpretarEnlace(url);
  const conexion = enlace ? conexiones.find((c) => c.provider === enlace.proveedor) : undefined;

  const guardarM = useMutation({
    mutationFn: () =>
      guardar({
        data: {
          companyId,
          purpose: proposito,
          folderUrl: url,
          monthSubfolder: sub,
          enabled: activa,
        },
      }),
    onSuccess: (r) => {
      toast.success(
        `Carpeta de ${info.titulo.toLowerCase()}: "${r.folderName}" (${NOMBRE_PROVEEDOR[r.provider]}).`,
      );
      onChange();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "No fue posible guardar la carpeta."),
  });
  const revisarM = useMutation({
    mutationFn: () => revisar({ data: { companyId, purpose: proposito } }),
    onSuccess: (r) => {
      if (r.errores.length)
        toast.error(`Revisión con ${r.errores.length} error(es). Mira el detalle.`);
      else if (proposito === "compras") {
        toast.success(
          `${r.facturasEncoladas + r.documentosExcel} factura(s) nuevas enviadas a la carga masiva.`,
        );
      } else toast.success(`${r.egresosRecibidos} archivo(s) nuevos en la bandeja de egresos.`);
      onChange();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "No fue posible revisar la carpeta."),
  });

  const r = fuente?.lastResult;
  const Icono = info.icono;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
          <Icono className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{info.titulo}</h2>
            {fuente ? (
              <Badge variant="secondary">{NOMBRE_PROVEEDOR[fuente.provider]}</Badge>
            ) : (
              <Badge variant="outline">Sin carpeta</Badge>
            )}
            {fuente && !fuente.enabled ? (
              <Badge variant="outline">Revisión diaria apagada</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{info.descripcion}</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="space-y-1">
          <Label htmlFor={`url-${proposito}`}>
            Enlace de la carpeta (Google Drive u OneDrive / SharePoint)
          </Label>
          <Input
            id={`url-${proposito}`}
            value={url}
            onChange={(ev) => setUrl(ev.target.value)}
            placeholder="https://… pega aquí el enlace de la carpeta"
          />
          {url.trim() ? (
            enlace ? (
              <p className="text-xs text-muted-foreground">
                {NOMBRE_PROVEEDOR[enlace.proveedor]}
                {conexion && !conexion.connected ? " · primero conecta esta cuenta arriba" : ""}
              </p>
            ) : (
              <p className="text-xs text-destructive">
                No reconozco este enlace como carpeta de Google Drive u OneDrive.
              </p>
            )
          ) : null}
          {fuente?.folderName ? (
            <p className="text-xs">Carpeta actual: {fuente.folderName}</p>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`sub-${proposito}`}>Subcarpeta dentro de cada mes (opcional)</Label>
            <Input
              id={`sub-${proposito}`}
              value={sub}
              onChange={(ev) => setSub(ev.target.value)}
              placeholder={`Ej. ${info.ejemploSub}; vacío = todo el mes`}
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-xs">
            <Switch checked={activa} onCheckedChange={setActiva} /> Revisión diaria
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => guardarM.mutate()}
            disabled={guardarM.isPending || !enlace || (conexion ? !conexion.connected : true)}
          >
            {guardarM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Guardar carpeta
          </Button>
          {fuente ? (
            <Button
              variant="outline"
              onClick={() => revisarM.mutate()}
              disabled={revisarM.isPending}
            >
              {revisarM.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Revisar ahora
            </Button>
          ) : null}
        </div>
      </div>

      {fuente ? (
        <div className="mt-4 space-y-1 rounded-md bg-muted/40 p-3 text-xs">
          <p>
            Última revisión: {fuente.lastRunAt ? fechaHora(fuente.lastRunAt) : "nunca"}
            {fuente.lastStatus === "con_errores" ? " · con errores" : ""}
          </p>
          {r ? (
            <>
              <p>
                {r.modo === "carpeta_directa"
                  ? "Carpeta sin meses (se revisa completa)"
                  : r.periodos.join(" y ")}
                : {r.encontrados} archivo(s) ·{" "}
                {proposito === "compras"
                  ? `${r.facturasEncoladas} PDF y ${r.documentosExcel} documento(s) del Excel enviados a la carga masiva`
                  : `${r.egresosRecibidos} nuevo(s) en la bandeja`}{" "}
                · {r.duplicados} ya cargado(s) antes
                {r.renombrados ? ` · ${r.renombrados} renombrado(s)` : ""}
                {r.pendientesProximaEjecucion
                  ? ` · ${r.pendientesProximaEjecucion} quedan para la próxima revisión`
                  : ""}
              </p>
              {r.advertencias.map((m) => (
                <p key={m} className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {m}
                </p>
              ))}
              {r.errores.map((m) => (
                <p key={m} className="text-destructive">
                  {m}
                </p>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ESTADO_EGRESO: Record<EgresoDoc["status"], string> = {
  pendiente: "Pendiente",
  revisado: "Revisado",
  descartado: "Descartado",
};

function BandejaEgresos({ companyId }: { companyId: string }) {
  const listar = useServerFn(egresosListar);
  const marcar = useServerFn(egresosMarcar);
  const [todos, setTodos] = useState(false);
  const lista = useQuery({
    queryKey: ["egresos-bandeja", companyId, todos],
    queryFn: () => listar({ data: { companyId, incluirRevisados: todos } }),
  });
  const cambiar = useMutation({
    mutationFn: (v: { id: string; status: EgresoDoc["status"] }) =>
      marcar({ data: { companyId, ...v } }),
    onSuccess: () => void lista.refetch(),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "No fue posible actualizar."),
  });

  async function abrir(d: EgresoDoc) {
    const { data, error } = await supabase.storage
      .from("facturas")
      .createSignedUrl(d.storage_path, 300);
    if (error || !data?.signedUrl) {
      toast.error(error?.message ?? "No fue posible abrir el archivo.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  const docs = lista.data ?? [];
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Bandeja de egresos</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Soportes de pago y extractos traídos de la carpeta de egresos, pendientes de cruzar con
            las facturas.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={todos} onCheckedChange={setTodos} /> Mostrar revisados y descartados
        </label>
      </div>
      {docs.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {lista.isLoading ? "Cargando…" : "No hay egresos pendientes."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Archivo</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Mes</TableHead>
                <TableHead>Recibido</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="max-w-[320px]">
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate" title={d.file_name}>
                        {d.file_name}
                      </span>
                    </div>
                    {d.folder_path ? (
                      <p className="truncate text-xs text-muted-foreground">{d.folder_path}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>{d.kind === "extracto" ? "Extracto" : "Soporte de pago"}</TableCell>
                  <TableCell>{d.period ?? "—"}</TableCell>
                  <TableCell>{fechaHora(d.created_at)}</TableCell>
                  <TableCell>
                    <Badge variant={d.status === "pendiente" ? "outline" : "secondary"}>
                      {ESTADO_EGRESO[d.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void abrir(d)}>
                        <ExternalLink className="size-4" /> Abrir
                      </Button>
                      {d.status === "pendiente" ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => cambiar.mutate({ id: d.id, status: "revisado" })}
                          >
                            Revisado
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => cambiar.mutate({ id: d.id, status: "descartado" })}
                          >
                            Descartar
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => cambiar.mutate({ id: d.id, status: "pendiente" })}
                        >
                          Volver a pendiente
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
