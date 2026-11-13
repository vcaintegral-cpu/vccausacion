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
  egresos: true,
  conciliacion: true,
  // Solo empresas con la función piloto_automatico lo encienden en su perfil.
  piloto: false,
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
  iva_solo_descontable: {
    descripcion:
      "El IVA de las compras va siempre a una cuenta descontable 2408 (compras, servicios, gastos, importación); nunca al IVA del costo (621008) de forma automática",
    porDefecto: false,
    agregada: "2026-11-11",
  },
  compras_por_pagar: {
    descripcion:
      "Toda compra se envía a Siigo POR PAGAR (forma de pago a crédito, cuenta por pagar al proveedor); nunca pagada con tarjeta, efectivo, banco o contado. Los pagos se registran con los recibos de pago de «Egresos y pagos»",
    porDefecto: false,
    agregada: "2026-11-11",
  },
  lector_consolidado_pagos: {
    descripcion:
      "Lee el reporte mensual de pagos con hoja «Consolidado» (FECHA, TERCERO, VALOR, CUENTA, RELACIÓN, APLICACIÓN, OBSERVACIONES) desde la carpeta de egresos o cargado a mano, para proponer los recibos de pago",
    porDefecto: false,
    agregada: "2026-11-11",
  },
  piloto_automatico: {
    descripcion:
      "Piloto automático nocturno: desde la hora de inicio revisa la carpeta de Drive, causa y envía a Siigo lo que está en verde, sigue con egresos y conciliación, guarda la memoria del día, pregunta por correo lo que no puede decidir solo y envía el reporte al terminar",
    porDefecto: false,
    agregada: "2026-11-13",
  },
  reporte_conciliacion_firma: {
    descripcion:
      "Conciliación bancaria: descarga un Excel por cuenta en el formato de la firma («Reporte Conciliación» con resumen, movimiento del mes, partidas del extracto y de libros, resumen por tipo, gastos bancarios y firmas, y la hoja de trabajo con columnas D y E y fórmulas), que se vuelve a leer el mes siguiente",
    porDefecto: false,
    agregada: "2026-11-12",
  },
  pasarelas_pago: {
    descripcion:
      "Conciliación bancaria: lee las hojas de las pasarelas de pago (Bold, Wompi…) del reporte mensual, cruza cada cobro con su RC y con el abono neto del banco, y propone el RP mensual de comisiones y retenciones contra la factura de la plataforma",
    porDefecto: false,
    agregada: "2026-11-12",
  },
  cargos_en_items: {
    descripcion:
      "INC, recargo global y descuento global se reparten en los ítems en proporción a su valor (subtotal = suma de los ítems), al crear y al recalcular el borrador",
    porDefecto: false,
    agregada: "2026-11-11",
  },
} satisfies Record<string, DefinicionFuncion>;

export type FuncionId = keyof typeof FUNCIONES;
