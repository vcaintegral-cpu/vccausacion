// Jerarquía del PUC por empresa. Regla: una cuenta con hijas activas NO es cuenta de movimiento.
export type PucAccount = {
  code: string;
  name: string;
  active?: boolean | null;
  level?: string | null;
  parent_code?: string | null;
  has_children?: boolean | null;
  is_movement?: boolean | null;
  source?: string | null;
  siigo_id?: string | null;
  siigo_code?: string | null;
  synced_at?: string | null;
  excel_active?: boolean | null;
  siigo_active?: boolean | null;
  siigo_is_movement?: boolean | null;
  siigo_seen_at?: string | null;
  /** Nivel 2 de la configuración: esta cuenta exige centro de costo. */
  requires_cost_center?: boolean | null;
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
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const perteneceA = (account: PucAccount) => {
    let parent = account.parent_code ?? null;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (parent === code) return true;
      visited.add(parent);
      parent = byCode.get(parent)?.parent_code ?? null;
    }
    return false;
  };
  const tieneDescendientesActivos = (codeToCheck: string) =>
    accounts.some((candidate) => candidate.code !== codeToCheck && perteneceADe(candidate, codeToCheck) && isActive(candidate));
  const perteneceADe = (account: PucAccount, parentCode: string) => {
    let parent = account.parent_code ?? null;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (parent === parentCode) return true;
      visited.add(parent);
      parent = byCode.get(parent)?.parent_code ?? null;
    }
    return false;
  };
  return accounts
    .filter(
      (a) =>
        a.code.length > code.length &&
        perteneceA(a) &&
        isActive(a) &&
        hasMovement(a) &&
        !tieneDescendientesActivos(a.code),
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

export const CUENTA_PADRE_MSG =
  "Esta cuenta no permite movimiento directo en Siigo. Seleccione una cuenta auxiliar o cuenta final activa.";

export type AccountCheck = { ok: boolean; problema: string | null; cuenta: PucAccount | null };

export type ResultadoCuenta = "VÁLIDA" | "REQUIERE AUXILIAR" | "INACTIVA" | "NO ENCONTRADA" | "SIN CUENTA";

export type OperationalAccountResult = {
  requestedAccount: string;
  operationalAccount: string | null;
  level: Nivel | null;
  hasMovement: boolean;
  active: boolean;
  hasChildren: boolean;
  siigoExists: boolean;
  valid: boolean;
  result: "VÁLIDA" | "RESUELTA A AUXILIAR" | "REQUIERE SELECCIÓN" | "INACTIVA" | "NO ENCONTRADA" | "SIN MOVIMIENTO" | "SIN CUENTA";
  message: string | null;
  account: PucAccount | null;
  operational: PucAccount | null;
  candidates: PucAccount[];
};

export type OperationalAccountContext = {
  /** Códigos relacionados con proveedor, histórico o configuración manual, en orden de prioridad. */
  preferredAccountCodes?: (string | null | undefined)[];
};

const siigoExists = (account: PucAccount | null) =>
  !!account && (account.siigo_active != null || account.siigo_is_movement != null || !!account.siigo_id || !!account.siigo_code || !!account.siigo_seen_at);

const isActive = (account: PucAccount) => account.siigo_active ?? account.excel_active ?? account.active !== false;
const hasMovement = (account: PucAccount) => account.siigo_is_movement ?? account.is_movement !== false;

const isOperational = (accounts: PucAccount[], account: PucAccount) => {
  const activeChildren = hijasActivas(accounts, account.code);
  const active = isActive(account);
  const movement = hasMovement(account);
  return active && movement && activeChildren.length === 0;
};

/**
 * Resolución central y determinística de la cuenta que realmente recibe movimiento.
 * No inventa códigos ni elige arbitrariamente entre varios auxiliares operativos.
 */
export function resolveOperationalAccount(
  accounts: PucAccount[],
  accountCode: string | null | undefined,
  context: OperationalAccountContext = {},
): OperationalAccountResult {
  const requestedAccount = String(accountCode ?? "").trim();
  const base = {
    requestedAccount,
    operationalAccount: null,
    level: requestedAccount ? nivelDeCodigo(requestedAccount) : null,
    hasMovement: false,
    active: false,
    hasChildren: false,
    siigoExists: false,
    valid: false,
    account: null,
    operational: null,
    candidates: [],
  } satisfies Omit<OperationalAccountResult, "result" | "message">;
  if (!requestedAccount) return { ...base, result: "SIN CUENTA", message: "Falta la cuenta contable." };

  const account = accounts.find((item) => String(item.code).trim() === requestedAccount) ?? null;
  const descendants = hijasActivas(accounts, requestedAccount);
  if (!account && descendants.length === 0) {
    return { ...base, result: "NO ENCONTRADA", message: `La cuenta ${requestedAccount} no aparece en el PUC completo de la empresa.` };
  }

  const active = account ? isActive(account) : true;
  const movement = account ? hasMovement(account) : false;
  const hasChildren = descendants.length > 0;
  const direct = account && isOperational(accounts, account) ? account : null;
  if (direct) {
    return {
      ...base,
      account,
      operational: direct,
      operationalAccount: direct.code,
      level: nivelDeCodigo(direct.code),
      hasMovement: movement,
      active,
      hasChildren: false,
      siigoExists: siigoExists(direct),
      valid: true,
      result: "VÁLIDA",
      message: null,
    };
  }

  const candidates = auxiliaresDe(accounts, requestedAccount).filter((candidate) => isOperational(accounts, candidate));
  const preferred = (context.preferredAccountCodes ?? []).map((code) => String(code ?? "").trim()).filter(Boolean);
  const preferredMatches = candidates.filter((candidate) => preferred.includes(candidate.code));
  const chosen = preferredMatches.length === 1 ? preferredMatches[0] : candidates.length === 1 ? candidates[0] : null;
  if (chosen) {
    return {
      ...base,
      account,
      operational: chosen,
      candidates,
      operationalAccount: chosen.code,
      level: nivelDeCodigo(chosen.code),
      hasMovement: movement,
      active,
      hasChildren,
      siigoExists: siigoExists(chosen),
      valid: true,
      result: "RESUELTA A AUXILIAR",
      message: `${requestedAccount} es una cuenta padre con auxiliares. Se utilizará automáticamente la cuenta operativa ${chosen.code}.`,
    };
  }
  if (candidates.length > 1) {
    return {
      ...base, account, candidates, active, hasMovement: movement, hasChildren, siigoExists: siigoExists(account),
      result: "REQUIERE SELECCIÓN",
      message: `La cuenta ${requestedAccount} tiene varios auxiliares operativos. Seleccione el correspondiente al proveedor.`,
    };
  }
  if (!active && candidates.length === 0) {
    return { ...base, account, active, hasMovement: movement, hasChildren, siigoExists: siigoExists(account), result: "INACTIVA", message: `La cuenta ${requestedAccount} está inactiva y no tiene una cuenta auxiliar operativa.` };
  }
  return {
    ...base, account, candidates, active, hasMovement: movement, hasChildren, siigoExists: siigoExists(account),
    result: "SIN MOVIMIENTO",
    message: "Esta cuenta existe en el PUC, pero actualmente no tiene movimiento en Siigo y no tiene una cuenta auxiliar operativa.",
  };
}

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
const hijasActivas = (accounts: PucAccount[], code: string) => {
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  return accounts.filter((account) => {
    if (!isActive(account) || account.code === code) return false;
    let parent = account.parent_code ?? null;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (parent === code) return true;
      visited.add(parent);
      parent = byCode.get(parent)?.parent_code ?? null;
    }
    return false;
  });
};

/**
 * Determina, para una cuenta del PUC, el nivel operativo que Siigo permite usar.
 * Existencia, actividad, jerarquía y movimiento son conceptos separados: una cuenta
 * puede existir y estar activa aunque no permita movimiento directo.
 */
export function evaluarCuenta(accounts: PucAccount[], code: string | null | undefined): CuentaEval {
  const resolved = resolveOperationalAccount(accounts, code);
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

  const cuenta = accounts.find((a) => String(a.code).trim() === codigo) ?? null;
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
  // Nunca se elige automáticamente una auxiliar por ser la única: el usuario debe
  // confirmar una cuenta real que exista, esté activa y permita movimiento.
  const cuentaOperativa = resolved.operationalAccount;

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

  if (resolved.valid)
    return {
      ...common,
      cuentaOperativa: resolved.operationalAccount,
      resultado: "VÁLIDA",
      mensaje: resolved.message,
    };

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
  const resolucion = resolveOperationalAccount(accounts, code);
  return {
    ok: resolucion.valid,
    problema: resolucion.valid ? null : resolucion.message,
    cuenta: resolucion.operational ?? resolucion.account,
  };
}
