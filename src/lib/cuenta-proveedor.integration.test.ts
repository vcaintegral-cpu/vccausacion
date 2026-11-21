// Prueba de orquestación con una «base» en memoria: un proveedor con varias facturas (borradores, una aprobada, una
// causada) y otro proveedor. Verifica que SOLO se modifiquen los borradores del proveedor, que la cuenta quede en todos
// sus renglones (releyendo la base) y que una escritura que falla se detecte aunque no avise.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Fila = Record<string, unknown>;
const db = {
  invoices: [] as Fila[],
  invoice_lines: [] as Fila[],
  provider_rules: [] as Fila[],
};
// Facturas cuya escritura «falla en silencio» (el mensaje dice ok pero la base no cambia).
const sinEscribir = new Set<string>();

function consulta(tabla: keyof typeof db) {
  const filtros: Array<(f: Fila) => boolean> = [];
  let limite = Infinity;
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (c: string, v: unknown) => (filtros.push((f) => f[c] === v), api),
    in: (c: string, v: unknown[]) => (filtros.push((f) => v.includes(f[c])), api),
    like: (c: string, v: string) => (filtros.push((f) => String(f[c] ?? "").startsWith(v.replace("%", ""))), api),
    limit: (n: number) => ((limite = n), api),
    maybeSingle: async () => ({ data: db[tabla].filter((f) => filtros.every((x) => x(f)))[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) => res({ data: db[tabla].filter((f) => filtros.every((x) => x(f))).slice(0, limite), error: null }),
    insert: async (fila: Fila) => (db[tabla].push({ id: `n${db[tabla].length}`, ...fila }), { error: null }),
    update: (campos: Fila) => ({ eq: async (c: string, v: unknown) => (db[tabla].filter((f) => f[c] === v).forEach((f) => Object.assign(f, campos)), { error: null }) }),
  };
  return api;
}

vi.mock("@/lib/db-contextual", () => ({ supabase: { from: (t: keyof typeof db) => consulta(t) } }));
vi.mock("@/lib/asignar-cuenta-gasto", () => ({
  asignarCuentaGasto: async (id: string, cuenta: { code: string }) => {
    if (!sinEscribir.has(id)) db.invoice_lines.filter((l) => l.invoice_id === id).forEach((l) => (l.account_code = cuenta.code));
    return { id, ok: true, renglones: 1, message: "ok" };
  },
}));

import { aplicarCuentaAlProveedor, listarFacturasDelProveedor } from "./cuenta-proveedor";

const inv = (id: string, nit: string, status: string, extra: Fila = {}): Fila => ({
  id, company_id: "c1", doc_kind: "compra", prefix: "F", number: id, provider_nit: nit, status, siigo_status: null, siigo_id: null, voucher_number: null, ...extra,
});
const lineas = (id: string, cuentas: string[]): Fila[] => cuentas.map((c, i) => ({ invoice_id: id, position: i, account_code: c }));

beforeEach(() => {
  sinEscribir.clear();
  db.invoices = [
    inv("a1", "900888827", "borrador"),
    inv("a2", "900888827-1", "borrador"),
    inv("a3", "900888827", "error"),
    inv("a4", "900888827", "aprobado"),
    inv("a5", "900888827", "causada", { voucher_number: "CP-1" }),
    inv("b1", "111222333", "borrador"),
  ];
  db.invoice_lines = [
    ...lineas("a1", ["621008", "621008"]), ...lineas("a2", [""]), ...lineas("a3", ["621033", "621008", "621008"]),
    ...lineas("a4", ["621008"]), ...lineas("a5", ["621008"]), ...lineas("b1", ["621008"]),
  ];
  db.provider_rules = [];
});

const base = { companyId: "c1", nit: "900888827", nombre: "VENTANAS Y PERFILES JZ", cuenta: { code: "621029", name: "Vidrios y Aluminio" }, usuario: "contadora", config: {} as never, inventario: false };

describe("cuenta por proveedor con varias facturas", () => {
  it("lista las del proveedor (con y sin DV), marca las bloqueadas y no mezcla otros proveedores", async () => {
    const f = await listarFacturasDelProveedor("c1", "900888827");
    expect(f.map((x) => x.id).sort()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(f.filter((x) => !x.modificable).map((x) => x.id).sort()).toEqual(["a4", "a5"]);
  });

  it("aplica la cuenta SOLO a los borradores del proveedor y lo verifica en la base", async () => {
    const facturas = await listarFacturasDelProveedor("c1", "900888827");
    const r = await aplicarCuentaAlProveedor({ ...base, facturas, recordarRegla: true });
    expect(r.actualizadas).toBe(3);
    expect(r.verificadas).toBe(3);
    expect(r.fallidas).toEqual([]);
    expect(r.omitidas.map((x) => x.id).sort()).toEqual(["a4", "a5"]);
    const cuentasDe = (id: string) => db.invoice_lines.filter((l) => l.invoice_id === id).map((l) => l.account_code);
    for (const id of ["a1", "a2", "a3"]) expect(cuentasDe(id).every((c) => c === "621029")).toBe(true);
    // Intactas: la aprobada, la causada y el otro proveedor.
    expect(cuentasDe("a4")).toEqual(["621008"]);
    expect(cuentasDe("a5")).toEqual(["621008"]);
    expect(cuentasDe("b1")).toEqual(["621008"]);
    // Regla del proveedor guardada una sola vez.
    expect(db.provider_rules).toHaveLength(1);
    expect(db.provider_rules[0]).toMatchObject({ provider_nit: "900888827", expense_account: "621029", keyword: "(todas)" });
  });

  it("detecta una escritura que no quedó guardada aunque la operación diga «ok»", async () => {
    sinEscribir.add("a2");
    const facturas = await listarFacturasDelProveedor("c1", "900888827");
    const r = await aplicarCuentaAlProveedor({ ...base, facturas, recordarRegla: false });
    expect(r.verificadas).toBe(2);
    expect(r.fallidas.map((x) => x.id)).toEqual(["a2"]);
    expect(r.fallidas[0]!.label).toBe("F-a2");
    expect(db.provider_rules).toHaveLength(0);
  });

  it("actualiza la regla existente en lugar de duplicarla", async () => {
    db.provider_rules = [{ id: "r1", company_id: "c1", provider_nit: "900888827", keyword: "(todas)", expense_account: "621008" }];
    const facturas = await listarFacturasDelProveedor("c1", "900888827");
    await aplicarCuentaAlProveedor({ ...base, facturas, recordarRegla: true });
    expect(db.provider_rules).toHaveLength(1);
    expect(db.provider_rules[0]).toMatchObject({ id: "r1", expense_account: "621029" });
  });
});
