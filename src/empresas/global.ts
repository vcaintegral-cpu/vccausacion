// NÚCLEO GLOBAL: valores que aplican a TODAS las empresas, actuales y futuras.
//
// - Un cambio "para todas las empresas" se hace en el código del núcleo
//   (src/lib, src/routes, src/components) o aquí, cambiando el valor por defecto.
// - Un cambio "solo para una o algunas empresas" se agrega como función en
//   FUNCIONES con porDefecto: false y se enciende en el perfil de esas empresas
//   (o porDefecto: true y se apaga en las que no deben tenerlo).
import type { DefinicionFuncion, ModuloId } from "@/empresas/tipos";

/** Todos los módulos están encendidos para todas las empresas salvo que su perfil diga lo contrario. */
export const MODULOS_POR_DEFECTO: Record<ModuloId, boolean> = {
  panel: true,
  causar: true,
  borradores: true,
  historial: true,
  documentos_soporte: true,
  pendientes_siigo: true,
  documentos: true,
  aprendizaje: true,
  fuentes: true,
  integraciones: true,
  administracion: true,
  empresas: true,
};

/**
 * Funciones que pueden variar por empresa. Cada entrada nueva debe venir de una
 * instrucción del chat en la que se definió su alcance (todas o algunas empresas).
 *
 * Ejemplo de entrada:
 *   cruce_egresos_automatico: {
 *     descripcion: "Propone comprobantes de egreso cruzando soportes con facturas",
 *     porDefecto: false,
 *     agregada: "2026-11-02",
 *   },
 */
export const FUNCIONES = {
  impoconsumo_al_gasto: {
    descripcion:
      "El impoconsumo (INC) no se causa aparte: se suma a la cuenta de gasto o costo de la compra (también en Siigo)",
    porDefecto: false,
    agregada: "2026-11-10",
  },
  productos_inventario: {
    descripcion:
      "Renglones de compra de inventario: se emparejan con el producto del catálogo (o se crea en Siigo) y usan la cuenta 14 que corresponda (p. ej. 1435, 1498)",
    porDefecto: false,
    agregada: "2026-11-11",
  },
  cargos_en_items: {
    descripcion:
      "INC, recargo global y descuento global se reparten en los ítems en proporción a su valor (subtotal = suma de los ítems), al crear y al recalcular el borrador",
    porDefecto: false,
    agregada: "2026-11-11",
  },
} satisfies Record<string, DefinicionFuncion>;

export type FuncionId = keyof typeof FUNCIONES;
