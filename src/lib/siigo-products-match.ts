// Elección del producto del catálogo para un renglón clasificado como producto sin código.
type ProductoCatalogo = {
  code?: string | null;
  name?: string | null;
  active?: boolean | null;
  account_code?: string | null;
};

const normal = (x: string | null | undefined) =>
  String(x ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const palabras = (x: string) => new Set(normal(x).split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/**
 * Producto activo cuya cuenta contable es la del renglón. Si hay varios, gana el de nombre más
 * parecido a la descripción (palabras en común, sin empates); sin un ganador claro devuelve null.
 */
export function productoDelCatalogo(
  catalogo: ProductoCatalogo[],
  cuenta: string,
  descripcion: string,
): string | null {
  if (!cuenta) return null;
  const candidatos = catalogo.filter(
    (p) => p.code && p.active !== false && String(p.account_code ?? "") === cuenta,
  );
  if (candidatos.length === 0) return null;
  if (candidatos.length === 1) return String(candidatos[0]!.code).trim();
  const desc = palabras(descripcion);
  const puntuados = candidatos
    .map((p) => ({
      code: String(p.code).trim(),
      puntos: [...palabras(String(p.name ?? ""))].filter((w) => desc.has(w)).length,
    }))
    .sort((a, b) => b.puntos - a.puntos);
  if (puntuados[0]!.puntos === 0 || puntuados[0]!.puntos === puntuados[1]!.puntos) return null;
  return puntuados[0]!.code;
}
