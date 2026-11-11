import { describe, expect, it } from "vitest";

import { nitDV } from "@/lib/purchase-excel";
import { PLANTILLA } from "@/empresas/_plantilla/perfil";
import { MODULOS_POR_DEFECTO } from "@/empresas/global";
import {
  PERFILES,
  diferenciasConGlobal,
  digitoVerificacion,
  funcionActiva,
  moduloActivo,
  perfilDeEmpresa,
  validarRegistro,
} from "@/empresas/registro";
import { MODULOS, type PerfilEmpresa } from "@/empresas/tipos";

describe("registro de empresas", () => {
  it("el registro actual no tiene errores (NIT, DV, duplicados, claves)", () => {
    expect(validarRegistro()).toEqual([]);
  });

  it("registra LED LIGHTS y BALLET con su DV DIAN", () => {
    expect(PERFILES.map((p) => [p.nombre, `${p.nit}-${p.dv}`])).toEqual([
      ["LED LIGHTS S.A.S.", "900470166-4"],
      ["CORPORACIÓN BALLET FOLCLÓRICO DE ANTIOQUIA", "800212838-7"],
    ]);
  });

  it("el DV coincide con el cálculo que ya usa la app", () => {
    for (const nit of ["900470166", "800212838", "901426172", "8277422"]) {
      expect(digitoVerificacion(nit)).toBe(nitDV(nit));
    }
  });

  it("reconoce el NIT en cualquier formato guardado en la app", () => {
    for (const nit of [
      "900470166",
      "900.470.166-4",
      "900470166-4",
      "9004701664",
      " 900.470.166 - 4 ",
    ]) {
      expect(perfilDeEmpresa(nit)?.carpeta).toBe("led-lights");
    }
    expect(perfilDeEmpresa("800212838")?.carpeta).toBe("ballet");
    // NIT que solo comparte el inicio, o vacío: no hay perfil (usa el núcleo global).
    expect(perfilDeEmpresa("9004701665")).toBeNull();
    expect(perfilDeEmpresa("900123456")).toBeNull();
    expect(perfilDeEmpresa(null)).toBeNull();
  });
});

describe("alcance global vs. empresa", () => {
  it("solo LED LIGHTS se aparta del núcleo global: impoconsumo al gasto y productos de inventario", () => {
    for (const p of PERFILES) {
      const dif = diferenciasConGlobal(p).map((d) => [d.tipo, d.clave, d.empresa]);
      expect(dif).toEqual(
        p.nit === "900470166"
          ? [
              ["función", "impoconsumo_al_gasto", true],
              ["función", "productos_inventario", true],
              ["función", "cargos_en_items", true],
              ["función", "iva_solo_descontable", true],
              ["función", "lector_consolidado_pagos", true],
              ["función", "compras_por_pagar", true],
            ]
          : [],
      );
    }
    for (const modulo of Object.keys(MODULOS) as Array<keyof typeof MODULOS>) {
      expect(moduloActivo("900470166", modulo)).toBe(MODULOS_POR_DEFECTO[modulo]);
      expect(moduloActivo("999999999", modulo)).toBe(true);
    }
  });

  it("una función inexistente nunca se enciende", () => {
    expect(funcionActiva("900470166", "no_existe" as never)).toBe(false);
  });

  it("detecta errores al registrar una empresa", () => {
    const mala: PerfilEmpresa = {
      ...PLANTILLA,
      nombre: "MALA",
      nit: "900470166",
      dv: "1",
      carpeta: "mala",
    };
    const errores = validarRegistro([...PERFILES, mala, { ...PLANTILLA }]);
    expect(errores).toEqual(
      expect.arrayContaining([
        "MALA: el DV de 900470166 es 4, no 1.",
        "NIT 900470166 repetido en LED LIGHTS S.A.S. y MALA.",
        "NOMBRE LEGAL DE LA EMPRESA: la plantilla no se registra; copia la carpeta.",
      ]),
    );
  });

  it("no permite apagar Administración ni Empresas, ni usar claves que no existen", () => {
    const p: PerfilEmpresa = {
      ...PLANTILLA,
      nombre: "X",
      nit: "901426172",
      dv: "6",
      carpeta: "x",
      modulos: { empresas: false, inventado: true } as never,
      funciones: { inventada: true },
    };
    expect(validarRegistro([p])).toEqual([
      'X: el módulo "empresas" no se puede apagar.',
      'X: el módulo "inventado" no existe.',
      'X: la función "inventada" no está definida en global.ts.',
    ]);
  });
});
