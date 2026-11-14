import { describe, expect, it } from "vitest";

import {
  compararImportacion,
  leerCeldaCuenta,
  leerImpuestosSiigo,
  registrosParaGuardar,
  validarImpuestos,
} from "./impuestos-siigo-excel";

const ENC = [
  "En uso",
  "Código",
  "Nombre",
  "Tipo de impuesto",
  "Por valor",
  "Tarifa",
  "Ventas",
  "Compras",
  "Devolución ventas",
  "Devolución compras",
];
const matriz = (filas: unknown[][]) => [["Impuestos"], ["Autoretenciones"], ENC, ...filas];
const fila = (
  cod: number,
  nombre: string,
  tipo: string,
  tarifa: number,
  v: string,
  c: string,
  dv: string,
  dc: string,
) => [null, cod, nombre, tipo, null, tarifa, v, c, dv, dc];
const BASE = [
  fila(
    1,
    "IVA 19% Pleno",
    "IVA",
    19,
    "24080601 - IVA generado 19%",
    "24081001 - IVA descontable 19%",
    "24082001 - Dev ventas 19%",
    "24081002 - Dev compras 19%",
  ),
  fila(
    17,
    "Impoconsumo por valor",
    "Impoconsumo",
    0,
    "246401 - En ventas",
    "246403 - En compras",
    "246402 - Dev ventas",
    "246404 - Dev compras",
  ),
];
const cat = (codes: string[]) =>
  codes.map((code) => ({ code, name: "", is_movement: true, has_children: false, active: true }));

describe("impuestos del Excel de Siigo", () => {
  it("conserva los códigos de 6 y 8 dígitos exactos y cada cuenta en su función", () => {
    const l = leerImpuestosSiigo(matriz(BASE));
    expect(l.filaEncabezado).toBe(3);
    const [iva, inc] = l.impuestos;
    expect(iva!.cuentas.ventas!.codigo).toBe("24080601");
    expect(iva!.cuentas.compras!.codigo).toBe("24081001");
    expect(iva!.cuentas.devolucion_ventas!.codigo).toBe("24082001");
    expect(iva!.cuentas.devolucion_compras!.codigo).toBe("24081002");
    expect(inc!.cuentas.ventas!.codigo).toBe("246401");
    expect(inc!.cuentas.devolucion_compras!.codigo).toBe("246404");
  });

  it("no pierde dígitos ni ceros aunque la celda sea numérica o traiga espacio duro", () => {
    expect(leerCeldaCuenta(24080601)).toMatchObject({ codigo: "24080601" });
    expect(leerCeldaCuenta("0123 - X")).toMatchObject({ codigo: "0123", nombre: "X" });
    expect("error" in (leerCeldaCuenta("IVA 24080601") as object)).toBe(true);
  });

  it("falla si faltan encabezados en vez de adivinar columnas", () => {
    expect(() =>
      leerImpuestosSiigo([
        ["Código", "Nombre"],
        [1, "x"],
      ]),
    ).toThrow(/encabezados/);
  });

  it("valida contra el catálogo: no existe, incompleta, sin movimiento", () => {
    const l = leerImpuestosSiigo(matriz(BASE));
    const todas = [
      "24080601",
      "24081001",
      "24082001",
      "24081002",
      "246401",
      "246403",
      "246402",
      "246404",
    ];
    expect(validarImpuestos(l.impuestos, cat(todas)).filter((h) => h.nivel === "error")).toEqual(
      [],
    );
    const sin = validarImpuestos(l.impuestos, cat(todas.filter((c) => c !== "24081001")));
    expect(sin.find((h) => h.tipo === "cuenta_no_existe")?.cuenta).toBe("24081001");
    const incompleta = validarImpuestos(
      l.impuestos,
      cat([...todas.filter((c) => c !== "246401"), "24640101"]),
    );
    expect(incompleta.find((h) => h.cuenta === "246401")?.tipo).toBe("cuenta_incompleta");
    const padre = validarImpuestos(l.impuestos, [
      ...cat(todas.filter((c) => c !== "246403")),
      { code: "246403", name: "", has_children: true },
    ]);
    expect(padre.find((h) => h.cuenta === "246403")?.tipo).toBe("cuenta_incompleta");
  });

  it("reporta, sin corregir, ventas igual a compras y tarifas inconsistentes", () => {
    const l = leerImpuestosSiigo(
      matriz([
        fila(
          5,
          "IVA 5%",
          "IVA",
          5,
          "24080602 - IVA 19%",
          "24080602 - IVA 19%",
          "24082002 - Dev",
          "24081004 - Dev",
        ),
      ]),
    );
    const h = validarImpuestos(l.impuestos, cat(["24080602", "24082002", "24081004"]));
    expect(h.some((x) => x.tipo === "ventas_compras_iguales")).toBe(true);
    expect(h.some((x) => x.tipo === "tarifa_inconsistente")).toBe(true);
    expect(l.impuestos[0]!.cuentas.ventas!.codigo).toBe("24080602");
  });

  it("la comparación detecta una cuenta guardada distinta del archivo", () => {
    const l = leerImpuestosSiigo(matriz(BASE));
    const regs = registrosParaGuardar("e", l.impuestos);
    expect(regs[0]).toMatchObject({
      account_code: "24081001",
      account_sales: "24080601",
      account_sales_return: "24082001",
      account_purchase_return: "24081002",
      excel_code: "1",
      source: "excel_siigo",
    });
    const ok = compararImportacion(
      l.impuestos,
      regs as unknown as Array<Record<string, unknown>>,
      [],
    );
    expect(ok.every((c) => c.coincide)).toBe(true);
    const mal = regs.map((r, i) => (i === 0 ? { ...r, account_sales: "2408060" } : r));
    const c = compararImportacion(
      l.impuestos,
      mal as unknown as Array<Record<string, unknown>>,
      [],
    );
    expect(c.filter((x) => !x.coincide)).toHaveLength(1);
  });
});
