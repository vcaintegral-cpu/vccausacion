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
  // Instrucción del 2026-11-18: el piloto automático está disponible para todas las empresas; cada una lo activa
  // (y elige su mes de trabajo) en su propia configuración; el envío a Siigo empieza apagado (modo prueba).
  piloto: true,
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
  impuestos_excel_siigo: {
    descripcion:
      "Impuestos desde el reporte en Excel de Siigo: conserva exactas las cuatro cuentas de cada impuesto (ventas, compras, devolución en ventas y en compras), las valida contra el catálogo de cuentas antes de guardar y la sincronización con Siigo deja de deducir cuentas",
    porDefecto: false,
    agregada: "2026-11-14",
  },
  historial_solo_movimientos: {
    descripcion:
      "Historial contable: al importar el auxiliar de Siigo solo se guardan los movimientos reales (con comprobante, fecha y cuenta); los títulos de tercero y los saldos iniciales sin movimiento se descartan e informan, para que no se muestren ni sumen como movimientos",
    porDefecto: false,
    agregada: "2026-11-15",
  },
  historial_confianza_concepto: {
    descripcion:
      "Causación con historial del proveedor: la cuenta se marca con confianza ALTA solo si el concepto del renglón coincide con compras anteriores; si solo es la cuenta dominante del proveedor se marca MEDIA y se pide validar, indicando cuántas veces se usó",
    porDefecto: false,
    agregada: "2026-11-15",
  },
  iva_de_costo_historial: {
    descripcion:
      "El histórico de compras reconoce como IVA los débitos a las cuentas de IVA de compras de la empresa que no son 2408 (p. ej. «IVA de costo» 621008), para aprender el IVA real del proveedor y no tratarlo como un gasto del renglón",
    porDefecto: false,
    agregada: "2026-11-15",
  },
  producto_del_historial: {
    descripcion:
      "Causación con historial del proveedor: si el proveedor suele causar la cuenta con el nombre de un producto del catálogo (en Siigo la descripción del renglón es el producto), el renglón se propone con ese producto, en confianza media para validar, conservando la descripción original en el motivo",
    porDefecto: false,
    agregada: "2026-11-15",
  },
  historial_api_siigo: {
    descripcion:
      "Historial contable desde la API de Siigo: muestra qué datos entrega la API de compras de la empresa (renglones, cuentas, impuestos, centro de costo) para construir la sincronización del histórico sin subir el Excel cada vez",
    porDefecto: false,
    agregada: "2026-11-15",
  },
  causar_con_motor_masivo: {
    descripcion:
      "Causar factura con un solo PDF usa el mismo motor de la carga masiva (histórico del proveedor, producto del historial, confianza e IVA por precedente) en lugar de la búsqueda de IVA por tarifa del motor individual",
    porDefecto: false,
    agregada: "2026-11-15",
  },
  cuenta_gasto_en_borradores: {
    descripcion:
      "Borradores: permite elegir la cuenta de gasto/costo de los renglones pendientes de cuenta de una factura y aplicarla a varias facturas seleccionadas de una vez; la cuenta queda como decisión manual que el recálculo no reemplaza",
    porDefecto: false,
    agregada: "2026-11-15",
  },
  drive_por_meses: {
    descripcion:
      "Carpetas de Drive por meses (año → mes → «facturas», «extractos» y el Excel de pagos del mes): EGRESOS no entra a «facturas», todo lo de «extractos» es extracto bancario y el Excel con el nombre del mes (aunque no traiga el año) es la relación de pagos",
    porDefecto: false,
    agregada: "2026-11-16",
  },
  facturas_xml: {
    descripcion:
      "Las facturas de compra de Drive se leen primero desde su XML (DIAN UBL, sin IA: valores, impuestos y retenciones exactos) y el PDF queda solo como respaldo cuando la carpeta no trae el XML; el Excel RECIBIDOS reconoce lo ya causado por su CUFE",
    porDefecto: false,
    agregada: "2026-11-17",
  },
  piloto_automatico: {
    descripcion:
      "Piloto automático nocturno: desde la hora de inicio revisa la carpeta de Drive, causa y envía a Siigo lo que está en verde, sigue con egresos y conciliación, guarda la memoria del día, pregunta por correo lo que no puede decidir solo y envía el reporte al terminar",
    porDefecto: true,
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
      "El impuesto al consumo (INC) también se reparte en los ítems en proporción a su valor y su casilla queda en 0 (la empresa no usa impoconsumo). El recargo global y el descuento global se reparten SIEMPRE en los ítems, en todas las empresas, y sus casillas quedan en 0 (subtotal = suma de los ítems), al crear y al recalcular el borrador",
    porDefecto: false,
    agregada: "2026-11-11",
  },
} satisfies Record<string, DefinicionFuncion>;

export type FuncionId = keyof typeof FUNCIONES;
