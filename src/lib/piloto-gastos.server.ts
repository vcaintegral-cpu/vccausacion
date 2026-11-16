// Piloto automático — paso «Gastos bancarios (RP único al cierre del mes)».
// Los gastos bancarios (comisiones, IVA bancario, 4x1000) de cada cuenta se envían juntos en UN solo recibo de
// pago del mes. Cada noche el piloto revisa si cada grupo está completo (con su cuenta débito); el envío real
// solo ocurre al cierre del mes (último día del mes de trabajo en adelante) y con el envío a Siigo activado.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type GrupoBancario = {
  /** «bancario|CORRIENTE». */
  grupo: string;
  banco: string;
  movimientos: number;
  valor: number;
  /** Movimientos listos o aprobados. */
  listos: number;
  /** Motivo más frecuente por el que el grupo no está completo. */
  faltante: string | null;
  /** Ya tiene RP en Siigo. */
  enviado: boolean;
  /** Comprobación contra el extracto del mes (carpeta «extractos»). */
  extracto: VerificacionExtracto;
};

export type VerificacionExtracto = {
  /** El servidor pudo leer el extracto de esta cuenta (los PDF se leen en el navegador). */
  disponible: boolean;
  /** Cargos de gastos bancarios, 4x1000 e IVA que trae el extracto (valor absoluto). */
  valorExtracto: number;
  movimientosExtracto: number;
  /** El valor del extracto coincide con el del RP (±$1). */
  cuadra: boolean;
  /** Rendimientos financieros que trae el extracto (informativo, no se usa para enviar). */
  rendimientos: number;
  nota: string | null;
};

export type ResultadoGastos = {
  grupos: GrupoBancario[];
  enviados: number;
  conError: number;
  mensajes: string[];
};

type Fila = {
  id: string;
  valor: number | string;
  estado: string;
  propuesta: { grupo?: string | null; motivos?: string[] } | null;
  motivos: string[] | null;
  siigo_id: string | null;
};

const clave = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

const RENDIMIENTO = /RENDIMIENTO|INTERESES? (GANADOS?|AHORROS?|ABONO)|ABONO INTERESES/;

const sinExtracto = (nota: string | null): VerificacionExtracto => ({
  disponible: false,
  valorExtracto: 0,
  movimientosExtracto: 0,
  cuadra: false,
  rendimientos: 0,
  nota,
});

/** Compara, por cuenta, los gastos bancarios del extracto del mes con los del RP único. */
async function verificarConExtractos(
  db: Db,
  companyId: string,
  periodo: string,
  totales: Map<string, number>,
): Promise<Map<string, VerificacionExtracto>> {
  const salida = new Map<string, VerificacionExtracto>();
  try {
    const [{ conciliacionFuentesCore }, { esGastoBancario }] = await Promise.all([
      import("./conciliacion.functions"),
      import("./conciliacion"),
    ]);
    const fuentes = await conciliacionFuentesCore(db, { companyId, periodo });
    const pdfs = new Set(fuentes.pdfs.map((x) => clave(x.etiqueta)));
    for (const [banco, esperado] of totales) {
      const c = fuentes.cuentas.find((x) => clave(x.etiqueta) === banco);
      if (!c || !c.movimientos.length) {
        salida.set(
          banco,
          sinExtracto(
            pdfs.has(banco)
              ? "extracto en PDF: se verifica desde la pantalla de Conciliación"
              : "sin extracto del mes en la carpeta «extractos»",
          ),
        );
        continue;
      }
      const cargos = c.movimientos.filter((m) => m.valor < 0 && esGastoBancario(m.descripcion));
      const valorExtracto = Math.round(cargos.reduce((t, m) => t - m.valor, 0));
      const rendimientos = Math.round(
        c.movimientos
          .filter((m) => m.valor > 0 && RENDIMIENTO.test(clave(m.descripcion)))
          .reduce((t, m) => t + m.valor, 0),
      );
      const cuadra = cargos.length > 0 && Math.abs(valorExtracto - esperado) <= 1;
      salida.set(banco, {
        disponible: true,
        valorExtracto,
        movimientosExtracto: cargos.length,
        cuadra,
        rendimientos,
        nota: cuadra
          ? null
          : `el extracto trae $${valorExtracto.toLocaleString("es-CO")} en ${cargos.length} cargos y el RP suma $${esperado.toLocaleString("es-CO")}`,
      });
    }
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 120);
    for (const banco of totales.keys())
      salida.set(banco, sinExtracto(`no se pudo leer el extracto (${msg})`));
  }
  return salida;
}

export async function procesarGastosBancarios(
  db: Db,
  companyId: string,
  op: { periodo: string; tope: number; enviar: boolean; cierre: boolean },
): Promise<ResultadoGastos> {
  const { data, error } = await db
    .from("egresos")
    .select("id, valor, estado, propuesta, motivos, siigo_id")
    .eq("company_id", companyId)
    .eq("period", op.periodo)
    .like("propuesta->>grupo", "bancario|%")
    .limit(2000);
  if (error) throw new Error(error.message);
  const porGrupo = new Map<string, Fila[]>();
  for (const f of (data ?? []) as Fila[]) {
    const g = f.propuesta?.grupo;
    if (g) porGrupo.set(g, [...(porGrupo.get(g) ?? []), f]);
  }
  const res: ResultadoGastos = { grupos: [], enviados: 0, conError: 0, mensajes: [] };
  const bancoDe = (grupo: string) => clave(grupo.replace(/^bancario\|/, ""));
  const totales = new Map<string, number>();
  for (const [grupo, lista] of porGrupo)
    totales.set(bancoDe(grupo), Math.round(lista.reduce((t, f) => t + Number(f.valor || 0), 0)));
  const extractos = totales.size
    ? await verificarConExtractos(db, companyId, op.periodo, totales)
    : new Map<string, VerificacionExtracto>();
  for (const [grupo, lista] of porGrupo) {
    const pendientes = lista.filter((f) => !f.siigo_id);
    const listos = pendientes.filter((f) => f.estado === "listo" || f.estado === "aprobado");
    const motivos = new Map<string, number>();
    for (const f of pendientes.filter((x) => !listos.includes(x)))
      for (const m of f.motivos ?? f.propuesta?.motivos ?? ["Sin completar"])
        motivos.set(m, (motivos.get(m) ?? 0) + 1);
    const faltante = [...motivos].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    res.grupos.push({
      grupo,
      banco: grupo.replace(/^bancario\|/, ""),
      movimientos: lista.length,
      valor: Math.round(lista.reduce((s, f) => s + Number(f.valor || 0), 0)),
      listos: listos.length,
      faltante,
      enviado: pendientes.length === 0,
      extracto: extractos.get(bancoDe(grupo)) ?? sinExtracto(null),
    });
  }
  if (!op.enviar || !op.cierre) return res;

  const { egresosEnviarGrupoBancarioCore } = await import("./egresos.functions");
  for (const g of res.grupos) {
    if (g.enviado) continue;
    const pendientes = (porGrupo.get(g.grupo) ?? []).filter((f) => !f.siigo_id).length;
    if (g.listos !== pendientes || g.faltante) {
      res.mensajes.push(
        `${g.banco}: no se envió, el grupo no está completo (${g.faltante ?? "faltan movimientos por completar"}).`,
      );
      continue;
    }
    if (!g.extracto.cuadra) {
      res.mensajes.push(
        `${g.banco}: no se envió, falta verificarlo con el extracto (${g.extracto.nota ?? "no coincide"}).`,
      );
      continue;
    }
    if (g.valor > op.tope) {
      res.mensajes.push(
        `${g.banco}: no se envió, el total supera el tope de aprobación automática.`,
      );
      continue;
    }
    try {
      const r = await egresosEnviarGrupoBancarioCore(db, {
        companyId,
        periodo: op.periodo,
        grupo: g.grupo,
      });
      if (!r.ok) throw new Error(r.message);
      res.enviados += 1;
      g.enviado = true;
    } catch (e) {
      res.conError += 1;
      res.mensajes.push(
        `${g.banco}: ${(e instanceof Error ? e.message : String(e)).slice(0, 250)}`,
      );
    }
  }
  return res;
}
