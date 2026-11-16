// Piloto automático — paso «Conciliación: movimiento de Siigo, cruce y memoria del día».
// SOLO LEE: junta los extractos del mes (carpeta «extractos» de Drive), trae el movimiento de bancos y caja
// desde la API de Siigo y cruza cada cuenta con el MISMO motor de la pantalla de Conciliación bancaria
// (armarConciliacion + conciliar). No registra nada en Siigo: los RP y RC que faltan, las diferencias y las
// partidas conciliatorias las decide la usuaria en la pantalla; aquí quedan contados en la memoria de la noche.
// Límites de esta versión: los extractos en PDF se leen en el navegador (no se concilian de noche) y el
// cruce de pasarelas de pago (Bold, Wompi) se hace desde la pantalla.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;

export type CuentaResumen = {
  etiqueta: string;
  movimientosBanco: number;
  cruzados: number;
  salidasSinRp: number;
  ingresosSinRc: number;
  diferencias: number;
  enLibrosSinBanco: number;
};

export type ResultadoConciliacionPiloto = {
  cuentas: CuentaResumen[];
  /** Cuentas de banco/caja que aún no tienen extracto del mes en formato que el servidor lee. */
  sinExtracto: string[];
  /** Cuentas cuyo extracto es un PDF (se concilian desde la aplicación). */
  soloPdf: string[];
  advertencias: string[];
};

const finDeMes = (periodo: string) => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

export async function conciliarMes(
  db: Db,
  companyId: string,
  periodo: string,
): Promise<ResultadoConciliacionPiloto> {
  const [{ conciliacionFuentesCore, conciliacionMovimientoSiigoCore }, motor] = await Promise.all([
    import("./conciliacion.functions"),
    import("./conciliacion"),
  ]);
  const { armarConciliacion, conciliar, partidasAlCorte } = motor;

  const fuentes = await conciliacionFuentesCore(db, { companyId, periodo });
  const salida: ResultadoConciliacionPiloto = {
    cuentas: [],
    sinExtracto: [],
    soloPdf: [],
    advertencias: [...fuentes.advertencias],
  };
  const pdfs = new Set(fuentes.pdfs.map((p) => p.etiqueta.toUpperCase()));
  const conExtracto = fuentes.cuentas.filter((c) => c.movimientos.length > 0);
  for (const c of fuentes.cuentas) {
    if (c.movimientos.length > 0) continue;
    (pdfs.has(c.etiqueta.toUpperCase()) ? salida.soloPdf : salida.sinExtracto).push(c.etiqueta);
  }
  if (!conExtracto.length) return salida;

  // Movimiento de bancos y caja del mes, desde la API de Siigo.
  const siigo = await conciliacionMovimientoSiigoCore(db, {
    companyId,
    desde: `${periodo}-01`,
    hasta: finDeMes(periodo),
  });
  salida.advertencias.push(...siigo.advertencias);

  const previasDe = (etiqueta: string) =>
    fuentes.anterior.find((a) => a.cuenta.toUpperCase() === etiqueta.toUpperCase())?.partidas ?? [];

  for (const c of conExtracto) {
    // Mismos documentos enviados desde la herramienta que arma la pantalla (lotes, ajustes y reclasificaciones).
    const enviados = fuentes.ajustes.filter((a) => a.siigoNombre);
    const armado = armarConciliacion({
      etiqueta: c.etiqueta,
      cuentaContable: c.cuentaContable,
      periodo,
      extracto: c.movimientos,
      auxiliar: siigo.filas,
      rpEnviados: fuentes.rpEnviados,
      rcApi: fuentes.rcApi,
      lotesEnviados: enviados
        .filter((a) => a.tipo === "lote" && a.detalle?.tipo !== "diferencia")
        .map((a) => ({
          id: `lote-${a.clave}`,
          fecha: a.fecha,
          comprobante: a.siigoNombre!,
          tercero: null,
          descripcion: `Lote de ${a.detalle?.lineas.length ?? 0} movimientos`,
          valor: a.valor,
          origen: "herramienta" as const,
          cuenta: a.cuenta,
          movimientos: (a.detalle?.lineas ?? []).map((l) => ({ fecha: l.fecha, valor: l.valor })),
        })),
      ajustesEnviados: [
        ...enviados
          .filter((a) => a.tipo === "lote" && a.detalle?.tipo === "diferencia")
          .flatMap((a) =>
            (a.detalle?.lineas ?? []).map((l, i) => ({
              id: `aj-${a.clave}-${i}`,
              fecha: a.fecha,
              comprobante: a.siigoNombre!,
              tercero: null,
              descripcion: "Ajuste en lote",
              valor: l.valor,
              origen: "herramienta" as const,
              cuenta: a.cuenta,
              ajusta: l.origen ?? "",
            })),
          ),
        ...enviados
          .filter((a) => a.tipo !== "reclasificacion" && a.tipo !== "lote")
          .map((a) => ({
            id: `aj-${a.clave}`,
            fecha: a.fecha,
            comprobante: a.siigoNombre!,
            tercero: null,
            descripcion: "Ajuste al peso",
            valor: a.valor,
            origen: "herramienta" as const,
            cuenta: a.cuenta,
            ajusta: a.origen ?? "",
          })),
      ],
      reclasificacionesEnviadas: enviados
        .filter((a) => a.tipo === "reclasificacion" && a.cuentaDestino)
        .flatMap((a) => [
          {
            id: `rcl-d-${a.clave}`,
            fecha: a.fecha,
            comprobante: a.siigoNombre!,
            tercero: null,
            descripcion: `Reclasificación de ${a.origen ?? ""} a ${a.cuentaDestino}`,
            valor: -a.valor,
            origen: "herramienta" as const,
            cuenta: a.cuenta,
            ajusta: a.origen ?? "",
          },
          {
            id: `rcl-h-${a.clave}`,
            fecha: a.fecha,
            comprobante: a.siigoNombre!,
            tercero: null,
            descripcion: `Reclasificación de ${a.origen ?? ""} desde ${a.cuenta}`,
            valor: a.valor,
            origen: "herramienta" as const,
            cuenta: a.cuentaDestino,
            ajusta: "",
          },
        ]),
      previas: previasDe(c.etiqueta),
      librosAnteriores: fuentes.librosAnteriores,
      pasarelas: fuentes.pasarelas.map((p) => p.plataforma),
    });
    const resultado = conciliar(armado);
    const partidas = partidasAlCorte(resultado);
    salida.cuentas.push({
      etiqueta: c.etiqueta,
      movimientosBanco: c.movimientos.length,
      cruzados: resultado.conciliados.length,
      salidasSinRp: resultado.faltaEnLibros.filter((m) => m.valor < 0).length,
      ingresosSinRc: resultado.faltaEnLibros.filter((m) => m.valor > 0).length,
      diferencias: resultado.diferencias.length,
      enLibrosSinBanco: partidas.filter((p) => p.tipo === "libros_sin_banco").length,
    });
  }
  return salida;
}
