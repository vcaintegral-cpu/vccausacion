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
export const FUNCIONES = {} satisfies Record<string, DefinicionFuncion>;

export type FuncionId = keyof typeof FUNCIONES;
