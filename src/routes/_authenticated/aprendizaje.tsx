import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Brain, Pencil, Plus, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { fecha } from "@/lib/format";
import { ITEM_TYPES, type LearningRule } from "@/lib/learning";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/aprendizaje")({
  head: () => ({
    meta: [
      { title: "Aprendizaje contable de la IA" },
      { name: "description", content: "Administra las reglas que la IA aprendió para sugerir cuentas contables por proveedor y concepto." },
      { property: "og:title", content: "Aprendizaje contable" },
      { property: "og:description", content: "Ver, editar, desactivar y crear reglas de causación aprendidas por empresa." },
    ],
  }),
  component: Aprendizaje,
});

type Draft = {
  id?: string;
  provider_nit: string;
  provider_name: string;
  concept: string;
  account_code: string;
  account_name: string;
  cost_center: string;
  iva: number;
  retentions: string;
  item_type: string;
  active: boolean;
};

const emptyDraft = (): Draft => ({
  provider_nit: "", provider_name: "", concept: "", account_code: "", account_name: "",
  cost_center: "", iva: 0, retentions: "", item_type: "gasto", active: true,
});

function Aprendizaje() {
  const companyId = useActiveCompany();
  const qc = useQueryClient();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const empresa = (companies ?? []).find((c) => c.id === companyId)?.name ?? "—";
  const autoLearning = (companies ?? []).find((c) => c.id === companyId)?.auto_learning ?? true;

  const { data: rules } = useQuery({
    queryKey: ["learning_rules", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("learning_rules").select("*").eq("company_id", companyId!).order("created_at", { ascending: false });
      if (error) throw error;
      return data as LearningRule[];
    },
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
      `${r.provider_nit ?? ""} ${r.provider_name ?? ""} ${r.concept ?? ""} ${r.account_code} ${r.account_name ?? ""}`
        .toLowerCase()
        .includes(term),
    );
  }, [rules, q]);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["learning_rules", companyId] });
  }

  async function guardar() {
    if (!companyId || !draft) return;
    if (!draft.account_code.trim()) { toast.error("Indica la cuenta contable."); return; }
    setSaving(true);
    const payload = {
      company_id: companyId,
      provider_nit: draft.provider_nit || null,
      provider_name: draft.provider_name || null,
      concept: draft.concept || null,
      account_code: draft.account_code.trim(),
      account_name: draft.account_name || accounts?.find((a) => a.code === draft.account_code)?.name || null,
      cost_center: draft.cost_center || null,
      iva: Number(draft.iva || 0),
      retentions: draft.retentions || null,
      item_type: draft.item_type,
      active: draft.active,
    };
    const { error } = draft.id
      ? await supabase.from("learning_rules").update(payload).eq("id", draft.id)
      : await supabase.from("learning_rules").insert(payload);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(draft.id ? "Regla actualizada." : "Regla creada.");
    setDraft(null);
    await refresh();
  }

  async function toggle(r: LearningRule) {
    const { error } = await supabase.from("learning_rules").update({ active: !r.active }).eq("id", r.id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  async function eliminar(r: LearningRule) {
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
            {rows.length} regla(s) de {empresa}. La IA consulta primero estas reglas antes de sugerir una cuenta.
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
          <p className="text-xs text-muted-foreground">Cuando está activo, la app pregunta si desea recordar la cuenta al cambiarla.</p>
        </div>
      </div>

      <Input
        placeholder="Buscar por proveedor, concepto o cuenta contable"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-lg"
      />

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Empresa</th>
              <th className="px-4 py-2 font-medium">Proveedor</th>
              <th className="px-4 py-2 font-medium">Concepto</th>
              <th className="px-4 py-2 font-medium">Cuenta</th>
              <th className="px-4 py-2 font-medium">C. costo</th>
              <th className="px-4 py-2 text-right font-medium">IVA %</th>
              <th className="px-4 py-2 font-medium">Retenciones</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Creada</th>
              <th className="px-4 py-2 text-right font-medium">Usos</th>
              <th className="px-4 py-2 font-medium">Activa</th>
              <th className="px-4 py-2 text-right font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="px-4 py-2 text-muted-foreground">{empresa}</td>
                <td className="px-4 py-2">{r.provider_name ?? r.provider_nit ?? "Cualquiera"}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.concept ?? "—"}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {r.account_code}
                  {r.account_name ? <span className="ml-1 font-sans text-muted-foreground">· {r.account_name}</span> : null}
                </td>
                <td className="px-4 py-2">{r.cost_center ?? "—"}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{Number(r.iva ?? 0)}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.retentions ?? "—"}</td>
                <td className="px-4 py-2 capitalize">{r.item_type}</td>
                <td className="px-4 py-2 text-muted-foreground">{fecha(r.created_at.slice(0, 10))}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{r.times_used}</td>
                <td className="px-4 py-2">
                  <Switch checked={r.active} onCheckedChange={() => toggle(r)} />
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Editar"
                    onClick={() =>
                      setDraft({
                        id: r.id,
                        provider_nit: r.provider_nit ?? "",
                        provider_name: r.provider_name ?? "",
                        concept: r.concept ?? "",
                        account_code: r.account_code,
                        account_name: r.account_name ?? "",
                        cost_center: r.cost_center ?? "",
                        iva: Number(r.iva ?? 0),
                        retentions: r.retentions ?? "",
                        item_type: r.item_type,
                        active: r.active,
                      })
                    }
                  >
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
                <td colSpan={12} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Aún no hay reglas aprendidas para esta empresa.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-xl">
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
              <Campo label="Cuenta contable" full>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.account_code}
                  onChange={(e) => {
                    const acc = (accounts ?? []).find((a) => a.code === e.target.value);
                    setDraft({ ...draft, account_code: e.target.value, account_name: acc?.name ?? "" });
                  }}
                >
                  <option value="">Seleccionar…</option>
                  {(accounts ?? []).map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="Centro de costo">
                <Input value={draft.cost_center} onChange={(e) => setDraft({ ...draft, cost_center: e.target.value })} />
              </Campo>
              <Campo label="IVA %">
                <Input type="number" value={draft.iva} onChange={(e) => setDraft({ ...draft, iva: Number(e.target.value) })} />
              </Campo>
              <Campo label="Retenciones">
                <Input value={draft.retentions} onChange={(e) => setDraft({ ...draft, retentions: e.target.value })} />
              </Campo>
              <Campo label="Tipo de ítem">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm capitalize"
                  value={draft.item_type}
                  onChange={(e) => setDraft({ ...draft, item_type: e.target.value })}
                >
                  {ITEM_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Campo>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
                <Label className="text-sm">Regla activa</Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancelar
            </Button>
            <Button onClick={guardar} disabled={saving}>
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
