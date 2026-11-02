import { describe, expect, it } from "vitest";

import {
  baseMinimaDe,
  condicionDePerfil,
  construirPrecedentes,
  decidirRetenciones,
  elegirIva,
  impuestoDeCuenta,
  nitBase,
  perfilConCondicion,
  precedenteDe,
  type ImpuestoConfigurado,
  type TablaBases,
} from "./precedente-tributario";

// Catálogo típico sincronizado de Siigo: dos IVA del 19 % y varias retenciones.
const TAXES: ImpuestoConfigurado[] = [
  { id: "iva19b", kind: "iva", name: "IVA 19% compras bienes", rate: 19, account_code: "24081001" },
  { id: "iva19s", kind: "iva", name: "IVA 19% servicios", rate: 19, account_code: "24081002" },
  { id: "iva5", kind: "iva", name: "IVA 5%", rate: 5, account_code: "24081005" },
  {
    id: "rfComp",
    kind: "retefuente",
    name: "Retención compras 2,5%",
    rate: 2.5,
    account_code: "23654001",
    retention_concept: "compras",
  },
  {
    id: "rfServ",
    kind: "retefuente",
    name: "Retención servicios 4%",
    rate: 4,
    account_code: "23652501",
    retention_concept: "servicios",
  },
  {
    id: "rfHon",
    kind: "retefuente",
    name: "Honorarios 11%",
    rate: 11,
    account_code: "23651501",
    min_base: 0,
  },
  { id: "riva", kind: "reteiva", name: "ReteIVA 15%", rate: 15, account_code: "23670101" },
  { id: "rica", kind: "reteica", name: "ReteICA 0,966%", rate: 0.966, account_code: "23680101" },
];

// Valores de prueba (no son la tabla oficial): solo verifican el cálculo.
const TABLAS: TablaBases[] = [
  {
    year: 2026,
    uvt: 50000,
    concepts: [
      { id: "compras", concepto: "Compras generales", base_uvt: 10 },
      { id: "servicios", concepto: "Servicios generales", base_uvt: 2 },
    ],
  },
];

function precedentes() {
  return construirPrecedentes({
    taxes: TAXES,
    facturas: [
      // MEGA LUCES: compras con IVA de bienes y retención en la fuente de compras.
      {
        id: "a1",
        provider_nit: "900.047.217-1",
        issue_date: "2026-08-10",
        subtotal: 1000000,
        iva: 190000,
        retefuente: 25000,
        reteiva: 0,
        reteica: 9660,
      },
      {
        id: "a2",
        provider_nit: "900047217",
        issue_date: "2026-09-12",
        subtotal: 2000000,
        iva: 380000,
        retefuente: 50000,
        reteiva: 0,
        reteica: 0,
      },
      // TELEVIGIA: servicios con IVA de servicios, nunca retenido (3 documentos).
      {
        id: "b1",
        provider_nit: "811000001",
        issue_date: "2026-07-01",
        subtotal: 100000,
        iva: 19000,
        retefuente: 0,
        reteiva: 0,
        reteica: 0,
      },
      {
        id: "b2",
        provider_nit: "811000001",
        issue_date: "2026-08-01",
        subtotal: 100000,
        iva: 19000,
        retefuente: 0,
        reteiva: 0,
        reteica: 0,
      },
      {
        id: "b3",
        provider_nit: "811000001",
        issue_date: "2026-09-01",
        subtotal: 100000,
        iva: 19000,
        retefuente: 0,
        reteiva: 0,
        reteica: 0,
      },
      // Documento sin NIT: se ignora.
      {
        id: "x",
        provider_nit: null,
        issue_date: null,
        subtotal: 1,
        iva: 0,
        retefuente: 0,
        reteiva: 0,
        reteica: 0,
      },
    ],
    lineas: [
      { invoice_id: "a1", iva: 190000, iva_tax_id: "iva19b" },
      { invoice_id: "a2", iva: 200000, iva_tax_id: "iva19b" },
      { invoice_id: "a2", iva: 180000, iva_tax_id: "iva19b" },
      { invoice_id: "b1", iva: 19000, iva_tax_id: "iva19s" },
      { invoice_id: "b2", iva: 19000, iva_tax_id: "iva19s" },
      // b3 es antiguo: sin impuesto por renglón, se toma la cuenta 2408 del asiento.
    ],
    asientos: [
      { invoice_id: "a1", account_code: "23654001", debit: 0, credit: 25000 },
      { invoice_id: "a1", account_code: "23680101", debit: 0, credit: 9660 },
      { invoice_id: "a2", account_code: "23654001", debit: 0, credit: 50000 },
      { invoice_id: "b3", account_code: "24081002", debit: 19000, credit: 0 },
    ],
    historico: [
      // Auxiliar de Siigo: a un arrendador se le retuvo con una cuenta sin impuesto configurado.
      {
        provider_nit: "70100200",
        account_code: "23653001",
        debit: 0,
        credit: 35000,
        period: "2026-06",
      },
      {
        provider_nit: "70100200",
        account_code: "11100501",
        debit: 0,
        credit: 1000000,
        period: "2026-06",
      },
    ],
  });
}

describe("construirPrecedentes", () => {
  it("aprende el IVA exacto y las retenciones de cada proveedor", () => {
    const p = precedentes();
    const mega = precedenteDe(p, "900047217-1")!;
    expect(mega.documentosSiigo).toBe(2);
    expect(mega.iva).toEqual([
      { taxId: "iva19b", cuenta: "24081001", tarifa: 19, veces: 2, ultima: "2026-09-12" },
    ]);
    expect(mega.retenciones.retefuente).toEqual([
      { taxId: "rfComp", cuenta: "23654001", tarifa: 2.5, veces: 2, ultima: "2026-09-12" },
    ]);
    expect(mega.retenciones.reteica[0]).toMatchObject({ taxId: "rica", veces: 1 });
    expect(mega.sinRetencion).toEqual({ retefuente: 0, reteiva: 2, reteica: 1 });

    const tele = precedenteDe(p, "811000001")!;
    expect(tele.iva[0]).toMatchObject({ taxId: "iva19s", veces: 3 });
    expect(tele.retenciones.retefuente).toEqual([]);
    expect(tele.sinRetencion.retefuente).toBe(3);
  });

  it("usa el auxiliar histórico como evidencia sin inventar tarifas", () => {
    const arrendador = precedenteDe(precedentes(), "70100200")!;
    expect(arrendador.documentosSiigo).toBe(0);
    expect(arrendador.movimientosHistoricos).toBe(1);
    expect(arrendador.retenciones.retefuente).toEqual([
      { taxId: null, cuenta: "23653001", tarifa: null, veces: 1, ultima: "2026-06" },
    ]);
  });

  it("identifica el impuesto por cuenta y, si hay varios, por la tarifa observada", () => {
    const dos = [
      ...TAXES,
      {
        id: "rfComp35",
        kind: "retefuente",
        name: "Compras 3,5%",
        rate: 3.5,
        account_code: "23654001",
      },
    ];
    expect(impuestoDeCuenta(dos, "retefuente", "23654001", 2.5)?.id).toBe("rfComp");
    expect(impuestoDeCuenta(dos, "retefuente", "23654001", 3.5)?.id).toBe("rfComp35");
    expect(impuestoDeCuenta(dos, "retefuente", "23654001", null)).toBeNull();
    expect(impuestoDeCuenta(TAXES, "retefuente", "23659999", 1)).toBeNull();
  });

  it("normaliza el NIT", () => {
    expect(nitBase("900.470.166-4")).toBe("900470166");
    expect(nitBase("900470166")).toBe("900470166");
    expect(nitBase(null)).toBe("");
  });
});

describe("elegirIva", () => {
  const p = precedentes();
  it("con un solo IVA de la tarifa lo toma sin precedente", () => {
    expect(
      elegirIva({ taxes: TAXES, linea: { iva: 5000, iva_rate: 5, base: 100000 }, precedente: null })
        .tax?.id,
    ).toBe("iva5");
  });
  it("con varios IVA del 19% elige el que se le usa al proveedor", () => {
    const linea = { iva: 19000, iva_rate: 19, base: 100000 };
    expect(
      elegirIva({ taxes: TAXES, linea, precedente: precedenteDe(p, "900047217") }).tax?.id,
    ).toBe("iva19b");
    expect(
      elegirIva({ taxes: TAXES, linea, precedente: precedenteDe(p, "811000001") }).tax?.id,
    ).toBe("iva19s");
    const nuevo = elegirIva({ taxes: TAXES, linea, precedente: null });
    expect(nuevo.tax).toBeNull();
    expect(nuevo.motivo).toContain("Hay 2 IVA del 19%");
  });
  it("sin tarifa en el documento solo usa el precedente si cuadra al peso", () => {
    const pre = precedenteDe(p, "900047217");
    expect(
      elegirIva({
        taxes: TAXES,
        linea: { iva: 19000, iva_rate: null, base: 100000 },
        precedente: pre,
      }).tax?.id,
    ).toBe("iva19b");
    expect(
      elegirIva({
        taxes: TAXES,
        linea: { iva: 5000, iva_rate: null, base: 100000 },
        precedente: pre,
      }).tax,
    ).toBeNull();
    expect(
      elegirIva({
        taxes: TAXES,
        linea: { iva: 19000, iva_rate: null, base: 100000 },
        precedente: null,
      }).tax,
    ).toBeNull();
  });
  it("renglón sin IVA no elige nada", () => {
    expect(
      elegirIva({ taxes: TAXES, linea: { iva: 0, iva_rate: 19, base: 1 }, precedente: null }).tax,
    ).toBeNull();
  });
});

describe("baseMinimaDe", () => {
  it("concepto × UVT del año de la factura; si no, la base fija del registro", () => {
    expect(baseMinimaDe(TAXES[3]!, "2026-10-15", TABLAS)).toEqual({
      valor: 500000,
      origen: "Compras generales: 10 UVT × $50.000 (2026)",
    });
    expect(baseMinimaDe(TAXES[3]!, "2025-10-15", TABLAS)).toBeNull();
    expect(baseMinimaDe({ ...TAXES[5]!, min_base: 1234567 }, "2026-10-01", TABLAS)?.valor).toBe(
      1234567,
    );
    expect(baseMinimaDe(TAXES[5]!, "2026-10-01", TABLAS)).toBeNull();
  });
});

describe("decidirRetenciones", () => {
  const p = precedentes();
  const base = {
    taxes: TAXES,
    ivaTotal: 0,
    fecha: "2026-10-20",
    tablas: TABLAS,
    kinds: ["retefuente", "reteiva", "reteica"] as const,
  };

  it("aplica la retención histórica si la base alcanza la mínima", () => {
    const d = decidirRetenciones({
      ...base,
      kinds: [...base.kinds],
      precedente: precedenteDe(p, "900047217"),
      condicion: null,
      baseGravable: 800000,
    });
    expect(d.confirmar).toBeNull();
    expect(d.aplicar.map((a) => [a.kind, a.tax.id, a.base, a.amount])).toEqual([
      ["retefuente", "rfComp", 800000, 20000],
      ["reteica", "rica", 800000, 7728],
    ]);
    expect(d.aplicar[0]!.origen).toBe("precedente en Siigo (2 vez/veces)");
  });

  it("no la practica si no alcanza la base mínima, y lo explica", () => {
    const d = decidirRetenciones({
      ...base,
      kinds: ["retefuente"],
      precedente: precedenteDe(p, "900047217"),
      condicion: null,
      baseGravable: 400000,
    });
    expect(d.aplicar).toEqual([]);
    expect(d.avisos[0]).toBe(
      "Retefuente (Retención compras 2,5%): no se practica porque la base $400.000 no alcanza la base mínima $500.000 (Compras generales: 10 UVT × $50.000 (2026)).",
    );
  });

  it("proveedor nunca retenido: pide confirmar su condición", () => {
    const d = decidirRetenciones({
      ...base,
      kinds: ["retefuente"],
      precedente: precedenteDe(p, "811000001"),
      condicion: null,
      baseGravable: 900000,
    });
    expect(d.aplicar).toEqual([]);
    expect(d.confirmar).toContain(
      "En 3 documento(s) sincronizados con Siigo no se le practicó retención",
    );
    const nuevo = decidirRetenciones({
      ...base,
      kinds: ["retefuente"],
      precedente: null,
      condicion: null,
      baseGravable: 900000,
    });
    expect(nuevo.confirmar).toContain("Proveedor sin precedente en Siigo");
  });

  it("respeta la condición confirmada: exento o retener siempre con un concepto", () => {
    const exento = decidirRetenciones({
      ...base,
      kinds: ["retefuente"],
      precedente: precedenteDe(p, "900047217"),
      condicion: { sinRetencion: { retefuente: { motivo: "autorretenedor" } } },
      baseGravable: 800000,
    });
    expect(exento.aplicar).toEqual([]);
    expect(exento.confirmar).toBeNull();
    expect(exento.avisos[0]).toBe(
      "Retefuente: no se practica (Autorretenedor; condición confirmada).",
    );

    const fijado = decidirRetenciones({
      ...base,
      kinds: ["retefuente"],
      precedente: precedenteDe(p, "811000001"),
      condicion: { retenerCon: { retefuente: "rfServ" } },
      baseGravable: 100000,
    });
    expect(fijado.aplicar.map((a) => [a.tax.id, a.amount, a.origen])).toEqual([
      ["rfServ", 4000, "condición confirmada del proveedor"],
    ]);
  });

  it("retención histórica sin impuesto identificado: avisa y no inventa", () => {
    const d = decidirRetenciones({
      ...base,
      kinds: ["retefuente"],
      precedente: precedenteDe(p, "70100200"),
      condicion: null,
      baseGravable: 900000,
    });
    expect(d.aplicar).toEqual([]);
    expect(d.confirmar).toBeNull();
    expect(d.avisos[0]).toContain("históricamente se le retuvo (cuenta 23653001)");
  });

  it("sin base mínima configurada aplica y lo advierte", () => {
    const d = decidirRetenciones({
      ...base,
      kinds: ["retefuente"],
      precedente: null,
      condicion: { retenerCon: { retefuente: "rfHon" } },
      baseGravable: 100000,
    });
    expect(d.aplicar[0]?.amount).toBe(11000);
    expect(d.avisos[0]).toContain("sin base mínima configurada");
  });
});

describe("condición en el perfil del proveedor", () => {
  it("se guarda junto al perfil existente y marca las banderas del Excel RECIBIDOS", () => {
    const perfil = perfilConCondicion(
      { declarant: true, concept: "Servicios" },
      {
        sinRetencion: { retefuente: { motivo: "autorretenedor" } },
        confirmadoPor: "u1",
        confirmadoEn: "2026-11-02",
      },
    );
    expect(perfil).toMatchObject({ declarant: true, concept: "Servicios", selfWithholder: true });
    expect(condicionDePerfil(perfil)?.sinRetencion?.retefuente?.motivo).toBe("autorretenedor");
    expect(perfilConCondicion(perfil, null)).not.toHaveProperty("condicion_retencion");
    expect(condicionDePerfil(null)).toBeNull();
  });
});
