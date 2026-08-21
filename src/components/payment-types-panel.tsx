import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Search } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { AccountCombobox } from "@/components/account-combobox";
import { type FormaPago } from "@/lib/payment-types";

export function PaymentTypesPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [buscar, setBuscar] = useState("");

  const { data: rows } = useQuery({
    queryKey: ["siigo_payment_types", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("siigo_payment_types")
        .select("*")
        .eq("company_id", companyId)
        .order("method")
        .order("name");
      if (error) throw error;
      return (data ?? []) as FormaPago[];
    },
  });

  const { data: cuentas } = useQuery({
    queryKey: ["puc_accounts", companyId, "payment-types"],
    queryFn: async () => {
      const { data } = await supabase
        .from("puc_accounts")
        .select("code, name")
        .eq("company_id", companyId)
        .order("code");
      return (data ?? []) as { code: string; name: string }[];
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["siigo_payment_types", companyId] });

  async function actualizar(id: string, patch: { active?: boolean; account_code?: string | null; account_name?: string | null }) {
    const { error } = await supabase.from("siigo_payment_types").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }

  const filtradas = (rows ?? []).filter((r) => {
    const q = buscar.trim().toLowerCase();
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      String(r.siigo_id).includes(q) ||
      String(r.type ?? "").toLowerCase().includes(q) ||
      String(r.method).toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Formas de pago sincronizadas desde Siigo. Puedes activar o inactivar las que usa la empresa y asignar la cuenta contable asociada.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={buscar}
            onChange={(e) => setBuscar(e.target.value)}
            placeholder="Buscar forma de pago…"
            className="pl-9"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {filtradas.length} de {(rows ?? []).length} forma(s) de pago
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Forma de pago</th>
              <th className="px-4 py-2 font-medium">Método</th>
              <th className="px-4 py-2 font-medium">Tipo Siigo</th>
              <th className="px-4 py-2 font-medium">Vencimiento</th>
              <th className="px-4 py-2 font-medium">Cuenta contable</th>
              <th className="px-4 py-2 font-medium">Activa</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtradas.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">
                  <div className="font-medium">{r.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">ID Siigo: {r.siigo_id}</div>
                </td>
                <td className="px-4 py-2">
                  <span className={r.method === "contado" ? "text-green-600" : "text-blue-600"}>
                    {r.method === "contado" ? "Contado" : "Crédito"}
                  </span>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{r.type ?? "—"}</td>
                <td className="px-4 py-2">{r.due_date_required ? "Requerido" : "No requiere"}</td>
                <td className="w-72 px-4 py-2">
                  <AccountCombobox
                    accounts={cuentas ?? []}
                    value={r.account_code ?? ""}
                    onChange={(code, name) => void actualizar(r.id, { account_code: code || null, account_name: name })}
                    placeholder="Buscar cuenta…"
                  />
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`active-${r.id}`}
                      checked={r.active}
                      onCheckedChange={(checked) => void actualizar(r.id, { active: checked })}
                    />
                    <Label htmlFor={`active-${r.id}`} className="sr-only">
                      Activa
                    </Label>
                  </div>
                </td>
              </tr>
            ))}
            {filtradas.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {buscar ? "Sin resultados para la búsqueda." : "Sin formas de pago registradas. Sincroniza con Siigo desde el módulo de Integraciones."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
