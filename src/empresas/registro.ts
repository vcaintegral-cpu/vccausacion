// REGISTRO CENTRAL: une el núcleo global con los perfiles específicos.
//
//   Núcleo global (global.ts) ──► aplica a todas las empresas, actuales y futuras
//         │
//         └─► Perfil de empresa (src/empresas/<empresa>/perfil.ts)
//               solo lo que cambia para esa empresa, identificada por NIT
//
// Una empresa sin perfil usa únicamente el núcleo global.
import { BALLET } from "@/empresas/ballet/perfil";
import { FUNCIONES, MODULOS_POR_DEFECTO, type FuncionId } from "@/empresas/global";
import { LED_LIGHTS } from "@/empresas/led-lights/perfil";
import { MODULOS, MODULOS_PROTEGIDOS, type ModuloId, type PerfilEmpresa } from "@/empresas/tipos";

/** Empresas con perfil propio. Una empresa nueva se agrega aquí solo cuando recibe un cambio específico. */
export const PERFILES: readonly PerfilEmpresa[] = [LED_LIGHTS, BALLET];

/** Dígito de verificación DIAN de un NIT. */
export function digitoVerificacion(nit: string): string {
  const pesos = [71, 67, 59, 53, 47, 43, 41, 37, 29, 23, 19, 17, 13, 7, 3];
  const digitos = nit.replace(/\D/g, "").padStart(15, "0");
  const resto = [...digitos].reduce((s, d, i) => s + Number(d) * (pesos[i] ?? 0), 0) % 11;
  return String(resto > 1 ? 11 - resto : resto);
}

/** Variantes con que la app puede tener guardado el NIT ("900.470.166-4", "9004701664", "900470166"). */
function coincideNit(nitGuardado: string | null | undefined, perfil: PerfilEmpresa): boolean {
  if (!nitGuardado) return false;
  const conGuion = /^(.*)-\s*(\d)\s*$/.exec(nitGuardado);
  if (conGuion) return conGuion[1]!.replace(/\D/g, "") === perfil.nit;
  const digitos = nitGuardado.replace(/\D/g, "");
  return digitos === perfil.nit || digitos === `${perfil.nit}${perfil.dv}`;
}

/** Perfil específico de la empresa, o null si solo usa el núcleo global. */
export function perfilDeEmpresa(nit: string | null | undefined): PerfilEmpresa | null {
  return PERFILES.find((p) => coincideNit(nit, p)) ?? null;
}

/** ¿El módulo está disponible para esta empresa? (perfil → si no, valor global). */
export function moduloActivo(nit: string | null | undefined, modulo: ModuloId): boolean {
  if (MODULOS_PROTEGIDOS.includes(modulo)) return true;
  return perfilDeEmpresa(nit)?.modulos?.[modulo] ?? MODULOS_POR_DEFECTO[modulo];
}

/** ¿La función está encendida para esta empresa? (perfil → si no, valor global). */
export function funcionActiva(nit: string | null | undefined, funcion: FuncionId): boolean {
  const definicion = (FUNCIONES as Record<string, { porDefecto: boolean }>)[funcion];
  if (!definicion) return false;
  return perfilDeEmpresa(nit)?.funciones?.[funcion] ?? definicion.porDefecto;
}

export type DiferenciaPerfil = {
  tipo: "módulo" | "función";
  clave: string;
  nombre: string;
  global: boolean;
  empresa: boolean;
};

/** Lo que esta empresa tiene distinto al núcleo global (para la pantalla de alcance). */
export function diferenciasConGlobal(perfil: PerfilEmpresa): DiferenciaPerfil[] {
  const out: DiferenciaPerfil[] = [];
  for (const [clave, valor] of Object.entries(perfil.modulos ?? {}) as Array<[ModuloId, boolean]>) {
    if (valor !== MODULOS_POR_DEFECTO[clave]) {
      out.push({
        tipo: "módulo",
        clave,
        nombre: MODULOS[clave].nombre,
        global: MODULOS_POR_DEFECTO[clave],
        empresa: valor,
      });
    }
  }
  const funciones = FUNCIONES as Record<string, { descripcion: string; porDefecto: boolean }>;
  for (const [clave, valor] of Object.entries(perfil.funciones ?? {})) {
    const def = funciones[clave];
    if (def && valor !== def.porDefecto) {
      out.push({
        tipo: "función",
        clave,
        nombre: def.descripcion,
        global: def.porDefecto,
        empresa: valor,
      });
    }
  }
  return out;
}

/** Errores del registro: NIT o DV inválidos, duplicados, claves inexistentes o módulos protegidos apagados. */
export function validarRegistro(perfiles: readonly PerfilEmpresa[] = PERFILES): string[] {
  const errores: string[] = [];
  const vistos = new Map<string, string>();
  const carpetas = new Set<string>();
  for (const p of perfiles) {
    if (!/^\d{6,10}$/.test(p.nit))
      errores.push(`${p.nombre}: el NIT debe ir sin DV, solo números (${p.nit}).`);
    else if (digitoVerificacion(p.nit) !== p.dv) {
      errores.push(`${p.nombre}: el DV de ${p.nit} es ${digitoVerificacion(p.nit)}, no ${p.dv}.`);
    }
    const previo = vistos.get(p.nit);
    if (previo) errores.push(`NIT ${p.nit} repetido en ${previo} y ${p.nombre}.`);
    vistos.set(p.nit, p.nombre);
    if (p.carpeta === "_plantilla")
      errores.push(`${p.nombre}: la plantilla no se registra; copia la carpeta.`);
    if (carpetas.has(p.carpeta)) errores.push(`Carpeta ${p.carpeta} repetida.`);
    carpetas.add(p.carpeta);
    for (const [clave, valor] of Object.entries(p.modulos ?? {})) {
      if (!(clave in MODULOS)) errores.push(`${p.nombre}: el módulo "${clave}" no existe.`);
      else if (valor === false && MODULOS_PROTEGIDOS.includes(clave as ModuloId)) {
        errores.push(`${p.nombre}: el módulo "${clave}" no se puede apagar.`);
      }
    }
    for (const clave of Object.keys(p.funciones ?? {})) {
      if (!(clave in FUNCIONES))
        errores.push(`${p.nombre}: la función "${clave}" no está definida en global.ts.`);
    }
  }
  return errores;
}
