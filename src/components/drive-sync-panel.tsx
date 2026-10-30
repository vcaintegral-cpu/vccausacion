import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, FolderSync, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fechaHora } from "@/lib/format";
import {
  driveConnectStart,
  driveDisconnect,
  driveSaveFolder,
  driveSyncRunNow,
  driveSyncStatus,
} from "@/lib/drive-sync.functions";

/**
 * Importador de compras desde Google Drive: conecta la cuenta de Google con
 * acceso a la carpeta de la empresa y encola los PDF nuevos de FACTURAS del
 * mes actual y el anterior en la carga masiva. La revisión automática es diaria.
 */
export function DriveSyncPanel({ companyId }: { companyId: string }) {
  const getStatus = useServerFn(driveSyncStatus);
  const connectStart = useServerFn(driveConnectStart);
  const saveFolder = useServerFn(driveSaveFolder);
  const runNow = useServerFn(driveSyncRunNow);
  const disconnect = useServerFn(driveDisconnect);
  const [folder, setFolder] = useState("");
  const [enabled, setEnabled] = useState(true);

  const status = useQuery({
    queryKey: ["drive-sync-status", companyId],
    queryFn: () => getStatus({ data: { companyId } }),
    enabled: !!companyId,
  });
  const s = status.data;

  useEffect(() => {
    if (s?.folderId) {
      setFolder(`https://drive.google.com/drive/folders/${s.folderId}`);
      setEnabled(s.enabled);
    }
  }, [s?.folderId, s?.enabled]);

  // Resultado del regreso desde Google (?drive=ok|error&detalle=...).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const drive = params.get("drive");
    if (!drive) return;
    if (drive === "ok") toast.success("Google Drive conectado.");
    else toast.error(`No se pudo conectar Google Drive. ${params.get("detalle") ?? ""}`);
    params.delete("drive");
    params.delete("detalle");
    const q = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
  }, []);

  const conectar = useMutation({
    mutationFn: () => connectStart({ data: { companyId } }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "No fue posible iniciar la conexión."),
  });
  const guardar = useMutation({
    mutationFn: () => saveFolder({ data: { companyId, folder, enabled } }),
    onSuccess: (r) => {
      toast.success(`Carpeta "${r.folderName}" guardada.`);
      void status.refetch();
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "No fue posible guardar la carpeta."),
  });
  const ejecutar = useMutation({
    mutationFn: () => runNow({ data: { companyId } }),
    onSuccess: (r) => {
      if (r.errores.length)
        toast.error(`Importación con ${r.errores.length} error(es). Revisa el detalle.`);
      else toast.success(`${r.encolados} factura(s) nuevas enviadas a la carga masiva.`);
      void status.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "No fue posible importar."),
  });
  const desconectar = useMutation({
    mutationFn: () => disconnect({ data: { companyId } }),
    onSuccess: () => {
      toast.success("Google Drive desconectado.");
      void status.refetch();
    },
  });

  const r = s?.lastResult;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
            <FolderSync className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Google Drive · compras del mes</h2>
              {s?.connected ? (
                <Badge variant="secondary">
                  <CheckCircle2 className="size-3" /> {s.googleEmail ?? "Conectado"}
                </Badge>
              ) : (
                <Badge variant="outline">Sin conectar</Badge>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Revisa una vez al día &lt;carpeta&gt;/&lt;año&gt;/&lt;N. MES&gt;/FACTURAS del mes
              actual y el anterior, y envía los PDF nuevos a la carga masiva. Quedan como borrador:
              nada se envía a Siigo sin aprobación.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {s?.connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => desconectar.mutate()}
              disabled={desconectar.isPending}
            >
              Desconectar
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => conectar.mutate()}
            disabled={conectar.isPending || !s || s.missingEnv.length > 0}
          >
            {conectar.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {s?.connected ? "Reconectar Google" : "Conectar Google Drive"}
          </Button>
        </div>
      </div>

      {s && s.missingEnv.length > 0 ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="size-4" /> Falta configurar en el servidor:{" "}
          {s.missingEnv.join(", ")}.
        </p>
      ) : null}

      {s?.connected ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="drive-folder">Carpeta raíz de la empresa (enlace de Drive)</Label>
            <Input
              id="drive-folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/..."
            />
            {s.folderName ? (
              <p className="text-xs text-muted-foreground">Actual: {s.folderName}</p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={enabled} onCheckedChange={setEnabled} /> Revisión diaria
          </label>
          <Button
            variant="outline"
            onClick={() => guardar.mutate()}
            disabled={guardar.isPending || !folder.trim()}
          >
            Guardar carpeta
          </Button>
        </div>
      ) : null}

      {s?.folderId ? (
        <div className="mt-4 space-y-2 rounded-md bg-muted/40 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Última revisión: {s.lastRunAt ? fechaHora(s.lastRunAt) : "nunca"}
              {s.lastStatus === "con_errores" ? " · con errores" : ""}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => ejecutar.mutate()}
              disabled={ejecutar.isPending}
            >
              {ejecutar.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Revisar ahora
            </Button>
          </div>
          {r ? (
            <>
              <p>
                {r.periodos.join(" y ")}: {r.encontrados} PDF en Drive · {r.encolados} nuevos
                enviados a la carga masiva · {r.duplicados} ya cargados antes · {r.renombrados}{" "}
                renombrados
                {r.pendientesProximaEjecucion > 0
                  ? ` · ${r.pendientesProximaEjecucion} quedan para la próxima revisión`
                  : ""}
              </p>
              {[...r.advertencias, ...r.errores].map((m) => (
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
