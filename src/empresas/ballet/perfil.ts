// PERFIL ESPECÍFICO: CORPORACIÓN BALLET FOLCLÓRICO DE ANTIOQUIA
// Solo lo que diferencia a esta empresa del núcleo global (src/empresas/global.ts).
// Sus datos (PUC, terceros, 15 reglas por proveedor, IVA, retenciones, Siigo)
// viven en la base de datos aislados por empresa; no se copian aquí.
import type { PerfilEmpresa } from "@/empresas/tipos";

export const BALLET: PerfilEmpresa = {
  nombre: "CORPORACIÓN BALLET FOLCLÓRICO DE ANTIOQUIA",
  nit: "800212838",
  dv: "7",
  carpeta: "ballet",
  modulos: {},
  funciones: {},
  notas: [
    "Software contable: Siigo (FC-1 compras, DS-3 documentos soporte).",
    "Soportes en OneDrive de mbustamante@integralyasesores.com: Mis Empresas/BALLET/<año>/CONTABILIDAD.",
    "Compras llegan en PDF y en Excel RECIBIDOS; pagos como soportes PDF y extractos.",
  ],
};
