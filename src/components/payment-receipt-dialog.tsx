import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccountCombobox } from "@/components/account-combobox";
import { cop } from "@/lib/format";
import { roundCOP } from "@/lib/money";
import type { PucAccount } from "@/lib/puc-hierarchy";
import {
  MEDIOS,
  MEDIO_LABEL,
  cuentasDePago,
  generarRecibo,
  sugerenciaPagoProveedor,
  type ConfigPago,
  type MedioPago,
  type ResultadoPago,
} from "@/lib/payments";

export type FacturaPagable = {
  id: string;
  etiqueta: string;
  proveedor: string;
  nit: string;
  saldo: number;
};

const hoy = () => new Date().toISOString().slice(0, 10);

/**
 * Configuración y confirmación de recibos de pago (individual o masiva).
 * La causación NO se modifica: solo se afecta el saldo de la cuenta por pagar.
 */
export function PaymentReceiptDialog({
  open,
  onOpenChange,
  companyId,
  puc,
  facturas,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companyId: string | null | undefined;
  puc: PucAccount[];
  facturas: FacturaPagable[];
  onDone: (resultados: ResultadoPago[]) => void;
}) {
  const [comun, setComun] = useState<{ fecha: string; medio: MedioPago; cuenta: string; cuentaNombre: string | null; cheque: string; observaciones: string; completo: boolean }>({
    fecha: hoy(),
    medio: "banco",
    cuenta: "",
    cuentaNombre: null,
    cheque: "",
    observaciones: "",
    completo: true,
  });
  const [filas, setFilas] = useState<Record<string, ConfigPago>>({});
  const [procesando, setProcesando] = useState(false);
  const [avance, setAvance] = useState<{ hechas: number; total: number } | null>(null);

  // Al abrir: valor por defecto = saldo pendiente, y sugerencia aprendida por proveedor.
  useEffect(() => {
    if (!open) return;
    const base: Record<string, ConfigPago> = {};
    for (const f of facturas) {
      base[f.id] = { fecha: hoy(), medio: "banco", cuenta: "", cuentaNombre: null, cheque: "", valor: f.saldo, observaciones: "" };
    }
    setFilas(base);
    setAvance(null);
    if (!companyId) return;
    void sugerenciaPagoProveedor(
      companyId,
      facturas.map((f) => f.nit).filter(Boolean),
    ).then((sug) => {
      if (sug.size === 0) return;
      setFilas((prev) => {
        const next = { ...prev };
        for (const f of facturas) {
          const s = sug.get(f.nit);
          if (s && next[f.id] && !next[f.id]!.cuenta) {
            next[f.id] = { ...next[f.id]!, medio: s.medio, cuenta: s.cuenta, cuentaNombre: s.cuentaNombre };
          }
        }
        return next;
      });
    });
  }, [open, companyId, facturas]);

  const cuentasComun = useMemo(() => cuentasDePago(puc, comun.medio), [puc, comun.medio]);

  const aplicarATodas = () => {
    setFilas((prev) => {
      const next = { ...prev };
      for (const f of facturas) {
        const actual = next[f.id];
        next[f.id] = {
          fecha: comun.fecha,
          medio: comun.medio,
          cuenta: comun.cuenta,
          cuentaNombre: comun.cuentaNombre,
          cheque: comun.cheque,
          observaciones: comun.observaciones,
          valor: comun.completo ? f.saldo : (actual?.valor ?? f.saldo),
        };
      }
      return next;
    });
  };

  const totalAPagar = roundCOP(facturas.reduce((s, f) => s + roundCOP(filas[f.id]?.valor ?? 0), 0));
  const listo = facturas.length > 0 && facturas.every((f) => !!filas[f.id]?.cuenta && roundCOP(filas[f.id]!.valor) > 0);

  async function confirmar() {
    if (procesando || !listo) return;
    setProcesando(true);
    setAvance({ hechas: 0, total: facturas.length });
    const out: ResultadoPago[] = [];
    try {
      // Cada factura genera su propio recibo; un error no detiene las demás.
      for (const f of facturas) {
        try {
          out.push(await generarRecibo({ invoiceId: f.id, etiqueta: f.etiqueta, config: filas[f.id]! }));
        } catch (err) {
          out.push({ id: f.id, etiqueta: f.etiqueta, ok: false, message: err instanceof Error ? err.message : "Error inesperado." });
        } finally {
          setAvance((p) => (p ? { ...p, hechas: p.hechas + 1 } : p));
        }
      }
    } finally {
      setProcesando(false);
      setAvance(null);
      onDone(out);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !procesando && onOpenChange(o)}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {facturas.length === 1 ? `Recibo de pago · ${facturas[0]?.etiqueta}` : `Configurar pago masivo · ${facturas.length} facturas`}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          El recibo de pago no modifica la causación. Registra el débito a la cuenta por pagar y el crédito a la cuenta de caja o banco elegida.
        </p>

        <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 md:grid-cols-5">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Fecha de pago</span>
            <Input type="date" value={comun.fecha} onChange={(e) => setComun((c) => ({ ...c, fecha: e.target.value }))} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Medio de pago</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={comun.medio}
              onChange={(e) => setComun((c) => ({ ...c, medio: e.target.value as MedioPago, cuenta: "", cuentaNombre: null }))}
            >
              {MEDIOS.map((m) => (
                <option key={m} value={m}>{MEDIO_LABEL[m]}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs md:col-span-2">
            <span className="text-muted-foreground">
              {comun.medio === "caja" ? "Cuenta de caja" : comun.medio === "otro" ? "Cuenta contable" : "Cuenta bancaria"}
            </span>
            <AccountCombobox
              accounts={cuentasComun}
              value={comun.cuenta}
              onChange={(code, name) => setComun((c) => ({ ...c, cuenta: code, cuentaNombre: name }))}
            />
          </label>
          {comun.medio === "cheque" ? (
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">N° de cheque</span>
              <Input value={comun.cheque} onChange={(e) => setComun((c) => ({ ...c, cheque: e.target.value }))} />
            </label>
          ) : (
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Observaciones</span>
              <Input value={comun.observaciones} onChange={(e) => setComun((c) => ({ ...c, observaciones: e.target.value }))} />
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3 md:col-span-5">
            <label className="flex items-center gap-1.5 text-xs">
              <input type="radio" checked={comun.completo} onChange={() => setComun((c) => ({ ...c, completo: true }))} />
              Pagar saldo completo de cada factura
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="radio" checked={!comun.completo} onChange={() => setComun((c) => ({ ...c, completo: false }))} />
              Pago parcial (valor editable por factura)
            </label>
            <Button size="sm" variant="secondary" onClick={aplicarATodas} disabled={procesando}>
              Aplicar a todas
            </Button>
          </div>
        </div>

        <div className="max-h-80 overflow-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/40 text-left text-[11px] uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Factura</th>
                <th className="px-3 py-2 font-medium">Proveedor</th>
                <th className="px-3 py-2 text-right font-medium">Saldo</th>
                <th className="px-3 py-2 font-medium">Medio</th>
                <th className="px-3 py-2 font-medium">Cuenta</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {facturas.map((f) => {
                const cfg = filas[f.id];
                const cuentas = cuentasDePago(puc, cfg?.medio ?? "banco");
                return (
                  <tr key={f.id}>
                    <td className="px-3 py-2 font-mono text-xs">{f.etiqueta}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-xs" title={f.proveedor}>{f.proveedor}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{cop(f.saldo)}</td>
                    <td className="px-3 py-2">
                      <select
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                        value={cfg?.medio ?? "banco"}
                        onChange={(e) =>
                          setFilas((p) => ({ ...p, [f.id]: { ...p[f.id]!, medio: e.target.value as MedioPago, cuenta: "", cuentaNombre: null } }))
                        }
                      >
                        {MEDIOS.map((m) => (
                          <option key={m} value={m}>{MEDIO_LABEL[m]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="min-w-[220px] px-3 py-2">
                      <AccountCombobox
                        accounts={cuentas}
                        value={cfg?.cuenta ?? ""}
                        onChange={(code, name) => setFilas((p) => ({ ...p, [f.id]: { ...p[f.id]!, cuenta: code, cuentaNombre: name } }))}
                      />
                      {cfg?.medio === "cheque" && (
                        <Input
                          className="mt-1 h-8 text-xs"
                          placeholder="N° de cheque"
                          value={cfg.cheque ?? ""}
                          onChange={(e) => setFilas((p) => ({ ...p, [f.id]: { ...p[f.id]!, cheque: e.target.value } }))}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        className="h-8 w-32 text-right text-xs"
                        type="number"
                        min={0}
                        max={f.saldo}
                        step="0.01"
                        value={cfg?.valor ?? 0}
                        onChange={(e) =>
                          setFilas((p) => ({ ...p, [f.id]: { ...p[f.id]!, valor: Math.min(f.saldo, Number(e.target.value || 0)) } }))
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            Total a pagar: <span className="font-mono font-semibold tabular-nums">{cop(totalAPagar)}</span>
            {avance && <span className="ml-2 text-xs text-muted-foreground">{avance.hechas} de {avance.total}</span>}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={procesando}>Cancelar</Button>
            <Button onClick={() => void confirmar()} disabled={!listo || procesando}>
              {procesando ? <Loader2 className="size-4 animate-spin" /> : null} Confirmar pagos
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
