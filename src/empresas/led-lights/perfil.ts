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
  funciones: {},
  notas: [
    "Software contable: Siigo (comprobantes CE-1, RC-1, FC-1).",
    "Soportes en Google Drive: <raíz>/<año>/<N. MES>/FACTURAS/<PROVEEDOR>/, compartida con vcaintegral@gmail.com.",
    "El nombre del PDF trae el pago: 'Corriente16 - …', 'Efectivo08 - …'.",
  ],
};
