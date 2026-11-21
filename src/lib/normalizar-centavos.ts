// Normalización de centavos del documento (todas las empresas).
//
// Los precios unitarios con 3 decimales (2179,973 × 5) redondean cada renglón a centavos y la suma de los
// renglones queda a ~1 centavo del subtotal que trae el documento; además algunos documentos traen el subtotal
// BRUTO y un descuento solo informativo (los renglones ya vienen netos). Las guardas contables exigen
// subtotal = suma de renglones y subtotal + IVA + INC + recargo = total, así que el documento se deja
// consistente desde el origen, sin renglones ni ajuste al peso:
// - El subtotal real es el que implica el total: total − IVA − INC − recargo.
// - Si la suma de los renglones está a ≤ ~medio centavo por renglón (tope $1) de ese subtotal, el centavo
//   se suma o resta al renglón de mayor valor (valor unitario incluido) y el descuento informativo se anula.
// - Una diferencia mayor NO se toca (descuento global real con renglones brutos, error de lectura): la revisan
//   el reparto de cargos y las validaciones existentes.
import { roundCOP } from "@/lib/money";

type LineaN = { subtotal?: number; total: number; quantity: number; unit_value: number; discount: number };
type DocN = { subtotal: number; iva: number; impoconsumo: number; discount: number; surcharge?: number; total: number; lines: LineaN[] };

export type ResultadoNormalizacion<T> = { data: T; nota: string } | null;

export function normalizarCentavos<T extends DocN>(d: T): ResultadoNormalizacion<T> {
  const n = d.lines.length;
  if (!n) return null;
  // Valor tal como se guarda: cada renglón redondeado a centavos.
  const valor = (l: LineaN) => roundCOP(Number(l.subtotal ?? l.total ?? 0));
  const sumaLineas = roundCOP(d.lines.reduce((s, l) => s + valor(l), 0));
  const objetivo = roundCOP(roundCOP(d.total) - roundCOP(d.iva) - roundCOP(d.impoconsumo || 0) - roundCOP(d.surcharge ?? 0));
  const tolerancia = Math.min(1, Math.ceil(n / 2) / 100);
  const diferencia = roundCOP(objetivo - sumaLineas);
  if (Math.abs(diferencia) > tolerancia + 1e-9) return null;
  const subtotalYaCuadra = Math.abs(roundCOP(d.subtotal) - objetivo) < 0.005;
  if (diferencia === 0 && subtotalYaCuadra && !d.discount) return null;
  let mayor = 0;
  d.lines.forEach((l, i) => {
    if (valor(l) > valor(d.lines[mayor]!)) mayor = i;
  });
  const lines = d.lines.map((l, i) => {
    if (i !== mayor || diferencia === 0) return l;
    const subtotal = roundCOP(valor(l) + diferencia);
    const cantidad = Number(l.quantity || 0) || 1;
    return { ...l, subtotal, total: subtotal, unit_value: Math.round(((subtotal + Number(l.discount || 0)) / cantidad) * 1e6) / 1e6 };
  });
  const partes: string[] = [];
  if (diferencia !== 0) partes.push(`${diferencia > 0 ? "+" : "−"}${Math.abs(diferencia).toFixed(2)} al renglón de mayor valor`);
  if (!subtotalYaCuadra) partes.push(`subtotal ${roundCOP(d.subtotal).toFixed(2)} → ${objetivo.toFixed(2)} (el que implica el total)`);
  if (d.discount) partes.push(`descuento informativo ${roundCOP(d.discount).toFixed(2)} anulado (los renglones ya vienen netos)`);
  return {
    data: { ...d, subtotal: objetivo, discount: 0, lines },
    nota: `Normalización de centavos: ${partes.join("; ")}.`,
  };
}
