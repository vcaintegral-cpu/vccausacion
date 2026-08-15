// Sección RETENCIONES: tres retenciones independientes en la misma factura.
// Retefuente, ReteIVA y ReteICA se activan por separado y nunca se sobrescriben.
import { AccountCombobox } from "@/components/account-combobox";
import { Input } from "@/components/ui/input";
import { cop } from "@/lib/format";
import { roundCOP } from "@/lib/money";
import type { PucAccount } from "@/lib/puc-hierarchy";
import {
  RETENCION_KINDS,
  RET_LABEL,
  RET_SHORT,
  aplicarImpuesto,
  baseDeKind,
  totalRetenciones,
  valorDeBloque,
  type RetBlocks,
  type RetencionKind,
  type TaxLike,
} from "@/lib/retenciones-multi";

const CONCEPT_LABEL: Partial<Record<RetencionKind, string>> = {
  retefuente: "Concepto / tipo de retención",
  reteica: "Municipio / concepto",
};

export function RetencionesPanel({
  blocks,
  taxes,
  accounts,
  baseGravable,
  ivaTotal,
  onChange,
  errors = [],
}: {
  blocks: RetBlocks;
  taxes: TaxLike[];
  accounts: PucAccount[];
  baseGravable: number;
  ivaTotal: number;
  onChange: (next: RetBlocks) => void;
  errors?: string[];
}) {
  const set = (kind: RetencionKind, patch: Partial<RetBlocks[RetencionKind]>) =>
    onChange({ ...blocks, [kind]: { ...blocks[kind], ...patch } });

  const toggle = (kind: RetencionKind, apply: boolean) => {
    const b = blocks[kind];
    const base = b.base > 0 ? b.base : baseDeKind(kind, baseGravable, ivaTotal);
    // Activar una retención NUNCA borra las otras: solo cambia su propio bloque.
    onChange({ ...blocks, [kind]: { ...b, apply, base } });
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold">Retenciones</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Una factura puede tener Retefuente, ReteIVA y ReteICA al mismo tiempo. Cada una es independiente y
        conserva su propia base, tarifa, valor y cuenta contable.
      </p>

      <div className="mt-4 space-y-4">
        {RETENCION_KINDS.map((kind) => {
          const b = blocks[kind];
          const opciones = taxes.filter((t) => String(t.kind) === kind && t.active !== false);
          return (
            <div key={kind} className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={b.apply}
                  onChange={(e) => toggle(kind, e.target.checked)}
                />
                {RET_LABEL[kind]}
                {b.apply && (
                  <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                    {cop(roundCOP(b.amount))}
                  </span>
                )}
              </label>

              {b.apply && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <span className="text-xs text-muted-foreground">Impuesto configurado</span>
                    <select
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                      value={b.taxId}
                      onChange={(e) => {
                        const tx = opciones.find((t) => String(t.id) === e.target.value) ?? null;
                        onChange({ ...blocks, [kind]: aplicarImpuesto(b, tx, accounts) });
                      }}
                    >
                      <option value="">Sin impuesto seleccionado</option>
                      {opciones.map((t) => (
                        <option key={String(t.id)} value={String(t.id)}>
                          {t.name} {Number(t.rate)}%
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Base</span>
                    <Input
                      className="mt-1"
                      type="number"
                      value={b.base}
                      onChange={(e) => {
                        const base = Number(e.target.value);
                        set(kind, { base, amount: valorDeBloque({ ...b, base }) });
                      }}
                    />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Porcentaje (%)</span>
                    <Input
                      className="mt-1"
                      type="number"
                      value={b.rate}
                      onChange={(e) => {
                        const rate = Number(e.target.value);
                        set(kind, { rate, amount: valorDeBloque({ ...b, rate }) });
                      }}
                    />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Valor</span>
                    <Input
                      className="mt-1"
                      type="number"
                      value={b.amount}
                      onChange={(e) => set(kind, { amount: Number(e.target.value) })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-xs text-muted-foreground">Cuenta contable</span>
                    <div className="mt-1">
                      <AccountCombobox
                        accounts={accounts}
                        value={b.account_code}
                        onChange={(code, name) => set(kind, { account_code: code, account_name: name })}
                      />
                    </div>
                  </div>
                  {CONCEPT_LABEL[kind] && (
                    <div className="sm:col-span-2">
                      <span className="text-xs text-muted-foreground">{CONCEPT_LABEL[kind]}</span>
                      <Input
                        className="mt-1"
                        value={b.concept}
                        onChange={(e) => set(kind, { concept: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <dl className="mt-4 space-y-1 border-t border-border pt-3 text-sm">
        {RETENCION_KINDS.map((kind) => (
          <div key={kind} className="flex justify-between">
            <dt className="text-muted-foreground">{RET_SHORT[kind]}</dt>
            <dd className="font-mono tabular-nums">
              {blocks[kind].apply ? cop(roundCOP(blocks[kind].amount)) : "—"}
            </dd>
          </div>
        ))}
        <div className="flex justify-between border-t border-border pt-1 font-medium">
          <dt>Total retenciones</dt>
          <dd className="font-mono tabular-nums">{cop(totalRetenciones(blocks))}</dd>
        </div>
      </dl>

      {errors.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
