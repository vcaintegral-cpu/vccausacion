// Cliente de base de datos inyectable.
// En el navegador usa el cliente de sesión del usuario; en el worker de segundo
// plano se reemplaza por el cliente del servidor, sin duplicar la lógica contable.
import { supabase as browserClient } from "@/integrations/supabase/client";

type Client = typeof browserClient;

let override: Client | null = null;

/** El worker del backend inyecta aquí su propio cliente antes de procesar trabajos. */
export function setDbClient(client: unknown) {
  override = client as Client;
}

export const db = new Proxy({} as Client, {
  get(_target, prop, receiver) {
    return Reflect.get(override ?? browserClient, prop, receiver);
  },
});
