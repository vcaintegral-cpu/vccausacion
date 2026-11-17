// Piloto automático — proveedores nuevos: pregunta por correo la cuenta de gasto/costo y la aplica.
// Cuando un borrador del mes queda con renglones SIN cuenta (proveedor sin regla ni historial), el piloto crea UNA
// pregunta por proveedor y mes con lo que se facturó (conceptos y valores, ya leídos de la factura) y hasta 4 cuentas
// sugeridas por el historial de la empresa. La respuesta (un toque en el correo, o el código/nombre de la cuenta
// escrito en Piloto automático → Bandeja) se aplica a todos los borradores de ese proveedor, hoy y los que lleguen,
// como cuenta MANUAL (el recálculo nunca la reemplaza) y el aprendizaje la recuerda al aprobar y causar.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type ResultadoCuentas = { creadas: number; aplicadas: number; sinReconocer: number };

type Renglon = { descripcion: string; valor: number };
type Pendiente = {
  nit: string;
  nombre: string;
  facturas: Array<{ id: string; numero: string; fecha: string; total: number }>;
  renglones: Renglon[];
};

const sinTildes = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const nitLimpio = (n: string | null | undefined) =>
  String(n ?? "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
const pesos = (n: number) => `$${Math.round(n).toLocaleString("es-CO")}`;

/** Cuentas sugeridas para unos conceptos según lo que la empresa ha causado con conceptos parecidos. */
export function sugerirCuentas(
  conceptos: string[],
  historial: Array<{ concept: string | null; account_code: string; weight?: number }>,
  puede: (codigo: string) => { codigo: string; nombre: string } | null,
  maximo = 4,
): Array<{ codigo: string; nombre: string }> {
  const palabras = (t: string) =>
    new Set(
      sinTildes(t)
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((p) => p.length >= 4 && !/^\d+$/.test(p)),
    );
  const buscadas = conceptos.map(palabras).filter((s) => s.size > 0);
  if (!buscadas.length) return [];
  const puntaje = new Map<string, number>();
  for (const h of historial) {
    if (!h.concept) continue;
    const hp = palabras(h.concept);
    if (!hp.size) continue;
    let mejor = 0;
    for (const b of buscadas) {
      let comunes = 0;
      for (const w of b) if (hp.has(w)) comunes += 1;
      mejor = Math.max(mejor, comunes / Math.min(b.size, hp.size));
    }
    if (mejor >= 0.5)
      puntaje.set(
        h.account_code,
        (puntaje.get(h.account_code) ?? 0) + mejor * Math.sqrt(Number(h.weight ?? 1)),
      );
  }
  const out: Array<{ codigo: string; nombre: string }> = [];
  for (const [codigo] of [...puntaje].sort((a, b) => b[1] - a[1])) {
    const c = puede(codigo);
    if (c && !out.some((x) => x.codigo === c.codigo)) out.push(c);
    if (out.length >= maximo) break;
  }
  return out;
}

export type CondicionEscrita =
  | { tipo: "sin"; motivo: string; detalle: string }
  | { tipo: "con"; impuestoId: string; nombre: string };

/**
 * Interpreta una instrucción escrita sobre la retención de un proveedor: «no se le retiene porque…» (con el motivo
 * en el detalle) o «retener servicios 4%» / «honorarios 10» (busca el impuesto de retefuente por nombre y tarifa).
 */
export function interpretarCondicionEscrita(
  texto: string,
  retefuentes: Array<{ id: string; name: string; rate: number }>,
): CondicionEscrita | null {
  const t = sinTildes(texto).replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/^(no|sin)\b|\bno se (le )?(retiene|practica|aplica)|\bno aplica\b|\bno retener\b/.test(t)) {
    const motivo = /autorretened/.test(t)
      ? "autorretenedor"
      : /regimen especial|esal/.test(t)
        ? "regimen_especial"
        : /no sujeto|no contribuyente/.test(t)
          ? "no_sujeto"
          : /gran contribuyente/.test(t)
            ? "gran_contribuyente"
            : "otro";
    return { tipo: "sin", motivo, detalle: texto.trim().slice(0, 200) };
  }
  const numero = /(\d+(?:[.,]\d+)?)\s*%?/.exec(t)?.[1];
  const tarifa = numero ? Number(numero.replace(",", ".")) : null;
  const palabras = t
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length >= 4 && !/^(retener|retiene|retencion|fuente|con|le|se|por|del|sobre)$/.test(w),
    );
  let candidatos = retefuentes;
  if (tarifa != null)
    candidatos = candidatos.filter((c) => Math.abs(Number(c.rate) - tarifa) < 0.001);
  if (palabras.length)
    candidatos = candidatos.filter((c) => palabras.every((w) => sinTildes(c.name).includes(w)));
  if (tarifa == null && !palabras.length) return null;
  return candidatos.length === 1
    ? { tipo: "con", impuestoId: String(candidatos[0]!.id), nombre: candidatos[0]!.name }
    : null;
}

/** Cuenta de gasto/costo que corresponde a una respuesta escrita: código o nombre. */
export function reconocerCuenta(
  texto: string,
  cuentas: Array<{ code: string; name: string }>,
  valida: (codigo: string) => boolean,
): { code: string; name: string } | null {
  const t = texto.trim();
  if (!t) return null;
  const codigo = /^\d{4,}/.exec(t)?.[0];
  if (codigo) {
    const exacta = cuentas.find((c) => c.code === codigo && valida(c.code));
    if (exacta) return exacta;
    const hijas = cuentas.filter((c) => c.code.startsWith(codigo) && valida(c.code));
    return hijas.length === 1 ? hijas[0]! : null;
  }
  const palabras = sinTildes(t)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((p) => p.length >= 3);
  if (!palabras.length) return null;
  const candidatas = cuentas
    .filter((c) => valida(c.code))
    .filter((c) => {
      const n = sinTildes(c.name);
      return palabras.every((p) => n.includes(p));
    })
    .sort((a, b) => a.name.length - b.name.length);
  return candidatas.length >= 1 &&
    (candidatas.length === 1 || candidatas[0]!.name.length <= candidatas[1]!.name.length * 0.7)
    ? candidatas[0]!
    : null;
}

export async function gestionarCuentasNuevas(
  db: Db,
  companyId: string,
  mes: { desde: string; hasta: string },
  etiquetaMes: string,
): Promise<ResultadoCuentas> {
  const res: ResultadoCuentas = { creadas: 0, aplicadas: 0, sinReconocer: 0 };
  const { conClienteDeServicio } = await import("./db-contextual");
  return conClienteDeServicio(db, async () => {
    const [{ isValidPurchaseAccount }, { funcionActiva }, { resolveOperationalAccount }] =
      await Promise.all([
        import("./provider-rules"),
        import("@/empresas/registro"),
        import("./puc-hierarchy"),
      ]);
    const { data: emp } = await db.from("companies").select("nit").eq("id", companyId).single();
    const inventario = funcionActiva(
      (emp as { nit: string | null } | null)?.nit ?? null,
      "productos_inventario",
    );

    // Borradores del mes sin documento en Siigo y sus renglones.
    const { data: invs } = await db
      .from("invoices")
      .select("id, prefix, number, provider_nit, provider_name, issue_date, total")
      .eq("company_id", companyId)
      .eq("doc_kind", "compra")
      .eq("status", "borrador")
      .gte("issue_date", mes.desde)
      .lte("issue_date", mes.hasta)
      .is("siigo_id", null)
      .is("siigo_number", null)
      .limit(300);
    const facturas = (invs ?? []) as Array<{
      id: string;
      prefix: string | null;
      number: string | null;
      provider_nit: string | null;
      provider_name: string | null;
      issue_date: string | null;
      total: number | string;
    }>;
    if (!facturas.length) return res;
    const lineas: Array<{
      invoice_id: string;
      description: string | null;
      total: number | string | null;
      account_code: string | null;
    }> = [];
    for (let i = 0; i < facturas.length; i += 50) {
      const { data } = await db
        .from("invoice_lines")
        .select("invoice_id, description, total, account_code, position")
        .in(
          "invoice_id",
          facturas.slice(i, i + 50).map((f) => f.id),
        )
        .order("position");
      lineas.push(...((data ?? []) as typeof lineas));
    }

    // Contexto (PUC, historial) con el dueño de las cargas, igual que al causar.
    const { data: tarea } = await db
      .from("bulk_upload_items")
      .select("upload_id")
      .in(
        "invoice_id",
        facturas.map((f) => f.id),
      )
      .limit(1)
      .maybeSingle();
    const { data: carga } = tarea
      ? await db
          .from("bulk_uploads")
          .select("created_by")
          .eq("id", (tarea as { upload_id: string }).upload_id)
          .maybeSingle()
      : { data: null };
    const dueno = (carga as { created_by: string } | null)?.created_by;
    const { loadDeps } = await import("./bulk-runner");
    const deps = await loadDeps(companyId, dueno);
    const cuentas = deps.config.accounts as Array<{ code: string; name: string }>;
    const operativa = (codigo: string) => {
      const r = resolveOperationalAccount(deps.config.accounts, codigo);
      return r.valid &&
        r.operationalAccount &&
        isValidPurchaseAccount(r.operationalAccount, inventario)
        ? {
            codigo: r.operationalAccount,
            nombre:
              r.operational?.name ??
              cuentas.find((c) => c.code === r.operationalAccount)?.name ??
              "",
          }
        : null;
    };
    const valida = (codigo: string) => !!operativa(codigo) && operativa(codigo)!.codigo === codigo;

    // 1) Respuestas: se aplican a los borradores del proveedor con renglones sin cuenta (hoy y los que lleguen).
    const { data: dec } = await db
      .from("piloto_decisiones")
      .select("id, referencia_id, estado, respuesta, instruccion, pregunta")
      .eq("company_id", companyId)
      .eq("tipo", "cuenta_proveedor")
      .in("estado", ["respondida", "aplicada"]);
    const respondidas = (dec ?? []) as Array<{
      id: string;
      referencia_id: string | null;
      estado: string;
      respuesta: string | null;
      instruccion: string | null;
      pregunta: string;
    }>;
    const pendientesPorFactura = (id: string) =>
      lineas
        .filter((l) => l.invoice_id === id)
        .some((l) => !isValidPurchaseAccount(l.account_code, inventario));
    for (const d of respondidas) {
      const nit = nitLimpio(d.referencia_id);
      if (!nit) continue;
      const texto = (d.instruccion?.trim() || d.respuesta || "").trim();
      if (d.respuesta === "ninguna" && d.estado === "respondida") {
        await db
          .from("piloto_decisiones")
          .update({ estado: "aplicada", aplicada_at: new Date().toISOString() })
          .eq("id", d.id);
        continue;
      }
      if (d.respuesta === "inventario" && !d.instruccion?.trim()) {
        // Inventario: el proveedor queda marcado y el motor propone cuenta 14, producto del catálogo o producto nuevo.
        const { data: prov } = await db
          .from("providers")
          .select("id, purchase_tax_profile")
          .eq("company_id", companyId)
          .eq("nit", d.referencia_id ?? "")
          .maybeSingle();
        if (prov) {
          const previo = ((prov as { purchase_tax_profile: unknown }).purchase_tax_profile ??
            {}) as Record<string, unknown>;
          const { error } = await db
            .from("providers")
            .update({ purchase_tax_profile: { ...previo, es_inventario: true } as never })
            .eq("id", (prov as { id: string }).id);
          if (!error) {
            const { recalcularCuentasBorrador } = await import("./bulk-invoices");
            const { invalidateBulkDeps } = await import("./bulk-runner");
            invalidateBulkDeps(companyId);
            const deps2 = await loadDeps(companyId, dueno);
            for (const f of facturas.filter((x) => nitLimpio(x.provider_nit) === nit)) {
              try {
                const r2 = await recalcularCuentasBorrador(f.id, deps2.config);
                if (r2.ok) res.aplicadas += 1;
              } catch {
                /* el siguiente recálculo lo reintenta */
              }
            }
            await db
              .from("piloto_decisiones")
              .update({ estado: "aplicada", aplicada_at: new Date().toISOString() })
              .eq("id", d.id);
          }
        }
        continue;
      }
      const cuenta = reconocerCuenta(texto, cuentas, valida);
      if (!cuenta) {
        if (d.estado === "respondida") {
          res.sinReconocer += 1;
          await db
            .from("piloto_decisiones")
            .update({
              estado: "pendiente",
              respuesta: null,
              instruccion: null,
              notificada_at: null,
              pregunta: `${d.pregunta.replace(/ ⚠ La respuesta .*$/s, "")} ⚠ La respuesta «${texto.slice(0, 60)}» no coincide con una cuenta de gasto/costo del PUC: escriba el código exacto de la cuenta.`,
            })
            .eq("id", d.id);
        }
        continue;
      }
      const { asignarCuentaGasto } = await import("./asignar-cuenta-gasto");
      for (const f of facturas.filter((x) => nitLimpio(x.provider_nit) === nit)) {
        if (!pendientesPorFactura(f.id)) continue;
        const a = await asignarCuentaGasto(
          f.id,
          { code: cuenta.code, name: cuenta.name },
          deps.config as never,
          { inventario },
        );
        if (a.ok && a.renglones > 0) res.aplicadas += 1;
      }
      if (d.estado === "respondida")
        await db
          .from("piloto_decisiones")
          .update({ estado: "aplicada", aplicada_at: new Date().toISOString() })
          .eq("id", d.id);
    }

    // 2) Preguntas nuevas: proveedores con renglones sin cuenta que aún no tienen pregunta este mes.
    const porProveedor = new Map<string, Pendiente>();
    for (const f of facturas) {
      const sin = lineas.filter(
        (l) => l.invoice_id === f.id && !isValidPurchaseAccount(l.account_code, inventario),
      );
      if (!sin.length) continue;
      const nit = nitLimpio(f.provider_nit);
      if (!nit) continue;
      const p = porProveedor.get(nit) ?? {
        nit,
        nombre: f.provider_name ?? nit,
        facturas: [],
        renglones: [],
      };
      p.facturas.push({
        id: f.id,
        numero: [f.prefix, f.number].filter(Boolean).join("-") || f.id.slice(0, 8),
        fecha: f.issue_date ?? "",
        total: Number(f.total || 0),
      });
      for (const l of sin)
        p.renglones.push({
          descripcion: String(l.description ?? "").trim(),
          valor: Number(l.total || 0),
        });
      porProveedor.set(nit, p);
    }
    const periodo = mes.desde.slice(0, 7);

    // 3) Productos nuevos de proveedores que la usuaria aún no confirmó como de inventario: una pregunta por proveedor.
    if (inventario) {
      const nuevosPorNit = new Map<
        string,
        { nitCrudo: string; nombre: string; productos: string[] }
      >();
      for (let i = 0; i < facturas.length; i += 50) {
        const { data: raws } = await db
          .from("invoices")
          .select("id, raw_extraction")
          .in(
            "id",
            facturas.slice(i, i + 50).map((f) => f.id),
          );
        for (const r of (raws ?? []) as Array<{
          id: string;
          raw_extraction: Record<string, unknown> | null;
        }>) {
          const nuevos = (r.raw_extraction?.["productos_nuevos"] ?? {}) as Record<
            string,
            { nombre?: string }
          >;
          const nombres = Object.values(nuevos)
            .map((n) => String(n?.nombre ?? "").trim())
            .filter(Boolean);
          if (!nombres.length) continue;
          const f = facturas.find((x) => x.id === r.id);
          if (!f) continue;
          const nit = nitLimpio(f.provider_nit);
          const confirmado = !!(
            deps.config.batch?.providers[String(f.provider_nit ?? "")]?.purchase_tax_profile as
              { es_inventario?: boolean } | undefined
          )?.es_inventario;
          if (!nit || confirmado) continue;
          const x = nuevosPorNit.get(nit) ?? {
            nitCrudo: String(f.provider_nit),
            nombre: f.provider_name ?? nit,
            productos: [],
          };
          x.productos.push(...nombres);
          nuevosPorNit.set(nit, x);
        }
      }
      for (const [nit, x] of nuevosPorNit) {
        const clave = `inventario|${nit}`;
        const { data: previa } = await db
          .from("piloto_decisiones")
          .select("id")
          .eq("company_id", companyId)
          .eq("clave", clave)
          .maybeSingle();
        if (previa) continue;
        const { error } = await db.from("piloto_decisiones").upsert(
          {
            company_id: companyId,
            clave,
            tipo: "cuenta_proveedor",
            referencia_id: x.nitCrudo,
            titulo: `¿Inventario? ${x.nombre.slice(0, 60)}`,
            pregunta: `${x.nombre} (NIT ${nit}) facturó productos que no existen en el catálogo: ${[
              ...new Set(x.productos),
            ]
              .slice(0, 6)
              .map((n) => `«${n.slice(0, 60)}»`)
              .join(
                "; ",
              )}. Si es inventario, cruzo con el catálogo y creo en Siigo los productos nuevos al causar la factura (cuenta 14); si no, queda por revisar.`,
            opciones: [
              {
                id: "inventario",
                etiqueta: "Sí, es inventario: cruzar con el catálogo o crear los productos nuevos",
              },
              { id: "ninguna", etiqueta: "No, lo reviso yo" },
            ] as never,
          },
          { onConflict: "company_id,clave", ignoreDuplicates: true },
        );
        if (!error) res.creadas += 1;
      }
    }
    for (const p of porProveedor.values()) {
      const clave = `cuenta|${p.nit}|${periodo}`;
      const { data: previa } = await db
        .from("piloto_decisiones")
        .select("id, estado, opciones")
        .eq("company_id", companyId)
        .eq("clave", clave)
        .maybeSingle();
      if (previa) {
        // Preguntas creadas antes de existir la opción de inventario: se les agrega (sin volver a enviar el correo).
        const pr = previa as {
          id: string;
          estado: string;
          opciones: Array<{ id: string; etiqueta: string }>;
        };
        if (
          inventario &&
          pr.estado === "pendiente" &&
          !pr.opciones.some((o) => o.id === "inventario")
        )
          await db
            .from("piloto_decisiones")
            .update({
              opciones: [
                {
                  id: "inventario",
                  etiqueta: "Es INVENTARIO: cuenta 14, producto del catálogo o nuevo",
                },
                ...pr.opciones,
              ] as never,
            })
            .eq("id", pr.id);
        continue;
      }
      let sugeridas = sugerirCuentas(
        p.renglones.map((r) => r.descripcion),
        (deps.knowledge.history ?? []) as Array<{
          concept: string | null;
          account_code: string;
          weight?: number;
        }>,
        operativa,
      );
      // Sin conceptos parecidos: las cuentas de gasto/costo que más usa la empresa (para elegir con un toque).
      if (!sugeridas.length) {
        const uso = new Map<string, number>();
        for (const h of (deps.knowledge.history ?? []) as Array<{
          account_code: string;
          weight?: number;
        }>)
          uso.set(h.account_code, (uso.get(h.account_code) ?? 0) + Number(h.weight ?? 1));
        sugeridas = [...uso]
          .sort((a, b) => b[1] - a[1])
          .map(([c]) => operativa(c))
          .filter((c): c is { codigo: string; nombre: string } => !!c)
          .slice(0, 3)
          .map((c) => ({
            codigo: c.codigo,
            nombre: `${c.nombre} (de las más usadas por la empresa)`,
          }));
      }
      const conceptos = p.renglones
        .slice(0, 6)
        .map((r) => `«${r.descripcion.slice(0, 70) || "sin descripción"}» ${pesos(r.valor)}`)
        .join("; ");
      const mas = p.renglones.length > 6 ? ` y ${p.renglones.length - 6} concepto(s) más` : "";
      const numeros = p.facturas.map((f) => `${f.numero} (${pesos(f.total)})`).join(", ");
      const { error } = await db.from("piloto_decisiones").upsert(
        {
          company_id: companyId,
          clave,
          tipo: "cuenta_proveedor",
          referencia_id: p.nit,
          titulo: `Cuenta contable para ${p.nombre.slice(0, 60)}`,
          pregunta: `Proveedor sin historial: ${p.nombre} (NIT ${p.nit}). Facturas de ${etiquetaMes}: ${numeros}. Facturó: ${conceptos}${mas}. ¿A qué cuenta de gasto/costo debo causarlo? ${sugeridas.length ? "Toque una cuenta sugerida o escriba" : "Escriba"} en la aplicación (Piloto automático → Bandeja) el código o el nombre de la cuenta; lo aplico a todas sus facturas y lo recuerdo.`,
          opciones: [
            ...(inventario
              ? [
                  {
                    id: "inventario",
                    etiqueta: "Es INVENTARIO: cuenta 14, producto del catálogo o nuevo",
                  },
                ]
              : []),
            ...sugeridas.map((c) => ({
              id: c.codigo,
              etiqueta: `${c.codigo} · ${c.nombre}`.slice(0, 80),
            })),
          ] as never,
        },
        { onConflict: "company_id,clave", ignoreDuplicates: true },
      );
      if (!error) res.creadas += 1;
    }
    return res;
  });
}

// ---------------------------------------------------------------------------
// Condición de retención del proveedor (pregunta por correo)
// ---------------------------------------------------------------------------
export type ResultadoCondiciones = { creadas: number; aplicadas: number; sinReconocer: number };

const MOTIVOS_SIN: Record<string, { motivo: string; etiqueta: string }> = {
  "sin:autorretenedor": {
    motivo: "autorretenedor",
    etiqueta: "No se le retiene: es autorretenedor",
  },
  "sin:regimen_especial": {
    motivo: "regimen_especial",
    etiqueta: "No se le retiene: régimen especial / ESAL",
  },
  "sin:no_sujeto": { motivo: "no_sujeto", etiqueta: "No se le retiene: no sujeto" },
  "sin:otro": { motivo: "otro", etiqueta: "No se le retiene (otra razón, p. ej. base menor)" },
};

/**
 * El motor pide confirmar si se le practica retención en la fuente a un proveedor sin precedente claro. Cada
 * proveedor con ese pedido en un borrador del mes recibe UNA pregunta por correo («no se le retiene» con su motivo,
 * o «se le retiene con» cada impuesto de retefuente activo). La respuesta queda guardada en el proveedor
 * (providers.purchase_tax_profile.condicion_retencion, la misma memoria de la pantalla de condición tributaria) y los
 * borradores de ese proveedor se recalculan en el acto.
 */
export async function gestionarCondicionesRetencion(
  db: Db,
  companyId: string,
  mes: { desde: string; hasta: string },
): Promise<ResultadoCondiciones> {
  const res: ResultadoCondiciones = { creadas: 0, aplicadas: 0, sinReconocer: 0 };
  const { conClienteDeServicio } = await import("./db-contextual");
  return conClienteDeServicio(db, async () => {
    // Proveedores con el pedido de confirmar la condición en un borrador del mes.
    const { data: marcadas } = await db
      .from("bulk_upload_items")
      .select("invoice_id")
      .eq("company_id", companyId)
      .eq("status", "completed")
      .eq("needs_review", true)
      .ilike("user_message", "%confirmar condición del proveedor%")
      .not("invoice_id", "is", null)
      .limit(200);
    const ids = [
      ...new Set(((marcadas ?? []) as Array<{ invoice_id: string }>).map((x) => x.invoice_id)),
    ];
    const proveedores = new Map<
      string,
      { nitCrudo: string; nombre: string; facturas: string[]; ids: string[] }
    >();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await db
        .from("invoices")
        .select("id, prefix, number, provider_nit, provider_name, total")
        .in("id", ids.slice(i, i + 100))
        .eq("status", "borrador")
        .gte("issue_date", mes.desde)
        .lte("issue_date", mes.hasta);
      for (const f of (data ?? []) as Array<{
        id: string;
        prefix: string | null;
        number: string | null;
        provider_nit: string | null;
        provider_name: string | null;
        total: number | string;
      }>) {
        const nit = nitLimpio(f.provider_nit);
        if (!nit) continue;
        const p = proveedores.get(nit) ?? {
          nitCrudo: String(f.provider_nit),
          nombre: f.provider_name ?? nit,
          facturas: [],
          ids: [],
        };
        p.facturas.push(
          `${[f.prefix, f.number].filter(Boolean).join("-") || f.id.slice(0, 8)} (${pesos(Number(f.total || 0))})`,
        );
        p.ids.push(f.id);
        proveedores.set(nit, p);
      }
    }

    // Impuestos de retefuente activos (para «se le retiene con…»).
    const { data: imp } = await db
      .from("tax_rates")
      .select("id, name, rate")
      .eq("company_id", companyId)
      .eq("kind", "retefuente")
      .eq("active", true)
      .order("rate")
      .limit(60);
    const retefuentes = (imp ?? []) as Array<{ id: string; name: string; rate: number }>;

    // 1) Respuestas ya dadas: se guardan en el proveedor y se recalculan sus borradores.
    const { data: dec } = await db
      .from("piloto_decisiones")
      .select("id, referencia_id, estado, respuesta, instruccion, pregunta")
      .eq("company_id", companyId)
      .eq("tipo", "condicion_retencion")
      .eq("estado", "respondida");
    const { perfilConCondicion } = await import("./precedente-tributario");
    for (const d of (dec ?? []) as Array<{
      id: string;
      referencia_id: string | null;
      respuesta: string | null;
      instruccion: string | null;
      pregunta: string;
    }>) {
      const nit = nitLimpio(d.referencia_id);
      let sin = d.respuesta ? MOTIVOS_SIN[d.respuesta] : undefined;
      const conId = d.respuesta?.startsWith("con:") ? d.respuesta.slice(4) : null;
      let impuesto = conId ? retefuentes.find((t) => String(t.id) === conId) : undefined;
      let detalleSin = "Confirmado por correo";
      // Instrucción escrita (cuando ninguna opción aplica): «no se le retiene porque…» o «servicios 4%».
      if (!sin && !impuesto && d.instruccion?.trim()) {
        const e = interpretarCondicionEscrita(d.instruccion, retefuentes);
        if (e?.tipo === "sin") {
          sin = { motivo: e.motivo, etiqueta: "" };
          detalleSin = e.detalle;
        } else if (e?.tipo === "con")
          impuesto = retefuentes.find((t) => String(t.id) === e.impuestoId);
      }
      if (!nit || (!sin && !impuesto)) {
        res.sinReconocer += 1;
        await db
          .from("piloto_decisiones")
          .update({
            estado: "pendiente",
            respuesta: null,
            instruccion: null,
            notificada_at: null,
            pregunta: `${d.pregunta.replace(/ ⚠ .*$/s, "")} ⚠ No entendí «${(d.instruccion ?? "").slice(0, 60)}»: toque una opción o escriba, por ejemplo, «no se le retiene porque es persona natural no responsable» o «se le retiene con Servicios 4%».`,
          })
          .eq("id", d.id);
        continue;
      }
      const { data: prov } = await db
        .from("providers")
        .select("id, purchase_tax_profile")
        .eq("company_id", companyId)
        .eq("nit", d.referencia_id ?? "")
        .maybeSingle();
      if (!prov) continue;
      const ahora = new Date().toISOString();
      const condicion = sin
        ? {
            sinRetencion: { retefuente: { motivo: sin.motivo, detalle: detalleSin } },
            confirmadoPor: "piloto automático (respuesta por correo)",
            confirmadoEn: ahora,
          }
        : {
            retenerCon: { retefuente: String(impuesto!.id) },
            confirmadoPor: "piloto automático (respuesta por correo)",
            confirmadoEn: ahora,
          };
      const previa = (prov as { purchase_tax_profile: unknown }).purchase_tax_profile as {
        condicion_retencion?: Record<string, unknown>;
      } | null;
      const fusion = {
        ...(previa?.condicion_retencion ?? {}),
        ...condicion,
      } as never;
      const perfil = perfilConCondicion(previa, fusion);
      const { error } = await db
        .from("providers")
        .update({ purchase_tax_profile: perfil as never })
        .eq("id", (prov as { id: string }).id);
      if (error) continue;
      await db
        .from("piloto_decisiones")
        .update({ estado: "aplicada", aplicada_at: ahora })
        .eq("id", d.id);
      res.aplicadas += 1;
      // Los borradores del proveedor se recalculan con la condición confirmada.
      const { recalcularCuentasBorrador } = await import("./bulk-invoices");
      const { loadDeps, invalidateBulkDeps } = await import("./bulk-runner");
      invalidateBulkDeps(companyId);
      // El dueño de las cargas da el contexto (el cliente de servicio no tiene sesión de usuario).
      const { data: t0 } = await db
        .from("bulk_upload_items")
        .select("upload_id")
        .in("invoice_id", proveedores.get(nit)?.ids ?? [])
        .limit(1)
        .maybeSingle();
      const { data: c0 } = t0
        ? await db
            .from("bulk_uploads")
            .select("created_by")
            .eq("id", (t0 as { upload_id: string }).upload_id)
            .maybeSingle()
        : { data: null };
      const deps = await loadDeps(companyId, (c0 as { created_by: string } | null)?.created_by);
      for (const f of proveedores.get(nit)?.ids ?? []) {
        try {
          await recalcularCuentasBorrador(f, deps.config);
        } catch {
          /* el siguiente recálculo lo reintenta */
        }
      }
    }

    // 2) Preguntas nuevas, una por proveedor (la condición vale para siempre).
    for (const [nit, p] of proveedores) {
      const clave = `retencion|${nit}`;
      const { data: previa } = await db
        .from("piloto_decisiones")
        .select("id")
        .eq("company_id", companyId)
        .eq("clave", clave)
        .maybeSingle();
      if (previa) continue;
      const opciones = [
        ...Object.entries(MOTIVOS_SIN).map(([id, v]) => ({ id, etiqueta: v.etiqueta })),
        ...retefuentes.slice(0, 4).map((t) => ({
          id: `con:${t.id}`,
          etiqueta: `Se le retiene con ${t.name}`.slice(0, 80),
        })),
      ];
      const { error } = await db.from("piloto_decisiones").upsert(
        {
          company_id: companyId,
          clave,
          tipo: "condicion_retencion",
          referencia_id: p.nitCrudo,
          titulo: `Retención en la fuente de ${p.nombre.slice(0, 60)}`,
          pregunta: `¿Se le practica retención en la fuente a ${p.nombre} (NIT ${nit})? Facturas de este mes: ${p.facturas.join(", ")}. No tiene precedente claro en Siigo. Toque una opción o, si ninguna aplica, escriba su instrucción en la aplicación (Piloto automático → Bandeja), por ejemplo «no se le retiene porque es persona natural no responsable» o «se le retiene con Servicios 4%». Su respuesta queda guardada para este proveedor y sus facturas pasan a verde si lo demás coincide.`,
          opciones: opciones as never,
        },
        { onConflict: "company_id,clave", ignoreDuplicates: true },
      );
      if (!error) res.creadas += 1;
    }
    return res;
  });
}
