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
  },
  notas: [
    "Software contable: Siigo (comprobantes CE-1, RC-1, FC-1).",
    "Soportes en Google Drive: <raíz>/<año>/<N. MES>/FACTURAS/<PROVEEDOR>/, compartida con vcaintegral@gmail.com.",
    "El nombre del PDF trae el pago: 'Corriente16 - …', 'Efectivo08 - …'.",
    "Impoconsumo (INC): no se causa aparte; se suma a la cuenta de gasto o costo de la compra.",
    "Compras de inventario: renglón tipo producto con el producto del catálogo y cuenta 14 (1435 / 1498); productos nuevos se crean en Siigo al causar.",
    "INC, recargo y descuento global del documento se reparten en el valor de los ítems (proporcional); subtotal = suma de los ítems.",
  ],
};
