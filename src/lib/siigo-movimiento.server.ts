// Movimiento de bancos y caja desde la API de Siigo (núcleo global: todas las empresas).
// La API no entrega el «Movimiento auxiliar por cuenta contable»; se reconstruye con los
// documentos que mueven bancos y caja, y se valida contra el balance de prueba de Siigo:
//   - comprobantes contables (/v1/journals): renglones con cuenta;
//   - recibos de caja (/v1/vouchers) y recibos de pago (/v1/payment-receipts): detallados
//     con cuenta, o con forma de pago (cuenta del banco/caja por la forma de pago);
//   - facturas de venta (/v1/invoices) y de compra (/v1/purchases) con pagos de contado.
// Siigo filtra los listados por fecha de CREACIÓN: se lista desde el inicio del rango y se
// filtra por la fecha del documento. El balance de prueba (POST /v1/test-balance-report)
// devuelve un Excel con saldo inicial, débitos, créditos y saldo final por cuenta.
import * as XLSX from "xlsx";

import type { LineaAuxiliar } from "@/lib/conciliacion";
import { roundCOP } from "@/lib/money";

export type CuentaMovimiento = {
  etiqueta: string;
  cuentaContable: string;
  /** Forma de pago de Siigo asociada a la cuenta (RP del módulo de egresos). */
  paymentTypeId: string | null;
};

export type BalanceCuenta = {
  cuenta: string;
  saldoInicial: number;
  debitos: number;
  creditos: number;
  saldoFinal: number;
};

type Cuenta = { code?: string | number; movement?: string };
type Item = {
  account?: Cuenta;
  customer?: { identification?: string | number };
  description?: string;
  value?: number;
};
type Pago = { id?: number | string; name?: string; value?: number };
type Doc = {
  id?: string;
  name?: string;
  date?: string;
  type?: string;
  customer?: { identification?: string | number };
  supplier?: { identification?: string | number };
  items?: Item[];
  payment?: Pago;
  payments?: Pago[];
  observations?: string;
};

const sinTildes = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** La forma de pago corresponde a la cuenta: por su id o por la etiqueta en su nombre. */
function cuentaDePago(p: Pago, cuentas: CuentaMovimiento[]): CuentaMovimiento | null {
  if (p.id != null) {
    const c = cuentas.find((x) => x.paymentTypeId && String(x.paymentTypeId) === String(p.id));
    if (c) return c;
  }
  const n = sinTildes(p.name);
  if (!n) return null;
  return (
    cuentas.find((c) => {
      const e = sinTildes(c.etiqueta);
      if (/EFECTIVO|CAJA/.test(e)) return /EFECTIVO|CAJA/.test(n);
      return e
        .split(" ")
        .filter((w) => w.length >= 4)
        .some((w) => n.includes(w.replace(/S$/, "")));
    }) ?? null
  );
}

/**
 * Movimiento de las cuentas de banco/caja entre `desde` y `hasta` (yyyy-MM-dd), como filas
 * del auxiliar de Siigo. `maxPaginas` limita las llamadas por tipo de documento.
 */
export async function movimientoDesdeApi(params: {
  desde: string;
  hasta: string;
  cuentas: CuentaMovimiento[];
  maxPaginas?: number;
  /**
   * Fecha de creación desde la que se listan los documentos (por defecto `desde`). Sirve para
   * traer los registrados después del corte con fecha de meses anteriores.
   */
  creadoDesde?: string;
}): Promise<{ filas: LineaAuxiliar[]; advertencias: string[]; documentos: number }> {
  const { siigoGet } = await import("./siigo.server");
  const codigos = new Set(params.cuentas.map((c) => c.cuentaContable));
  const filas: LineaAuxiliar[] = [];
  const advertencias: string[] = [];
  const enRango = (f: string) => f >= params.desde && f <= params.hasta;
  const fechaTexto = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
  let documentos = 0;
  const vistos = new Set<string>();

  const listar = async (ruta: string, etiqueta: string, alDoc: (d: Doc) => void) => {
    const max = params.maxPaginas ?? 25;
    for (let page = 1; page <= max; page++) {
      let r: { results?: Doc[]; pagination?: { total_results?: number } } | Doc[];
      try {
        r = await siigoGet(`${ruta}${ruta.includes("?") ? "&" : "?"}page=${page}&page_size=100`);
      } catch (e) {
        advertencias.push(`${etiqueta}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const l = Array.isArray(r) ? r : (r.results ?? []);
      for (const d of l) {
        const k = `${etiqueta}|${d.id ?? d.name}`;
        if (vistos.has(k)) continue;
        vistos.add(k);
        const f = String(d.date ?? "").slice(0, 10);
        if (!f || !enRango(f)) continue;
        documentos += 1;
        alDoc(d);
      }
      if (l.length < 100) return;
      if (page === max)
        advertencias.push(
          `${etiqueta}: se alcanzó el límite de ${max * 100} documentos; el movimiento puede estar incompleto (sube el auxiliar).`,
        );
    }
  };
  const fila = (
    d: Doc,
    code: string,
    debito: number,
    credito: number,
    nit: unknown,
    desc: string | null,
  ) =>
    filas.push({
      account_code: code,
      voucher: String(d.name ?? d.id ?? ""),
      entry_date_text: fechaTexto(String(d.date).slice(0, 10)),
      provider_name: null,
      provider_nit: nit != null && String(nit).trim() ? String(nit).trim() : null,
      description: desc ?? d.observations ?? null,
      debit: roundCOP(debito),
      credit: roundCOP(credito),
    });
  const renglones = (d: Doc, tercero: unknown) => {
    for (const it of d.items ?? []) {
      const code = String(it.account?.code ?? "").trim();
      if (!codigos.has(code)) continue;
      const debito = /^D/i.test(String(it.account?.movement ?? ""));
      const v = Number(it.value ?? 0);
      fila(
        d,
        code,
        debito ? v : 0,
        debito ? 0 : v,
        it.customer?.identification ?? tercero,
        it.description ?? null,
      );
    }
  };
  const pagos = (d: Doc, entra: boolean, tercero: unknown) => {
    for (const p of d.payments ?? (d.payment ? [d.payment] : [])) {
      const c = cuentaDePago(p, params.cuentas);
      if (!c) continue;
      const v = Number(p.value ?? 0);
      fila(d, c.cuentaContable, entra ? v : 0, entra ? 0 : v, tercero, p.name ?? null);
    }
  };
  const desde = params.creadoDesde ?? params.desde;
  await listar(`/v1/journals?created_start=${desde}`, "Comprobantes contables", (d) =>
    renglones(d, null),
  );
  await listar(`/v1/vouchers?created_start=${desde}`, "Recibos de caja", (d) => {
    if (d.items?.some((i) => i.account?.code)) renglones(d, d.customer?.identification);
    else pagos(d, true, d.customer?.identification);
  });
  await listar(`/v1/payment-receipts?created_start=${desde}`, "Recibos de pago", (d) => {
    if (d.items?.some((i) => i.account?.code)) renglones(d, d.supplier?.identification);
    else pagos(d, false, d.supplier?.identification);
  });
  await listar(`/v1/invoices?created_start=${desde}`, "Facturas de venta", (d) =>
    pagos(d, true, d.customer?.identification),
  );
  await listar(`/v1/purchases?created_start=${desde}`, "Facturas de compra", (d) =>
    pagos(d, false, d.supplier?.identification),
  );
  return { filas, advertencias, documentos };
}

const numero = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v ?? "").replace(/[$\s]/g, "");
  if (!t || !/\d/.test(t)) return null;
  const es = /,\d{1,2}$/.test(t) || /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t);
  const n = Number(es ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Lee el Excel del balance de prueba de Siigo: fila de encabezados con «Saldo inicial»,
 * «Débito(s)», «Crédito(s)», «Saldo final» y una columna con el código de la cuenta.
 */
export function leerBalancePrueba(bytes: Uint8Array | ArrayBuffer): BalanceCuenta[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const out: BalanceCuenta[] = [];
  for (const nombre of wb.SheetNames) {
    const filas = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[nombre]!, {
      header: 1,
      raw: true,
      defval: null,
    });
    const iEnc = filas.findIndex((f) => {
      const h = (f ?? []).map(sinTildes);
      return h.some((x) => /SALDO INICIAL/.test(x)) && h.some((x) => /SALDO FINAL/.test(x));
    });
    if (iEnc < 0) continue;
    const h = filas[iEnc]!.map(sinTildes);
    const col = (re: RegExp) => h.findIndex((x) => re.test(x));
    const cIni = col(/SALDO INICIAL/);
    const cDeb = col(/^(MOVIMIENTO )?DEBITOS?$|^DEBITO/);
    const cCre = col(/^(MOVIMIENTO )?CREDITOS?$|^CREDITO/);
    const cFin = col(/SALDO FINAL/);
    const cCod = col(/CODIGO|CUENTA CONTABLE|^CUENTA$/);
    for (const f of filas.slice(iEnc + 1)) {
      if (!f) continue;
      // Código: la columna de código, o la primera celda con 6 a 10 dígitos.
      const codigo =
        (cCod >= 0 ? String(f[cCod] ?? "").replace(/\D/g, "") : "") ||
        f.map((x) => String(x ?? "").trim()).find((x) => /^\d{6,10}$/.test(x)) ||
        "";
      if (!/^\d{4,10}$/.test(codigo)) continue;
      const ini = numero(f[cIni]);
      const fin = numero(f[cFin]);
      if (ini == null && fin == null) continue;
      out.push({
        cuenta: codigo,
        saldoInicial: roundCOP(ini ?? 0),
        debitos: roundCOP(cDeb >= 0 ? (numero(f[cDeb]) ?? 0) : 0),
        creditos: roundCOP(cCre >= 0 ? (numero(f[cCre]) ?? 0) : 0),
        saldoFinal: roundCOP(fin ?? 0),
      });
    }
    if (out.length) break;
  }
  return out;
}

/** Balance de prueba de Siigo de las cuentas, meses `mesInicial`..`mesFinal` del año. */
export async function balanceDesdeApi(params: {
  anio: number;
  mesInicial: number;
  mesFinal: number;
  cuentas: string[];
}): Promise<BalanceCuenta[]> {
  const { siigoPost } = await import("./siigo.server");
  const orden = [...new Set(params.cuentas)].sort();
  if (!orden.length) return [];
  const r = await siigoPost<{ file_url?: string; file_id?: string }>("/v1/test-balance-report", {
    account_start: orden[0],
    account_end: orden[orden.length - 1],
    year: params.anio,
    month_start: params.mesInicial,
    month_end: params.mesFinal,
    includes_tax_difference: false,
  });
  if (!r?.file_url) throw new Error("Siigo no devolvió el enlace del balance de prueba.");
  const res = await fetch(r.file_url);
  if (!res.ok) throw new Error(`No se pudo descargar el balance de prueba (HTTP ${res.status}).`);
  const todos = leerBalancePrueba(new Uint8Array(await res.arrayBuffer()));
  const set = new Set(orden);
  return todos.filter((b) => set.has(b.cuenta));
}
