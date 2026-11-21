// «Cuenta para todo el proveedor»: aplica una cuenta (y, si se quiere, la clasificación) a todas las facturas
// del proveedor en borrador, con confirmación, advertencia de las que no se pueden tocar y verificación real.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AccountCombobox, type PucOption } from "@/components/account-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  aplicarCuentaAlProveedor,
  listarFacturasDelProveedor,
  type FacturaProveedor,
  type ResultadoProveedor,
} from "@/lib/cuenta-proveedor";
import { loadDeps, invalidateBulkDeps } from "@/lib/bulk-runner";
import { supabase } from "@/integrations/supabase/client";

export function CuentaProveedorDialog(props: {
  open: boolean;
  onClose: (huboCambios: boolean) => void;
  companyId: string;
  nit: string | null;
  nombre: string | null;
  cuentas: PucOption[];
  inventario: boolean;
}) {
  const { open, companyId, nit } = props;
  const [facturas, setFacturas] = useState<FacturaProveedor[] | null>(null);
  const [cuenta, setCuenta] = useState<{ code: string; name: string | null } | null>(null);
  const [tipo, setTipo] = useState<"" | "gasto" | "producto">("");
  const [recordar, setRecordar] = useState(true);
  const [trabajando, setTrabajando] = useState(false);
  const [avance, setAvance] = useState<{ hechas: number; total: number } | null>(null);
  const [resultado, setResultado] = useState<ResultadoProveedor | null>(null);

  useEffect(() => {
    if (!open || !nit) return;
    setFacturas(null);
    setResultado(null);
    setCuenta(null);
    setTipo("");
    listarFacturasDelProveedor(companyId, nit)
      .then(setFacturas)
      .catch((e) => toast.error(e instanceof Error ? e.message : "No se pudieron leer las facturas del proveedor."));
  }, [open, companyId, nit]);

  const modificables = (facturas ?? []).filter((f) => f.modificable);
  const bloqueadas = (facturas ?? []).filter((f) => !f.modificable);

  async function aplicar() {
    if (!cuenta || !nit || modificables.length === 0) return;
    setTrabajando(true);
    setAvance({ hechas: 0, total: modificables.length });
    try {
      invalidateBulkDeps(companyId);
      const { config } = await loadDeps(companyId);
      const usuario = (await supabase.auth.getUser()).data.user?.email ?? null;
      const r = await aplicarCuentaAlProveedor({
        companyId,
        nit,
        nombre: props.nombre,
        facturas: facturas ?? [],
        cuenta,
        ...(tipo ? { tipo } : {}),
        recordarRegla: recordar,
        usuario,
        config,
        inventario: props.inventario,
        onAvance: (hechas, total) => setAvance({ hechas, total }),
      });
      setResultado(r);
      if (r.fallidas.length === 0) toast.success(`Cuenta ${cuenta.code} verificada en ${r.verificadas} factura(s).`);
      else toast.error(`${r.fallidas.length} factura(s) no quedaron con la cuenta. Revise el detalle.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible aplicar la cuenta.");
    } finally {
      setTrabajando(false);
      setAvance(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !trabajando && props.onClose(!!resultado)}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cuenta para todas las facturas del proveedor</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {props.nombre ?? "Proveedor"} · NIT {nit}. Solo cambia la cuenta (y la clasificación) de los renglones: no toca NIT,
          valores, impuestos, fechas ni centro de costo.
        </p>

        {facturas === null ? (
          <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Leyendo las facturas del proveedor…</p>
        ) : resultado ? (
          <div className="space-y-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="size-4 text-emerald-600" />
              Verificado en la base: {resultado.verificadas} de {modificables.length} factura(s) quedaron con la cuenta {cuenta?.code} en todos sus renglones.
            </p>
            {resultado.reglaGuardada ? <p className="text-xs text-muted-foreground">Quedó como regla del proveedor para sus próximas facturas.</p> : null}
            {resultado.fallidas.length ? (
              <ul className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 pl-6 text-xs text-destructive">
                {resultado.fallidas.map((f) => <li key={f.id}><strong>{f.label}</strong>: {f.motivo}</li>)}
              </ul>
            ) : null}
            {resultado.omitidas.length ? (
              <p className="text-xs text-muted-foreground">{resultado.omitidas.length} factura(s) no se modificaron (ver lista de advertencias).</p>
            ) : null}
            <Button onClick={() => props.onClose(true)}>Cerrar</Button>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p><strong>{modificables.length}</strong> factura(s) en borrador se actualizarán:{" "}
                <span className="text-muted-foreground">{modificables.map((f) => f.label).join(", ") || "ninguna"}</span></p>
            </div>
            {bloqueadas.length ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> {bloqueadas.length} factura(s) NO se modificarán</p>
                <ul className="mt-1 list-disc pl-6 text-xs">
                  {bloqueadas.map((f) => <li key={f.id}>{f.label}: {f.motivo}. Para cambiarla, devuélvala a borrador o revierta su causación.</li>)}
                </ul>
              </div>
            ) : null}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Cuenta contable (gasto/costo) para todos los renglones</label>
              <AccountCombobox accounts={props.cuentas} value={cuenta?.code ?? ""} onChange={(code, name) => setCuenta({ code, name })} placeholder="Elija la cuenta…" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Clasificación del concepto</label>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
                <option value="">Mantener la actual</option>
                <option value="gasto">Cuenta contable (gasto)</option>
                <option value="producto">Producto (busca el producto del catálogo por la descripción)</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="size-4 accent-primary" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} />
              Recordar esta cuenta como regla del proveedor para sus próximas facturas
            </label>
            {avance ? (
              <div>
                <p className="text-xs">Actualizando {avance.hechas} de {avance.total}…</p>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${avance.total ? (avance.hechas / avance.total) * 100 : 0}%` }} /></div>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={trabajando} onClick={() => props.onClose(false)}>Cancelar</Button>
              <Button disabled={trabajando || !cuenta || modificables.length === 0} onClick={() => void aplicar()}>
                {trabajando ? <Loader2 className="size-4 animate-spin" /> : null} Confirmar y aplicar a {modificables.length} factura(s)
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
