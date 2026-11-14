// IMPORTACIÓN DEL EXCEL DE IMPUESTOS DE SIIGO (función «impuestos_excel_siigo», solo empresas
// con la función encendida en su perfil). Lógica pura: lectura, validación y comparación.
//
// Por qué existe: la API de impuestos de Siigo (/v1/taxes) no trae la cuenta contable, así
// que la sincronización la deducía del historial o del nombre de las cuentas del PUC, y la
// importación genérica de Excel solo conoce UNA columna «Cuenta» (el reporte de Siigo trae
// cuatro: Ventas, Compras, Devolución ventas y Devolución compras, ninguna llamada «Cuenta»).
// Resultado: cuentas deducidas, de otra tarifa o de otro nivel del PUC.
//
// Reglas de este lector:
//   - Lee la hoja «Hoja1» del reporte de impuestos de Siigo; los encabezados se reconocen por
//     nombre EXACTO (sin coincidencias parciales).
//   - Cada cuenta se toma como TEXTO tal como viene antes del « - » ("24080601 - IVA …"):
//     no se quitan ni agregan dígitos, no se completa ni se reemplaza por otra parecida.
//   - Cada cuenta va a su función: ventas, compras, devolución en ventas y devolución en
//     compras (la de compras es la que usa la causación de compras: tax_rates.account_code).
//   - La validación contra el catálogo de cuentas de la empresa y las inconsistencias del
//     propio archivo se REPORTAN; nunca se corrigen solas. Errores bloquean la importación;
//     advertencias exigen que la usuaria confirme que las validó.

export type FuncionCuenta = "ventas" | "compras" | "devolucion_ventas" | "devolucion_compras";

export const FUNCIONES_CUENTA: Array<{ id: FuncionCuenta; nombre: string; encabezado: string }> = [
  { id: "ventas", nombre: "Ventas", encabezado: "ventas" },
  { id: "compras", nombre: "Compras", encabezado: "compras" },
  { id: "devolucion_ventas", nombre: "Devolución ventas", encabezado: "devolucion ventas" },
  { id: "devolucion_compras", nombre: "Devolución compras", encabezado: "devolucion compras" },
];

export type CuentaExcel = {
  /** Código contable exactamente como está en el archivo (texto, solo dígitos). */
  codigo: string;
  /** Nombre de la cuenta escrito en el archivo. */
  nombre: string;
  /** Texto completo de la celda. */
  texto: string;
};

export type ImpuestoExcel = {
  /** Fila del Excel (1 = primera fila). */
  fila: number;
  codigo: string;
  nombre: string;
  tipo: string;
  tarifa: number | null;
  cuentas: Record<FuncionCuenta, CuentaExcel | null>;
  /** Problemas de formato de la propia fila (celda de cuenta ilegible, tarifa vacía…). */
  problemas: string[];
};

export type LecturaImpuestos = {
  hoja: string;
  filaEncabezado: number;
  impuestos: ImpuestoExcel[];
};

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
/** Encabezado normalizado: minúsculas, sin tildes, espacios simples (incluye el espacio duro). */
export const normalizarEncabezado = (s: unknown) =>
  sinTildes(String(s ?? ""))
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ")
    .trim();

/** Nombre de cuenta para comparar: sin tildes, mayúsculas/minúsculas ni espacios repetidos. */
export const normalizarNombreCuenta = (s: unknown) =>
  normalizarEncabezado(s)
    .replace(/\s*%/g, "%")
    .replace(/(\d),(\d)/g, "$1.$2");

const COLUMNAS = {
  codigo: "codigo",
  nombre: "nombre",
  tipo: "tipo de impuesto",
  tarifa: "tarifa",
} as const;

/**
 * Celda de cuenta → código y nombre. Acepta «24080601 - Nombre», «24080601» o el número
 * 24080601. El código se conserva tal cual (texto); cualquier otro formato es un problema.
 */
export function leerCeldaCuenta(valor: unknown): CuentaExcel | null | { error: string } {
  if (valor == null) return null;
  if (typeof valor === "number") {
    if (!Number.isInteger(valor) || valor < 0)
      return { error: `la cuenta «${valor}» no es un código contable` };
    // Un entero de hasta 15 dígitos se representa exacto; se pasa a texto sin formato.
    const codigo = valor.toFixed(0);
    return { codigo, nombre: "", texto: codigo };
  }
  const texto = String(valor)
    .replace(/\u00a0/g, " ")
    .trim();
  if (!texto) return null;
  const m = /^(\d+)(?:\s*-\s*(.*))?$/s.exec(texto);
  if (!m) return { error: `la celda «${texto}» no empieza con un código contable` };
  return { codigo: m[1]!, nombre: (m[2] ?? "").replace(/\s+/g, " ").trim(), texto };
}

/** Tarifa de la celda: número de Excel, o texto con punto o coma decimal. */
export function leerTarifa(valor: unknown): number | null {
  if (valor == null || valor === "") return null;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  const t = String(valor).replace(/%/g, "").replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/**
 * Lee la matriz de la hoja (valores crudos de cada celda). Busca la fila de encabezados que
 * tenga TODAS las columnas requeridas con nombre exacto.
 */
export function leerImpuestosSiigo(matriz: unknown[][], hoja = "Hoja1"): LecturaImpuestos {
  const requeridos = [
    COLUMNAS.codigo,
    COLUMNAS.nombre,
    COLUMNAS.tipo,
    COLUMNAS.tarifa,
    ...FUNCIONES_CUENTA.map((f) => f.encabezado),
  ];
  let filaEnc = -1;
  let indice: Record<string, number> = {};
  for (let i = 0; i < Math.min(matriz.length, 30); i++) {
    const celdas = (matriz[i] ?? []).map(normalizarEncabezado);
    const idx: Record<string, number> = {};
    for (const r of requeridos) {
      const pos = celdas.indexOf(r);
      if (pos >= 0 && celdas.lastIndexOf(r) === pos) idx[r] = pos;
    }
    if (Object.keys(idx).length === requeridos.length) {
      filaEnc = i;
      indice = idx;
      break;
    }
  }
  if (filaEnc < 0)
    throw new Error(
      `La hoja «${hoja}» no tiene los encabezados del reporte de impuestos de Siigo: ` +
        "Código, Nombre, Tipo de impuesto, Tarifa, Ventas, Compras, Devolución ventas y Devolución compras.",
    );

  const impuestos: ImpuestoExcel[] = [];
  for (let i = filaEnc + 1; i < matriz.length; i++) {
    const fila = matriz[i] ?? [];
    const celda = (col: string) => fila[indice[col]!];
    const codigoCrudo = celda(COLUMNAS.codigo);
    const nombre = String(celda(COLUMNAS.nombre) ?? "")
      .replace(/[\s\u00a0]+/g, " ")
      .trim();
    const vacia = fila.every((v) => v == null || String(v).trim() === "");
    if (vacia) continue;
    const problemas: string[] = [];
    const codigo =
      typeof codigoCrudo === "number" ? codigoCrudo.toFixed(0) : String(codigoCrudo ?? "").trim();
    if (!codigo) problemas.push("Sin código de impuesto.");
    if (!nombre) problemas.push("Sin nombre de impuesto.");
    const tipo = String(celda(COLUMNAS.tipo) ?? "").trim();
    if (!tipo) problemas.push("Sin tipo de impuesto.");
    const tarifa = leerTarifa(celda(COLUMNAS.tarifa));
    if (tarifa == null) problemas.push("Tarifa vacía o ilegible.");
    const cuentas = {} as Record<FuncionCuenta, CuentaExcel | null>;
    for (const f of FUNCIONES_CUENTA) {
      const c = leerCeldaCuenta(celda(f.encabezado));
      if (c && "error" in c) {
        problemas.push(`${f.nombre}: ${c.error}.`);
        cuentas[f.id] = null;
      } else cuentas[f.id] = c;
    }
    impuestos.push({ fila: i + 1, codigo, nombre, tipo, tarifa, cuentas, problemas });
  }
  return { hoja, filaEncabezado: filaEnc + 1, impuestos };
}

// ----------------------------------------------------------------------------------------
// Validación contra el catálogo de cuentas de la empresa y coherencia del propio archivo.

export type CuentaCatalogo = {
  code: string;
  name: string;
  active?: boolean | null;
  is_movement?: boolean | null;
  has_children?: boolean | null;
};

export type Hallazgo = {
  nivel: "error" | "advertencia";
  /** Código del impuesto en el archivo. */
  impuesto: string;
  funcion?: FuncionCuenta;
  cuenta?: string;
  tipo:
    | "formato"
    | "duplicado"
    | "cuenta_no_existe"
    | "cuenta_incompleta"
    | "cuenta_inactiva"
    | "cuenta_mal_asignada"
    | "ventas_compras_iguales"
    | "tarifa_inconsistente"
    | "nombre_distinto"
    | "cuenta_compartida";
  mensaje: string;
};

/** Grupos del PUC esperados por tipo de impuesto y función (para detectar cuentas cruzadas). */
export function gruposEsperados(tipo: string, funcion: FuncionCuenta): string[] | null {
  const t = normalizarEncabezado(tipo).replace(/\s/g, "");
  const venta = funcion === "ventas" || funcion === "devolucion_ventas";
  if (t === "iva") return venta ? ["2408"] : ["2408", "5", "6", "7"];
  if (t === "retefuente" || t.startsWith("autorret") || t.startsWith("autoret"))
    return venta ? ["1355"] : ["2365"];
  if (t === "reteica") return venta ? ["1355"] : ["2368"];
  if (t === "reteiva") return venta ? ["1355"] : ["2367"];
  if (t === "impoconsumo") return ["24"];
  return null;
}

/** Números escritos en un nombre ("Rete Ica 13,08" → [13.08]; "IVA 19% Pleno" → [19]). */
export function numerosEnNombre(nombre: string): number[] {
  const t = normalizarNombreCuenta(nombre);
  return [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

const mismaTarifa = (a: number, b: number) => Math.abs(a - b) < 0.0001;

export function validarImpuestos(
  impuestos: ImpuestoExcel[],
  catalogo: CuentaCatalogo[],
): Hallazgo[] {
  const h: Hallazgo[] = [];
  const porCodigo = new Map(catalogo.map((c) => [String(c.code), c]));
  const codigos = [...porCodigo.keys()];

  // Duplicados en el archivo (código de impuesto, o tipo + nombre: la clave de guardado).
  const vistos = new Map<string, number>();
  const vistosNombre = new Map<string, number>();
  for (const i of impuestos) {
    if (i.codigo && vistos.has(i.codigo))
      h.push({
        nivel: "error",
        impuesto: i.codigo,
        tipo: "duplicado",
        mensaje: `El código de impuesto ${i.codigo} está repetido (filas ${vistos.get(i.codigo)} y ${i.fila}).`,
      });
    else vistos.set(i.codigo, i.fila);
    const clave = `${normalizarEncabezado(i.tipo)}|${normalizarEncabezado(i.nombre)}`;
    if (vistosNombre.has(clave))
      h.push({
        nivel: "error",
        impuesto: i.codigo,
        tipo: "duplicado",
        mensaje: `El impuesto «${i.nombre}» (${i.tipo}) está repetido (filas ${vistosNombre.get(clave)} y ${i.fila}).`,
      });
    else vistosNombre.set(clave, i.fila);
  }

  for (const i of impuestos) {
    for (const p of i.problemas)
      h.push({
        nivel: "error",
        impuesto: i.codigo,
        tipo: "formato",
        mensaje: `Fila ${i.fila}: ${p}`,
      });

    // Tarifa del nombre del impuesto vs columna Tarifa.
    if (i.tarifa != null) {
      const enNombre = numerosEnNombre(i.nombre);
      if (enNombre.length && !enNombre.some((n) => mismaTarifa(n, i.tarifa!)))
        h.push({
          nivel: "advertencia",
          impuesto: i.codigo,
          tipo: "tarifa_inconsistente",
          mensaje: `El nombre «${i.nombre}» indica ${enNombre.join(" / ")} pero la tarifa es ${i.tarifa}.`,
        });
    }

    for (const f of FUNCIONES_CUENTA) {
      const c = i.cuentas[f.id];
      if (!c) {
        if (!i.problemas.some((p) => p.startsWith(f.nombre)))
          h.push({
            nivel: "error",
            impuesto: i.codigo,
            funcion: f.id,
            tipo: "formato",
            mensaje: `${f.nombre}: sin cuenta en el archivo.`,
          });
        continue;
      }
      const base = { impuesto: i.codigo, funcion: f.id, cuenta: c.codigo };
      const enCatalogo = porCodigo.get(c.codigo);
      if (!enCatalogo) {
        const hijas = codigos.filter((x) => x.startsWith(c.codigo) && x !== c.codigo);
        h.push({
          ...base,
          nivel: "error",
          tipo: hijas.length ? "cuenta_incompleta" : "cuenta_no_existe",
          mensaje: hijas.length
            ? `${f.nombre}: la cuenta ${c.codigo} no existe como cuenta de movimiento; en el catálogo hay subcuentas (${hijas.slice(0, 3).join(", ")}${hijas.length > 3 ? "…" : ""}).`
            : `${f.nombre}: la cuenta ${c.codigo} no existe en el catálogo de cuentas de la empresa.`,
        });
      } else {
        if (enCatalogo.has_children || enCatalogo.is_movement === false)
          h.push({
            ...base,
            nivel: "error",
            tipo: "cuenta_incompleta",
            mensaje: `${f.nombre}: la cuenta ${c.codigo} existe pero no es de movimiento (tiene subcuentas).`,
          });
        if (enCatalogo.active === false)
          h.push({
            ...base,
            nivel: "advertencia",
            tipo: "cuenta_inactiva",
            mensaje: `${f.nombre}: la cuenta ${c.codigo} está inactiva en el catálogo.`,
          });
        if (
          c.nombre &&
          normalizarNombreCuenta(c.nombre) !== normalizarNombreCuenta(enCatalogo.name)
        )
          h.push({
            ...base,
            nivel: "advertencia",
            tipo: "nombre_distinto",
            mensaje: `${f.nombre}: la cuenta ${c.codigo} se llama «${c.nombre}» en el archivo y «${enCatalogo.name}» en el catálogo.`,
          });
      }

      const grupos = gruposEsperados(i.tipo, f.id);
      if (grupos && !grupos.some((g) => c.codigo.startsWith(g)))
        h.push({
          ...base,
          nivel: "advertencia",
          tipo: "cuenta_mal_asignada",
          mensaje: `${f.nombre}: la cuenta ${c.codigo} no es del grupo esperado para ${i.tipo} en ${f.nombre.toLowerCase()} (${grupos.join(", ")}).`,
        });

      if (i.tarifa != null && c.nombre) {
        const nums = numerosEnNombre(c.nombre);
        if (nums.length && !nums.some((n) => mismaTarifa(n, i.tarifa!)))
          h.push({
            ...base,
            nivel: "advertencia",
            tipo: "tarifa_inconsistente",
            mensaje: `${f.nombre}: la cuenta ${c.codigo} «${c.nombre}» indica ${nums.join(" / ")} y el impuesto es de ${i.tarifa}.`,
          });
      }
    }

    const v = i.cuentas.ventas?.codigo;
    const co = i.cuentas.compras?.codigo;
    if (v && co && v === co)
      h.push({
        nivel: "error",
        impuesto: i.codigo,
        cuenta: v,
        tipo: "ventas_compras_iguales",
        mensaje: `La misma cuenta ${v} está en Ventas y en Compras.`,
      });
  }

  // Misma cuenta, misma función, en impuestos de distinta tarifa.
  for (const f of FUNCIONES_CUENTA) {
    const porCuenta = new Map<string, ImpuestoExcel[]>();
    for (const i of impuestos) {
      const c = i.cuentas[f.id]?.codigo;
      if (c) porCuenta.set(c, [...(porCuenta.get(c) ?? []), i]);
    }
    for (const [cuenta, lista] of porCuenta) {
      const tarifas = new Set(lista.map((x) => x.tarifa));
      if (lista.length > 1 && tarifas.size > 1)
        for (const i of lista)
          h.push({
            nivel: "advertencia",
            impuesto: i.codigo,
            funcion: f.id,
            cuenta,
            tipo: "cuenta_compartida",
            mensaje: `${f.nombre}: la cuenta ${cuenta} también la usan impuestos de otra tarifa (${lista
              .filter((x) => x !== i)
              .map((x) => `${x.codigo} «${x.nombre}» ${x.tarifa}`)
              .join("; ")}).`,
          });
    }
  }
  return h;
}

// ----------------------------------------------------------------------------------------
// Registros a guardar y comparación después de guardar.

/** Columna de tax_rates de cada función. */
export const COLUMNA_DE_FUNCION: Record<FuncionCuenta, string> = {
  ventas: "account_sales",
  compras: "account_code",
  devolucion_ventas: "account_sales_return",
  devolucion_compras: "account_purchase_return",
};

export type RegistroImpuesto = {
  company_id: string;
  kind: string;
  name: string;
  rate: number;
  excel_code: string;
  account_code: string | null;
  account_sales: string | null;
  account_sales_return: string | null;
  account_purchase_return: string | null;
  source: "excel_siigo";
};

/** Tipo del impuesto como lo guarda la sincronización con Siigo (minúsculas). */
export const tipoGuardado = (tipo: string) => tipo.trim().toLowerCase();

export function registrosParaGuardar(
  companyId: string,
  impuestos: ImpuestoExcel[],
): RegistroImpuesto[] {
  return impuestos.map((i) => ({
    company_id: companyId,
    kind: tipoGuardado(i.tipo),
    name: i.nombre,
    rate: i.tarifa ?? 0,
    excel_code: i.codigo,
    account_code: i.cuentas.compras?.codigo ?? null,
    account_sales: i.cuentas.ventas?.codigo ?? null,
    account_sales_return: i.cuentas.devolucion_ventas?.codigo ?? null,
    account_purchase_return: i.cuentas.devolucion_compras?.codigo ?? null,
    source: "excel_siigo",
  }));
}

export type FilaComparacion = {
  codigoImpuesto: string;
  impuesto: string;
  funcion: FuncionCuenta;
  cuentaExcel: string | null;
  cuentaImportada: string | null;
  coincide: boolean;
  /** Validación contra el catálogo: «Válida» o el problema. */
  validacion: string;
};

/**
 * Compara, carácter por carácter, la cuenta del archivo con la que quedó guardada en la base
 * de datos (lectura posterior al guardado) y añade el resultado de la validación del catálogo.
 */
export function compararImportacion(
  impuestos: ImpuestoExcel[],
  guardados: Array<Record<string, unknown>>,
  hallazgos: Hallazgo[],
): FilaComparacion[] {
  const clave = (kind: unknown, name: unknown) =>
    `${String(kind ?? "")
      .trim()
      .toLowerCase()}|${String(name ?? "")}`;
  const porClave = new Map(guardados.map((g) => [clave(g["kind"], g["name"]), g]));
  const filas: FilaComparacion[] = [];
  for (const i of impuestos) {
    const g = porClave.get(clave(tipoGuardado(i.tipo), i.nombre));
    for (const f of FUNCIONES_CUENTA) {
      const excel = i.cuentas[f.id]?.codigo ?? null;
      const valor = g ? g[COLUMNA_DE_FUNCION[f.id]] : undefined;
      const importada = valor == null ? null : String(valor);
      const problemas = hallazgos.filter(
        (x) => x.impuesto === i.codigo && x.funcion === f.id && x.cuenta === excel,
      );
      filas.push({
        codigoImpuesto: i.codigo,
        impuesto: i.nombre,
        funcion: f.id,
        cuentaExcel: excel,
        cuentaImportada: importada,
        coincide: excel !== null && importada === excel,
        validacion: problemas.length
          ? problemas
              .map(
                (p) => `${p.nivel === "error" ? "Error" : "Revisar"}: ${p.tipo.replace(/_/g, " ")}`,
              )
              .join(" · ")
          : "Válida",
      });
    }
  }
  return filas;
}
