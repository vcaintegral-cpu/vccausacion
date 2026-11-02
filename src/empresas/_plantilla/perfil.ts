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
