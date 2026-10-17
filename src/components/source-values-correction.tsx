import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toCents } from "@/lib/money";
import type { SourceValues } from "@/lib/source-values";

export function SourceValuesCorrection({ invoiceId, companyId, source }: { invoiceId: string; companyId: string; source: SourceValues }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(source);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: permission } = useQuery({ queryKey: ["source-correction-permission", companyId], queryFn: async () => {
    const result = await supabase.rpc("is_company_admin", { _company_id: companyId });
    return !result.error && result.data === true;
  } });
  async function save() {
    if (!reason.trim()) { toast.error("El motivo es obligatorio."); return; }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("correct_invoice_source_values", { _invoice_id: invoiceId, _values: values as never, _reason: reason.trim() });
      if (error) throw error;
      window.location.reload();
    } catch (error) { toast.error(error instanceof Error ? error.message : "No se pudo corregir el valor."); }
    finally { setBusy(false); }
  }
  if (!permission) return null;
  return <>
    <Button variant="outline" size="sm" onClick={() => { setValues(source); setOpen(true); }}><Pencil className="size-4" /> Corregir valores con motivo</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Corrección autorizada de valores</DialogTitle></DialogHeader>
      <div className="grid grid-cols-2 gap-3">{(["subtotal", "iva", "impoconsumo", "discount", "surcharge", "total"] as const).map(field => <div key={field}><Label>{({ subtotal: "Subtotal", iva: "IVA", impoconsumo: "INC", discount: "Descuento global", surcharge: "Recargo global", total: "Total" })[field]}</Label><Input type="number" step="0.01" value={values[field] / 100} onChange={e => setValues({ ...values, [field]: toCents(e.target.value) })} /></div>)}</div>
      {values.lines.map((line, i) => <div key={i} className="grid grid-cols-3 gap-2"><div className="col-span-3 text-sm font-medium">Línea {i + 1}</div>{(["subtotal", "iva", "impoconsumo"] as const).map(field => <div key={field}><Label>{field === "impoconsumo" ? "INC" : field === "iva" ? "IVA" : "Subtotal"}</Label><Input type="number" step="0.01" value={line[field] / 100} onChange={e => setValues({ ...values, lines: values.lines.map((l, j) => j === i ? { ...l, [field]: toCents(e.target.value) } : l) })} /></div>)}</div>)}
      <div><Label>Motivo obligatorio</Label><Textarea value={reason} onChange={e => setReason(e.target.value)} /></div>
      <Button disabled={busy || !reason.trim()} onClick={() => void save()}><Save className="size-4" /> Guardar corrección</Button>
    </DialogContent></Dialog>
  </>;
}