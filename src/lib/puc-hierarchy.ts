// Jerarquía del PUC por empresa. Regla: una cuenta con hijas activas NO es cuenta de movimiento.
export type PucAccount = {
  code: string;
  name: string;
  active?: boolean | null;
  level?: string | null;
  parent_code?: string | null;
  has_children?: boolean | null;
  is_movement?: boolean | null;
  siigo_id?: string | null;
  siigo_code?: string | null;
  synced_at?: string | null;
};

export const NIVELES = ["clase", "grupo", "cuenta", "subcuenta", "auxiliar"] as const;
export type Nivel = (typeof NIVELES)[number];

export function nivelDeCodigo(code: string): Nivel {
  const n = code.trim().length;
  if (n <= 1) return "clase";
  if (n <= 2) return "grupo";
  if (n <= 4) return "cuenta";
  if (n <= 6) return "subcuenta";
  return "auxiliar";
}

export type HierarchyRow = {
  code: string;
  name: string;
  active: boolean;
  level: Nivel;
  parent_code: string | null;
  has_children: boolean;
  is_movement: boolean;
};

/** Calcula nivel, cuenta padre, hijas y cuentas de movimiento para todo el PUC de una empresa. */
export function buildHierarchy(accounts: PucAccount[]): HierarchyRow[] {
  const clean = accounts
    .map((a) => ({ ...a, code: String(a.code ?? "").trim() }))
    .filter((a) => a.code.length > 0);
  const codes = clean.map((a) => a.code).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const activos = new Set(clean.filter((a) => a.active !== false).map((a) => a.code));

  const padreDe = (code: string): string | null => {
    let best: string | null = null;
    for (const c of codes) {
      if (c.length >= code.length) continue;
      if (!code.startsWith(c)) continue;
      if (!best || c.length > best.length) best = c;
    }
    return best;
  };

  const tieneHijasActivas = (code: string) =>
    clean.some((a) => a.code.length > code.length && a.code.startsWith(code) && activos.has(a.code));

  return clean.map((a) => {
    const active = a.active !== false;
    const has_children = tieneHijasActivas(a.code);
    return {
      code: a.code,
      name: a.name,
      active,
      level: nivelDeCodigo(a.code),
      parent_code: padreDe(a.code),
      has_children,
      is_movement: active && !has_children,
    };
  });
}

/** Cuentas hijas activas directas o auxiliares finales de una cuenta padre. */
export function auxiliaresDe(accounts: PucAccount[], code: string): PucAccount[] {
  return accounts
    .filter(
      (a) =>
        a.code.length > code.length &&
        a.code.startsWith(code) &&
        a.active !== false &&
        a.is_movement !== false &&
        !accounts.some((h) => h.code.length > a.code.length && h.code.startsWith(a.code) && h.active !== false),
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

export const CUENTA_PADRE_MSG =
  "Esta cuenta no permite movimiento directo en Siigo. Seleccione una cuenta auxiliar o cuenta final activa.";

export type AccountCheck = { ok: boolean; problema: string | null; cuenta: PucAccount | null };

/** Valida una cuenta contra el PUC de la empresa activa. */
export function validarCuenta(accounts: PucAccount[], code: string | null | undefined): AccountCheck {
  const codigo = String(code ?? "").trim();
  if (!codigo) return { ok: false, problema: "Falta la cuenta contable.", cuenta: null };
  const cuenta = accounts.find((a) => a.code === codigo) ?? null;
  if (!cuenta)
    return {
      ok: false,
      problema: `La cuenta ${codigo} no existe en el PUC de la empresa seleccionada. Sincronice las cuentas contables desde Integraciones.`,
      cuenta: null,
    };
  if (cuenta.active === false) return { ok: false, problema: `La cuenta ${codigo} está inactiva.`, cuenta };
  if (cuenta.has_children || cuenta.is_movement === false)
    return {
      ok: false,
      problema: `La cuenta ${codigo} — ${cuenta.name} tiene cuentas auxiliares y no permite movimiento directo. Seleccione una cuenta auxiliar activa.`,
      cuenta,
    };
  return { ok: true, problema: null, cuenta };
}
