// Tipos del mapa de empresas: núcleo global + perfiles por empresa.
//
// Regla: el código del núcleo (src/lib, src/routes, src/components) es el mismo
// para todas las empresas. Lo que solo aplica a una o algunas empresas se declara
// aquí, en el perfil de cada empresa (src/empresas/<empresa>/perfil.ts), y el
// núcleo lo consulta con moduloActivo() / funcionActiva().

/** Módulos del menú lateral. Se pueden apagar por empresa en su perfil. */
export const MODULOS = {
  panel: { nombre: "Panel", ruta: "/panel" },
  causar: { nombre: "Causar factura", ruta: "/causar" },
  borradores: { nombre: "Borradores", ruta: "/borradores" },
  historial: { nombre: "Historial", ruta: "/facturas" },
  documentos_soporte: { nombre: "Documentos soporte", ruta: "/documentos-soporte" },
  pendientes_siigo: { nombre: "Pendientes Siigo", ruta: "/pendientes-siigo" },
  documentos: { nombre: "Documentos", ruta: "/documentos" },
  egresos: { nombre: "Egresos y pagos", ruta: "/egresos" },
  conciliacion: { nombre: "Conciliación bancaria", ruta: "/conciliacion" },
  aprendizaje: { nombre: "Aprendizaje contable", ruta: "/aprendizaje" },
  fuentes: { nombre: "Fuentes de documentos", ruta: "/fuentes" },
  integraciones: { nombre: "Integraciones", ruta: "/integraciones" },
  administracion: { nombre: "Administración", ruta: "/admin" },
  empresas: { nombre: "Empresas", ruta: "/empresas" },
} as const;

export type ModuloId = keyof typeof MODULOS;

/** Módulos que ninguna empresa puede apagar (sin ellos no se podría administrar ni cambiar de empresa). */
export const MODULOS_PROTEGIDOS: readonly ModuloId[] = ["administracion", "empresas"];

/**
 * Definición de una función o comportamiento que puede variar por empresa.
 * - porDefecto: valor del núcleo global (aplica a todas las empresas, actuales y
 *   futuras, que no lo cambien en su perfil).
 * - agregada: fecha (AAAA-MM-DD) en que se creó, para trazabilidad.
 */
export type DefinicionFuncion = {
  descripcion: string;
  porDefecto: boolean;
  agregada: string;
};

/** Perfil de una empresa: solo contiene lo que la diferencia del núcleo global. */
export type PerfilEmpresa = {
  /** Nombre legal como aparece en la app. */
  nombre: string;
  /** NIT sin dígito de verificación, solo números. Es la llave del perfil. */
  nit: string;
  /** Dígito de verificación (se valida contra el NIT). */
  dv: string;
  /** Carpeta del perfil dentro de src/empresas. */
  carpeta: string;
  /** Módulos apagados o encendidos solo para esta empresa (lo que no aparece usa el valor global). */
  modulos?: Partial<Record<ModuloId, boolean>>;
  /** Funciones apagadas o encendidas solo para esta empresa (lo que no aparece usa el valor global). */
  funciones?: Record<string, boolean>;
  /** Notas de contexto: software contable, particularidades, decisiones tomadas en el chat. */
  notas: string[];
};
