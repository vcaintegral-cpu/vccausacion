// Emparejamiento de un renglón de compra con el catálogo de productos (inventario).
//
// Compara la descripción facturada por el proveedor con el nombre de cada producto:
// - Especificaciones técnicas normalizadas (las que más pesan): potencia (W / kW),
//   voltaje (V / VAC / VDC), corriente (A / mA), temperatura de color (K), lúmenes (lm),
//   medidas (mm / cm / m / pulgadas), grado IP, cantidad de piezas, etc.
//   "1kw" = "1000w", "12 v" = "12V", "3000 k" = "3000K".
//   Dos especificaciones del mismo tipo que difieren (p. ej. 10W contra 20W) descartan
//   el producto: es otra referencia.
// - Palabras (sin tildes, mayúsculas ni palabras vacías) y códigos de referencia.
// Devuelve los productos ordenados por puntaje (0 a 1) y si la coincidencia es clara.

export type ProductoCatalogo = {
  code: string;
  name: string;
  kind?: string | null;
  category?: string | null;
  account_code?: string | null;
  account_name?: string | null;
  active?: boolean | null;
};

export type Especificacion = { tipo: string; valor: number };

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Unidad → [tipo, factor a la unidad base]. */
const UNIDADES: Record<string, [string, number]> = {
  w: ["potencia", 1], watt: ["potencia", 1], watts: ["potencia", 1], vatios: ["potencia", 1], vatio: ["potencia", 1],
  kw: ["potencia", 1000], kilovatio: ["potencia", 1000], kilovatios: ["potencia", 1000], kilowatt: ["potencia", 1000], kilowatts: ["potencia", 1000],
  v: ["voltaje", 1], vac: ["voltaje", 1], vdc: ["voltaje", 1], voltios: ["voltaje", 1], volt: ["voltaje", 1], volts: ["voltaje", 1], kv: ["voltaje", 1000],
  a: ["corriente", 1], amp: ["corriente", 1], amps: ["corriente", 1], amperios: ["corriente", 1], ma: ["corriente", 0.001],
  k: ["color", 1], kelvin: ["color", 1],
  lm: ["lumenes", 1], lumenes: ["lumenes", 1], lumens: ["lumenes", 1],
  mm: ["medida", 1], cm: ["medida", 10], mts: ["medida", 1000], mt: ["medida", 1000], m: ["medida", 1000], metros: ["medida", 1000], metro: ["medida", 1000],
  pulg: ["medida", 25.4], pulgadas: ["medida", 25.4],
  awg: ["calibre", 1], hz: ["frecuencia", 1], mah: ["capacidad", 1], ah: ["capacidad", 1000],
};

/** Especificaciones técnicas de un texto ("Panel LED 18W 6500K 110-220V" → potencia 18, color 6500, voltaje 110/220). */
export function especificaciones(texto: string): Especificacion[] {
  const t = sinTildes(String(texto ?? "")).toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  const out: Especificacion[] = [];
  const agregar = (tipo: string, valor: number) => {
    if (!Number.isFinite(valor)) return;
    const v = Math.round(valor * 1000) / 1000;
    if (!out.some((e) => e.tipo === tipo && e.valor === v)) out.push({ tipo, valor: v });
  };
  // Rangos de voltaje "110-220v", "100-240vac".
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(v|vac|vdc|voltios)\b/g)) {
    agregar("voltaje", Number(m[1]));
    agregar("voltaje", Number(m[2]));
  }
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(kilovatios|kilowatts|kilowatt|kilovatio|watts|watt|vatios|vatio|kw|w|voltios|volts|volt|vac|vdc|kv|v|amperios|amps|amp|ma|a|kelvin|k|lumenes|lumens|lm|mts|mt|mm|cm|metros|metro|m|pulgadas|pulg|awg|hz|mah|ah)(?![a-z])/g)) {
    const u = UNIDADES[m[2]!];
    if (u) agregar(u[0], Number(m[1]) * u[1]);
  }
  for (const m of t.matchAll(/\bip\s*-?\s*(\d{2})\b/g)) agregar("ip", Number(m[1]));
  return out;
}

const VACIAS = new Set([
  "de", "la", "el", "los", "las", "y", "en", "por", "para", "con", "del", "al", "x", "und", "unidad", "unidades",
  "ref", "referencia", "producto", "cant", "color", "tipo", "marca", "modelo",
]);

/** Palabras significativas (sin especificaciones numéricas con unidad). */
export function palabras(texto: string): string[] {
  const t = sinTildes(String(texto ?? ""))
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\d+(?:\.\d+)?\s*(kilovatios|kilowatts|kilowatt|kilovatio|watts|watt|vatios|vatio|kw|w|voltios|volts|volt|vac|vdc|kv|v|amperios|amps|amp|ma|a|kelvin|k|lumenes|lumens|lm|mts|mt|mm|cm|metros|metro|m|pulgadas|pulg|awg|hz|mah|ah)(?![a-z])/g, " ");
  return [
    ...new Set(
      t
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((p) => p.length >= 2 && !VACIAS.has(p) && !/^\d{1,2}$/.test(p)),
    ),
  ];
}

export type Coincidencia = { producto: ProductoCatalogo; puntaje: number; motivo: string };

/**
 * Puntaje de un producto para una descripción:
 * - Especificaciones: cada tipo presente en ambos que coincide suma; uno que difiere descarta.
 * - Palabras: proporción de palabras del producto que aparecen en la descripción (y viceversa).
 * - Código del producto escrito en la descripción: coincidencia directa.
 */
export function puntuar(descripcion: string, producto: ProductoCatalogo, codigoRenglon?: string | null): Coincidencia | null {
  const codigo = String(producto.code ?? "").trim().toLowerCase();
  if (codigoRenglon && codigo && String(codigoRenglon).trim().toLowerCase() === codigo)
    return { producto, puntaje: 1, motivo: "Mismo código de producto." };
  const eD = especificaciones(descripcion);
  const eP = especificaciones(producto.name);
  const tiposComunes = [...new Set(eD.map((e) => e.tipo))].filter((t) => eP.some((e) => e.tipo === t));
  let iguales = 0;
  for (const tipo of tiposComunes) {
    const vd = eD.filter((e) => e.tipo === tipo).map((e) => e.valor);
    const vp = eP.filter((e) => e.tipo === tipo).map((e) => e.valor);
    if (vd.some((v) => vp.includes(v))) iguales += 1;
    else return null; // misma clase de especificación con otro valor: es otra referencia
  }
  const pD = palabras(descripcion);
  const pP = palabras(producto.name);
  if (!pP.length && !eP.length) return null;
  const comunes = pP.filter((p) => pD.includes(p) || pD.some((d) => d.length >= 4 && p.length >= 4 && (d.startsWith(p) || p.startsWith(d))));
  const cobertura = pP.length ? comunes.length / pP.length : 0;
  const reciproca = pD.length ? comunes.length / pD.length : 0;
  const palabrasScore = 0.7 * cobertura + 0.3 * reciproca;
  // Código del producto escrito dentro de la descripción (p. ej. "LRS-75-24").
  if (codigo.length >= 4 && sinTildes(descripcion).toLowerCase().replace(/\s+/g, "").includes(codigo.replace(/\s+/g, "")))
    return { producto, puntaje: 0.95, motivo: `La descripción contiene el código ${producto.code}.` };
  const totalEspecs = new Set([...eD.map((e) => e.tipo), ...eP.map((e) => e.tipo)]).size;
  const especScore = totalEspecs ? iguales / totalEspecs : 0;
  // Sin palabras en común no hay coincidencia, aunque compartan una medida.
  if (!comunes.length) return null;
  const puntaje = totalEspecs ? 0.55 * palabrasScore + 0.45 * especScore : palabrasScore;
  const partes = [`${comunes.length} palabra(s) en común (${comunes.slice(0, 4).join(", ")})`];
  if (iguales) partes.push(`${iguales} especificación(es) iguales`);
  return { producto, puntaje: Math.round(puntaje * 1000) / 1000, motivo: partes.join(" · ") };
}

export type ResultadoCoincidencia = {
  /** Productos más parecidos, de mayor a menor puntaje (máx. 5). */
  candidatos: Coincidencia[];
  /** Coincidencia clara: puntaje alto y con distancia del segundo. */
  elegido: Coincidencia | null;
};

/** Umbrales: clara ≥ 0,6 y al menos 0,1 por encima de la segunda opción. */
export const UMBRAL_CLARO = 0.6;
export const MARGEN_CLARO = 0.1;

export function buscarProducto(
  descripcion: string,
  catalogo: ProductoCatalogo[],
  opts: { codigo?: string | null; tipos?: string[] } = {},
): ResultadoCoincidencia {
  const tipos = opts.tipos ?? ["producto"];
  const candidatos = catalogo
    .filter((p) => p.active !== false && tipos.includes(String(p.kind ?? "producto")))
    .map((p) => puntuar(descripcion, p, opts.codigo))
    .filter((c): c is Coincidencia => !!c && c.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje || a.producto.name.length - b.producto.name.length)
    .slice(0, 5);
  const [primero, segundo] = candidatos;
  const elegido =
    primero && primero.puntaje >= UMBRAL_CLARO && (!segundo || primero.puntaje - segundo.puntaje >= MARGEN_CLARO)
      ? primero
      : null;
  return { candidatos, elegido };
}

/** Código para un producto nuevo creado desde una factura: letras y especificaciones, máx. 30 caracteres. */
export function codigoProductoNuevo(descripcion: string, existentes: Set<string>): string {
  const base =
    sinTildes(descripcion)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 26) || "PRODUCTO";
  let code = base;
  for (let i = 2; existentes.has(code.toLowerCase()); i++) code = `${base.slice(0, 26 - String(i).length - 1)}-${i}`;
  return code;
}
