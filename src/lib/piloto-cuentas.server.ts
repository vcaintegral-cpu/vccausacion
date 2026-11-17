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
    for (const p of porProveedor.values()) {
      const clave = `cuenta|${p.nit}|${periodo}`;
      const { data: previa } = await db
        .from("piloto_decisiones")
        .select("id")
        .eq("company_id", companyId)
        .eq("clave", clave)
        .maybeSingle();
      if (previa) continue;
      const sugeridas = sugerirCuentas(
        p.renglones.map((r) => r.descripcion),
        (deps.knowledge.history ?? []) as Array<{
          concept: string | null;
          account_code: string;
          weight?: number;
        }>,
        operativa,
      );
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
          opciones: sugeridas.map((c) => ({
            id: c.codigo,
            etiqueta: `${c.codigo} · ${c.nombre}`.slice(0, 80),
          })) as never,
        },
        { onConflict: "company_id,clave", ignoreDuplicates: true },
      );
      if (!error) res.creadas += 1;
    }
    return res;
  });
}
