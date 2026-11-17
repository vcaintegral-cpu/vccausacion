// PLANTILLA RESERVADA PARA EMPRESAS NUEVAS (no está registrada).
//
// Una empresa nueva funciona desde el primer día solo con el núcleo global: no
// necesita perfil. Se crea su perfil únicamente cuando recibe una instrucción
// que aplica solo a ella:
//   1. Copiar esta carpeta a src/empresas/<nombre-corto>/.
//   2. Llenar nombre, NIT (sin DV) y DV; renombrar la constante.
//   3. Agregarla a PERFILES en src/empresas/registro.ts.
//   4. Correr las pruebas (src/empresas/registro.test.ts valida NIT, DV y duplicados).
import type { PerfilEmpresa } from "@/empresas/tipos";

export const PLANTILLA: PerfilEmpresa = {
  nombre: "NOMBRE LEGAL DE LA EMPRESA",
  nit: "000000000",
  dv: "0",
  carpeta: "_plantilla",
  modulos: {},
  funciones: {},
  notas: [],
};

// PREGUNTAS AL CREAR UN PERFIL (instrucción del 2026-11-16):
//  - ¿La empresa usa impuesto al consumo (impoconsumo)? Si NO lo usa, encender las funciones
//    «impoconsumo_al_gasto» y «cargos_en_items» (el INC leído se suma a los ítems y su casilla queda vacía).
//  - El recargo global y el descuento global NO necesitan función: en todas las empresas se reparten en los ítems.
