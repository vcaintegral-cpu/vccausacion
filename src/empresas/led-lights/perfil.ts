// PERFIL ESPECÍFICO: LED LIGHTS S.A.S.
// Solo lo que diferencia a esta empresa del núcleo global (src/empresas/global.ts).
// Sus datos (PUC, terceros, reglas por proveedor, IVA, retenciones, Siigo) viven
// en la base de datos aislados por empresa; no se copian aquí.
import type { PerfilEmpresa } from "@/empresas/tipos";

export const LED_LIGHTS: PerfilEmpresa = {
  nombre: "LED LIGHTS S.A.S.",
  nit: "900470166",
  dv: "4",
  carpeta: "led-lights",
  modulos: {},
  funciones: {
    // Instrucción del 2026-11-10: LED LIGHTS no usa ni causa el impoconsumo; su valor
    // se suma a la cuenta de gasto o costo relacionada con la compra.
    impoconsumo_al_gasto: true,
    // Instrucción del 2026-11-11: proveedores de inventario (precedente en la 14) y
    // descripciones que coinciden con el catálogo pasan a «producto» con su producto y
    // cuenta 14 (1435 mercancías, 1498 p. ej. pintura electrostática); si no existe, se
    // crea el producto en Siigo al causar.
    productos_inventario: true,
    // Instrucción del 2026-11-11: INC, recargo global y descuento global se suman o restan
    // en el valor de los ítems facturados (proporcional a su valor), sin corrección manual.
    cargos_en_items: true,
    // Instrucción del 2026-11-11: el IVA de las compras va al descontable 2408; la cuenta
    // 621008 (IVA del costo) casi no se usa y no debe elegirse sola.
    iva_solo_descontable: true,
    // Instrucción del 2026-11-11: los pagos del mes vienen en el Excel «<MES> <AÑO>» de la
    // carpeta del mes en Drive (hojas por banco y efectivo, y «Consolidado» con la columna
    // de observaciones que indica cómo hacer cada recibo de pago).
    lector_consolidado_pagos: true,
    // Instrucción del 2026-11-11: todas las compras quedan por pagar (CxP 22050501); ninguna
    // se envía a Siigo pagada. Los pagos se hacen con el RP desde «Egresos y pagos».
    compras_por_pagar: true,
    // Instrucción del 2026-11-12: los clientes también pagan por Bold (abona a Davivienda) y
    // Wompi (abona a la Corriente); el RC va por el valor completo, la plataforma consigna el
    // neto y factura sus comisiones, que se cruzan con lo descontado (hojas Bold y Wompi).
    pasarelas_pago: true,
    // Instrucción del 2026-11-12: las conciliaciones se descargan en el formato de la firma
    // (archivos de octubre 2026): un Excel por cuenta con «Reporte Conciliación» y la hoja
    // de trabajo «CONCILIACION <MES>» (columnas D y E).
    reporte_conciliacion_firma: true,
  },
  notas: [
    "Software contable: Siigo (comprobantes CE-1, RC-1, FC-1).",
    "Soportes en Google Drive: <raíz>/<año>/<N. MES>/FACTURAS/<PROVEEDOR>/, compartida con vcaintegral@gmail.com.",
    "El nombre del PDF trae el pago: 'Corriente16 - …', 'Efectivo08 - …'.",
    "Impoconsumo (INC): no se causa aparte; se suma a la cuenta de gasto o costo de la compra.",
    "Compras de inventario: renglón tipo producto con el producto del catálogo y cuenta 14 (1435 / 1498); productos nuevos se crean en Siigo al causar.",
    "INC, recargo y descuento global del documento se reparten en el valor de los ítems (proporcional); subtotal = suma de los ítems.",
    "Compras: siempre POR PAGAR en Siigo (forma de pago a crédito → CxP 22050501), nunca pagadas con tarjeta, efectivo o banco; el pago va con el RP.",
    "Pasarelas: Bold (abona a Davivienda) y Wompi (abona a la Corriente). RC por el valor completo del cliente; la plataforma consigna el neto; sus facturas de comisiones se cruzan con lo descontado (RP mensual por plataforma).",
    "Egresos: Excel mensual «<MES> <AÑO>» en la carpeta del mes (hoja Consolidado: CUENTA, RELACIÓN, APLICACIÓN, OBSERVACIONES); los recibos de pago (RP) se proponen desde ahí.",
    "IVA de compras: siempre descontable 2408 (compras, servicios, gastos, importación); 621008 solo si se elige a mano.",
  ],
};
