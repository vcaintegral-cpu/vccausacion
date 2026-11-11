// Teléfono para la API de terceros de Siigo: `phones[].number` y
// `contacts[].phone.number` son texto de SOLO DÍGITOS, hasta 10 (documentación de la
// API: string numérico, sin espacios ni caracteres especiales). Se envía como texto:
// un número JSON produce "Invalid data type: phones[0].number", y un texto con
// espacios o signos ("(604) 444 5566", "+57 300…") también se rechaza.

/** Solo los dígitos del teléfono como número (últimos 10); null si no es un teléfono usable. */
export function telefonoSiigo(valor: unknown): number | null {
  // Varios teléfonos en el mismo campo ("4445566 - 3001234567"): se toma el primero.
  const primero = String(valor ?? "").split(/[,;/|]|\s-\s|\sy\s/i)[0] ?? "";
  let digitos = primero.replace(/\D/g, "");
  // Indicativo de Colombia escrito con el número (57 + 10 dígitos).
  if (digitos.length > 10) digitos = digitos.slice(-10);
  if (digitos.length < 7) return null;
  const n = Number(digitos);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
