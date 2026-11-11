// Compras siempre POR PAGAR (función por empresa `compras_por_pagar`).
//
// Las empresas que pagan desde «Egresos y pagos» envían toda compra a Siigo con la forma
// de pago a crédito (cuenta por pagar al proveedor), nunca pagada de contado, con tarjeta,
// efectivo o banco: el pago se registra después con el recibo de pago (RP).

export type FormaPagoLocal = {
  siigo_id: string;
  name: string;
  method: string | null;
  account_code: string | null;
  active: boolean | null;
  due_date_required: boolean | null;
};

/** Formas de pago que pagan en el acto (no dejan cuenta por pagar). */
const PAGADA =
  /TARJETA|\bT\.?C\b|VISA|MASTER|AMEX|DOLAR|EFECTIVO|CAJA|CONTADO|BANCO|CTE|\bAHO\b|CORRIENTE|AHORRO|DAVIVIENDA|BANCOLOMBIA|NEQUI|DAVIPLATA|PSE|TRANSFERENCIA/;
const norm = (s: string | null | undefined) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

export function esFormaPorPagar(
  f: Pick<FormaPagoLocal, "name" | "method" | "due_date_required">,
): boolean {
  const n = norm(f.name);
  if (PAGADA.test(n)) return false;
  return (
    f.method === "credito" ||
    !!f.due_date_required ||
    /CREDITO|PROVEEDOR|POR PAGAR|CXP/.test(n)
  );
}

/**
 * Forma de pago de Siigo que deja la compra por pagar: la de crédito cuya cuenta es la
 * CxP de la compra; si no se conoce la cuenta, la única «Crédito/Proveedores».
 */
export function formaPagoPorPagar(
  formas: FormaPagoLocal[],
  cuentaCxP: string | null | undefined,
): { id: string; name: string } | { error: string } {
  const cand = formas.filter((f) => f.active !== false && esFormaPorPagar(f));
  const cuenta = String(cuentaCxP ?? "").trim();
  const porCuenta = cuenta
    ? cand.filter((f) => String(f.account_code ?? "").trim() === cuenta)
    : [];
  if (porCuenta.length === 1) return { id: porCuenta[0]!.siigo_id, name: porCuenta[0]!.name };
  const lista = porCuenta.length > 1 ? porCuenta : cand;
  if (lista.length === 1) return { id: lista[0]!.siigo_id, name: lista[0]!.name };
  const proveedores = lista.filter((f) => /PROVEEDOR/.test(norm(f.name)));
  if (proveedores.length === 1) return { id: proveedores[0]!.siigo_id, name: proveedores[0]!.name };
  const credito = lista.filter((f) => /^CREDITO\b/.test(norm(f.name).trim()));
  if (credito.length === 1) return { id: credito[0]!.siigo_id, name: credito[0]!.name };
  return {
    error: lista.length
      ? `Hay varias formas de pago a crédito en Siigo (${lista.map((f) => f.name).join(", ")}): elige en el borrador la que lleva a la cuenta ${cuenta || "por pagar"}.`
      : `No hay en Siigo una forma de pago a crédito (cuenta por pagar${cuenta ? ` ${cuenta}` : ""}). Créala en Siigo y sincroniza las formas de pago en Integraciones.`,
  };
}
