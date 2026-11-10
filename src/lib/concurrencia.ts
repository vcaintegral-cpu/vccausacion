/**
 * Ejecuta `tarea` sobre cada elemento con a lo sumo `limite` en curso a la vez y
 * devuelve los resultados en el mismo orden de entrada. Un fallo no detiene a los
 * demás: cada tarea maneja sus propios errores.
 */
export async function enParalelo<T, R>(
  elementos: readonly T[],
  limite: number,
  tarea: (elemento: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(elementos.length);
  let siguiente = 0;
  const trabajador = async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= elementos.length) return;
      out[i] = await tarea(elementos[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limite, elementos.length)) }, trabajador));
  return out;
}
