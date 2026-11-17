import { describe, expect, it } from "vitest";
import {
  aprenderPerfilesDesde,
  diferenciasConPrecedente,
  type PerfilHistorico,
} from "./auxiliar-historico";

const uso = (cuenta: string, veces = 3) => ({ cuenta, nombre: "", veces, valor: 0, ultima: null });
const perfil = (p: Partial<PerfilHistorico> = {}): PerfilHistorico => ({
  nit: "900111222",
  nombre: "PROVEEDOR PRUEBA",
  compras: 4,
  ultima: "2026-10-30",
  gastos: [],
  centros: [],
  iva: [{ ...uso("24081501"), tarifa: 19 }],
  retenciones: { retefuente: [], reteiva: [], reteica: [] },
  sinRetencion: {
    retefuente: { veces: 4, baseMax: 1_000_000 },
    reteiva: { veces: 4, baseMax: 0 },
    reteica: { veces: 4, baseMax: 0 },
  },
  cuentasPorPagar: [],
  descuentos: [],
  impoconsumo: [],
  ...p,
});
const sinRet = { retefuente: false, reteiva: false, reteica: false };
const base = { retefuente: 500_000, reteiva: 95_000, reteica: 500_000 };

describe("diferenciasConPrecedente", () => {
  it("coincide cuando el IVA y las retenciones son las del precedente", () => {
    expect(
      diferenciasConPrecedente(perfil(), {
        cuentasIva: ["24081501"],
        hayIva: true,
        retenciones: sinRet,
        baseRetencion: base,
      }),
    ).toEqual([]);
  });

  it("avisa cuando la cuenta de IVA es otra o falta el impuesto elegido", () => {
    const p = perfil();
    const e = { retenciones: sinRet, baseRetencion: base, hayIva: true };
    expect(diferenciasConPrecedente(p, { ...e, cuentasIva: ["24082501"] })).toHaveLength(1);
    expect(diferenciasConPrecedente(p, { ...e, cuentasIva: [null] })).toHaveLength(1);
  });

  it("avisa cuando el proveedor sí cobraba IVA y el borrador no lo trae, o al revés", () => {
    expect(
      diferenciasConPrecedente(perfil(), {
        cuentasIva: [],
        hayIva: false,
        retenciones: sinRet,
        baseRetencion: base,
      }),
    ).toHaveLength(1);
    expect(
      diferenciasConPrecedente(perfil({ iva: [] }), {
        cuentasIva: ["24081501"],
        hayIva: true,
        retenciones: sinRet,
        baseRetencion: base,
      }),
    ).toHaveLength(1);
  });

  it("exige la retención si al proveedor se la practicaban, salvo bases menores a las no retenidas", () => {
    const conRet = perfil({
      retenciones: {
        retefuente: [
          { ...uso("23654001"), tarifa: 2.5, concepto: "compras", baseMin: 1, baseMax: 2 },
        ],
        reteiva: [],
        reteica: [],
      },
      sinRetencion: {
        retefuente: { veces: 1, baseMax: 300_000 },
        reteiva: { veces: 4, baseMax: 0 },
        reteica: { veces: 4, baseMax: 0 },
      },
    });
    const e = { cuentasIva: ["24081501"], hayIva: true };
    // Base alta sin retención en el borrador: difiere.
    expect(
      diferenciasConPrecedente(conRet, { ...e, retenciones: sinRet, baseRetencion: base }),
    ).toHaveLength(1);
    // Base menor a las históricamente sin retención: coincide.
    expect(
      diferenciasConPrecedente(conRet, {
        ...e,
        retenciones: sinRet,
        baseRetencion: { ...base, retefuente: 200_000 },
      }),
    ).toEqual([]);
    // El borrador lleva la retención y el proveedor la tenía: coincide.
    expect(
      diferenciasConPrecedente(conRet, {
        ...e,
        retenciones: { ...sinRet, retefuente: true },
        baseRetencion: base,
      }),
    ).toEqual([]);
    // Lleva retención que el proveedor nunca tuvo: difiere.
    expect(
      diferenciasConPrecedente(perfil(), {
        ...e,
        retenciones: { ...sinRet, retefuente: true },
        baseRetencion: base,
      }),
    ).toHaveLength(1);
  });
});

describe("aprenderPerfilesDesde", () => {
  it("solo cuenta las compras desde la fecha", () => {
    const compra = (fecha: string, cuenta: string) =>
      ({
        comprobante: `FC-1-${fecha}`,
        tipo: "FC",
        fecha,
        nit: "900111222",
        nombre: "PROVEEDOR PRUEBA",
        gastos: [{ cuenta, nombre: "", valor: 1000, descripcion: "x" }],
        iva: [],
        retenciones: { retefuente: [], reteiva: [], reteica: [] },
        impoconsumo: [],
        descuentos: [],
        cuentasPorPagar: [],
        centro: null,
        total: 1000,
      }) as never;
    const m = aprenderPerfilesDesde(
      [
        compra("2025-12-01", "51950101"),
        compra("2026-05-02", "51952501"),
        compra("2026-06-03", "51952501"),
      ],
      "2026-04-01",
    );
    const p = m.get("900111222");
    expect(p?.compras).toBe(2);
    expect(p?.gastos[0]?.cuenta).toBe("51952501");
  });
});
