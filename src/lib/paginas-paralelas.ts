// Lectura de tablas grandes por páginas: pide varias páginas a la vez (en orden) en lugar de una tras otra.
// Las consultas DEBEN llevar `.order(...)` por una columna única para que las páginas no se repitan ni se salten filas.
export type RespuestaPagina = { data: unknown; error: { message: string } | null };

export async function leerPaginas<T>(
  consulta: (desde: number, hasta: number) => PromiseLike<RespuestaPagina>,
  opciones: { pagina?: number; paralelo?: number; maximo?: number } = {},
): Promise<T[]> {
  const pagina = opciones.pagina ?? 1000;
  const paralelo = Math.max(1, opciones.paralelo ?? 6);
  const maximo = opciones.maximo ?? Infinity;
  const out: T[] = [];
  for (let desde = 0; out.length < maximo; desde += pagina * paralelo) {
    const lote = await Promise.all(
      Array.from({ length: paralelo }, (_, i) =>
        Promise.resolve(consulta(desde + i * pagina, desde + (i + 1) * pagina - 1)),
      ),
    );
    let fin = false;
    for (const r of lote) {
      if (r.error) throw new Error(r.error.message);
      const filas = (r.data ?? []) as T[];
      out.push(...filas);
      if (filas.length < pagina) {
        fin = true;
        break;
      }
    }
    if (fin) break;
  }
  return out;
}
