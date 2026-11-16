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
