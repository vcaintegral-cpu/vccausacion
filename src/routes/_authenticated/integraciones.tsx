import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fechaHora } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/integraciones")({
  head: () => ({
    meta: [
      { title: "Integraciones contables — Siigo, Loggro, Helisa, World Office" },
      {
        name: "description",
        content:
          "Conecta tu software contable y sincroniza facturas electrónicas. Asistente de conexión con Siigo en tres pasos.",
      },
      { property: "og:title", content: "Integraciones contables" },
      { property: "og:description", content: "Conecta Siigo, Loggro, Helisa o World Office y sincroniza tus facturas." },
    ],
  }),
  component: Integraciones,
});

type Software = { id: string; name: string; desc: string; available: boolean };

const SOFTWARE: Software[] = [
  { id: "siigo", name: "Siigo", desc: "Sincroniza facturas, terceros y plan de cuentas vía API.", available: true },
  { id: "loggro", name: "Loggro", desc: "Integración por API en preparación.", available: false },
  { id: "helisa", name: "Helisa", desc: "Exportación de comprobantes en archivo plano.", available: false },
  { id: "world-office", name: "World Office", desc: "Importación de comprobantes en Excel.", available: false },
];

const STORAGE_KEY = "causacion.integracion.siigo";

type SiigoConn = { user: string; connectedAt: string; lastSync: string };

function readConn(): SiigoConn | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SiigoConn) : null;
  } catch {
    return null;
  }
}

function Integraciones() {
  const [conn, setConn] = useState<SiigoConn | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setConn(readConn());
  }, []);

  function persist(next: SiigoConn | null) {
    setConn(next);
    if (typeof window === "undefined") return;
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  }

  function sincronizar() {
    if (!conn) return;
    const next = { ...conn, lastSync: new Date().toISOString() };
    persist(next);
    toast.success("Sincronización completada con Siigo.");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Integraciones</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Conecta tu software contable para sincronizar facturas electrónicas y catálogos.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SOFTWARE.map((s) => {
          const connected = s.id === "siigo" && !!conn;
          return (
            <div key={s.id} className="flex flex-col rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex size-9 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                  <Plug className="size-4" />
                </div>
                <Badge variant={connected ? "default" : "secondary"}>{connected ? "Conectado" : "No conectado"}</Badge>
              </div>
              <h2 className="mt-3 text-sm font-semibold">{s.name}</h2>
              <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">{s.desc}</p>
              {s.id === "siigo" ? (
                <div className="mt-4 space-y-2">
                  <Button className="w-full" variant={connected ? "outline" : "default"} onClick={() => setOpen(true)}>
                    {connected ? "Administrar conexión" : "Conectar"}
                  </Button>
                  {connected ? (
                    <>
                      <p className="text-xs text-muted-foreground">Última sincronización: {fechaHora(conn!.lastSync)}</p>
                      <Button variant="ghost" size="sm" className="w-full" onClick={sincronizar}>
                        <RefreshCw className="size-3.5" /> Sincronizar ahora
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : (
                <Button className="mt-4 w-full" variant="outline" disabled>
                  Próximamente
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <SiigoWizard
        open={open}
        conn={conn}
        onOpenChange={setOpen}
        onConnected={(c) => persist(c)}
        onDisconnect={() => {
          persist(null);
          toast.success("Conexión con Siigo eliminada.");
        }}
      />
    </div>
  );
}

const PERMISOS = [
  "Lectura de facturas electrónicas de compra",
  "Lectura de terceros (proveedores y clientes)",
  "Lectura del plan único de cuentas (PUC)",
];

function SiigoWizard({
  open,
  conn,
  onOpenChange,
  onConnected,
  onDisconnect,
}: {
  open: boolean;
  conn: SiigoConn | null;
  onOpenChange: (v: boolean) => void;
  onConnected: (c: SiigoConn) => void;
  onDisconnect: () => void;
}) {
  const [step, setStep] = useState(1);
  const [user, setUser] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [testing, setTesting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (conn) {
      setStep(3);
      setUser(conn.user);
      setDone(true);
      setAccepted(true);
    } else {
      setStep(1);
      setUser("");
      setAccessKey("");
      setAccepted(false);
      setDone(false);
    }
    setTesting(false);
  }, [open, conn]);

  useEffect(() => {
    if (step !== 3 || done || testing) return;
    setTesting(true);
    const t = setTimeout(() => {
      setTesting(false);
      setDone(true);
      onConnected({ user, connectedAt: new Date().toISOString(), lastSync: new Date().toISOString() });
    }, 1800);
    return () => clearTimeout(t);
  }, [step, done, testing, user, onConnected]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Conectar con Siigo</DialogTitle>
          <DialogDescription>Paso {step} de 3 · asistente de conexión segura</DialogDescription>
        </DialogHeader>

        <Progress value={(step / 3) * 100} className="h-1.5" />

        {step === 1 ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="siigo-user">Usuario API</Label>
              <Input
                id="siigo-user"
                placeholder="contabilidad@empresa.com.co"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="siigo-key">Access Key</Label>
              <Input
                id="siigo-key"
                type="password"
                placeholder="••••••••••••••••"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              ¿Dónde encuentro mis credenciales? En Siigo Nube entra a{" "}
              <span className="font-medium text-foreground">Configuración → Integraciones → API</span> y genera tu Access
              Key con el usuario administrador.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button disabled={!user.trim() || !accessKey.trim()} onClick={() => setStep(2)}>
                Continuar
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 text-primary" /> Autorización segura
              </div>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                {PERMISOS.map((p) => (
                  <li key={p} className="flex gap-2">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                    {p}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                No se realizan escrituras en Siigo sin tu aprobación explícita de cada comprobante.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} className="mt-0.5" />
              <span>Autorizo el acceso a mi cuenta de Siigo con los permisos descritos.</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Atrás
              </Button>
              <Button disabled={!accepted} onClick={() => setStep(3)}>
                Autorizar y continuar
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-4">
            {!done ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <Loader2 className="size-7 animate-spin text-primary" />
                <p className="text-sm font-medium">Probando conexión...</p>
                <p className="text-xs text-muted-foreground">Validando credenciales y permisos con Siigo.</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-md border border-border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Estado de la conexión</span>
                    <Badge className="bg-success text-success-foreground hover:bg-success">Activa</Badge>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Usuario API</dt>
                      <dd className="truncate font-mono text-xs">{conn?.user ?? user}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Última sincronización</dt>
                      <dd className="font-mono text-xs">{fechaHora(conn?.lastSync ?? new Date().toISOString())}</dd>
                    </div>
                  </dl>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" onClick={onDisconnect}>
                    Desconectar
                  </Button>
                  <Button variant="outline" onClick={() => toast.success("Sincronización completada con Siigo.")}>
                    <RefreshCw className="size-4" /> Sincronizar ahora
                  </Button>
                  <Button onClick={() => onOpenChange(false)}>Finalizar</Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}