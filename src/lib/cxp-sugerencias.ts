// Egresos del extracto sin RP contra las cuentas por pagar vivas de Siigo (núcleo global).
// Para una salida del banco sin registro busca el proveedor (número de la factura en la
// descripción, NIT o nombre parecido) y la factura —o varias del mismo proveedor— cuyo
// saldo suma el pago, para proponer el RP de pago de facturas en lugar de un RP a una
// cuenta de gasto. Nunca inventa: sin coincidencia exacta de valor (±1 peso) no sugiere.
import { similitud } from "@/lib/conciliacion";
import { roundCOP } from "@/lib/money";

export type CxpAbierta = {
  prefix: string;
  consecutive: number;
  quote: number;
  balance: number;
  dueDate: string | null;
  providerNit: string | null;
  providerName: string | null;
  /** Número de la factura del proveedor (p. ej. «IT41700»). */
  factura: string | null;
};

export type SugerenciaCxp = {
  terceroNit: string;
  terceroNombre: string | null;
  items: Array<{
    prefix: string;
    consecutive: number;
    quote: number;
    factura: string | null;
    saldo: number;
    valor: number;
    vence: string | null;
  }>;
  criterio: string;
};

const alnum = (s: string | null | undefined) =>
  String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
const digitos = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");

function combinacion(cands: CxpAbierta[], objetivo: number, max: number): CxpAbierta[] | null {
  const rec = (i: number, suma: number, el: CxpAbierta[]): CxpAbierta[] | null => {
    if (el.length && Math.abs(suma - objetivo) <= 1) return el;
    if (el.length === max || suma > objetivo + 1) return null;
    for (let k = i; k < cands.length; k++) {
      const r = rec(k + 1, suma + cands[k]!.balance, [...el, cands[k]!]);
      if (r) return r;
    }
    return null;
  };
  return rec(0, 0, []);
}

/** Factura(s) abierta(s) del proveedor que paga una salida del extracto, o null. */
export function sugerirFacturas(
  mov: { descripcion: string; valor: number; tercero?: string | null },
  cxp: CxpAbierta[],
): SugerenciaCxp | null {
  const valor = roundCOP(Math.abs(mov.valor));
  if (!(mov.valor < 0) || valor < 1) return null;
  const texto = `${mov.descripcion} ${mov.tercero ?? ""}`;
  const textoAlnum = alnum(texto);
  const textoDig = digitos(texto);
  const abiertas = cxp.filter((c) => c.balance > 0.009 && c.providerNit);
  // Proveedores candidatos: por número de factura citado, NIT en el texto o nombre parecido.
  const porProveedor = new Map<string, { puntaje: number; criterio: string }>();
  const anotar = (nit: string, puntaje: number, criterio: string) => {
    const prev = porProveedor.get(nit);
    if (!prev || prev.puntaje < puntaje) porProveedor.set(nit, { puntaje, criterio });
  };
  for (const c of abiertas) {
    const nit = c.providerNit!;
    const f = alnum(c.factura);
    if (f.length >= 4 && /\d{3,}/.test(f) && textoAlnum.includes(f))
      anotar(nit, 3, `Factura ${c.factura} citada en el extracto`);
    const nitBase = digitos(nit).slice(0, 9);
    if (nitBase.length >= 6 && textoDig.includes(nitBase)) anotar(nit, 2.5, "NIT en el extracto");
    const s = similitud(c.providerName, texto);
    if (s >= 0.5) anotar(nit, 1 + s, `Nombre «${c.providerName}» en el extracto`);
  }
  const candidatos = [...porProveedor].sort((a, b) => b[1].puntaje - a[1].puntaje);
  for (const [nit, info] of candidatos) {
    const suyas = abiertas
      .filter((c) => c.providerNit === nit)
      .sort(
        (a, b) =>
          String(a.dueDate ?? "").localeCompare(String(b.dueDate ?? "")) ||
          a.consecutive - b.consecutive,
      );
    // Primero la factura citada; luego una sola por el valor; luego 2 a 4 que sumen el pago.
    const citada = suyas.find(
      (c) => alnum(c.factura).length >= 4 && textoAlnum.includes(alnum(c.factura)),
    );
    const elegidas =
      (citada && Math.abs(citada.balance - valor) <= 1 ? [citada] : null) ??
      (suyas.filter((c) => Math.abs(c.balance - valor) <= 1).slice(0, 1) as CxpAbierta[]) ??
      null;
    const combo =
      elegidas && elegidas.length ? elegidas : combinacion(suyas.slice(0, 15), valor, 4);
    if (!combo || !combo.length) continue;
    // El pago se reparte por el saldo de cada factura (el ajuste de ±1 peso, a la última).
    let resto = valor;
    const items = combo.map((c, i) => {
      const v = i === combo.length - 1 ? roundCOP(resto) : roundCOP(Math.min(c.balance, resto));
      resto = roundCOP(resto - v);
      return {
        prefix: c.prefix,
        consecutive: c.consecutive,
        quote: c.quote,
        factura: c.factura,
        saldo: c.balance,
        valor: Math.min(v, c.balance),
        vence: c.dueDate,
      };
    });
    if (Math.abs(items.reduce((t, i) => t + i.valor, 0) - valor) > 1) continue;
    return {
      terceroNit: nit,
      terceroNombre: combo[0]!.providerName,
      items,
      criterio: `${info.criterio}; ${combo.length === 1 ? "saldo de la factura" : `${combo.length} facturas`} = valor del pago`,
    };
  }
  return null;
}
