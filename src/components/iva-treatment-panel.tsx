// Panel de trazabilidad y corrección del tratamiento contable del IVA de UNA factura.
import { AccountCombobox } from "@/components/account-combobox";
import { cop } from "@/lib/format";
import { IVA_TREATMENT_LABEL, type IvaTreatment, type IvaTreatmentDecision } from "@/lib/iva-treatment";
import type { PucAccount } from "@/lib/puc-hierarchy";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const ORIGEN: Record<IvaTreatmentDecision["origin"], string> = {
  CORRECCION: "Corrección aprobada",
  HISTORIAL: "Histórico",
  CONFIGURACION: "Configuración de la empresa",
  SIN_EVIDENCIA: "Sin evidencia",
};

export function IvaTreatmentPanel({
  decision,
  ivaTotal,
  accounts,
  overridden,
  onChange,
  onReset,
}: {
  decision: IvaTreatmentDecision | null;
  ivaTotal: number;
  accounts: PucAccount[];
  overridden: boolean;
  onChange: (value: { treatment: IvaTreatment; account: string }) => void;
  onReset: () => void;
}) {
  if (!decision || ivaTotal <= 0) return null;
  const cuenta = decision.account;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3 text-sm font-semibold">Tratamiento contable del IVA</div>
      <div className="space-y-3 px-5 py-4 text-sm">
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">IVA de la factura</dt>
            <dd className="font-mono tabular-nums">{cop(ivaTotal)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Tratamiento</dt>
            <dd>{IVA_TREATMENT_LABEL[decision.treatment]}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Origen</dt>
            <dd>{ORIGEN[decision.origin]}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Confianza</dt>
            <dd>{Math.round(decision.confidence * 100)}%</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">{decision.reason}</p>
        {decision.warning && <p className="text-xs text-destructive">{decision.warning}</p>}

        <div className="grid gap-3 sm:grid-cols-[220px_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label className="text-xs">Tratamiento del IVA</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={decision.treatment}
              onChange={(e) => onChange({ treatment: e.target.value as IvaTreatment, account: cuenta })}
            >
              <option value="descontable">IVA descontable</option>
              <option value="gasto">IVA mayor valor del gasto</option>
              <option value="costo">IVA mayor valor del costo</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Cuenta de IVA</Label>
            <AccountCombobox
              accounts={accounts}
              value={cuenta || null}
              onChange={(code) => onChange({ treatment: decision.treatment, account: code })}
              placeholder={decision.treatment === "descontable" ? "Cuenta del impuesto seleccionado" : "Elija la cuenta de IVA"}
            />
          </div>
          {overridden && (
            <Button variant="outline" size="sm" onClick={onReset}>
              Usar la recomendación
            </Button>
          )}
        </div>
        {decision.treatment !== "descontable" && (
          <p className="text-xs text-muted-foreground">
            El IVA se contabiliza en una línea independiente por el valor total ({cop(ivaTotal)}); nunca se suma a la
            cuenta de gasto o costo.
          </p>
        )}
      </div>
    </div>
  );
}
