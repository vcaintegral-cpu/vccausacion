// Teléfono para la API de terceros de Siigo: `phones[].number` y
// `contacts[].phone.number` son NUMÉRICOS de hasta 10 dígitos. Enviar texto
// ("(604) 444 5566", "+57 300…") hace que Siigo rechace la creación del tercero
// con "Invalid data type: number".

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
