// Prueba de punta a punta del motor de causación con el precedente tributario:
// la base de datos se simula vacía y el precedente se inyecta en la configuración.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => {
  const vacio = () => {
    const b: Record<string, unknown> = {};
    const encadenar = () => b;
    for (const m of [
      "select",
      "eq",
      "in",
      "or",
      "not",
      "order",
      "range",
      "limit",
      "neq",
      "gte",
      "lte",
      "ilike",
      "like",
      "is",
    ])
      b[m] = encadenar;
    b["maybeSingle"] = () => Promise.resolve({ data: null, error: null });
    b["single"] = () => Promise.resolve({ data: null, error: null });
    b["then"] = (ok: (r: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(ok);
    return b;
  };
  return { supabase: { from: vacio, rpc: () => Promise.resolve({ data: null, error: null }) } };
});

const { computeDraftAccounting } = await import("./bulk-invoices");
const { construirPrecedentes } = await import("./precedente-tributario");

const TAXES = [
  {
    id: "iva19b",
    kind: "iva",
    name: "IVA 19% bienes",
    rate: 19,
    account_code: "24081001",
    active: true,
    min_base: 0,
  },
  {
    id: "iva19s",
    kind: "iva",
    name: "IVA 19% servicios",
    rate: 19,
    account_code: "24081002",
    active: true,
    min_base: 0,
  },
  {
    id: "rfComp",
    kind: "retefuente",
    name: "Retención compras 2,5%",
    rate: 2.5,
    account_code: "23654001",
    active: true,
    min_base: 0,
    retention_concept: "compras",
  },
];
const cuenta = (code: string, name: string) => ({
  code,
  name,
  active: true,
  is_movement: true,
  has_children: false,
});
const PUC = [
  cuenta("51959501", "Gastos diversos"),
  cuenta("24081001", "IVA descontable bienes"),
  cuenta("24081002", "IVA descontable servicios"),
  cuenta("23654001", "Retención compras"),
  cuenta("22050501", "Proveedores nacionales"),
];

const precedentes = construirPrecedentes({
  taxes: TAXES,
  facturas: [
    {
      id: "a1",
      provider_nit: "900047217",
      issue_date: "2026-09-12",
      subtotal: 2000000,
      iva: 380000,
      retefuente: 50000,
      reteiva: 0,
      reteica: 0,
    },
  ],
  lineas: [{ invoice_id: "a1", iva: 380000, iva_tax_id: "iva19b" }],
  asientos: [{ invoice_id: "a1", account_code: "23654001", debit: 0, credit: 50000 }],
  historico: [],
});

function config(
  tablas: {
    year: number;
    uvt: number;
    concepts: { id: string; concepto: string; base_uvt: number }[];
  }[],
) {
  return {
    accounts: PUC,
    rules: [],
    taxes: TAXES as never,
    products: [],
    categories: [],
    knowledge: { learning: [], history: [] },
    precedentes,
    tablasBases: tablas,
    batch: {
      company: {
        id: "c1",
        name: "EMPRESA",
        nit: "800212838",
        uses_cost_centers: false,
        default_payable_account: "22050501",
      },
      providers: {
        "900047217": {
          nit: "900047217",
          default_expense_account: "51959501",
          default_payable_account: "22050501",
          default_iva_account: null,
        },
      },
      providerRules: [],
      userId: "u1",
    },
  };
}

const header = {
  prefix: "FE",
  number: "1001",
  issue_date: "2026-10-20",
  due_date: null,
  provider_nit: "900047217",
  provider_name: "MEGA LUCES S.A.S",
  provider_address: null,
  provider_city: null,
  provider_phone: null,
  provider_email: null,
  buyer_nit: "800212838",
  buyer_name: "EMPRESA",
  cufe: "abc",
  payment_form: "Crédito",
  payment_method: null,
  currency: "COP",
  cost_center: null,
  notes: null,
  subtotal: 1000000,
  discount: 0,
  iva: 190000,
  impoconsumo: 0,
  retefuente: 0,
  reteiva: 0,
  reteica: 0,
  total: 1190000,
};
const lineas = [
  {
    code: null,
    description: "Luminarias LED",
    quantity: 1,
    unit_value: 1000000,
    discount: 0,
    iva: 190000,
    iva_rate: 19,
    retention: 0,
    impoconsumo: 0,
    total: 1000000,
    subtotal: 1000000,
  },
];
const TABLA_2026 = [
  {
    year: 2026,
    valid_from: "2026-01-01",
    valid_to: null,
    uvt: 50000,
    concepts: [{ id: "compras", concepto: "Compras", base_uvt: 10 }],
  },
];

describe("causación con precedente tributario", () => {
  it("elige el IVA del proveedor, practica la retención histórica y deja el asiento con cuentas", async () => {
    const acc = await computeDraftAccounting({
      companyId: "c1",
      config: config(TABLA_2026) as never,
      header: header as never,
      extracted: lineas as never,
    });
    expect(acc.ivaPorLinea[0]?.tax.id).toBe("iva19b");
    expect(acc.retenciones.retefuente).toBe(25000);
    expect(acc.confirmarCondicion).toBeNull();
    const iva = acc.journal.find((j) => j.account_code === "24081001");
    expect(iva?.debit).toBe(190000);
    // Ningún impuesto queda sin cuenta (la cuenta de gasto depende del historial de gastos, aquí vacío).
    expect(acc.journal.filter((j) => !j.account_code).map((j) => j.debit)).toEqual([1000000]);
    expect(acc.unresolvedAccounts).toEqual(["Pendiente de cuenta: línea 1."]);
    expect(acc.journal.find((j) => j.account_code === "23654001")?.credit).toBe(25000);
    expect(acc.journal.find((j) => j.account_code === "22050501")?.credit).toBe(1165000);
    const debitos = acc.journal.reduce((s, j) => s + j.debit, 0);
    const creditos = acc.journal.reduce((s, j) => s + j.credit, 0);
    expect(Math.abs(debitos - creditos)).toBeLessThan(0.01);
    expect(acc.alertas.some((a) => a.includes("por precedente en Siigo"))).toBe(true);
  });

  it("si la base no alcanza la mínima no retiene y lo explica", async () => {
    const tablaAlta = [
      {
        year: 2026,
        valid_from: "2026-01-01",
        valid_to: null,
        uvt: 50000,
        concepts: [{ id: "compras", concepto: "Compras", base_uvt: 27 }],
      },
    ];
    const acc = await computeDraftAccounting({
      companyId: "c1",
      config: config(tablaAlta) as never,
      header: header as never,
      extracted: lineas as never,
    });
    expect(acc.retenciones.retefuente).toBe(0);
    expect(acc.journal.some((j) => j.account_code.startsWith("2365"))).toBe(false);
    expect(acc.alertas.some((a) => a.includes("no alcanza la base mínima $1.350.000"))).toBe(true);
  });

  it("proveedor sin precedente: IVA más usado por la empresa con esa tarifa; no inventa retención y pide confirmar", async () => {
    const otro = { ...header, provider_nit: "811000001", provider_name: "NUEVO S.A.S." };
    const acc = await computeDraftAccounting({
      companyId: "c1",
      config: config(TABLA_2026) as never,
      header: otro as never,
      extracted: lineas as never,
    });
    // Precedente de la empresa (no del proveedor): el IVA del 19 % que más usa la empresa.
    expect(acc.ivaPorLinea[0]?.tax.id).toBe("iva19b");
    expect(acc.ivaPorLinea[0]?.motivo).toContain("más usa la empresa");
    expect(acc.journal.find((j) => j.account_name === "IVA sin impuesto seleccionado")).toBeUndefined();
    expect(acc.retenciones.retefuente).toBe(0);
    expect(acc.confirmarCondicion).toContain("Proveedor sin precedente en Siigo");
  });

  it("la retención que trae el documento sigue mandando", async () => {
    const conRet = { ...header, retefuente: 25000 };
    const acc = await computeDraftAccounting({
      companyId: "c1",
      config: config(TABLA_2026) as never,
      header: conRet as never,
      extracted: lineas as never,
    });
    expect(acc.retenciones.retefuente).toBe(25000);
    expect(
      acc.retenciones.detalle.filter((d) => (d as { kind: string }).kind === "retefuente"),
    ).toHaveLength(1);
  });
});

describe("retención informada por la factura sin tarifa configurada que coincida", () => {
  const TAXES2 = [
    ...TAXES,
    { id: "rfServ", kind: "retefuente", name: "Retención servicios 4%", rate: 4, account_code: "23652501", active: true, min_base: 0 },
  ];
  const precedentes2 = construirPrecedentes({
    taxes: TAXES2,
    facturas: [
      { id: "a1", provider_nit: "900047217", issue_date: "2026-09-12", subtotal: 2000000, iva: 380000, retefuente: 50000, reteiva: 0, reteica: 0 },
      // Proveedor al que nunca se le retiene (p. ej. autorretenedor), con bases grandes.
      { id: "b1", provider_nit: "811000002", issue_date: "2026-09-01", subtotal: 5000000, iva: 950000, retefuente: 0, reteiva: 0, reteica: 0 },
    ],
    lineas: [],
    asientos: [{ invoice_id: "a1", account_code: "23654001", debit: 0, credit: 50000 }],
    historico: [],
  });
  const config2 = () => ({ ...config(TABLA_2026), taxes: TAXES2 as never, precedentes: precedentes2 });

  it("usa el impuesto que el historial le aplica al proveedor (la retención queda con cuenta)", async () => {
    const acc = await computeDraftAccounting({
      companyId: "c1",
      config: config2() as never,
      header: { ...header, retefuente: 42702.91 } as never,
      extracted: lineas as never,
    });
    const det = acc.retenciones.detalle.find((d) => (d as { kind: string }).kind === "retefuente") as { account_code: string; amount: number };
    expect(det).toMatchObject({ account_code: "23654001", amount: 42702.91 });
    expect(acc.unresolvedAccounts.some((u) => u.includes("ninguna tarifa configurada coincide"))).toBe(false);
  });

  it("si nunca se le ha retenido (bases iguales o mayores), el valor del documento es informativo y no se registra", async () => {
    const acc = await computeDraftAccounting({
      companyId: "c1",
      config: config2() as never,
      header: { ...header, provider_nit: "811000002", provider_name: "AUTORRETENEDOR S.A.S.", retefuente: 42702.91 } as never,
      extracted: lineas as never,
    });
    expect(acc.retenciones.retefuente).toBe(0);
    expect(acc.alertas.some((a) => a.includes("nunca se le ha retenido"))).toBe(true);
    // Sin retención, la cuenta por pagar es el total del documento.
    expect(acc.journal.find((j) => j.account_code === "22050501")?.credit).toBe(1190000);
  });
});
