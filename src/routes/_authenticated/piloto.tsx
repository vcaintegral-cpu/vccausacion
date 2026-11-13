// Piloto automático (empresas con el módulo «piloto»): configuración, memoria de cada noche y
// bandeja de decisiones (las mismas preguntas que llegan por correo).
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Play, Save } from "lucide-react";

import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fecha } from "@/lib/format";
import { PASOS } from "@/lib/piloto";
import {
  pilotoEjecutarAhora,
  pilotoEstado,
  pilotoGuardarConfig,
  pilotoResponder,
} from "@/lib/piloto.functions";

export const Route = createFileRoute("/_authenticated/piloto")({
  head: () => ({
    meta: [
      { title: "Piloto automático" },
      { name: "description", content: "Trabajo nocturno automático, memoria diaria y decisiones." },
    ],
  }),
  component: Piloto,
});

const ICONO: Record<string, string> = { hecho: "✔", pendiente: "…", omitido: "—", error: "✖" };

function Piloto() {
  const companyId = useActiveCompany();
  if (!companyId) return <EmptyCompany />;
  return <PilotoEmpresa key={companyId} companyId={companyId} />;
}

function PilotoEmpresa({ companyId }: { companyId: string }) {
  const leer = useServerFn(pilotoEstado);
  const guardar = useServerFn(pilotoGuardarConfig);
  const responder = useServerFn(pilotoResponder);
  const ejecutar = useServerFn(pilotoEjecutarAhora);
  const estado = useQuery({
    queryKey: ["piloto", companyId],
    queryFn: () => leer({ data: { companyId } }),
    refetchInterval: 60000,
  });
  const [form, setForm] = useState({
    activo: false,
    correo: "",
    tope_valor: "5000000",
    hora_inicio: "19",
  });
  useEffect(() => {
    const c = estado.data?.config;
    if (c)
      setForm({
        activo: c.activo,
        correo: c.correo ?? "",
        tope_valor: String(c.tope_valor),
        hora_inicio: String(c.hora_inicio),
      });
  }, [estado.data?.config]);
  const [instrucciones, setInstrucciones] = useState<Record<string, string>>({});

  const mGuardar = useMutation({
    mutationFn: () =>
      guardar({
        data: {
          companyId,
          activo: form.activo,
          correo: form.correo || null,
          tope_valor: Number(form.tope_valor),
          hora_inicio: Number(form.hora_inicio),
        },
      }),
    onSuccess: () => {
      toast.success("Configuración guardada.");
      void estado.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const mEjecutar = useMutation({
    mutationFn: () => ejecutar({ data: { companyId, base: window.location.origin } }),
    onSuccess: (r) => {
      for (const x of r) toast.info(x.detalle);
      if (!r.length) toast.warning("El piloto no está activo para esta empresa.");
      void estado.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const onResponder = async (id: string, respuesta: string | null) => {
    try {
      await responder({
        data: { decisionId: id, respuesta, instruccion: instrucciones[id] ?? null },
      });
      toast.success("Respuesta registrada: el piloto la aplica en su siguiente paso.");
      void estado.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const d = estado.data;
  const pendientes = (d?.decisiones ?? []).filter((x) => x.estado === "pendiente");
  const respondidas = (d?.decisiones ?? []).filter((x) => x.estado !== "pendiente").slice(0, 20);

  return (
    <div className="space-y-4 p-4 text-sm">
      <div>
        <h1 className="text-lg font-semibold">Piloto automático</h1>
        <p className="text-xs text-muted-foreground">
          Trabaja solo cada noche desde la hora de inicio hasta las 7 a. m.: Drive, compras, egresos
          y conciliación. Envía a Siigo solo lo que está en verde, le pregunta por correo lo demás y
          le envía el reporte al terminar.
        </p>
      </div>

      {estado.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
      {estado.error ? (
        <div className="text-red-700">
          {estado.error instanceof Error ? estado.error.message : String(estado.error)}
        </div>
      ) : null}

      <div className="rounded-lg border bg-card p-3 text-xs">
        <div className="mb-2 font-semibold">Configuración</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.activo}
              onChange={(e) => setForm((x) => ({ ...x, activo: e.target.checked }))}
            />
            Activo
          </label>
          <label className="flex flex-col gap-1">
            Correo para preguntas y reporte
            <Input
              className="h-8 w-64"
              type="email"
              value={form.correo}
              onChange={(e) => setForm((x) => ({ ...x, correo: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            Tope para aprobar solo ($)
            <Input
              className="h-8 w-36"
              type="number"
              value={form.tope_valor}
              onChange={(e) => setForm((x) => ({ ...x, tope_valor: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            Hora de inicio (Colombia)
            <Input
              className="h-8 w-24"
              type="number"
              min={0}
              max={23}
              value={form.hora_inicio}
              onChange={(e) => setForm((x) => ({ ...x, hora_inicio: e.target.value }))}
            />
          </label>
          <Button size="sm" onClick={() => mGuardar.mutate()} disabled={mGuardar.isPending}>
            <Save className="mr-1 h-4 w-4" /> Guardar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => mEjecutar.mutate()}
            disabled={mEjecutar.isPending}
          >
            {mEjecutar.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            Ejecutar un paso ahora
          </Button>
        </div>
        {d && !d.correoConfigurado ? (
          <div className="mt-2 text-amber-700">
            El envío de correos no está configurado: falta el secreto RESEND_API_KEY en la
            aplicación. Mientras tanto, las preguntas y el reporte quedan aquí.
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border bg-card p-3 text-xs">
        <div className="font-semibold">Bandeja de decisiones ({pendientes.length} pendientes)</div>
        <div className="text-muted-foreground">
          Las mismas preguntas del correo. Elija una opción o escriba una instrucción; el piloto
          sigue con lo demás mientras tanto.
        </div>
        {pendientes.map((x) => (
          <div key={x.id} className="mt-2 rounded border p-2">
            <div className="font-medium">{x.titulo}</div>
            <div className="my-1">{x.pregunta}</div>
            <div className="flex flex-wrap items-center gap-2">
              {x.opciones.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => void onResponder(x.id, o.id)}
                >
                  {o.etiqueta}
                </Button>
              ))}
              <Input
                className="h-7 w-80"
                placeholder="Instrucción adicional (opcional)"
                value={instrucciones[x.id] ?? ""}
                onChange={(e) => setInstrucciones((s) => ({ ...s, [x.id]: e.target.value }))}
              />
              <Button
                size="sm"
                className="h-7"
                disabled={!instrucciones[x.id]?.trim()}
                onClick={() => void onResponder(x.id, null)}
              >
                Enviar instrucción
              </Button>
            </div>
          </div>
        ))}
        {respondidas.length ? (
          <div className="mt-3">
            <div className="text-muted-foreground">Respondidas recientemente</div>
            {respondidas.map((x) => (
              <div key={x.id} className="border-b py-1">
                {x.titulo}:{" "}
                <b>
                  {x.opciones.find((o) => o.id === x.respuesta)?.etiqueta ?? x.respuesta ?? "—"}
                </b>
                {x.instruccion ? ` · «${x.instruccion}»` : ""} · {x.estado}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border bg-card p-3 text-xs">
        <div className="mb-1 font-semibold">Memoria de cada noche</div>
        {(d?.ejecuciones ?? []).map((e) => (
          <div key={e.id} className="mb-3">
            <div className="font-medium">
              Noche del {fecha(e.noche)} · {e.estado}
              {e.reporte_enviado_at ? " · reporte enviado" : ""}
            </div>
            {PASOS.map((p) => {
              const r = e.pasos.find((x) => x.id === p.id);
              return (
                <div key={p.id} className="flex gap-2 pl-2">
                  <span className="w-4">{r ? ICONO[r.estado] : "·"}</span>
                  <span className="w-80">{p.nombre}</span>
                  <span className="flex-1 text-muted-foreground">{r?.detalle ?? "Aún no"}</span>
                </div>
              );
            })}
          </div>
        ))}
        {!d?.ejecuciones.length ? (
          <div className="text-muted-foreground">Aún no hay noches ejecutadas.</div>
        ) : null}
      </div>
    </div>
  );
}
