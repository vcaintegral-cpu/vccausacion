// Catálogo único de tipos de ítem de la causación.
// Es la ÚNICA fuente de verdad: pantalla, resumen, validación y envío a Siigo.

export const ITEM_TYPES = ["producto", "servicio", "gasto", "activo"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

const ALIAS: Record<string, ItemType> = {
  producto: "producto",
  productos: "producto",
  product: "producto",
  inventario: "producto",
  inventory: "producto",
  servicio: "servicio",
  servicios: "servicio",
  service: "servicio",
  gasto: "gasto",
  gastos: "gasto",
  expense: "gasto",
  activo: "activo",
  activos: "activo",
  "activo fijo": "activo",
  asset: "activo",
};

/** Normaliza el tipo de ítem sin convertir nunca producto en gasto. */
export function normalizeItemType(value?: string | null): ItemType {
  const clean = (value ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  if (!clean) return "gasto";
  const alias = ALIAS[clean];
  if (alias) return alias;
  if ((ITEM_TYPES as readonly string[]).includes(clean)) return clean as ItemType;
  return "gasto";
}

export function isValidItemType(value?: string | null): boolean {
  const clean = (value ?? "").toString().trim().toLowerCase();
  return clean in ALIAS || (ITEM_TYPES as readonly string[]).includes(clean);
}
