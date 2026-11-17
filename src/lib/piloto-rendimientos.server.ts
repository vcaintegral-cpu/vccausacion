// Piloto automático — comprobante contable mensual de RENDIMIENTOS FINANCIEROS por cuenta bancaria.
// Cada noche junta los abonos de intereses/rendimientos del mes de cada cuenta (extracto en Excel o, mientras
// no llega, la hoja de la cuenta del reporte de pagos). Solo cuando el EXTRACTO del banco confirma los valores
// (llega los primeros días del mes siguiente), con el cierre del mes cumplido y el envío a Siigo activo, crea
// UN comprobante contable por cuenta: débito a la cuenta del banco y crédito a la cuenta de rendimientos
// (perfil de la empresa), con el banco como tercero. Cada comprobante queda registrado en conciliacion_ajustes
// (tipo «lote» de entrada) para que la conciliación cruce los abonos con él y nunca se reenvíe.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type MovimientoRendimiento = { fecha: string; valor: number; descripcion: string };

export type RendimientosCuenta = {
  etiqueta: string;
  cuentaBanco: string | null;
  movimientos: MovimientoRendimiento[];
  total: number;
  fuente: string | null;
  /** Los movimientos salen de un extracto del banco (no de la hoja del reporte de pagos). */
  desdeExtracto: boolean;
  terceroNit: string | null;
  /** Nombre del comprobante si ya está en Siigo. */
  enSiigo: string | null;
  nota: string | null;
};

export type ResultadoRendimientos = {
  cuentas: RendimientosCuenta[];
  enviados: number;
  conError: number;
  mensajes: string[];
};

const quitarTildes = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/** Abonos de intereses o rendimientos del banco (ingresos). */
export const esRendimientoFinanciero = (descripcion: string) =>
  /RENDIMIENTO|ABONO INTERES|INTERESES? (GANADOS?|AHORROS?|ABONO|FINANCIERO)|ABONO POR INTERES/.test(
    quitarTildes(descripcion),
  );

export function rendimientosDe(
  movimientos: Array<{ fecha: string; valor: number; descripcion: string }>,
): MovimientoRendimiento[] {
  return movimientos
    .filter((m) => m.valor > 0 && esRendimientoFinanciero(m.descripcion))
    .map((m) => ({
      fecha: m.fecha,
      valor: Math.round(m.valor * 100) / 100,
      descripcion: m.descripcion,
    }));
}

/** Comprobante contable: débito al banco y crédito a rendimientos, ambos con el banco como tercero. */
export function payloadRendimientos(p: {
  documentId: number;
  fecha: string;
  total: number;
  cuentaBanco: string;
  cuentaRendimientos: string;
  terceroNit: string;
  descripcion: string;
  referencia: string;
}): Record<string, unknown> {
  const v = Math.round(p.total * 100) / 100;
  const customer = { identification: p.terceroNit.replace(/\D/g, ""), branch_office: 0 };
  const desc = p.descripcion.slice(0, 100);
  return {
    document: { id: p.documentId },
    date: p.fecha,
    observations: `${p.descripcion} · Ref ${p.referencia}`.slice(0, 250),
    items: [
      {
        account: { code: p.cuentaBanco, movement: "Debit" },
        customer,
        description: desc,
        value: v,
      },
      {
        account: { code: p.cuentaRendimientos, movement: "Credit" },
        customer,
        description: desc,
        value: v,
      },
    ],
  };
}

const finDeMes = (periodo: string) => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

export async function procesarRendimientos(
  db: Db,
  companyId: string,
  op: { periodo: string; cuentaRendimientos: string | null; enviar: boolean; cierre: boolean },
): Promise<ResultadoRendimientos> {
  const res: ResultadoRendimientos = { cuentas: [], enviados: 0, conError: 0, mensajes: [] };
  const { conciliacionFuentesCore } = await import("./conciliacion.functions");
  const fuentes = await conciliacionFuentesCore(db, { companyId, periodo: op.periodo });

  // Tercero (el banco) de cada cuenta: el de su RP mensual de gastos bancarios.
  const { data: eg } = await db
    .from("egresos")
    .select("propuesta, tercero_nit")
    .eq("company_id", companyId)
    .eq("period", op.periodo)
    .like("propuesta->>grupo", "bancario|%")
    .not("tercero_nit", "is", null)
    .limit(500);
  const nitDe = new Map<string, string>();
  for (const e of (eg ?? []) as Array<{
    propuesta: { grupo?: string } | null;
    tercero_nit: string | null;
  }>) {
    const g = (e.propuesta?.grupo ?? "").replace(/^bancario\|/, "");
    if (g && e.tercero_nit && !nitDe.has(quitarTildes(g)))
      nitDe.set(quitarTildes(g), e.tercero_nit);
  }

  for (const c of fuentes.cuentas) {
    if (/EFECTIVO|CAJA/.test(quitarTildes(c.etiqueta))) continue;
    const movs = rendimientosDe(c.movimientos);
    const total = Math.round(movs.reduce((s, m) => s + m.valor, 0) * 100) / 100;
    if (!movs.length && !c.movimientos.length) continue;
    const clave = `rendimientos|${quitarTildes(c.etiqueta)}|${op.periodo}`;
    const { data: previo } = await db
      .from("conciliacion_ajustes")
      .select("siigo_nombre, siigo_id")
      .eq("company_id", companyId)
      .eq("clave", clave)
      .maybeSingle();
    const desdeExtracto = !!c.fuente && !/\(hoja de /i.test(c.fuente);
    res.cuentas.push({
      etiqueta: c.etiqueta,
      cuentaBanco: c.cuentaContable,
      movimientos: movs,
      total,
      fuente: c.fuente,
      desdeExtracto,
      terceroNit: nitDe.get(quitarTildes(c.etiqueta)) ?? null,
      enSiigo: (previo as { siigo_id: string | null; siigo_nombre: string | null } | null)?.siigo_id
        ? ((previo as { siigo_nombre: string | null }).siigo_nombre ?? "enviado")
        : null,
      nota: null,
    });
  }
  if (!op.enviar || !op.cierre || !op.cuentaRendimientos) return res;

  for (const r of res.cuentas) {
    if (r.enSiigo || r.total <= 0) continue;
    if (!r.desdeExtracto) {
      r.nota = "falta el extracto del banco para confirmar los rendimientos";
      continue;
    }
    if (!r.cuentaBanco || !r.terceroNit) {
      r.nota = !r.cuentaBanco
        ? "la cuenta no tiene cuenta contable"
        : "no se conoce el NIT del banco (sale del RP de gastos bancarios)";
      continue;
    }
    try {
      const clave = `rendimientos|${quitarTildes(r.etiqueta)}|${op.periodo}`;
      const fechaMes = finDeMes(op.periodo);
      const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
      const fecha = fechaMes < hoy ? fechaMes : hoy;
      const descripcion = `Rendimientos financieros ${r.etiqueta} ${op.periodo}`;
      const detalle = {
        tipo: "entrada",
        lineas: r.movimientos.map((m) => ({
          clave: `rend|${m.fecha}|${m.valor.toFixed(2)}`,
          fecha: m.fecha,
          descripcion: m.descripcion,
          valor: m.valor,
        })),
      };
      const { data: previo } = await db
        .from("conciliacion_ajustes")
        .select("id, estado")
        .eq("company_id", companyId)
        .eq("clave", clave)
        .maybeSingle();
      if ((previo as { estado?: string } | null)?.estado === "enviando") continue;
      const base = {
        company_id: companyId,
        periodo: op.periodo,
        tipo: "lote",
        detalle: detalle as never,
        cuenta_etiqueta: r.etiqueta,
        clave,
        fecha,
        valor: r.total,
        cuenta_banco: r.cuentaBanco,
        cuenta_ajuste: op.cuentaRendimientos,
        tercero_nit: r.terceroNit.replace(/\D/g, ""),
        comprobante_origen: null,
        descripcion,
        estado: "enviando",
        siigo_error: null,
        created_by: null,
      };
      const bloqueo = previo
        ? await db
            .from("conciliacion_ajustes")
            .update(base)
            .eq("id", (previo as { id: string }).id)
            .in("estado", ["pendiente", "error"])
            .is("siigo_id", null)
            .select("id")
        : await db.from("conciliacion_ajustes").insert(base).select("id");
      if (bloqueo.error || !(bloqueo.data ?? []).length)
        throw new Error(bloqueo.error?.message ?? "El comprobante ya se está procesando.");
      const id = (bloqueo.data as Array<{ id: string }>)[0]!.id;
      try {
        const { siigoCrearComprobante, siigoUseCompany, siigoJournalDocumentId } =
          await import("./siigo.server");
        await siigoUseCompany(companyId);
        const creado = await siigoCrearComprobante<{ id?: string; name?: string }>(
          payloadRendimientos({
            documentId: await siigoJournalDocumentId(),
            fecha,
            total: r.total,
            cuentaBanco: r.cuentaBanco,
            cuentaRendimientos: op.cuentaRendimientos,
            terceroNit: r.terceroNit,
            descripcion,
            referencia: id.slice(0, 8),
          }),
        );
        await db
          .from("conciliacion_ajustes")
          .update({
            estado: "enviado",
            siigo_id: String(creado.id ?? ""),
            siigo_nombre: creado.name ?? null,
          })
          .eq("id", id);
        r.enSiigo = creado.name ?? String(creado.id ?? "enviado");
        res.enviados += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db
          .from("conciliacion_ajustes")
          .update({ estado: "error", siigo_error: msg.slice(0, 2000) })
          .eq("id", id)
          .is("siigo_id", null);
        throw e;
      }
    } catch (e) {
      res.conError += 1;
      res.mensajes.push(
        `${r.etiqueta}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
      );
    }
  }
  return res;
}
