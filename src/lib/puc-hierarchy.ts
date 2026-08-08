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

export type ResultadoCuenta = "VÁLIDA" | "REQUIERE AUXILIAR" | "INACTIVA" | "NO ENCONTRADA" | "SIN CUENTA";

export type CuentaEval = {
  code: string;
  cuenta: PucAccount | null;
  existe: boolean;
  activa: boolean;
  nivel: Nivel | null;
  enSiigo: boolean;
  tieneAuxiliares: boolean;
  auxiliares: PucAccount[];
  permiteMovimiento: boolean;
  cuentaOperativa: string | null;
  resultado: ResultadoCuenta;
  mensaje: string | null;
};

/** ¿La cuenta existe en Siigo? (tiene identificador o código sincronizado) */
export const cuentaEnSiigo = (a: PucAccount | null) => !!(a && (a.siigo_id || a.siigo_code));

/** Hijas activas directas o indirectas dentro del PUC de la empresa. */
const hijasActivas = (accounts: PucAccount[], code: string) =>
  accounts.filter((a) => a.code.length > code.length && a.code.startsWith(code) && a.active !== false);

/**
 * Determina, para una cuenta del PUC, el nivel operativo que Siigo permite usar.
 * Existencia, actividad, jerarquía y movimiento son conceptos separados: una cuenta
 * puede existir y estar activa aunque no permita movimiento directo.
 */
export function evaluarCuenta(accounts: PucAccount[], code: string | null | undefined): CuentaEval {
  const codigo = String(code ?? "").trim();
  const base: CuentaEval = {
    code: codigo,
    cuenta: null,
    existe: false,
    activa: false,
    nivel: codigo ? nivelDeCodigo(codigo) : null,
    enSiigo: false,
    tieneAuxiliares: false,
    auxiliares: [],
    permiteMovimiento: false,
    cuentaOperativa: null,
    resultado: "SIN CUENTA",
    mensaje: "Falta la cuenta contable.",
  };
  if (!codigo) return base;

  const cuenta = accounts.find((a) => a.code === codigo) ?? null;
  const descendientes = hijasActivas(accounts, codigo);
  const auxiliares = auxiliaresDe(accounts, codigo);

  // Segunda validación antes de declarar inexistente: si el PUC tiene cuentas que
  // dependen de este código, la cuenta existe como nivel superior de la jerarquía.
  if (!cuenta && descendientes.length === 0) {
    return {
      ...base,
      resultado: "NO ENCONTRADA",
      mensaje: `La cuenta ${codigo} no aparece en el PUC de la empresa seleccionada. Impórtelo o sincronícelo desde Integraciones antes de causar.`,
    };
  }

  const activa = cuenta ? cuenta.active !== false : true;
  const tieneAuxiliares = descendientes.length > 0;
  const permiteMovimiento = activa && !tieneAuxiliares && (cuenta ? cuenta.is_movement !== false : false);
  const cuentaOperativa = permiteMovimiento ? codigo : auxiliares.length === 1 ? auxiliares[0]!.code : null;

  const common = {
    ...base,
    cuenta,
    existe: true,
    activa,
    nivel: nivelDeCodigo(codigo),
    enSiigo: cuentaEnSiigo(cuenta),
    tieneAuxiliares,
    auxiliares,
    permiteMovimiento,
    cuentaOperativa,
  };

  if (!activa)
    return { ...common, resultado: "INACTIVA", mensaje: `La cuenta ${codigo} está inactiva en el PUC de la empresa.` };

  if (permiteMovimiento) return { ...common, resultado: "VÁLIDA", mensaje: null };

  const nombre = cuenta?.name ? ` — ${cuenta.name}` : "";
  const lista = auxiliares.slice(0, 8).map((a) => `${a.code} — ${a.name}`).join(", ");
  return {
    ...common,
    resultado: "REQUIERE AUXILIAR",
    mensaje:
      auxiliares.length > 0
        ? `La cuenta ${codigo}${nombre} tiene auxiliares activas y no permite movimiento directo. Seleccione la cuenta de movimiento: ${lista}${auxiliares.length > 8 ? "…" : ""}.`
        : `La cuenta ${codigo}${nombre} no permite movimiento directo y no tiene auxiliares activas sincronizadas. Revise el PUC de la empresa.`,
  };
}

/** Valida una cuenta contra el PUC de la empresa activa. */
export function validarCuenta(accounts: PucAccount[], code: string | null | undefined): AccountCheck {
  const evaluacion = evaluarCuenta(accounts, code);
  return {
    ok: evaluacion.resultado === "VÁLIDA",
    problema: evaluacion.resultado === "VÁLIDA" ? null : evaluacion.mensaje,
    cuenta: evaluacion.cuenta,
  };
}
