import { resolverRetenciones, retencionesReportadas } from "../lib/retenciones";
import { buildJournal, totals } from "../lib/accounting";

const puc = [
  { code: "23652505", name: "Servicios 3.5%", active: true, has_children: false, is_movement: true, parent_code: "236525", siigo_active: true, siigo_is_movement: true },
  { code: "2365", name: "Retefuente", active: true, has_children: true, is_movement: false, parent_code: null },
  { code: "236525", name: "Servicios", active: true, has_children: true, is_movement: false, parent_code: "2365" },
  { code: "23670501", name: "ReteIVA 15%", active: true, has_children: false, is_movement: true, parent_code: "236705" },
  { code: "236705", name: "ReteIVA", active: true, has_children: true, is_movement: false, parent_code: "2367" },
  { code: "23680509", name: "ReteICA 7x1000", active: true, has_children: false, is_movement: true, parent_code: "236805" },
  { code: "236805", name: "ReteICA", active: true, has_children: true, is_movement: false, parent_code: "2368" },
  { code: "24080101", name: "IVA descontable 19%", active: true, has_children: false, is_movement: true, parent_code: "240801" },
  { code: "61800102", name: "Fletes", active: true, has_children: false, is_movement: true, parent_code: "618001" },
  { code: "22050501", name: "Proveedores nacionales", active: true, has_children: false, is_movement: true, parent_code: "220505" },
] as any;

const taxes = [
  { id: "t1", kind: "retefuente", name: "Servicios 3.5%", rate: 3.5, min_base: 0, account_code: "23652505", active: true },
  { id: "t2", kind: "retefuente", name: "Compras 2.5%", rate: 2.5, min_base: 0, account_code: "236540", active: true },
  { id: "t3", kind: "reteiva", name: "ReteIVA 15%", rate: 15, min_base: 0, account_code: "23670501", active: true },
  { id: "t4", kind: "reteica", name: "ReteICA 7x1000", rate: 0.7, min_base: 0, account_code: "23680509", active: true },
  { id: "t5", kind: "iva", name: "IVA 19%", rate: 19, min_base: 0, account_code: "24080101", active: true },
] as any;

const base = 1_000_000;
const linea = (iva: number) => [{ description: "Fletes", quantity: 1, unit_value: base, discount: 0, iva, retention: 0, impoconsumo: 0, total: 0, account_code: "61800102", account_name: "Fletes" }] as any;

function corre(nombre: string, header: any, iva: number) {
  const reportado = retencionesReportadas({ header, lineRetention: 0, baseGravable: base, ivaTotal: iva, taxes });
  const { retenciones, errores } = resolverRetenciones({ reportado, baseGravable: base, ivaTotal: iva, taxes, puc });
  const j = buildJournal({
    lines: linea(iva), iva, retenciones, payableAccount: { code: "22050501", name: "Proveedores" },
    ivaDetalle: iva > 0 ? [{ account_code: "24080101", account_name: "IVA descontable", amount: iva }] : undefined,
  });
  const t = totals(j);
  console.log(nombre, "| cuentas:", j.map((l) => `${l.account_code}:${l.debit || -l.credit}`).join(" "), "| dif:", t.diferencia, "| errores:", errores);
  if (t.diferencia !== 0) throw new Error("descuadre en " + nombre);
  if (j.some((l) => ["2365", "2367", "2368"].includes(l.account_code))) throw new Error("cuenta mayor en " + nombre);
}

corre("P1 sin IVA sin retenciones", {}, 0);
corre("P2 IVA sin retenciones", {}, 190000);
corre("P3 retefuente", { retefuente: 35000 }, 190000);
corre("P4 reteiva", { reteiva: 28500 }, 190000);
corre("P5 reteica", { reteica: 7000 }, 190000);
corre("P6 todas", { retefuente: 35000, reteiva: 28500, reteica: 7000 }, 190000);
// Masivo: cinco facturas seguidas, cada una con sus propios impuestos.
[{}, { retefuente: 35000 }, {}, { reteiva: 28500 }, { retefuente: 35000, reteica: 7000 }].forEach((h, i) => corre(`P7.${i + 1}`, h, 190000));
