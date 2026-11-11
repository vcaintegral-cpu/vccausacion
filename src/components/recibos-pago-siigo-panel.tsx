// Recibos de pago (RP) en Siigo: tipos y formas de pago, y prueba controlada
// (crear un anticipo pequeño real en Siigo, verlo y borrarlo).
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { siigoBorrarRecibo, siigoCrearAnticipo, siigoRecibosConfig } from "@/lib/siigo-pagos.functions";

const hoy = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

export function RecibosPagoSiigoPanel({ companyId }: { companyId: string }) {
  const cargar = useServerFn(siigoRecibosConfig);
  const crear = useServerFn(siigoCrearAnticipo);
  const borrar = useServerFn(siigoBorrarRecibo);
  const [abierto, setAbierto] = useState(false);
  const [nit, setNit] = useState("");
  const [valor, setValor] = useState("1000");
  const [fecha, setFecha] = useState(hoy());
  const [forma, setForma] = useState<number | "">("");
  const [tipo, setTipo] = useState<number | "">("");
  const [creados, setCreados] = useState<Array<{ siigoId: string; nombre: string | null; borrado?: boolean }>>([]);

  const config = useQuery({
    queryKey: ["siigo-rp-config", companyId],
    enabled: abierto && !!companyId,
    queryFn: () => cargar({ data: { companyId } }),
  });
  const tipos = (config.data?.tipos ?? []).filter((t) => t.active);
  const formas = (config.data?.formas ?? []).filter((f) => f.active && !f.dueDate);

  const crearPrueba = useMutation({
    mutationFn: () =>
      crear({
        data: {
          companyId,
          nit,
          fecha,
          valor: Number(valor),
          paymentTypeId: Number(forma),
          documentId: Number(tipo || tipos[0]?.id),
          observaciones: "PRUEBA de conexión desde la herramienta de causación — borrar",
        },
      }),
    onSuccess: (r) => {
      if (r.ok && r.siigoId) {
        setCreados((c) => [{ siigoId: r.siigoId!, nombre: r.nombre }, ...c]);
        toast.success(r.message);
      } else toast.error(`Siigo rechazó el anticipo: ${r.message}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "No fue posible crear el anticipo."),
  });
  const borrarPrueba = useMutation({
    mutationFn: (siigoId: string) => borrar({ data: { companyId, siigoId } }),
    onSuccess: (r, siigoId) => {
      if (r.ok) {
        setCreados((c) => c.map((x) => (x.siigoId === siigoId ? { ...x, borrado: true } : x)));
        toast.success(r.message);
      } else toast.error(`No se pudo borrar en Siigo: ${r.message}`);
    },
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Recibos de pago (RP) en Siigo</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Prueba de conexión: crea un anticipo pequeño real en Siigo a un proveedor, verifica que quedó creado y
            permite borrarlo de inmediato.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAbierto((v) => !v)}>
          {abierto ? "Ocultar" : "Probar recibo de pago"}
        </Button>
      </div>
      {abierto ? (
        <div className="mt-3 space-y-3">
          {config.isLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Consultando tipos de recibo y formas de pago en Siigo…
            </p>
          ) : config.error ? (
            <p className="text-xs text-destructive">{config.error instanceof Error ? config.error.message : "Error consultando Siigo."}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-5">
              <div className="space-y-1">
                <Label className="text-xs">NIT del proveedor (existente en Siigo)</Label>
                <Input value={nit} onChange={(e) => setNit(e.target.value)} placeholder="Sin dígito de verificación" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Valor</Label>
                <Input type="number" min={1} value={valor} onChange={(e) => setValor(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Fecha</Label>
                <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Forma de pago (caja / banco)</Label>
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={forma} onChange={(e) => setForma(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">Seleccionar…</option>
                  {formas.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}{f.accountCode ? ` · ${f.accountCode}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tipo de recibo</Label>
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={tipo} onChange={(e) => setTipo(e.target.value ? Number(e.target.value) : "")}>
                  {tipos.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.code ? ` (${t.code})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <Button
            size="sm"
            disabled={crearPrueba.isPending || !nit.trim() || !forma || !(Number(valor) > 0) || !tipos.length}
            onClick={() => crearPrueba.mutate()}
          >
            {crearPrueba.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Crear anticipo de prueba en Siigo
          </Button>
          {creados.length ? (
            <ul className="space-y-1 text-sm">
              {creados.map((c) => (
                <li key={c.siigoId} className="flex flex-wrap items-center gap-2">
                  <span className={c.borrado ? "line-through text-muted-foreground" : "font-medium"}>
                    {c.nombre || "Recibo"} · id Siigo {c.siigoId}
                  </span>
                  {c.borrado ? (
                    <span className="text-xs text-emerald-600">Borrado en Siigo</span>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-destructive" disabled={borrarPrueba.isPending} onClick={() => borrarPrueba.mutate(c.siigoId)}>
                      <Trash2 className="size-3.5" /> Borrar en Siigo
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
