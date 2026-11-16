// Piloto automático — paso «Egresos: pagos del mes, CxP de Siigo y recibos de pago».
// Reutiliza el módulo Egresos de la aplicación (sincronizarCxP, proponerPeriodo, egresosEnviarCore):
//   1. Una vez por noche: lee las cuentas por pagar de Siigo y vuelve a proponer los pagos del mes de
//      trabajo (no toca Siigo ni crea recibos).
//   2. Evalúa cada pago con el semáforo estricto (piloto-verde.ts): solo el pago de facturas completo,
//      con forma de pago y bajo el tope es verde; abonos, anticipos, ajustes y gastos bancarios los
//      decide la usuaria.
//   3. Solo con el envío activo aprueba y crea el recibo de pago en Siigo (de a 2 por pasada), con las
//      validaciones y el bloqueo contra doble envío de «Enviar» de Egresos. Lo que falla no se reintenta solo.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type ResultadoEgresos = {
  /** Se sincronizaron las CxP y se volvió a proponer el mes en esta pasada. */
  preparado: boolean;
  evaluados: number;
  verdes: number;
  enviados: number;
  conError: number;
  verdesPendientes: number;
  porRevisar: Array<{ etiqueta: string; motivos: string[] }>;
  modoPrueba: boolean;
  primerError: string | null;
};

export async function procesarEgresos(
  db: Db,
  companyId: string,
  op: { periodo: string; tope: number; enviar: boolean; preparar: boolean; limite?: number },
): Promise<ResultadoEgresos> {
  const r: ResultadoEgresos = {
    preparado: false,
    evaluados: 0,
    verdes: 0,
    enviados: 0,
    conError: 0,
    verdesPendientes: 0,
    porRevisar: [],
    modoPrueba: !op.enviar,
    primerError: null,
  };
  const [{ sincronizarCxP, proponerPeriodo }, { egresosEnviarCore }, { motivosNoVerdeEgreso }] =
    await Promise.all([
      import("./egresos.server"),
      import("./egresos.functions"),
      import("./piloto-verde"),
    ]);

  if (op.preparar) {
    await sincronizarCxP(db, companyId);
    await proponerPeriodo(db, companyId, op.periodo);
    r.preparado = true;
  }

  const { data, error } = await db
    .from("egresos")
    .select("id, estado, siigo_id, propuesta, motivos, valor, descripcion, tercero_nombre, fecha")
    .eq("company_id", companyId)
    .eq("period", op.periodo)
    .is("siigo_id", null)
    .in("estado", ["listo", "aprobado", "por_revisar"])
    .order("fecha")
    .order("id")
    .limit(500);
  if (error) throw new Error(error.message);
  const filas = (data ?? []) as Array<{
    id: string;
    estado: string;
    siigo_id: string | null;
    propuesta: Record<string, unknown> | null;
    motivos: string[] | null;
    valor: number | string;
    descripcion: string | null;
    tercero_nombre: string | null;
    fecha: string;
  }>;
  r.evaluados = filas.length;

  const verdes: typeof filas = [];
  for (const f of filas) {
    const etiqueta = `${String(f.fecha).slice(0, 10)} · ${f.tercero_nombre ?? f.descripcion ?? f.id.slice(0, 8)}`;
    const motivos = motivosNoVerdeEgreso({
      estado: f.estado,
      siigoId: f.siigo_id,
      propuesta: f.propuesta as never,
      motivos: f.motivos ?? [],
      valor: Number(f.valor),
      tope: op.tope,
    });
    if (motivos.length) r.porRevisar.push({ etiqueta, motivos });
    else verdes.push(f);
  }
  r.verdes = verdes.length;
  if (!op.enviar) {
    r.verdesPendientes = verdes.length;
    return r;
  }

  const turno = verdes.slice(0, op.limite ?? 2);
  for (const f of turno) {
    const etiqueta = `${String(f.fecha).slice(0, 10)} · ${f.tercero_nombre ?? f.descripcion ?? f.id.slice(0, 8)}`;
    try {
      if (f.estado === "listo") {
        const { data: aprobado, error: e1 } = await db
          .from("egresos")
          .update({ estado: "aprobado" })
          .eq("id", f.id)
          .eq("estado", "listo")
          .is("siigo_id", null)
          .select("id");
        if (e1 || !aprobado?.length) throw new Error(e1?.message ?? "No se pudo aprobar el pago.");
      }
      const res = await egresosEnviarCore(db, f.id, null);
      if (!res.ok) throw new Error(res.message);
      r.enviados += 1;
    } catch (e) {
      r.conError += 1;
      const msg = e instanceof Error ? e.message : String(e);
      r.porRevisar.push({ etiqueta, motivos: [msg.slice(0, 300)] });
      r.primerError ??= msg.slice(0, 300);
    }
  }
  r.verdesPendientes = Math.max(0, verdes.length - turno.length);
  return r;
}
