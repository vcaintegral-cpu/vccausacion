// PERFIL ESPECÍFICO: SOLUCIONES Y DISEÑOS (NIT 900.088.704-1)
// Solo lo que diferencia a esta empresa del núcleo global (src/empresas/global.ts).
// Sus datos contables (PUC, terceros, impuestos, Siigo) viven en la base de datos, aislados
// por company_id; no se copian aquí.
import type { PerfilEmpresa } from "@/empresas/tipos";

export const SOLUCIONES_Y_DISENOS: PerfilEmpresa = {
  nombre: "SOLUCIONES Y DISEÑOS",
  nit: "900088704",
  dv: "1",
  carpeta: "soluciones-y-disenos",
  modulos: {},
  funciones: {
    impuestos_excel_siigo: true,
    historial_solo_movimientos: true,
    historial_confianza_concepto: true,
    iva_de_costo_historial: true,
  },
  notas: [
    "Los impuestos se importan del reporte en Excel de Siigo (impuestos.xlsx, Hoja1): se conservan las cuatro cuentas de cada impuesto tal como están en el archivo.",
  ],
};
