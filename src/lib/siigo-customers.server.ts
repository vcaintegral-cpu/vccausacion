// Terceros (proveedores) en Siigo: búsqueda por documento y creación automática.
// Usa la MISMA conexión de Siigo ya configurada por empresa (siigo.server.ts).
// Endpoints oficiales: GET /v1/customers?identification=..., POST /v1/customers.
import { siigoGet, siigoPost } from "@/lib/siigo.server";

export type SiigoCustomer = {
  id?: string;
  identification?: string;
  branch_office?: number;
  name?: string[] | string;
  person_type?: string;
  id_type?: { code?: string; name?: string } | string;
};

/** Normaliza el documento: solo dígitos, sin puntos, espacios, guiones ni DV. */
export function normalizeNit(raw: string | null | undefined): string {
  const solo = String(raw ?? "").replace(/[^0-9kK-]/g, "");
  const sinDv = solo.includes("-") ? solo.split("-")[0]! : solo;
  return sinDv.replace(/\D/g, "");
}

/** Dígito de verificación DIAN calculado a partir del NIT normalizado. */
export function checkDigit(nit: string): string {
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digitos = nit.replace(/\D/g, "").split("").reverse();
  let suma = 0;
  digitos.forEach((d, i) => {
    suma += Number(d) * (pesos[i] ?? 0);
  });
  const resto = suma % 11;
  return String(resto > 1 ? 11 - resto : resto);
}

export type ProviderInput = {
  nit: string | null | undefined;
  name: string | null | undefined;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
};

/** Campos obligatorios que Siigo exige para crear un tercero. */
export function validarTercero(p: ProviderInput): { ok: boolean; faltantes: string[]; nit: string } {
  const nit = normalizeNit(p.nit);
  const faltantes: string[] = [];
  if (!nit || nit.length < 5) faltantes.push("NIT o documento de identificación válido");
  if (!String(p.name ?? "").trim()) faltantes.push("Razón social o nombre del proveedor");
  return { ok: faltantes.length === 0, faltantes, nit };
}

/** Busca el tercero en Siigo por documento (nunca por razón social). */
export async function siigoFindCustomer(nitRaw: string): Promise<SiigoCustomer | null> {
  const nit = normalizeNit(nitRaw);
  if (!nit) return null;
  type Res = { results?: SiigoCustomer[] } | SiigoCustomer[];
  const rutas = [
    `/v1/customers?identification=${encodeURIComponent(nit)}`,
    `/v1/customers?identification=${encodeURIComponent(nit)}&page_size=100`,
  ];
  for (const ruta of rutas) {
    try {
      const res = await siigoGet<Res>(ruta);
      const list = Array.isArray(res) ? res : (res?.results ?? []);
      const found = list.find((c) => normalizeNit(c.identification) === nit);
      if (found?.id) return found;
    } catch (e) {
      console.warn("[siigo][terceros] búsqueda fallida en", ruta, e instanceof Error ? e.message : e);
    }
  }
  return null;
}

type City = { country_code?: string; state_code?: string; city_code?: string; city_name?: string };
let cityCache: City[] | null = null;

async function resolveCity(nombre: string | null | undefined): Promise<Required<City>> {
  const bogota = { country_code: "Co", state_code: "11", city_code: "11001", city_name: "Bogotá, D.C." };
  const buscado = String(nombre ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  if (!buscado) return bogota;
  if (!cityCache) {
    try {
      const res = await siigoGet<City[] | { results?: City[] }>("/v1/cities?country_code=Co");
      cityCache = Array.isArray(res) ? res : (res?.results ?? []);
    } catch {
      cityCache = [];
    }
  }
  const match = (cityCache ?? []).find(
    (c) =>
      String(c.city_name ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .startsWith(buscado.split(",")[0]!.trim()),
  );
  if (match?.city_code)
    return {
      country_code: match.country_code ?? "Co",
      state_code: match.state_code ?? match.city_code.slice(0, 2),
      city_code: match.city_code,
      city_name: match.city_name ?? String(nombre),
    };
  return bogota;
}

export type EnsureCustomerResult = {
  id: string;
  identification: string;
  action: "encontrado" | "creado";
  message: string;
  raw?: unknown;
};

/**
 * Garantiza que el tercero exista en Siigo:
 * 1) busca por documento; 2) si no existe lo crea; 3) si Siigo responde que ya
 * existe (condición de carrera), vuelve a consultar y usa el existente.
 */
export async function siigoEnsureCustomer(p: ProviderInput): Promise<EnsureCustomerResult> {
  const { ok, faltantes, nit } = validarTercero(p);
  if (!ok)
    throw new Error(
      `No fue posible crear automáticamente el tercero en Siigo porque falta: ${faltantes.join(", ")}. Complete la información del proveedor e intente nuevamente.`,
    );

  const existente = await siigoFindCustomer(nit);
  if (existente?.id)
    return {
      id: String(existente.id),
      identification: nit,
      action: "encontrado",
      message: "Tercero encontrado en Siigo. Se utilizará el tercero existente.",
      raw: existente,
    };

  // Persona jurídica cuando el documento tiene estructura de NIT (9+ dígitos).
  const esEmpresa = nit.length >= 9;
  const nombre = String(p.name ?? "").trim();
  const partes = nombre.split(/\s+/);
  const payload: Record<string, unknown> = {
    type: "Supplier",
    person_type: esEmpresa ? "Company" : "Person",
    id_type: esEmpresa ? "31" : "13",
    identification: nit,
    name: esEmpresa
      ? [nombre]
      : [partes.slice(0, Math.max(1, partes.length - 1)).join(" "), partes.slice(-1).join(" ") || nombre],
    commercial_name: nombre.slice(0, 100),
    branch_office: 0,
    active: true,
    vat_responsible: false,
    fiscal_responsibilities: [{ code: esEmpresa ? "R-99-PN" : "R-99-PN" }],
    address: {
      address: String(p.address ?? "").trim() || "No registrada",
      city: await resolveCity(p.city),
    },
    contacts: [
      {
        first_name: (esEmpresa ? nombre : partes[0] || nombre).slice(0, 50),
        last_name: (esEmpresa ? "Contacto" : partes.slice(1).join(" ") || "Contacto").slice(0, 50),
        email: String(p.email ?? "").trim() || undefined,
        phone: String(p.phone ?? "").trim() ? { number: String(p.phone).trim() } : undefined,
      },
    ],
  };
  if (esEmpresa) payload["check_digit"] = checkDigit(nit);
  if (String(p.phone ?? "").trim()) payload["phones"] = [{ number: String(p.phone).trim() }];

  try {
    const creado = await siigoPost<SiigoCustomer>("/v1/customers", payload);
    if (!creado?.id) throw new Error("Siigo no devolvió el identificador del tercero creado.");
    return {
      id: String(creado.id),
      identification: nit,
      action: "creado",
      message: "Tercero no encontrado en Siigo. Se creó automáticamente y se continuará con la causación.",
      raw: creado,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Condición de carrera o duplicado: el tercero ya existe → se reutiliza.
    if (/already exist|ya existe|duplicate|duplicad/i.test(raw)) {
      const otra = await siigoFindCustomer(nit);
      if (otra?.id)
        return {
          id: String(otra.id),
          identification: nit,
          action: "encontrado",
          message: "Tercero encontrado en Siigo. Se utilizará el tercero existente.",
          raw: otra,
        };
    }
    throw new Error(`No fue posible crear el tercero en Siigo: ${raw}. La factura no fue causada.`);
  }
}
