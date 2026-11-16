// Cliente de base de datos «contextual» de la lógica de causación (bulk-*, motor, precedente…).
//
// En el navegador es exactamente el cliente de siempre (sesión de la usuaria, con RLS). Cuando el
// piloto automático causa en el servidor sin sesión de usuaria, ejecuta esa misma lógica con el
// cliente de servicio dentro de `conClienteDeServicio`. Todas las consultas de esa lógica filtran
// por company_id explícitamente; el cliente de servicio solo se usa para una empresa a la vez.
import { supabase as navegador } from "@/integrations/supabase/client";

let reemplazo: unknown = null;

/** Mismo tipo y uso que el cliente del navegador; delega en el cliente de servicio si hay uno activo. */
export const supabase = new Proxy({} as typeof navegador, {
  get(_destino, propiedad) {
    const cliente = (reemplazo ?? navegador) as unknown as Record<string | symbol, unknown>;
    const valor = cliente[propiedad];
    return typeof valor === "function"
      ? (valor as (...a: unknown[]) => unknown).bind(cliente)
      : valor;
  },
});

/**
 * Ejecuta `fn` con el cliente de servicio. Solo una ejecución a la vez: si el piloto ya está
 * causando para otra empresa, esta falla en vez de mezclarse.
 */
export async function conClienteDeServicio<T>(cliente: unknown, fn: () => Promise<T>): Promise<T> {
  if (reemplazo) throw new Error("Ya hay una causación del piloto en curso en este proceso.");
  reemplazo = cliente;
  try {
    return await fn();
  } finally {
    reemplazo = null;
  }
}
