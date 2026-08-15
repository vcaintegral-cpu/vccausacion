import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Brain, Eye, Pencil, Plus, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { fecha } from "@/lib/format";
import { ITEM_TYPES } from "@/lib/learning";
import {
  CONFIANZA_LABEL,
  confianzaRegla,
  fetchCompanyRules,
  fetchRuleChanges,
  type RuleShape,
} from "@/lib/learning-rules";
import { IVA_TREATMENT_LABEL } from "@/lib/iva-treatment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/aprendizaje")({
  head: () => ({
    meta: [
      { title: "Aprendizaje contable de la IA" },
      { name: "description", content: "Administra las reglas contables completas que la IA aprendió por proveedor, concepto, impuestos y retenciones." },
      { property: "og:title", content: "Aprendizaje contable" },
      { property: "og:description", content: "Reglas de causación con cuenta, centro de costo, IVA, retenciones, CxP y forma de pago por empresa." },
    ],
  }),
  component: Aprendizaje,
});

type Draft = {
  id?: string;
  provider_nit: string;
  provider_name: string;
  concept: string;
  item_type: string;
  account_code: string;
  account_name: string;
  cost_center: string;
  iva_aplica: boolean;
  iva_rate: number;
  iva_treatment: string;
  iva_account: string;
  retefuente_aplica: boolean;
  retefuente_rate: number;
  retefuente_account: string;
  reteiva_aplica: boolean;
  reteiva_rate: number;
  reteiva_account: string;
  reteica_aplica: boolean;
  reteica_rate: number;
  reteica_account: string;
  otras_aplica: boolean;
  otras_rate: number;
  otras_account: string;
  payable_account: string;
  payment_form: string;
  active: boolean;
};

const emptyDraft = (): Draft => ({
  provider_nit: "", provider_name: "", concept: "", item_type: "gasto",
  account_code: "", account_name: "", cost_center: "",
  iva_aplica: false, iva_rate: 0, iva_treatment: "descontable", iva_account: "",
  retefuente_aplica: false, retefuente_rate: 0, retefuente_account: "",
  reteiva_aplica: false, reteiva_rate: 0, reteiva_account: "",
  reteica_aplica: false, reteica_rate: 0, reteica_account: "",
  otras_aplica: false, otras_rate: 0, otras_account: "",
  payable_account: "", payment_form: "", active: true,
});

const draftFromRule = (r: RuleShape): Draft => ({
  id: r.id,
  provider_nit: r.provider_nit ?? "",
  provider_name: r.provider_name ?? "",
  concept: r.concept ?? "",
  item_type: r.item_type,
  account_code: r.account_code,
  account_name: r.account_name ?? "",
  cost_center: r.cost_center ?? "",
  iva_aplica: !!r.iva_aplica,
  iva_rate: Number(r.iva_rate ?? r.iva ?? 0),
  iva_treatment: r.iva_treatment ?? "descontable",
  iva_account: r.iva_account ?? "",
  retefuente_aplica: !!r.retefuente_aplica,
  retefuente_rate: Number(r.retefuente_rate ?? 0),
  retefuente_account: r.retefuente_account ?? "",
  reteiva_aplica: !!r.reteiva_aplica,
  reteiva_rate: Number(r.reteiva_rate ?? 0),
  reteiva_account: r.reteiva_account ?? "",
  reteica_aplica: !!r.reteica_aplica,
  reteica_rate: Number(r.reteica_rate ?? 0),
  reteica_account: r.reteica_account ?? "",
  otras_aplica: !!r.otras_aplica,
  otras_rate: Number(r.otras_rate ?? 0),
  otras_account: r.otras_account ?? "",
  payable_account: r.payable_account ?? "",
  payment_form: r.payment_form ?? "",
  active: r.active,
});

function Aprendizaje() {
  const companyId = useActiveCompany();
  const qc = useQueryClient();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [detalle, setDetalle] = useState<RuleShape | null>(null);
  const [saving, setSaving] = useState(false);

  const empresa = (companies ?? []).find((c) => c.id === companyId)?.name ?? "—";
  const autoLearning = (companies ?? []).find((c) => c.id === companyId)?.auto_learning ?? true;

  const { data: rules } = useQuery({
    queryKey: ["learning_rules", companyId],
    enabled: !!companyId,
    queryFn: () => fetchCompanyRules(companyId!),
  });

  const { data: cambios } = useQuery({
    queryKey: ["learning_rule_changes", detalle?.id],
    enabled: !!detalle?.id,
    queryFn: () => fetchRuleChanges(detalle!.id),
  });

  const { data: accounts } = useQuery({
    queryKey: ["puc", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data } = await supabase.from("puc_accounts").select("code, name").eq("company_id", companyId!).order("code");
      return data ?? [];
    },
  });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return rules ?? [];
    return (rules ?? []).filter((r) =>
      `${r.provider_nit ?? ""} ${r.provider_name ?? ""} ${r.concept ?? ""} ${r.account_code} ${r.account_name ?? ""} ${r.iva_account ?? ""} ${r.retefuente_account ?? ""} ${r.reteiva_account ?? ""} ${r.reteica_account ?? ""} ${r.payable_account ?? ""}`
        .toLowerCase()
        .includes(term),
    );
  }, [rules, q]);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["learning_rules", companyId] });
  }

  async function guardar() {
    if (!companyId || !draft) return;
    if (!draft.account_code.trim()) { toast.error("Indica la cuenta contable de gasto o costo."); return; }
    setSaving(true);
    const payload = {
      company_id: companyId,
      provider_nit: draft.provider_nit || null,
      provider_name: draft.provider_name || null,
      concept: draft.concept || null,
      item_type: draft.item_type,
      account_code: draft.account_code.trim(),
      account_name: draft.account_name || accounts?.find((a) => a.code === draft.account_code)?.name || null,
      cost_center: draft.cost_center || null,
      iva: Number(draft.iva_rate || 0),
      iva_aplica: draft.iva_aplica,
      iva_rate: Number(draft.iva_rate || 0),
      iva_treatment: draft.iva_treatment || null,
      iva_account: draft.iva_account || null,
      retefuente_aplica: draft.retefuente_aplica,
      retefuente_rate: Number(draft.retefuente_rate || 0),
      retefuente_account: draft.retefuente_account || null,
      reteiva_aplica: draft.reteiva_aplica,
      reteiva_rate: Number(draft.reteiva_rate || 0),
      reteiva_account: draft.reteiva_account || null,
      reteica_aplica: draft.reteica_aplica,
      reteica_rate: Number(draft.reteica_rate || 0),
      reteica_account: draft.reteica_account || null,
      otras_aplica: draft.otras_aplica,
      otras_rate: Number(draft.otras_rate || 0),
      otras_account: draft.otras_account || null,
      payable_account: draft.payable_account || null,
      payment_form: draft.payment_form || null,
      active: draft.active,
    };
    const { error } = draft.id
      ? await supabase.from("learning_rules").update(payload as never).eq("id", draft.id)
      : await supabase.from("learning_rules").insert(payload as never);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(draft.id ? "Regla actualizada." : "Regla creada.");
    setDraft(null);
    await refresh();
  }

  async function toggle(r: RuleShape) {
    const { error } = await supabase.from("learning_rules").update({ active: !r.active }).eq("id", r.id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  async function eliminar(r: RuleShape) {
    const { error } = await supabase.from("learning_rules").delete().eq("id", r.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Regla eliminada.");
    await refresh();
  }

  if (!loadingCompanies && (companies ?? []).length === 0) return <EmptyCompany />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Brain className="size-5" /> Aprendizaje contable
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} regla(s) de {empresa}. La IA consulta primero estas reglas —con toda su estructura contable— antes de sugerir una causación.
          </p>
        </div>
        <Button onClick={() => setDraft(emptyDraft())}>
          <Plus className="size-4" /> Nueva regla
        </Button>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
        <Switch
          checked={autoLearning}
          onCheckedChange={async (v) => {
            if (!companyId) return;
            const { error } = await supabase.from("companies").update({ auto_learning: v }).eq("id", companyId);
            if (error) { toast.error(error.message); return; }
            await qc.invalidateQueries({ queryKey: ["companies"] });
          }}
        />
        <div>
          <p className="text-sm font-medium">Aprendizaje automático</p>
          <p className="text-xs text-muted-foreground">
            Cuando está activo, cada causación aprobada guarda o actualiza la regla del proveedor sin preguntar.
          </p>
        </div>
      </div>

      <Input
        placeholder="Buscar por proveedor, concepto o cualquier cuenta contable"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-lg"
      />

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[2200px] text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Proveedor</th>
              <th className="px-4 py-2 font-medium">NIT</th>
              <th className="px-4 py-2 font-medium">Concepto</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Cuenta gasto/costo</th>
              <th className="px-4 py-2 font-medium">C. costo</th>
              <th className="px-4 py-2 font-medium">IVA</th>
              <th className="px-4 py-2 font-medium">Cuenta IVA</th>
              <th className="px-4 py-2 font-medium">Retefuente</th>
              <th className="px-4 py-2 font-medium">ReteIVA</th>
              <th className="px-4 py-2 font-medium">ReteICA</th>
              <th className="px-4 py-2 font-medium">Otras ret.</th>
              <th className="px-4 py-2 font-medium">CxP</th>
              <th className="px-4 py-2 font-medium">Forma de pago</th>
              <th className="px-4 py-2 text-right font-medium">Usos</th>
              <th className="px-4 py-2 font-medium">Confianza</th>
              <th className="px-4 py-2 font-medium">Actualizada</th>
              <th className="px-4 py-2 font-medium">Activa</th>
              <th className="px-4 py-2 text-right font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="px-4 py-2">{r.provider_name ?? "Cualquiera"}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{r.provider_nit ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.concept ?? "—"}</td>
                <td className="px-4 py-2 capitalize">{r.item_type}</td>
                <td className="px-4 py-2"><Cuenta code={r.account_code} name={r.account_name} /></td>
                <td className="px-4 py-2">{r.cost_center ?? "—"}</td>
                <td className="px-4 py-2 text-xs">
                  {r.iva_aplica
                    ? `${Number(r.iva_rate ?? r.iva ?? 0)}% · ${IVA_TREATMENT_LABEL[(r.iva_treatment ?? "descontable") as keyof typeof IVA_TREATMENT_LABEL] ?? r.iva_treatment}`
                    : "No aplica"}
                </td>
                <td className="px-4 py-2"><Cuenta code={r.iva_account} /></td>
                <td className="px-4 py-2"><Ret aplica={r.retefuente_aplica} rate={r.retefuente_rate} code={r.retefuente_account} /></td>
                <td className="px-4 py-2"><Ret aplica={r.reteiva_aplica} rate={r.reteiva_rate} code={r.reteiva_account} /></td>
                <td className="px-4 py-2"><Ret aplica={r.reteica_aplica} rate={r.reteica_rate} code={r.reteica_account} /></td>
                <td className="px-4 py-2"><Ret aplica={r.otras_aplica} rate={r.otras_rate} code={r.otras_account} /></td>
                <td className="px-4 py-2"><Cuenta code={r.payable_account} /></td>
                <td className="px-4 py-2">{r.payment_form ?? "—"}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{r.times_used}</td>
                <td className="px-4 py-2"><Confianza uses={r.times_used} /></td>
                <td className="px-4 py-2 text-muted-foreground">{fecha((r.updated_at ?? r.created_at ?? "").slice(0, 10))}</td>
                <td className="px-4 py-2"><Switch checked={r.active} onCheckedChange={() => toggle(r)} /></td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <Button variant="ghost" size="icon" title="Ver detalle" onClick={() => setDetalle(r)}>
                    <Eye className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title="Editar" onClick={() => setDraft(draftFromRule(r))}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title="Eliminar" onClick={() => eliminar(r)}>
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={19} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Aún no hay reglas aprendidas para esta empresa.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!detalle} onOpenChange={(o) => !o && setDetalle(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalle de la regla</DialogTitle>
          </DialogHeader>
          {detalle && (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Dato k="Proveedor" v={`${detalle.provider_name ?? "Cualquiera"}${detalle.provider_nit ? ` · ${detalle.provider_nit}` : ""}`} />
                <Dato k="Concepto" v={detalle.concept ?? "—"} />
                <Dato k="Tipo de ítem" v={detalle.item_type} />
                <Dato k="Cuenta gasto/costo" v={`${detalle.account_code}${detalle.account_name ? ` · ${detalle.account_name}` : ""}`} />
                <Dato k="Centro de costo" v={detalle.cost_center ?? "—"} />
                <Dato k="IVA" v={detalle.iva_aplica ? `${Number(detalle.iva_rate ?? detalle.iva ?? 0)}% · ${detalle.iva_treatment ?? "descontable"} · ${detalle.iva_account ?? "cuenta del módulo de impuestos"}` : "No aplica"} />
                <Dato k="Retefuente" v={detalle.retefuente_aplica ? `${Number(detalle.retefuente_rate ?? 0)}% · ${detalle.retefuente_account ?? "sin cuenta"}` : "No aplica"} />
                <Dato k="ReteIVA" v={detalle.reteiva_aplica ? `${Number(detalle.reteiva_rate ?? 0)}% · ${detalle.reteiva_account ?? "sin cuenta"}` : "No aplica"} />
                <Dato k="ReteICA" v={detalle.reteica_aplica ? `${Number(detalle.reteica_rate ?? 0)}% · ${detalle.reteica_account ?? "sin cuenta"}` : "No aplica"} />
                <Dato k="Otras retenciones" v={detalle.otras_aplica ? `${Number(detalle.otras_rate ?? 0)}% · ${detalle.otras_account ?? "sin cuenta"}` : "No aplica"} />
                <Dato k="Cuenta por pagar" v={detalle.payable_account ?? "—"} />
                <Dato k="Forma de pago" v={detalle.payment_form ?? "—"} />
                <Dato k="Veces usada" v={String(detalle.times_used)} />
                <Dato k="Confianza" v={CONFIANZA_LABEL[confianzaRegla(detalle.times_used)]} />
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Historial de cambios</p>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full min-w-[600px] text-xs">
                    <thead className="bg-muted/40 text-left uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Fecha</th>
                        <th className="px-3 py-2 font-medium">Campo</th>
                        <th className="px-3 py-2 font-medium">Valor anterior</th>
                        <th className="px-3 py-2 font-medium">Valor nuevo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(cambios ?? []).map((c) => (
                        <tr key={c.id}>
                          <td className="px-3 py-1.5 text-muted-foreground">{fecha(c.created_at.slice(0, 10))}</td>
                          <td className="px-3 py-1.5">{c.field_label ?? c.field}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{c.old_value ?? "—"}</td>
                          <td className="px-3 py-1.5 font-medium">{c.new_value ?? "—"}</td>
                        </tr>
                      ))}
                      {(cambios ?? []).length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                            Esta regla no ha tenido cambios registrados.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Editar regla" : "Nueva regla de aprendizaje"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Campo label="NIT proveedor">
                <Input value={draft.provider_nit} onChange={(e) => setDraft({ ...draft, provider_nit: e.target.value })} />
              </Campo>
              <Campo label="Proveedor">
                <Input value={draft.provider_name} onChange={(e) => setDraft({ ...draft, provider_name: e.target.value })} />
              </Campo>
              <Campo label="Concepto" full>
                <Input value={draft.concept} onChange={(e) => setDraft({ ...draft, concept: e.target.value })} />
              </Campo>
              <Campo label="Cuenta de gasto o costo" full>
                <SelectCuenta
                  accounts={accounts ?? []}
                  value={draft.account_code}
                  onChange={(code, name) => setDraft({ ...draft, account_code: code, account_name: name })}
                />
              </Campo>
              <Campo label="Tipo de ítem">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm capitalize"
                  value={draft.item_type}
                  onChange={(e) => setDraft({ ...draft, item_type: e.target.value })}
                >
                  {ITEM_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
                </select>
              </Campo>
              <Campo label="Centro de costo">
                <Input value={draft.cost_center} onChange={(e) => setDraft({ ...draft, cost_center: e.target.value })} />
              </Campo>

              <Bloque
                label="IVA"
                aplica={draft.iva_aplica}
                onAplica={(v) => setDraft({ ...draft, iva_aplica: v })}
                rate={draft.iva_rate}
                onRate={(v) => setDraft({ ...draft, iva_rate: v })}
                account={draft.iva_account}
                onAccount={(v) => setDraft({ ...draft, iva_account: v })}
                accounts={accounts ?? []}
                extra={
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={draft.iva_treatment}
                    onChange={(e) => setDraft({ ...draft, iva_treatment: e.target.value })}
                  >
                    {Object.entries(IVA_TREATMENT_LABEL).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
                  </select>
                }
              />
              <Bloque label="Retefuente" aplica={draft.retefuente_aplica} onAplica={(v) => setDraft({ ...draft, retefuente_aplica: v })}
                rate={draft.retefuente_rate} onRate={(v) => setDraft({ ...draft, retefuente_rate: v })}
                account={draft.retefuente_account} onAccount={(v) => setDraft({ ...draft, retefuente_account: v })} accounts={accounts ?? []} />
              <Bloque label="ReteIVA" aplica={draft.reteiva_aplica} onAplica={(v) => setDraft({ ...draft, reteiva_aplica: v })}
                rate={draft.reteiva_rate} onRate={(v) => setDraft({ ...draft, reteiva_rate: v })}
                account={draft.reteiva_account} onAccount={(v) => setDraft({ ...draft, reteiva_account: v })} accounts={accounts ?? []} />
              <Bloque label="ReteICA" aplica={draft.reteica_aplica} onAplica={(v) => setDraft({ ...draft, reteica_aplica: v })}
                rate={draft.reteica_rate} onRate={(v) => setDraft({ ...draft, reteica_rate: v })}
                account={draft.reteica_account} onAccount={(v) => setDraft({ ...draft, reteica_account: v })} accounts={accounts ?? []} />
              <Bloque label="Otras retenciones" aplica={draft.otras_aplica} onAplica={(v) => setDraft({ ...draft, otras_aplica: v })}
                rate={draft.otras_rate} onRate={(v) => setDraft({ ...draft, otras_rate: v })}
                account={draft.otras_account} onAccount={(v) => setDraft({ ...draft, otras_account: v })} accounts={accounts ?? []} />

              <Campo label="Cuenta por pagar" full>
                <SelectCuenta accounts={accounts ?? []} value={draft.payable_account} onChange={(code) => setDraft({ ...draft, payable_account: code })} />
              </Campo>
              <Campo label="Forma de pago">
                <Input value={draft.payment_form} onChange={(e) => setDraft({ ...draft, payment_form: e.target.value })} />
              </Campo>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
                <Label className="text-sm">Regla activa</Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancelar</Button>
            <Button onClick={guardar} disabled={saving}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Account = { code: string; name: string };

function SelectCuenta({ accounts, value, onChange }: { accounts: Account[]; value: string; onChange: (code: string, name: string) => void }) {
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      onChange={(e) => {
        const acc = accounts.find((a) => a.code === e.target.value);
        onChange(e.target.value, acc?.name ?? "");
      }}
    >
      <option value="">Seleccionar…</option>
      {accounts.map((a) => (<option key={a.code} value={a.code}>{a.code} · {a.name}</option>))}
    </select>
  );
}

function Bloque(props: {
  label: string;
  aplica: boolean;
  onAplica: (v: boolean) => void;
  rate: number;
  onRate: (v: number) => void;
  account: string;
  onAccount: (v: string) => void;
  accounts: Account[];
  extra?: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3 sm:col-span-2">
      <div className="flex items-center gap-2">
        <Switch checked={props.aplica} onCheckedChange={props.onAplica} />
        <Label className="text-sm font-medium">{props.label}</Label>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input type="number" value={props.rate} onChange={(e) => props.onRate(Number(e.target.value))} placeholder="Tarifa %" />
        <div className="sm:col-span-2">
          <SelectCuenta accounts={props.accounts} value={props.account} onChange={(code) => props.onAccount(code)} />
        </div>
        {props.extra ? <div className="sm:col-span-3">{props.extra}</div> : null}
      </div>
    </div>
  );
}

function Cuenta({ code, name }: { code?: string | null; name?: string | null }) {
  if (!code) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-xs">
      {code}
      {name ? <span className="ml-1 font-sans text-muted-foreground">· {name}</span> : null}
    </span>
  );
}

function Ret({ aplica, rate, code }: { aplica: boolean; rate?: number | null; code?: string | null }) {
  if (!aplica) return <span className="text-muted-foreground">No aplica</span>;
  return (
    <span className="text-xs">
      {Number(rate ?? 0)}% <span className="font-mono text-muted-foreground">{code ?? "sin cuenta"}</span>
    </span>
  );
}

function Confianza({ uses }: { uses: number }) {
  const nivel = confianzaRegla(uses);
  const clase =
    nivel === "ALTA" ? "bg-primary/10 text-primary" : nivel === "MEDIA" ? "bg-muted text-foreground" : "bg-muted text-muted-foreground";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${clase}`}>{CONFIANZA_LABEL[nivel]}</span>;
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className="text-sm">{v}</p>
    </div>
  );
}

function Campo({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`space-y-1.5 ${full ? "sm:col-span-2" : ""}`}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
