// Compras del mes enviadas a Siigo como pagadas que deben quedar por pagar
// (función por empresa `compras_por_pagar`). Revisión en Siigo por lotes y corrección
// de la forma de pago solo con confirmación.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cop, fecha } from "@/lib/format";
import {
  comprasPagadasRevisar,
  compraPasarAPorPagar,
  type CompraPagada,
} from "@/lib/compras-por-pagar.functions";

export function ComprasPorPagarPanel({
  companyId,
  periodo,
  onCambio,
}: {
  companyId: string;
  periodo: string;
  onCambio: () => void;
}) {
  const revisar = useServerFn(comprasPagadasRevisar);
  const corregir = useServerFn(compraPasarAPorPagar);
  const [pagadas, setPagadas] = useState<CompraPagada[] | null>(null);
  const [erroresLectura, setErroresLectura] = useState<string[]>([]);
  const [progreso, setProgreso] = useState<string | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [resultados, setResultados] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  );

  const onRevisar = async () => {
    setPagadas(null);
    setErroresLectura([]);
    const errs: string[] = [];
    setResultados({});
    const todas: CompraPagada[] = [];
    let desde: number | null = 0;
    try {
      while (desde != null) {
        const r = await revisar({ data: { companyId, periodo, desde } });
        todas.push(...r.pagadas);
        errs.push(...r.errores);
        setErroresLectura([...errs]);
        setProgreso(`Revisadas ${r.revisadas} de ${r.total} compras en Siigo…`);
        desde = r.siguiente;
      }
      setPagadas(todas);
      // Por defecto solo las del mes revisado.
      setMarcadas(
        new Set(
          todas.filter((c) => String(c.fecha ?? "").startsWith(periodo)).map((c) => c.siigoId),
        ),
      );
      toast.info(
        todas.length
          ? `${todas.length} compras quedaron pagadas en Siigo.`
          : "Todas las compras del mes están por pagar.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setProgreso(null);
    }
  };

  const onCorregir = async () => {
    const lista = (pagadas ?? []).filter(
      (c) => marcadas.has(c.siigoId) && !resultados[c.siigoId]?.ok,
    );
    if (!lista.length) return;
    if (
      !window.confirm(
        `Se editarán ${lista.length} compras en Siigo: su forma de pago pasará a la forma a crédito (por pagar) de la empresa, por el mismo valor. ¿Continuar?`,
      )
    )
      return;
    let ok = 0;
    for (const [i, c] of lista.entries()) {
      setProgreso(`Corrigiendo ${i + 1} de ${lista.length}: ${c.siigoNumero ?? c.factura}`);
      // Pausa entre compras: Siigo limita las peticiones por segundo.
      if (i > 0) await new Promise((r) => setTimeout(r, 1200));
      try {
        const r = await corregir({
          data: { companyId, invoiceId: c.invoiceId, siigoId: c.siigoId, confirmado: true },
        });
        setResultados((x) => ({ ...x, [c.siigoId]: r }));
        if (r.ok) ok += 1;
        else {
          toast.error(r.message);
          break; // se detiene en el primer rechazo para revisarlo
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setResultados((x) => ({ ...x, [c.siigoId]: { ok: false, message } }));
        toast.error(message);
        break;
      }
    }
    setProgreso(null);
    toast.success(`${ok} compras quedaron por pagar en Siigo.`);
    onCambio();
  };

  return (
    <div className="rounded-lg border bg-card p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold">Compras del mes que quedaron pagadas en Siigo</div>
          <div className="text-muted-foreground">
            Regla de la empresa: toda compra queda por pagar (crédito) y se paga con el recibo de
            pago. Aquí se corrigen las enviadas como pagadas (tarjeta, efectivo, banco, contado).
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onRevisar} disabled={!!progreso}>
            Revisar compras de {periodo}
          </Button>
          {pagadas?.length ? (
            <Button size="sm" onClick={onCorregir} disabled={!!progreso || marcadas.size === 0}>
              Pasar a por pagar en Siigo ({marcadas.size})
            </Button>
          ) : null}
        </div>
      </div>
      {erroresLectura.length ? (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-800">
          <div className="font-medium">
            Siigo no devolvió {erroresLectura.length} compra(s) al revisarlas; se clasificaron con
            la forma de pago con que las envió la herramienta. Si alguna falta en la lista, vuelve a
            revisar en unos minutos.
          </div>
          {erroresLectura.slice(0, 20).map((e) => (
            <div key={e} className="truncate">
              • {e}
            </div>
          ))}
        </div>
      ) : null}
      {progreso ? (
        <div className="mt-2 flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {progreso}
        </div>
      ) : null}
      {pagadas?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">Marcar:</span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2"
            onClick={() => setMarcadas(new Set(pagadas.map((c) => c.siigoId)))}
          >
            Todas ({pagadas.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2"
            onClick={() => setMarcadas(new Set())}
          >
            Ninguna
          </Button>
          {[...new Set(pagadas.map((c) => String(c.fecha ?? "").slice(0, 7)).filter(Boolean))]
            .sort()
            .map((mes) => {
              const delMes = pagadas.filter((c) => String(c.fecha ?? "").startsWith(mes));
              return (
                <Button
                  key={mes}
                  size="sm"
                  variant="outline"
                  className="h-6 px-2"
                  onClick={() => setMarcadas(new Set(delMes.map((c) => c.siigoId)))}
                >
                  Solo {mes} ({delMes.length})
                </Button>
              );
            })}
        </div>
      ) : null}
      {pagadas?.length ? (
        <div className="mt-2 max-h-80 overflow-auto rounded border">
          {pagadas.map((c) => (
            <div key={c.siigoId} className="flex items-start gap-2 border-b px-2 py-1">
              <Checkbox
                checked={marcadas.has(c.siigoId)}
                onCheckedChange={(v) =>
                  setMarcadas((s) => {
                    const n = new Set(s);
                    if (v) n.add(c.siigoId);
                    else n.delete(c.siigoId);
                    return n;
                  })
                }
              />
              <span className="w-24">{c.siigoNumero}</span>
              <span className="w-20">{fecha(c.fecha)}</span>
              <span className="w-56 truncate">{c.proveedor}</span>
              <span className="w-28">{c.factura}</span>
              <span className="w-28 text-right">{cop(c.total)}</span>
              <span className="flex-1 text-muted-foreground">
                {c.pagos.map((p) => p.name).join(", ")}
              </span>
              {resultados[c.siigoId] ? (
                <span className={resultados[c.siigoId]!.ok ? "text-emerald-700" : "text-red-700"}>
                  {resultados[c.siigoId]!.message}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
