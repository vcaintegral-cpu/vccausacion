// Condición tributaria del proveedor: precedente aprendido de Siigo, condición
// confirmada (memoria) y sugerencia de retenciones para la factura abierta.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, History, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { invalidateBulkDeps } from "@/lib/bulk-runner";
import { cop } from "@/lib/format";
import {
  MOTIVO_LABEL,
  RETENCIONES,
  condicionDePerfil,
  decidirRetenciones,
  perfilConCondicion,
  precedenteDe,
  type CondicionTributaria,
  type DecisionRetenciones,
  type ImpuestoConfigurado,
  type MotivoSinRetencion,
} from "@/lib/precedente-tributario";
import { cargarPrecedentes, cargarTablasBases } from "@/lib/precedente-tributario.data";
import type { PucAccount } from "@/lib/puc-hierarchy";
import {
  RET_LABEL,
  aplicarImpuesto,
  type RetBlocks,
  type RetencionKind,
  type TaxLike,
} from "@/lib/retenciones-multi";

/** Bloques de retención según la decisión: aplica las sugeridas y apaga las exentas. */
export function bloquesDesdeDecision(
  blocks: RetBlocks,
  decision: DecisionRetenciones,
  condicion: CondicionTributaria | null,
  puc: PucAccount[],
): RetBlocks {
  const next: RetBlocks = { ...blocks };
  for (const r of decision.aplicar) {
    next[r.kind] = aplicarImpuesto(
      { ...blocks[r.kind], base: r.base },
      r.tax as unknown as TaxLike,
      puc,
    );
  }
  for (const kind of RETENCIONES) {
    if (condicion?.sinRetencion?.[kind]) next[kind] = { ...blocks[kind], apply: false, amount: 0 };
  }
  return next;
}

export function CondicionTributariaPanel(props: {
  companyId: string;
  nit: string | null | undefined;
  nombre: string | null | undefined;
  fecha: string | null | undefined;
  baseGravable: number;
  ivaTotal: number;
  taxes: ImpuestoConfigurado[];
  puc: PucAccount[];
  blocks: RetBlocks;
  onApply: (next: RetBlocks) => void;
}) {
  const { companyId, nit, taxes } = props;
  const queryClient = useQueryClient();
  const [modo, setModo] = useState<"exento" | "retener" | null>(null);
  const [motivo, setMotivo] = useState<MotivoSinRetencion>("autorretenedor");
  const [detalle, setDetalle] = useState("");
  const [kindsExentos, setKindsExentos] = useState<RetencionKind[]>(["retefuente"]);
  const [retenerCon, setRetenerCon] = useState<Partial<Record<RetencionKind, string>>>({});
  const [guardando, setGuardando] = useState(false);

  const precedentes = useQuery({
    queryKey: ["precedente-tributario", companyId, taxes.length],
    enabled: !!companyId && taxes.length > 0,
    staleTime: 5 * 60_000,
    queryFn: () => cargarPrecedentes(companyId, taxes),
  });
  const tablas = useQuery({
    queryKey: ["tablas-bases"],
    staleTime: 5 * 60_000,
    queryFn: cargarTablasBases,
  });
  const proveedor = useQuery({
    queryKey: ["proveedor-condicion", companyId, nit],
    enabled: !!companyId && !!nit,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("providers")
        .select("id, name, purchase_tax_profile")
        .eq("company_id", companyId)
        .eq("nit", nit!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (!nit) return null;
  const precedente = precedenteDe(precedentes.data, nit);
  const condicion = condicionDePerfil(proveedor.data?.purchase_tax_profile);
  const decision = decidirRetenciones({
    kinds: RETENCIONES,
    precedente,
    condicion,
    taxes,
    baseGravable: props.baseGravable,
    ivaTotal: props.ivaTotal,
    fecha: props.fecha ?? null,
    tablas: tablas.data ?? [],
  });
  const nombreTax = (id: string | null) =>
    id ? (taxes.find((t) => String(t.id) === id)?.name ?? "impuesto no configurado") : null;
  const retencionesDisponibles = (kind: RetencionKind) =>
    taxes.filter((t) => t.kind === kind && t.active !== false);

  async function guardar(nueva: CondicionTributaria | null) {
    setGuardando(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const conFirma = nueva
        ? {
            ...nueva,
            confirmadoPor: auth.user?.email ?? auth.user?.id ?? null,
            confirmadoEn: new Date().toISOString().slice(0, 10),
          }
        : null;
      const perfil = perfilConCondicion(proveedor.data?.purchase_tax_profile, conFirma);
      const { error } = await supabase.from("providers").upsert(
        {
          company_id: companyId,
          nit: nit!,
          name: proveedor.data?.name ?? props.nombre ?? nit!,
          purchase_tax_profile: perfil as never,
        },
        { onConflict: "company_id,nit" },
      );
      if (error) throw error;
      invalidateBulkDeps(companyId);
      await queryClient.invalidateQueries({ queryKey: ["proveedor-condicion", companyId, nit] });
      // La factura abierta toma la nueva condición de inmediato.
      const d = decidirRetenciones({
        kinds: RETENCIONES,
        precedente,
        condicion: conFirma,
        taxes,
        baseGravable: props.baseGravable,
        ivaTotal: props.ivaTotal,
        fecha: props.fecha ?? null,
        tablas: tablas.data ?? [],
      });
      props.onApply(bloquesDesdeDecision(props.blocks, d, conFirma, props.puc));
      setModo(null);
      toast.success(
        nueva
          ? "Condición guardada: se aplicará a las próximas facturas de este proveedor."
          : "Condición eliminada.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible guardar la condición.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Condición tributaria del proveedor</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Aprendida de lo sincronizado con Siigo. Vale para todas las facturas de este proveedor
            en esta empresa.
          </p>
        </div>
        {precedentes.isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <div className="mt-3 space-y-1 text-xs">
        <p className="flex items-start gap-1.5">
          <History className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          {precedente
            ? `${precedente.documentosSiigo} documento(s) sincronizados con Siigo${precedente.movimientosHistoricos ? ` y ${precedente.movimientosHistoricos} movimiento(s) del auxiliar histórico` : ""}.`
            : "Sin precedente en Siigo para este proveedor."}
        </p>
        {precedente?.iva.length ? (
          <p className="pl-5">
            IVA usado:{" "}
            {precedente.iva
              .map((u) => `${nombreTax(u.taxId) ?? `cuenta ${u.cuenta}`} (${u.veces})`)
              .join(" · ")}
          </p>
        ) : null}
        {precedente
          ? RETENCIONES.map((k) =>
              precedente.retenciones[k].length || precedente.sinRetencion[k] ? (
                <p key={k} className="pl-5">
                  {RET_LABEL[k]}:{" "}
                  {precedente.retenciones[k].length
                    ? precedente.retenciones[k]
                        .map(
                          (u) =>
                            `${nombreTax(u.taxId) ?? `cuenta ${u.cuenta}`}${u.tarifa != null ? ` ${u.tarifa}%` : ""} (${u.veces})`,
                        )
                        .join(" · ")
                    : "nunca"}
                  {precedente.sinRetencion[k]
                    ? ` · sin retención en ${precedente.sinRetencion[k]}`
                    : ""}
                </p>
              ) : null,
            )
          : null}
      </div>

      {condicion ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 p-2 text-xs">
          <span className="flex items-start gap-1.5">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
            <span>
              {Object.entries(condicion.sinRetencion ?? {}).map(([k, v]) => (
                <span key={k} className="block">
                  Sin {RET_LABEL[k as RetencionKind]}: {MOTIVO_LABEL[v!.motivo]}
                  {v!.detalle ? ` (${v!.detalle})` : ""}
                </span>
              ))}
              {Object.entries(condicion.retenerCon ?? {}).map(([k, id]) => (
                <span key={k} className="block">
                  {RET_LABEL[k as RetencionKind]} siempre con: {nombreTax(id ?? null)}
                </span>
              ))}
              <span className="block text-muted-foreground">
                Confirmado {condicion.confirmadoEn ?? ""}{" "}
                {condicion.confirmadoPor ? `por ${condicion.confirmadoPor}` : ""}
              </span>
            </span>
          </span>
          <Button size="sm" variant="ghost" disabled={guardando} onClick={() => void guardar(null)}>
            Quitar condición
          </Button>
        </div>
      ) : null}

      {decision.confirmar ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {decision.confirmar}
        </p>
      ) : null}
      {decision.avisos.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {decision.avisos.map((a) => (
            <li key={a}>• {a}</li>
          ))}
        </ul>
      ) : null}
      {decision.aplicar.length ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            Sugerido:{" "}
            {decision.aplicar
              .map((r) => `${r.tax.name} ${cop(r.amount)} (${r.origen})`)
              .join(" · ")}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              props.onApply(bloquesDesdeDecision(props.blocks, decision, condicion, props.puc))
            }
          >
            Aplicar a las retenciones
          </Button>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={modo === "exento" ? "secondary" : "outline"}
          onClick={() => setModo(modo === "exento" ? null : "exento")}
        >
          No se le retiene…
        </Button>
        <Button
          size="sm"
          variant={modo === "retener" ? "secondary" : "outline"}
          onClick={() => setModo(modo === "retener" ? null : "retener")}
        >
          Retenerle siempre con…
        </Button>
      </div>

      {modo === "exento" ? (
        <div className="mt-3 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Condición</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value as MotivoSinRetencion)}
            >
              {(Object.keys(MOTIVO_LABEL) as MotivoSinRetencion[]).map((m) => (
                <option key={m} value={m}>
                  {MOTIVO_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Detalle (resolución, certificado, nota)</Label>
            <Input
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              placeholder="Opcional"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">No se le practica</Label>
            <div className="flex flex-wrap gap-3 text-sm">
              {RETENCIONES.map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={kindsExentos.includes(k)}
                    onChange={(e) =>
                      setKindsExentos((prev) =>
                        e.target.checked ? [...prev, k] : prev.filter((x) => x !== k),
                      )
                    }
                  />
                  {RET_LABEL[k]}
                </label>
              ))}
            </div>
          </div>
          <div className="sm:col-span-2">
            <Button
              size="sm"
              disabled={guardando || kindsExentos.length === 0}
              onClick={() =>
                void guardar({
                  ...condicion,
                  sinRetencion: {
                    ...condicion?.sinRetencion,
                    ...Object.fromEntries(
                      kindsExentos.map((k) => [k, { motivo, detalle: detalle.trim() || null }]),
                    ),
                  },
                  retenerCon: Object.fromEntries(
                    Object.entries(condicion?.retenerCon ?? {}).filter(
                      ([k]) => !kindsExentos.includes(k as RetencionKind),
                    ),
                  ),
                })
              }
            >
              Guardar condición
            </Button>
          </div>
        </div>
      ) : null}

      {modo === "retener" ? (
        <div className="mt-3 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          {RETENCIONES.map((k) => (
            <div key={k} className="space-y-1">
              <Label className="text-xs">{RET_LABEL[k]}</Label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={retenerCon[k] ?? ""}
                onChange={(e) =>
                  setRetenerCon((prev) => ({ ...prev, [k]: e.target.value || undefined }))
                }
              >
                <option value="">Sin cambio</option>
                {retencionesDisponibles(k).map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.name} ({t.rate}%)
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="sm:col-span-3">
            <Button
              size="sm"
              disabled={guardando || !Object.values(retenerCon).some(Boolean)}
              onClick={() => {
                const elegidos = Object.fromEntries(
                  Object.entries(retenerCon).filter(([, v]) => !!v),
                ) as Partial<Record<RetencionKind, string>>;
                void guardar({
                  ...condicion,
                  retenerCon: { ...condicion?.retenerCon, ...elegidos },
                  sinRetencion: Object.fromEntries(
                    Object.entries(condicion?.sinRetencion ?? {}).filter(([k]) => !(k in elegidos)),
                  ),
                });
              }}
            >
              Guardar condición
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
