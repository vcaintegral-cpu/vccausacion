import type { Rule } from "@/lib/accounting";

export type CategoryRef = {
  id?: string | null;
  name: string;
  kind?: string | null;
  account_code?: string | null;
  account_name?: string | null;
};

export type ProductRef = {
  code?: string | null;
  name?: string | null;
  kind?: string | null;
  category?: string | null;
  category_id?: string | null;
  account_code?: string | null;
  account_name?: string | null;
};

export const SIN_CUENTA_MSG =
  "Este producto no tiene una cuenta contable parametrizada. Configure la cuenta en Administración → Categorías o directamente en el Producto.";

const n = (s?: string | null) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

/** Categoría del producto: primero por identificador y, si no existe, por nombre (compatibilidad con catálogos antiguos). */
export function findCategory(product: ProductRef, categories: CategoryRef[]): CategoryRef | undefined {
  if (product.category_id) {
    const byId = categories.find((c) => c.id && c.id === product.category_id);
    if (byId) return byId;
  }
  if (!product.category) return undefined;
  return (
    categories.find((c) => n(c.name) === n(product.category) && n(c.kind) === n(product.kind)) ??
    categories.find((c) => n(c.name) === n(product.category))
  );
}

export type ResolvedAccount = {
  code: string;
  name: string;
  /** producto | categoria | ia | ninguna */
  origin: "producto" | "categoria" | "ia" | "ninguna";
  error: string | null;
};

/**
 * Cuenta contable de un ítem del catálogo:
 * 1) cuenta propia del producto, 2) cuenta de su categoría, 3) reglas de aprendizaje, 4) error.
 */
export function resolveProductAccount(
  product: ProductRef,
  categories: CategoryRef[],
  rules: Rule[] = [],
  options: { log?: boolean } = {},
): ResolvedAccount {
  const clean = (c?: string | null) => (c ?? "").replace(/\s+/g, "");
  const category = findCategory(product, categories);

  let result: ResolvedAccount = { code: "", name: "", origin: "ninguna", error: SIN_CUENTA_MSG };
  if (clean(product.account_code)) {
    result = {
      code: clean(product.account_code),
      name: product.account_name ?? "",
      origin: "producto",
      error: null,
    };
  } else if (clean(category?.account_code)) {
    result = {
      code: clean(category?.account_code),
      name: category?.account_name ?? "",
      origin: "categoria",
      error: null,
    };
  } else {
    const texto = n(product.name);
    const regla = [...rules]
      .sort((a, b) => a.priority - b.priority)
      .find((r) => r.match_type === "keyword" && texto.includes(n(r.match_value)));
    if (regla) result = { code: regla.account_code, name: regla.account_name ?? "", origin: "ia", error: null };
  }

  if (options.log) {
    // Diagnóstico temporal de la asignación automática de cuentas.
    console.info("[Causación] Producto seleccionado:", product.code, product.name);
    console.info("[Causación] Categoría encontrada:", category?.name ?? "(ninguna)");
    console.info("[Causación] Cuenta del producto:", product.account_code ?? "(ninguna)");
    console.info("[Causación] Cuenta de la categoría:", category?.account_code ?? "(ninguna)");
    console.info("[Causación] Cuenta finalmente utilizada:", result.code || "(ninguna)");
    console.info("[Causación] Origen de la cuenta:", result.origin);
  }
  return result;
}
