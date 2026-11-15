// Borradores (función «cuenta_gasto_en_borradores»): asignar la cuenta de gasto/costo a los renglones
// pendientes de cuenta de uno o varios borradores. La cuenta queda como decisión MANUAL del renglón:
// el recálculo del motor nunca la reemplaza (igual que las demás cuentas manuales).
import { supabase } from "@/integrations/supabase/client";
import { recalcularCuentasBorrador, type BulkConfig } from "@/lib/bulk-invoices";
import { isValidPurchaseAccount } from "@/lib/provider-rules";

export type ResultadoAsignacion = { id: string; ok: boolean; message: string; renglones: number };

/**
 * Pone `code` en los renglones del borrador cuya cuenta no es válida (o en todos con `todos`).
 * Después recalcula el asiento para que el débito quede en la cuenta elegida.
 */
export async function asignarCuentaGasto(
  invoiceId: string,
  cuenta: { code: string; name: string | null },
  config: BulkConfig,
  opciones: { inventario?: boolean; todos?: boolean } = {},
): Promise<ResultadoAsignacion> {
  const code = cuenta.code.trim();
  if (!isValidPurchaseAccount(code, !!opciones.inventario))
    return {
      id: invoiceId,
      ok: false,
      renglones: 0,
      message: `La cuenta ${code} no es una cuenta de gasto, costo o inventario válida.`,
    };
  const { data: inv, error } = await supabase
    .from("invoices")
    .select("id, status, raw_extraction")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error || !inv)
    return {
      id: invoiceId,
      ok: false,
      renglones: 0,
      message: error?.message ?? "La factura no existe.",
    };
  if (inv.status !== "borrador" && inv.status !== "error")
    return {
      id: invoiceId,
      ok: false,
      renglones: 0,
      message: "Solo se puede asignar cuenta a facturas en borrador.",
    };
  const raw = ((inv.raw_extraction ?? {}) as Record<string, unknown>) ?? {};
  const ia = raw["ia"] as { lines?: unknown[] } | undefined;
  if (!ia || !Array.isArray(ia.lines))
    return {
      id: invoiceId,
      ok: false,
      renglones: 0,
      message: "Esta factura no conserva la extracción original; no se puede asignar la cuenta.",
    };

  const { data: lineas } = await supabase
    .from("invoice_lines")
    .select("position, account_code")
    .eq("invoice_id", invoiceId)
    .order("position");
  const actual = new Map<number, string>(
    (lineas ?? []).map((l) => [Number(l.position), String(l.account_code ?? "").trim()]),
  );
  const decisiones = { ...((raw["account_decisions"] ?? {}) as Record<string, unknown>) };
  let renglones = 0;
  ia.lines.forEach((_, i) => {
    const pendiente = !isValidPurchaseAccount(actual.get(i) ?? "", !!opciones.inventario);
    if (!opciones.todos && !pendiente) return;
    decisiones[String(i)] = {
      code,
      name: cuenta.name,
      origin: "MANUAL",
      reason: "Cuenta elegida en Borradores.",
      confidence: "ALTA",
      score: 1,
      error: null,
    };
    renglones += 1;
  });
  if (renglones === 0)
    return {
      id: invoiceId,
      ok: true,
      renglones: 0,
      message: "No tenía renglones pendientes de cuenta.",
    };
  const { error: upErr } = await supabase
    .from("invoices")
    .update({ raw_extraction: { ...raw, account_decisions: decisiones } as never })
    .eq("id", invoiceId);
  if (upErr) return { id: invoiceId, ok: false, renglones: 0, message: upErr.message };
  const rec = await recalcularCuentasBorrador(invoiceId, config);
  return {
    id: invoiceId,
    ok: rec.ok,
    renglones,
    message: rec.ok ? `Cuenta ${code} en ${renglones} renglón(es).` : rec.message,
  };
}
