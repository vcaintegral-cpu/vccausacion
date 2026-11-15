// Muestra qué entrega la API de compras de Siigo (función «historial_api_siigo»). No guarda nada.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { siigoDiagnosticoCompras, type DiagnosticoCompras } from "@/lib/siigo-historial.functions";

export function HistorialApiSiigoPanel({ companyId }: { companyId: string }) {
  const diagnosticar = useServerFn(siigoDiagnosticoCompras);
  const [desde, setDesde] = useState("2026-11-01");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<DiagnosticoCompras | null>(null);

  async function probar() {
    setBusy(true);
    try {
      setRes(await diagnosticar({ data: { companyId, desde } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible consultar a Siigo.");
    } finally {
      setBusy(false);
    }
  }
  const texto = res
    ? `Compras desde ${desde}: ${res.total ?? "—"}\nCampos de compra: ${res.camposCompra.join(", ")}\nCampos de renglón: ${res.camposRenglon.join(", ")}\n\n${res.muestra}`
    : "";

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">Compras desde la API de Siigo</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Primero se comprueba qué datos entrega Siigo por cada compra (renglones, impuestos, centro
        de costo y si trae la cuenta contable). No se guarda nada.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          Compras creadas desde
          <Input
            type="date"
            className="h-8 w-40"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </label>
        <Button size="sm" variant="outline" onClick={() => void probar()} disabled={busy}>
          {busy ? <Loader2 className="mr-1 size-4 animate-spin" /> : null} Ver qué entrega Siigo
        </Button>
        {res ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigator.clipboard.writeText(texto).then(() => toast.success("Copiado."))
            }
          >
            Copiar resultado
          </Button>
        ) : null}
      </div>
      {res ? (
        <div className="mt-3 space-y-2 text-xs">
          <div>
            Compras encontradas desde esa fecha: <b>{res.total ?? "—"}</b>
          </div>
          <div>
            Campos de cada compra:{" "}
            <span className="font-mono">{res.camposCompra.join(", ") || "—"}</span>
          </div>
          <div>
            Campos de cada renglón:{" "}
            <span className="font-mono">{res.camposRenglon.join(", ") || "—"}</span>
          </div>
          <pre className="max-h-96 overflow-auto rounded bg-muted/40 p-3 text-[11px]">{texto}</pre>
        </div>
      ) : null}
    </div>
  );
}
