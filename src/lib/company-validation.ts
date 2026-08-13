/**
 * Validación determinística: la factura debe pertenecer a la empresa activa.
 * La comparación principal es el NIT del comprador (adquiriente) contra el NIT de la empresa.
 * La IA solo extrae los datos; la decisión la toma esta regla.
 */

/** Deja solo dígitos y elimina el dígito de verificación cuando viene separado. */
export function normalizeNit(value?: string | null): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const sinDv = raw.includes("-") ? raw.slice(0, raw.lastIndexOf("-")) : raw;
  return sinDv.replace(/\D/g, "");
}

/** Compara dos NIT ignorando puntos, guiones y el dígito de verificación. */
export function sameNit(a?: string | null, b?: string | null): boolean {
  const x = normalizeNit(a);
  const y = normalizeNit(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Uno puede traer el dígito de verificación pegado al final.
  if (x.length === y.length + 1 && x.startsWith(y)) return true;
  if (y.length === x.length + 1 && y.startsWith(x)) return true;
  return false;
}

/** Normaliza razones sociales (tildes, puntuación y sufijos societarios) para la validación secundaria. */
export function normalizeCompanyName(value?: string | null): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?|ltda\.?|sas|eu|e\.?u\.?|sociedad|limitada)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type CompanyRef = { name?: string | null; nit?: string | null };
export type InvoiceBuyer = { buyer_nit?: string | null; buyer_name?: string | null };

export type CompanyCheck =
  | { status: "ok"; nameMismatch: boolean }
  | { status: "sin-datos" }
  | { status: "sin-nit-empresa" }
  | { status: "mismatch"; companyNit: string; buyerNit: string };

/** Regla determinística usada en pantalla y antes de enviar a Siigo. */
export function checkInvoiceCompany(company: CompanyRef | null | undefined, invoice: InvoiceBuyer): CompanyCheck {
  const buyerNit = normalizeNit(invoice.buyer_nit);
  const companyNit = normalizeNit(company?.nit);
  if (!buyerNit) return { status: "sin-datos" };
  if (!companyNit) return { status: "sin-nit-empresa" };
  if (!sameNit(buyerNit, companyNit)) return { status: "mismatch", companyNit, buyerNit };
  const a = normalizeCompanyName(company?.name);
  const b = normalizeCompanyName(invoice.buyer_name);
  return { status: "ok", nameMismatch: !!a && !!b && a !== b && !a.includes(b) && !b.includes(a) };
}

export function mensajeEmpresaIncorrecta(check: Extract<CompanyCheck, { status: "mismatch" }>): string {
  return `Factura no pertenece a la empresa seleccionada. El NIT del comprador en la factura (${check.buyerNit}) no coincide con el NIT de la empresa activa (${check.companyNit}). No es posible aprobar ni enviar esta factura a Siigo.`;
}

/**
 * Motivo bloqueante para guardar, aprobar o causar. Devuelve null cuando la factura
 * pertenece a la empresa activa. Se usa en causación, revisión, carga masiva y servidor.
 */
export function motivoBloqueoEmpresa(check: CompanyCheck): string | null {
  if (check.status === "mismatch") return mensajeEmpresaIncorrecta(check);
  if (check.status === "sin-datos")
    return "No fue posible verificar el NIT del comprador de la factura. Verifique la factura manualmente antes de continuar. No es posible guardar, aprobar ni causar esta factura.";
  if (check.status === "sin-nit-empresa")
    return "La empresa activa no tiene NIT configurado. Registre el NIT de la empresa antes de guardar o causar facturas.";
  return null;
}

/**
 * Respaldo determinístico: busca el NIT de la empresa dentro del texto del documento,
 * ignorando puntos, espacios y el dígito de verificación. Se usa cuando la IA no logró
 * separar bien proveedor y adquiriente, para no rechazar facturas que sí son de la empresa.
 */
export function textoContieneNit(texto: string | null | undefined, nit: string | null | undefined): boolean {
  const objetivo = normalizeNit(nit);
  if (!objetivo || objetivo.length < 6 || !texto) return false;
  const digitos = String(texto).replace(/[^0-9]/g, "");
  return digitos.includes(objetivo);
}
