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
  },
  notas: [
    "Software contable: Siigo (comprobantes CE-1, RC-1, FC-1).",
    "Soportes en Google Drive: <raíz>/<año>/<N. MES>/FACTURAS/<PROVEEDOR>/, compartida con vcaintegral@gmail.com.",
    "El nombre del PDF trae el pago: 'Corriente16 - …', 'Efectivo08 - …'.",
    "Impoconsumo (INC): no se causa aparte; se suma a la cuenta de gasto o costo de la compra.",
  ],
};
