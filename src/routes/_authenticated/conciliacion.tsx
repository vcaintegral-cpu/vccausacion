// Conciliación bancaria — núcleo global (todas las empresas).
// Cruza por cuenta (bancos y caja): extracto del mes, movimiento de Siigo (auxiliar subido,
// completado con RC de la API y RP enviados) y las partidas del corte anterior. Devuelve los
// RP que faltan, las diferencias en RC/ingresos y las partidas conciliatorias al corte.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { CloudDownload, Download, Loader2, RefreshCw, Save, Send, Upload } from "lucide-react";

import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany } from "@/components/app-shell";
import { cop, fecha } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readRawHistory } from "@/lib/history-raw";
import { supabase } from "@/integrations/supabase/client";
import { AccountCombobox, type PucOption } from "@/components/account-combobox";
import { TerceroCombobox, type TerceroOption } from "@/components/tercero-combobox";
import { egresosEnviar } from "@/lib/egresos.functions";
import {
  ajusteDeDiferencia,
  ajustesAlPeso,
  armarConciliacion,
  clavePartida,
  partidaDeBanco,
  partidaDeDiferencia,
  partidaDeLibro,
  conciliar,
  detectarCuentaErrada,
  diferenciaSinExplicar,
  fechaAuxiliar,
  partidasAlCorte,
  type AjustePropuesto,
  type LineaAuxiliar,
  type MovBanco,
  type MovLibro,
  type PartidaConciliatoria,
  type ResultadoConciliacion,
} from "@/lib/conciliacion";
import {
  leerConciliacionAnterior,
  leerExtractoBancolombia,
  leerExtractoGenerico,
  type Extracto,
} from "@/lib/lectores-extracto";
import { compararExtractos, leerExtractoPdf, type ComparacionExtractos } from "@/lib/extracto-pdf";
import { itemsDePdf } from "@/lib/extracto-pdf-navegador";
import {
  abonadoPorCuenta,
  citarAbonos,
  cruzarPasarela,
  type ResultadoPasarela,
} from "@/lib/pasarelas";
import {
  conciliacionCrearRpPasarela,
  conciliacionEnviarAjuste,
  conciliacionFuentes,
  conciliacionGuardar,
  conciliacionGuardarCuentasPasarela,
  conciliacionMovimientoSiigo,
  conciliacionReclasificar,
  conciliacionRegistrarLote,
  conciliacionRegistrarRc,
  conciliacionRegistrarRp,
  type FuentesConciliacion,
  type LoteDetalle,
} from "@/lib/conciliacion.functions";
import type { BalanceCuenta } from "@/lib/siigo-movimiento.server";

export const Route = createFileRoute("/_authenticated/conciliacion")({
  head: () => ({
    meta: [
      { title: "Conciliación bancaria" },
      {
        name: "description",
        content: "Extractos, movimiento de Siigo y partidas conciliatorias por banco y caja.",
      },
    ],
  }),
  component: Conciliacion,
});

const mesAnterior = () => {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const TIPO: Record<PartidaConciliatoria["tipo"], string> = {
  banco_sin_libros: "Banco sin libros",
  libros_sin_banco: "Libros sin banco",
  diferencia: "Diferencia",
};

type Calculo = {
  etiqueta: string;
  cuentaContable: string | null;
  resultado: ResultadoConciliacion;
  partidas: PartidaConciliatoria[];
  saldoExtractoInicial: number | null;
  saldoExtractoFinal: number | null;
  saldoLibrosInicial: number | null;
  saldoLibrosFinal: number | null;
  sinExplicar: number | null;
  movimientos: number;
  /** Diferencias dentro del tope del ajuste al peso aún sin ajustar en Siigo. */
  ajustes: AjustePropuesto[];
};

const leerPdfBase64 = async (base64: string) => {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return itemsDePdf(bytes);
};
const finDeMes = (periodo: string) => {
  const [a, m] = periodo.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

// Estado de la conciliación por empresa en memoria: se conserva al cambiar de panel dentro
// de la aplicación (se pierde al recargar la página).
const memoria = new Map<string, unknown>();
function usePersistente<T>(clave: string, inicial: T | (() => T)) {
  const [v, setV] = useState<T>(() =>
    memoria.has(clave)
      ? (memoria.get(clave) as T)
      : typeof inicial === "function"
        ? (inicial as () => T)()
        : inicial,
  );
  const set = useCallback(
    (u: SetStateAction<T>) =>
      setV((prev) => {
        const n = typeof u === "function" ? (u as (p: T) => T)(prev) : u;
        memoria.set(clave, n);
        return n;
      }),
    [clave],
  );
  return [v, set] as const;
}

function Conciliacion() {
  const companyId = useActiveCompany();
  if (!companyId) return <EmptyCompany />;
  return <ConciliacionEmpresa key={companyId} companyId={companyId} />;
}

function ConciliacionEmpresa({ companyId }: { companyId: string }) {
  const k = (n: string) => `${companyId}:${n}`;
  const [periodo, setPeriodo] = usePersistente(k("periodo"), mesAnterior());
  const [fuentes, setFuentes] = usePersistente<FuentesConciliacion | null>(k("fuentes"), null);
  const [auxiliar, setAuxiliar] = usePersistente<{ nombre: string; filas: LineaAuxiliar[] } | null>(
    k("auxiliar"),
    null,
  );
  const [anteriorSubida, setAnteriorSubida] = usePersistente<Map<string, PartidaConciliatoria[]>>(
    k("anteriorSubida"),
    new Map(),
  );
  const [cuentaAnterior, setCuentaAnterior] = usePersistente(k("cuentaAnterior"), "");
  const [extractosManual, setExtractosManual] = usePersistente<
    Record<
      string,
      {
        nombre: string;
        movimientos: MovBanco[];
        saldoInicial: number | null;
        saldoFinal: number | null;
      }
    >
  >(k("extractosManual"), {});
  const [extractosPdf, setExtractosPdf] = usePersistente<
    Record<string, { nombre: string; ext: Extracto; comparacion: ComparacionExtractos | null }>
  >(k("extractosPdf"), {});
  const [desde, setDesde] = usePersistente(k("desde"), "");
  const [hasta, setHasta] = usePersistente(k("hasta"), "");
  const [movSiigo, setMovSiigo] = usePersistente<{
    balance: BalanceCuenta[];
    advertencias: string[];
    documentos: number;
  } | null>(k("movSiigo"), null);
  const [cuentasPas, setCuentasPas] = usePersistente<{
    retefuente: string | null;
    reteiva: string | null;
    reteica: string | null;
  }>(k("cuentasPas"), { retefuente: null, reteiva: null, reteica: null });
  const [enviando, setEnviando] = useState<string | null>(null);
  const [saldosLibros, setSaldosLibros] = usePersistente<Record<string, string>>(
    k("saldosLibros"),
    {},
  );
  /** Cuentas cuyo saldo inicial de libros viene del balance de prueba actual de Siigo. */
  const [saldoDeBalance, setSaldoDeBalance] = usePersistente<Set<string>>(
    k("saldoDeBalance"),
    new Set(),
  );
  const [cuentaVista, setCuentaVista] = usePersistente<string | null>(k("cuentaVista"), null);
  const refAux = useRef<HTMLInputElement>(null);
  const refAnt = useRef<HTMLInputElement>(null);

  const cargar = useServerFn(conciliacionFuentes);
  const guardar = useServerFn(conciliacionGuardar);
  const traerSiigo = useServerFn(conciliacionMovimientoSiigo);
  const enviarAjuste = useServerFn(conciliacionEnviarAjuste);
  const reclasificar = useServerFn(conciliacionReclasificar);
  const crearRpPasarela = useServerFn(conciliacionCrearRpPasarela);
  const guardarCuentasPas = useServerFn(conciliacionGuardarCuentasPasarela);
  // PUC y terceros de la empresa (para registrar en Siigo desde la conciliación).
  const catalogos = useQuery({
    queryKey: ["conciliacion-catalogos", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const leer = async <T,>(
        q: (
          a: number,
          b: number,
        ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
      ) => {
        const out: T[] = [];
        for (let a = 0; ; a += 1000) {
          const { data, error } = await q(a, a + 999);
          if (error) throw new Error(error.message);
          const l = (data ?? []) as T[];
          out.push(...l);
          if (l.length < 1000) return out;
        }
      };
      const [puc, terceros] = await Promise.all([
        leer<PucOption>((a, b) =>
          supabase
            .from("puc_accounts")
            .select("code, name, active, level, parent_code, has_children, is_movement")
            .eq("company_id", companyId)
            .order("code")
            .range(a, b),
        ),
        leer<TerceroOption>((a, b) =>
          supabase
            .from("providers")
            .select("nit, name")
            .eq("company_id", companyId)
            .order("name")
            .range(a, b),
        ),
      ]);
      return { puc, terceros: terceros.filter((t) => t.nit && t.name) };
    },
  });
  const puc = { data: (catalogos.data?.puc ?? []).filter((c) => c.code.startsWith("1355")) };
  const registrarRp = useServerFn(conciliacionRegistrarRp);
  const registrarRc = useServerFn(conciliacionRegistrarRc);
  const registrarLote = useServerFn(conciliacionRegistrarLote);
  const enviarEgreso = useServerFn(egresosEnviar);
  const [notas, setNotas] = usePersistente<Record<string, string>>(k("notas"), {});
  const mFuentes = useMutation({
    /** silencioso: actualización en segundo plano al volver al panel (conserva lo hecho). */
    mutationFn: async (_opciones?: { silencioso?: boolean }) => {
      const f = await cargar({ data: { companyId: companyId, periodo } });
      // Extractos PDF de la bandeja: se leen aquí y se comparan con la hoja del reporte.
      const pdfs: typeof extractosPdf = {};
      for (const p of f.pdfs) {
        try {
          const ext = leerExtractoPdf(
            await leerPdfBase64(p.base64),
            `${p.etiqueta.slice(0, 3)}pdf`,
          );
          const hoja = f.cuentas.find((c) => c.etiqueta === p.etiqueta)?.movimientos ?? [];
          pdfs[p.etiqueta] = {
            nombre: p.nombre,
            ext,
            comparacion:
              hoja.length && ext.movimientos.length
                ? compararExtractos(ext.movimientos, hoja)
                : null,
          };
          for (const w of ext.advertencias) toast.warning(`${p.etiqueta}: ${w}`);
        } catch (e) {
          toast.error(`${p.nombre}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { f, pdfs };
    },
    onSuccess: ({ f, pdfs }, opciones) => {
      const silencioso = !!opciones?.silencioso;
      // En la actualización en segundo plano se conservan los PDF cargados a mano.
      setExtractosPdf((x) => (silencioso ? { ...pdfs, ...x } : pdfs));
      setNotas((x) => ({ ...f.notas, ...x }));
      if (!silencioso) setCuentasPas(f.cuentasPasarela);
      setDesde((d) => d || `${periodo}-01`);
      setHasta((h) => h || finDeMes(periodo));
      setFuentes(f);
      setCuentaVista((v) =>
        v && f.cuentas.some((c) => c.etiqueta === v) ? v : (f.cuentas[0]?.etiqueta ?? null),
      );
      // Saldo inicial de libros: el final guardado del mes anterior.
      const s: Record<string, string> = {};
      for (const a of f.anterior)
        if (a.saldoLibrosFinal != null) s[a.cuenta] = String(a.saldoLibrosFinal);
      setSaldosLibros((x) => ({ ...s, ...x }));
      if (silencioso) return;
      for (const w of f.advertencias) toast.warning(w);
      toast.success(
        `Fuentes cargadas: ${f.cuentas.filter((c) => c.movimientos.length || pdfs[c.etiqueta]).length} de ${f.cuentas.length} cuentas con extracto.`,
      );
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  // Al volver al panel con una conciliación en curso, se actualizan Siigo y la bandeja.
  useEffect(() => {
    if (fuentes) mFuentes.mutate({ silencioso: true });
    // Solo al montar el panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Extracto de cada cuenta: cargado a mano > PDF del banco (con las referencias de la hoja
  // del reporte, si la hay) > Excel de la bandeja u hoja del reporte.
  const base = useMemo(() => {
    const out: Record<
      string,
      { movimientos: MovBanco[]; saldoInicial: number | null; saldoFinal: number | null }
    > = {};
    for (const c of fuentes?.cuentas ?? []) {
      const manual = extractosManual[c.etiqueta];
      const pdf = extractosPdf[c.etiqueta];
      out[c.etiqueta] = manual
        ? manual
        : pdf
          ? {
              movimientos: pdf.comparacion?.oficialConRefs ?? pdf.ext.movimientos,
              saldoInicial: pdf.ext.saldoInicial,
              saldoFinal: pdf.ext.saldoFinal,
            }
          : { movimientos: c.movimientos, saldoInicial: c.saldoInicial, saldoFinal: c.saldoFinal };
    }
    return out;
  }, [fuentes, extractosManual, extractosPdf]);

  const previasDe = (etiqueta: string) =>
    fuentes?.anterior.find((a) => a.cuenta.toUpperCase() === etiqueta.toUpperCase())?.partidas ??
    anteriorSubida.get(etiqueta.toUpperCase()) ??
    [];

  // Pasarelas de pago: cobros vs RC (brutos) y abonos del banco (netos).
  const pasarelas = useMemo(() => {
    if (!fuentes?.pasarelas.length) return [];
    const codigos = new Set(fuentes.cuentas.map((c) => c.cuentaContable).filter(Boolean));
    const librosRc: MovLibro[] = [
      ...(auxiliar?.filas ?? [])
        .filter((l) => codigos.has(String(l.account_code ?? "").trim()) && Number(l.debit ?? 0) > 0)
        .map((l, i) => ({
          id: `rcaux-${i}`,
          fecha: fechaAuxiliar(l.entry_date_text) ?? "",
          comprobante: String(l.voucher ?? "").trim(),
          tercero: l.provider_name,
          descripcion: null,
          valor: Number(l.debit),
        })),
      ...fuentes.rcApi,
      ...fuentes.cuentas.flatMap((c) =>
        previasDe(c.etiqueta)
          .filter((p) => p.tipo === "libros_sin_banco" && p.valor > 0 && p.comprobante)
          .map((p, i) => ({
            id: `rcprev-${c.etiqueta}-${i}`,
            fecha: p.fecha,
            comprobante: p.comprobante!,
            tercero: p.tercero,
            descripcion: p.descripcion,
            valor: p.valor,
          })),
      ),
    ];
    // Un mismo RC puede estar en el auxiliar y en la API: una vez por comprobante.
    const vistos = new Set<string>();
    const unicos = librosRc.filter((l) => {
      const k = `${l.comprobante.toUpperCase()}|${l.valor}`;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    return fuentes.pasarelas.map((p) => {
      const patron = new RegExp(`\\b${p.plataforma.replace(/[^A-Za-z0-9]/g, "")}\\b`, "i");
      const abonos = fuentes.cuentas.flatMap((c) =>
        (base[c.etiqueta]?.movimientos ?? [])
          .filter((m) => m.valor > 0 && patron.test(m.descripcion))
          .map((mov) => ({ cuenta: c.etiqueta, mov })),
      );
      const r = cruzarPasarela({
        plataforma: p.plataforma,
        periodo,
        transacciones: p.transacciones,
        abonos,
        libros: unicos,
      });
      return { p, r, porCuenta: abonadoPorCuenta(r) };
    });
  }, [fuentes, base, auxiliar, anteriorSubida, periodo]);

  const calculos: Calculo[] = useMemo(() => {
    if (!fuentes) return [];
    const enviados = new Set(
      fuentes.ajustes
        .filter((a) => a.estado === "enviado" || a.estado === "enviando")
        .flatMap((a) => [a.clave, ...(a.detalle?.lineas ?? []).map((l) => l.clave)]),
    );
    return fuentes.cuentas.map((c) => {
      const b = base[c.etiqueta]!;
      const extracto = pasarelas.reduce((ms, x) => citarAbonos(ms, x.r), b.movimientos);
      const armado = armarConciliacion({
        etiqueta: c.etiqueta,
        cuentaContable: c.cuentaContable,
        periodo,
        extracto,
        auxiliar: auxiliar?.filas ?? [],
        rpEnviados: fuentes.rpEnviados,
        rcApi: fuentes.rcApi,
        // Lotes de RP/RC: un documento contra los movimientos del extracto que agrupa.
        lotesEnviados: fuentes.ajustes
          .filter((a) => a.tipo === "lote" && a.siigoNombre && a.detalle?.tipo !== "diferencia")
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
          // Lote de diferencias: un ajuste por línea dentro del mismo comprobante.
          ...fuentes.ajustes
            .filter((a) => a.tipo === "lote" && a.siigoNombre && a.detalle?.tipo === "diferencia")
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
          ...fuentes.ajustes
            .filter((a) => a.siigoNombre && a.tipo !== "reclasificacion" && a.tipo !== "lote")
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
        // Reclasificación enviada: sale de la cuenta errada (anula el RC/RP) y entra a la correcta.
        reclasificacionesEnviadas: fuentes.ajustes
          .filter((a) => a.siigoNombre && a.tipo === "reclasificacion" && a.cuentaDestino)
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
      const partidas = partidasAlCorte(resultado).map((p) => ({
        ...p,
        nota: notas[clavePartida(p)] || null,
      }));
      const saldoExtractoFinal = b.saldoFinal;
      const ini = saldosLibros[c.etiqueta];
      const saldoLibrosInicial = ini != null && ini !== "" ? Number(ini) : null;
      const saldoLibrosFinal =
        saldoLibrosInicial != null
          ? Math.round(
              (saldoLibrosInicial +
                armado.movimientoLibros +
                // El saldo del balance de prueba actual ya incluye lo registrado con fecha
                // de meses anteriores; el de la conciliación anterior no.
                (saldoDeBalance.has(c.etiqueta) ? 0 : armado.movimientoAnterior)) *
                100,
            ) / 100
          : null;
      return {
        etiqueta: c.etiqueta,
        cuentaContable: c.cuentaContable,
        resultado,
        partidas,
        saldoExtractoInicial: b.saldoInicial,
        saldoExtractoFinal,
        saldoLibrosInicial,
        saldoLibrosFinal,
        sinExplicar:
          saldoExtractoFinal != null && saldoLibrosFinal != null
            ? diferenciaSinExplicar({
                saldoExtracto: saldoExtractoFinal,
                saldoLibros: saldoLibrosFinal,
                partidas,
              })
            : null,
        movimientos: extracto.length,
        ajustes: ajustesAlPeso(resultado, c.etiqueta, fuentes.ajusteCuentas.tope).filter(
          (a) => !enviados.has(a.clave),
        ),
      };
    });
  }, [
    fuentes,
    base,
    pasarelas,
    anteriorSubida,
    auxiliar,
    saldosLibros,
    saldoDeBalance,
    periodo,
    notas,
  ]);

  // RC/RP registrados en otra cuenta bancaria (aún sin reclasificar en Siigo).
  const cuentaErrada = useMemo(() => {
    const hechas = new Set(
      (fuentes?.ajustes ?? [])
        .filter((a) => a.tipo === "reclasificacion" && (a.siigoNombre || a.estado === "enviando"))
        .map((a) => a.clave),
    );
    return detectarCuentaErrada(calculos).filter((r) => !hechas.has(r.clave));
  }, [calculos, fuentes]);
  /** Líneas marcadas por lista («CUENTA|tipo» → claves) para las acciones en lote. */
  const [seleccion, setSeleccion] = usePersistente<Record<string, string[]>>(k("seleccion"), {});
  const [marcadas, setMarcadas] = usePersistente<Set<string>>(k("marcadas"), new Set());

  const subirAuxiliar = async (file: File) => {
    try {
      const raw = await readRawHistory(file);
      setAuxiliar({ nombre: file.name, filas: raw.rows });
      toast.success(`Auxiliar de Siigo: ${raw.rows.length} movimientos leídos.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const subirAnterior = async (file: File) => {
    try {
      const r = leerConciliacionAnterior(
        await file.arrayBuffer(),
        cuentaAnterior || fuentes?.cuentas[0]?.etiqueta || "",
        fuentes?.cuentas ?? [],
        !!cuentaAnterior,
      );
      setAnteriorSubida((x) => {
        const n = new Map(x);
        for (const [k, v] of r.porCuenta) n.set(k, v);
        return n;
      });
      // El saldo final en libros del corte anterior es el saldo inicial de este mes.
      setSaldosLibros((x) => {
        const n = { ...x };
        for (const [k, sld] of r.saldos) {
          const et = fuentes?.cuentas.find((c) => c.etiqueta.toUpperCase() === k)?.etiqueta ?? k;
          if (sld.libros != null && (n[et] == null || n[et] === "")) n[et] = String(sld.libros);
        }
        return n;
      });
      for (const w of r.advertencias) toast.warning(w);
      toast.success(
        [...r.porCuenta]
          .map(([k, v]) =>
            v.length
              ? `${k}: ${v.length} partidas conciliatorias`
              : `${k}: conciliada sin partidas pendientes`,
          )
          .join(" · ") || "No se encontraron partidas en el archivo.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const subirExtracto = async (etiqueta: string, file: File) => {
    const bytes = await file.arrayBuffer();
    let ext: Extracto;
    if (/\.pdf$/i.test(file.name)) {
      try {
        ext = leerExtractoPdf(await itemsDePdf(bytes), `${etiqueta.slice(0, 3)}pdf`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        return;
      }
      for (const w of ext.advertencias) toast.warning(`${etiqueta}: ${w}`);
      // Con la hoja del reporte de la cuenta: se compara y se toman sus referencias.
      const hoja = fuentes?.cuentas.find((c) => c.etiqueta === etiqueta)?.movimientos ?? [];
      if (hoja.length && ext.movimientos.length) {
        const comparacion = compararExtractos(ext.movimientos, hoja);
        setExtractosPdf((x) => ({ ...x, [etiqueta]: { nombre: file.name, ext, comparacion } }));
        setExtractosManual((x) => {
          const n = { ...x };
          delete n[etiqueta];
          return n;
        });
        toast.success(
          `${etiqueta}: ${ext.movimientos.length} movimientos del PDF; ${comparacion.faltanEnRelacion.length} no reportados en la hoja.`,
        );
        return;
      }
    } else {
      ext = leerExtractoBancolombia(bytes, etiqueta.slice(0, 3));
      if (!ext.movimientos.length) ext = leerExtractoGenerico(bytes, etiqueta.slice(0, 3));
    }
    if (!ext.movimientos.length) {
      toast.error(`No se encontraron movimientos en ${file.name}.`);
      return;
    }
    setExtractosManual((x) => ({
      ...x,
      [etiqueta]: {
        nombre: file.name,
        movimientos: ext.movimientos,
        saldoInicial: ext.saldoInicial,
        saldoFinal: ext.saldoFinal,
      },
    }));
    toast.success(`${etiqueta}: ${ext.movimientos.length} movimientos de ${file.name}.`);
  };

  const onTraerSiigo = async () => {
    if (!desde || !hasta) return;
    setEnviando("siigo");
    try {
      const r = await traerSiigo({ data: { companyId, desde, hasta } });
      setAuxiliar({ nombre: `Siigo API ${desde} a ${hasta}`, filas: r.filas });
      setMovSiigo({ balance: r.balance, advertencias: r.advertencias, documentos: r.documentos });
      // Saldo inicial de libros: el del balance de prueba de Siigo.
      if (r.balance.length && fuentes)
        setSaldosLibros((x) => {
          const n = { ...x };
          for (const c of fuentes.cuentas) {
            const b = r.balance.find((y) => y.cuenta === c.cuentaContable);
            if (b) n[c.etiqueta] = String(b.saldoInicial);
          }
          return n;
        });
      if (r.balance.length && fuentes)
        setSaldoDeBalance(
          new Set(
            fuentes.cuentas
              .filter((c) => r.balance.some((y) => y.cuenta === c.cuentaContable))
              .map((c) => c.etiqueta),
          ),
        );
      for (const w of r.advertencias) toast.warning(w);
      toast.success(
        `Movimiento de Siigo: ${r.filas.length} movimientos de bancos y caja en ${r.documentos} documentos.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(null);
    }
  };
  const descargarMovimiento = () => {
    if (!auxiliar) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        auxiliar.filas.map((f) => ({
          Cuenta: f.account_code ?? "",
          Comprobante: f.voucher ?? "",
          Fecha: f.entry_date_text ?? "",
          NIT: f.provider_nit ?? "",
          Tercero: f.provider_name ?? "",
          Descripción: f.description ?? "",
          Débito: f.debit ?? 0,
          Crédito: f.credit ?? 0,
        })),
      ),
      "Movimiento",
    );
    XLSX.writeFile(wb, `Movimiento_bancos_${desde}_${hasta}.xlsx`);
  };
  const onEnviarAjuste = async (cuenta: string, a: AjustePropuesto) => {
    setEnviando(a.clave);
    try {
      const r = await enviarAjuste({ data: { companyId, periodo, cuenta, ajuste: a } });
      if (r.ok) toast.success(r.mensaje);
      else toast.error(r.mensaje);
      mFuentes.mutate({ silencioso: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(null);
    }
  };
  /** Registra en Siigo una línea del extracto o una diferencia, con la cuenta y el tercero escogidos. */
  const onRegistrar = async (
    cuenta: string,
    linea:
      | { tipo: "salida" | "entrada"; mov: MovBanco }
      | { tipo: "diferencia"; ajuste: AjustePropuesto },
    f: {
      terceroNit: string;
      terceroNombre: string | null;
      cuenta: string;
      descripcion: string;
      enviar: boolean;
    },
  ) => {
    const k = "ajuste" in linea ? linea.ajuste.clave : linea.mov.id;
    setEnviando(`reg-${k}`);
    try {
      if (linea.tipo === "salida") {
        const r = await registrarRp({
          data: {
            companyId,
            periodo,
            cuenta,
            mov: {
              fecha: linea.mov.fecha,
              descripcion: linea.mov.descripcion,
              valor: linea.mov.valor,
            },
            terceroNit: f.terceroNit,
            terceroNombre: f.terceroNombre,
            cuentaDebito: f.cuenta,
            descripcion: f.descripcion,
            aprobar: f.enviar,
          },
        });
        if (f.enviar && r.estado === "aprobado") {
          const e = await enviarEgreso({ data: { egresoId: r.id } });
          if (e.ok) toast.success(e.message);
          else toast.error(e.message);
        } else toast.success(r.mensaje);
      } else if (linea.tipo === "entrada") {
        const r = await registrarRc({
          data: {
            companyId,
            periodo,
            cuenta,
            mov: {
              fecha: linea.mov.fecha,
              descripcion: linea.mov.descripcion,
              valor: linea.mov.valor,
            },
            terceroNit: f.terceroNit,
            cuentaCredito: f.cuenta,
            descripcion: f.descripcion,
          },
        });
        if (r.ok) toast.success(r.mensaje);
        else toast.error(r.mensaje);
      } else if ("ajuste" in linea) {
        const r = await enviarAjuste({
          data: {
            companyId,
            periodo,
            cuenta,
            ajuste: {
              ...linea.ajuste,
              terceroNit: f.terceroNit || linea.ajuste.terceroNit,
              descripcion: f.descripcion || linea.ajuste.descripcion,
            },
            contrapartida: f.cuenta,
          },
        });
        if (r.ok) toast.success(r.mensaje);
        else toast.error(r.mensaje);
      }
      mFuentes.mutate({ silencioso: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(null);
    }
  };
  /** Registra en Siigo en un solo documento las líneas marcadas de una lista. */
  const onLote = async (cuenta: string, lista: string, detalle: LoteDetalle, f: FormRegistro) => {
    setEnviando(`lote-${lista}`);
    try {
      const r = await registrarLote({
        data: {
          companyId,
          periodo,
          cuenta,
          detalle,
          terceroNit: f.terceroNit,
          contrapartida: f.cuenta,
          descripcion: f.descripcion,
        },
      });
      if (r.ok) {
        toast.success(r.mensaje);
        setSeleccion((x) => ({ ...x, [lista]: [] }));
      } else toast.error(r.mensaje);
      mFuentes.mutate({ silencioso: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(null);
    }
  };
  /** Deja como partida conciliatoria, con la misma nota, las líneas marcadas de una lista. */
  const onPartidaLote = (lista: string, clavesPartida: string[], nota: string) => {
    setNotas((x) => {
      const n = { ...x };
      for (const c of clavesPartida) n[c] = nota.trim() || "Partida conciliatoria";
      return n;
    });
    setSeleccion((x) => ({ ...x, [lista]: [] }));
    toast.success(
      `${clavesPartida.length} línea(s) quedan como partida conciliatoria; se guardan con «Guardar conciliación».`,
    );
  };
  const onReclasificar = async () => {
    const items = cuentaErrada.filter((r) => marcadas.has(r.clave));
    if (!items.length) return;
    setEnviando("reclasificar");
    try {
      const { resultados } = await reclasificar({ data: { companyId, periodo, items } });
      const ok = resultados.filter((r) => r.ok).length;
      if (ok) toast.success(`${ok} recibo(s) reclasificado(s) en Siigo.`);
      for (const r of resultados.filter((x) => !x.ok)) toast.error(r.mensaje);
      setMarcadas(new Set());
      mFuentes.mutate({ silencioso: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(null);
    }
  };
  const onCrearRp = async (plataforma: string, cuenta: string, r: ResultadoPasarela) => {
    const abonado = abonadoPorCuenta(r).get(cuenta);
    if (!abonado) return;
    setEnviando(`rp-${plataforma}-${cuenta}`);
    try {
      await guardarCuentasPas({ data: { companyId, ...cuentasPas } });
      const x = await crearRpPasarela({
        data: {
          companyId,
          periodo,
          plataforma,
          cuenta,
          abonado,
          detalle: `${abonado.cobros} cobros abonados en ${cuenta}: valor ${abonado.bruto}, neto ${abonado.neto}, descuentos ${abonado.deducciones}.`,
        },
      });
      toast.success(x.mensaje);
      mFuentes.mutate({ silencioso: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(null);
    }
  };

  const exportar = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        calculos.map((c) => ({
          Cuenta: c.etiqueta,
          "Cuenta contable": c.cuentaContable ?? "",
          "Saldo extracto inicial": c.saldoExtractoInicial ?? "",
          "Saldo extracto final": c.saldoExtractoFinal ?? "",
          "Saldo libros inicial": c.saldoLibrosInicial ?? "",
          "Saldo libros final": c.saldoLibrosFinal ?? "",
          "Banco sin libros": c.partidas
            .filter((p) => p.tipo === "banco_sin_libros")
            .reduce((s, p) => s + p.valor, 0),
          "Libros sin banco": c.partidas
            .filter((p) => p.tipo === "libros_sin_banco")
            .reduce((s, p) => s + p.valor, 0),
          Diferencias: c.partidas
            .filter((p) => p.tipo === "diferencia")
            .reduce((s, p) => s + p.valor, 0),
          "Diferencia sin explicar": c.sinExplicar ?? "",
        })),
      ),
      "Resumen",
    );
    // Partidas al corte en el formato que la herramienta vuelve a leer el mes siguiente.
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        calculos.flatMap((c) =>
          c.partidas.map((p) => ({
            Cuenta: c.etiqueta,
            Tipo: TIPO[p.tipo],
            Fecha: p.fecha,
            Descripción: p.descripcion,
            Comprobante: p.comprobante ?? "",
            Tercero: p.tercero ?? "",
            Valor: p.valor,
            Nota: p.nota ?? "",
          })),
        ),
      ),
      "Partidas",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        calculos.flatMap((c) =>
          c.resultado.faltaEnLibros
            .filter((b) => b.valor < 0)
            .map((b) => ({
              Cuenta: c.etiqueta,
              Fecha: b.fecha,
              Descripción: b.descripcion,
              Valor: -b.valor,
              "Del mes anterior": b.previa ? "Sí" : "",
            })),
        ),
      ),
      "RP faltantes",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        ...calculos.flatMap((c) =>
          c.resultado.diferencias.map((d) => ({
            Cuenta: c.etiqueta,
            Tipo: "Diferencia de valor",
            Fecha: d.banco[0]?.fecha ?? "",
            Banco: d.banco.map((b) => b.descripcion).join(" + "),
            "Valor banco": d.banco.reduce((s, b) => s + b.valor, 0),
            Comprobante: d.libros.map((l) => l.comprobante).join(", "),
            "Valor Siigo": d.libros.reduce((s, l) => s + l.valor, 0),
            Diferencia: d.diferencia,
          })),
        ),
        ...calculos.flatMap((c) =>
          c.resultado.faltaEnLibros
            .filter((b) => b.valor > 0)
            .map((b) => ({
              Cuenta: c.etiqueta,
              Tipo: "Ingreso sin RC",
              Fecha: b.fecha,
              Banco: b.descripcion,
              "Valor banco": b.valor,
              Comprobante: (b.refs ?? []).join(", "),
              "Valor Siigo": 0,
              Diferencia: b.valor,
            })),
        ),
      ]),
      "Diferencias RC e ingresos",
    );
    for (const c of calculos)
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          c.resultado.conciliados.flatMap((x) =>
            x.banco.map((b) => ({
              Fecha: b.fecha,
              Banco: b.descripcion,
              Valor: b.valor,
              Comprobante: x.libros.map((l) => l.comprobante).join(", "),
              Criterio: x.criterio,
            })),
          ),
        ),
        `Conciliado ${c.etiqueta}`.slice(0, 31),
      );
    for (const { p, r } of pasarelas)
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          r.cobros.map((c) => ({
            Fecha: c.t.fecha,
            Transacción: c.t.id,
            Pagador: c.t.pagador ?? "",
            Valor: c.t.bruto,
            Comisión: c.t.comision,
            "IVA comisión": c.t.ivaComision,
            Retefuente: c.t.retefuente,
            "Rete IVA": c.t.reteiva,
            "Rete ICA": c.t.reteica,
            Neto: c.t.neto,
            RC: c.rc?.comprobantes.join(", ") ?? "SIN RC",
            "Valor RC": c.rc?.valor ?? "",
            "Diferencia RC": c.difRc || "",
            Abono: c.abono
              ? (() => {
                  const a = r.abonos.find((x) => x.mov.id === c.abono);
                  return a ? `${a.cuenta} ${a.mov.fecha} ${a.mov.valor}` : c.abono;
                })()
              : "Sin abono en el mes",
            Estimada: c.t.estimada ? "Sí" : "",
          })),
        ),
        `Pasarela ${p.plataforma}`.slice(0, 31),
      );
    for (const [etiqueta, x] of Object.entries(extractosPdf))
      if (x.comparacion)
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet([
            ...x.comparacion.faltanEnRelacion.map((m) => ({
              Tipo: "En el extracto y no en la hoja",
              Fecha: m.fecha,
              Descripción: m.descripcion,
              Valor: m.valor,
            })),
            ...x.comparacion.sobranEnRelacion.map((m) => ({
              Tipo: "En la hoja y no en el extracto",
              Fecha: m.fecha,
              Descripción: m.descripcion,
              Valor: m.valor,
            })),
            ...x.comparacion.fechaDistinta.map(([o, h]) => ({
              Tipo: `Fecha distinta (hoja ${h.fecha})`,
              Fecha: o.fecha,
              Descripción: o.descripcion,
              Valor: o.valor,
            })),
          ]),
          `PDF vs hoja ${etiqueta}`.slice(0, 31),
        );
    XLSX.writeFile(wb, `Conciliacion_bancaria_${periodo}.xlsx`);
  };

  const onGuardar = async () => {
    try {
      const r = await guardar({
        data: {
          companyId,
          periodo,
          cuentas: calculos.map((c) => ({
            etiqueta: c.etiqueta,
            cuentaContable: c.cuentaContable,
            saldoExtractoInicial: c.saldoExtractoInicial,
            saldoExtractoFinal: c.saldoExtractoFinal,
            saldoLibrosInicial: c.saldoLibrosInicial,
            saldoLibrosFinal: c.saldoLibrosFinal,
            partidas: c.partidas,
            resumen: {
              conciliados: c.resultado.conciliados.length,
              diferencias: c.resultado.diferencias.length,
              faltaEnLibros: c.resultado.faltaEnLibros.length,
              sobraEnLibros: c.resultado.sobraEnLibros.length,
              sinExplicar: c.sinExplicar,
              auxiliar: auxiliar?.nombre ?? null,
            },
          })),
        },
      });
      toast.success(
        `Conciliación de ${periodo} guardada (${r.guardadas} cuentas): sus partidas se usarán en el mes siguiente.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const vista = calculos.find((c) => c.etiqueta === cuentaVista) ?? calculos[0] ?? null;
  type ItemLote = {
    clave: string;
    partida: PartidaConciliatoria;
    linea: LoteDetalle["lineas"][number] | null;
  };
  const propsLote = (
    etiqueta: string,
    tipo: "salida" | "entrada" | "diferencia" | "libros",
    items: ItemLote[],
  ) => {
    const lista = `${etiqueta}|${tipo}`;
    const marcadasL = new Set(seleccion[lista] ?? []);
    const elegidos = items.filter((i) => marcadasL.has(i.clave));
    const registrables = elegidos.filter((i) => i.linea);
    return {
      seleccion: {
        claves: items.map((i) => i.clave),
        marcadas: marcadasL,
        onCambiar: (cs: string[], marcar: boolean) =>
          setSeleccion((x) => {
            const n = new Set(x[lista] ?? []);
            for (const c of cs) {
              if (marcar) n.add(c);
              else n.delete(c);
            }
            return { ...x, [lista]: [...n] };
          }),
      },
      lote: elegidos.length ? (
        <LoteBar
          key={lista}
          tipo={tipo}
          n={elegidos.length}
          total={elegidos.reduce((t, i) => t + i.partida.valor, 0)}
          noRegistrables={elegidos.length - registrables.length}
          puc={catalogos.data?.puc ?? []}
          terceros={catalogos.data?.terceros ?? []}
          ocupado={enviando === `lote-${lista}`}
          onPartida={(nota) =>
            onPartidaLote(
              lista,
              elegidos.map((i) => clavePartida(i.partida)),
              nota,
            )
          }
          {...(tipo !== "libros" && registrables.length
            ? {
                onRegistrar: (f: FormRegistro) =>
                  void onLote(
                    etiqueta,
                    lista,
                    {
                      tipo: tipo as LoteDetalle["tipo"],
                      lineas: registrables.map((i) => i.linea!),
                    },
                    f,
                  ),
              }
            : {})}
        />
      ) : null,
    };
  };
  const itemBanco = (b: MovBanco): ItemLote => {
    const partida = partidaDeBanco(b);
    const clave = clavePartida(partida);
    return {
      clave,
      partida,
      linea: { clave, fecha: b.fecha, descripcion: b.descripcion, valor: b.valor },
    };
  };
  const accion = (
    etiqueta: string,
    tipo: "salida" | "entrada" | "diferencia" | "libros",
    partida: PartidaConciliatoria,
    opciones: {
      id: string;
      sugerido?: { nit: string | null; nombre: string | null };
      registrar?: (f: FormRegistro) => void;
    },
  ) => {
    const k = clavePartida(partida);
    return (
      <AccionLinea
        tipo={tipo}
        nota={notas[k] ?? ""}
        onNota={(n) => setNotas((x) => ({ ...x, [k]: n }))}
        puc={catalogos.data?.puc ?? []}
        terceros={catalogos.data?.terceros ?? []}
        sugerido={opciones.sugerido ?? { nit: null, nombre: null }}
        descripcion={partida.descripcion.slice(0, 120)}
        ocupado={enviando === `reg-${opciones.id}`}
        {...(opciones.registrar ? { onRegistrar: opciones.registrar } : {})}
      />
    );
  };
  const fuenteVista = fuentes?.cuentas.find((c) => c.etiqueta === vista?.etiqueta);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Conciliación bancaria</h1>
          <p className="text-xs text-muted-foreground">
            Extractos del mes, movimiento de Siigo y partidas del corte anterior → RP faltantes,
            diferencias en RC/ingresos y partidas conciliatorias al corte.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="month"
            value={periodo}
            onChange={(e) => {
              // Cambiar de mes empieza una conciliación nueva.
              setPeriodo(e.target.value);
              setFuentes(null);
              setAuxiliar(null);
              setAnteriorSubida(new Map());
              setExtractosManual({});
              setExtractosPdf({});
              setNotas({});
              setMarcadas(new Set());
              setSaldosLibros({});
              setSaldoDeBalance(new Set());
              setMovSiigo(null);
              setDesde("");
              setHasta("");
              setSeleccion({});
            }}
            className="h-8 w-40"
          />
          <Button size="sm" onClick={() => mFuentes.mutate({})} disabled={mFuentes.isPending}>
            {mFuentes.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            Cargar extractos y movimientos
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-3 text-xs">
          <div className="font-semibold">1. Movimiento de Siigo (bancos y caja)</div>
          <div className="text-muted-foreground">
            Reporte «Movimiento auxiliar por cuenta contable» de Siigo del mes, de las cuentas de
            bancos y caja. Se completa con los RC de la API de Siigo y los RP enviados desde la
            herramienta que no estén en el auxiliar.
          </div>
          <input
            ref={refAux}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void subirAuxiliar(f);
              e.target.value = "";
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => refAux.current?.click()}>
              <Upload className="mr-1 h-4 w-4" />{" "}
              {auxiliar ? `Movimiento: ${auxiliar.nombre}` : "Subir auxiliar de Siigo"}
            </Button>
            <span className="text-muted-foreground">o traerlo de Siigo:</span>
            <Input
              type="date"
              className="h-8 w-36"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
            />
            <Input
              type="date"
              className="h-8 w-36"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onTraerSiigo()}
              disabled={!fuentes || !desde || !hasta || enviando === "siigo"}
            >
              {enviando === "siigo" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CloudDownload className="mr-1 h-4 w-4" />
              )}
              Traer de Siigo
            </Button>
            {auxiliar ? (
              <Button size="sm" variant="ghost" onClick={descargarMovimiento}>
                <Download className="mr-1 h-4 w-4" /> Descargar movimiento
              </Button>
            ) : null}
          </div>
          {movSiigo && fuentes ? (
            <div className="mt-2 space-y-1">
              <div className="text-muted-foreground">
                Validación contra el balance de prueba de Siigo ({movSiigo.documentos} documentos
                leídos):
              </div>
              {fuentes.cuentas.map((c) => {
                const b = movSiigo.balance.find((x) => x.cuenta === c.cuentaContable);
                const filas = (auxiliar?.filas ?? []).filter(
                  (f) => String(f.account_code ?? "").trim() === c.cuentaContable,
                );
                const deb = filas.reduce((s, f) => s + Number(f.debit ?? 0), 0);
                const cre = filas.reduce((s, f) => s + Number(f.credit ?? 0), 0);
                const dif = b
                  ? Math.round((b.debitos - deb - (b.creditos - cre)) * 100) / 100
                  : null;
                return (
                  <div
                    key={c.etiqueta}
                    className={dif != null && Math.abs(dif) >= 0.01 ? "text-amber-700" : ""}
                  >
                    • {c.etiqueta} ({c.cuentaContable}):{" "}
                    {b
                      ? Math.abs(dif!) < 0.01 && Math.abs(b.debitos - deb) < 0.01
                        ? `completo (débitos ${cop(deb)}, créditos ${cop(cre)}; saldo inicial ${cop(b.saldoInicial)}, final ${cop(b.saldoFinal)})`
                        : `incompleto: el balance tiene débitos ${cop(b.debitos)} / créditos ${cop(b.creditos)} y la API reconstruyó ${cop(deb)} / ${cop(cre)}. Sube el auxiliar de esta cuenta.`
                      : "sin dato en el balance de prueba"}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border bg-card p-3 text-xs">
          <div className="font-semibold">2. Conciliación del mes anterior</div>
          <div className="text-muted-foreground">
            {fuentes?.anterior.length
              ? `Se usa la conciliación guardada del mes anterior (${fuentes.anterior.map((a) => `${a.cuenta}: ${a.partidas.length} partidas`).join(", ")}).`
              : "Primera vez: sube los Excel de la conciliación del mes anterior (puedes elegir varios). El reporte trae la cuenta contable y se asigna solo; si el archivo no la trae, elige la cuenta."}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className="h-8 rounded border bg-background px-1"
              value={cuentaAnterior}
              onChange={(e) => setCuentaAnterior(e.target.value)}
            >
              <option value="">Cuenta (si el archivo no la trae)</option>
              {(fuentes?.cuentas ?? []).map((c) => (
                <option key={c.etiqueta} value={c.etiqueta}>
                  {c.etiqueta}
                </option>
              ))}
            </select>
            <input
              ref={refAnt}
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="hidden"
              onChange={(e) => {
                // Una conciliación por cuenta: se pueden elegir varias a la vez.
                const fs = [...(e.target.files ?? [])];
                e.target.value = "";
                void (async () => {
                  for (const f of fs) await subirAnterior(f);
                })();
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => refAnt.current?.click()}
              disabled={!fuentes}
            >
              <Upload className="mr-1 h-4 w-4" /> Subir conciliación anterior
            </Button>
            {anteriorSubida.size ? (
              <span>{[...anteriorSubida].map(([k, v]) => `${k}: ${v.length}`).join(" · ")}</span>
            ) : null}
          </div>
        </div>
      </div>

      {fuentes ? (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2">Cuenta</th>
                  <th className="p-2">Extracto</th>
                  <th className="p-2 text-right">Saldo extracto</th>
                  <th className="p-2">Saldo inicial libros</th>
                  <th className="p-2 text-right">Saldo final libros</th>
                  <th className="p-2 text-right">Conciliados</th>
                  <th className="p-2 text-right">RP faltantes</th>
                  <th className="p-2 text-right">Ingresos sin RC / diferencias</th>
                  <th className="p-2 text-right">Sin explicar</th>
                </tr>
              </thead>
              <tbody>
                {calculos.map((c) => {
                  const f = fuentes.cuentas.find((x) => x.etiqueta === c.etiqueta);
                  return (
                    <tr
                      key={c.etiqueta}
                      className={`cursor-pointer border-t ${vista?.etiqueta === c.etiqueta ? "bg-muted/40" : ""}`}
                      onClick={() => setCuentaVista(c.etiqueta)}
                    >
                      <td className="p-2 font-medium">
                        {c.etiqueta}{" "}
                        <span className="text-muted-foreground">{c.cuentaContable}</span>
                      </td>
                      <td className="p-2">
                        {extractosManual[c.etiqueta]?.nombre ??
                          extractosPdf[c.etiqueta]?.nombre ??
                          f?.fuente ?? <span className="text-amber-700">sin extracto</span>}{" "}
                        · {c.movimientos} mov.
                        <label
                          className="ml-2 cursor-pointer text-blue-700 underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          cargar
                          <input
                            type="file"
                            accept=".xlsx,.xls,.pdf"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void subirExtracto(c.etiqueta, file);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      </td>
                      <td className="p-2 text-right">
                        {c.saldoExtractoFinal != null ? cop(c.saldoExtractoFinal) : "—"}
                      </td>
                      <td className="p-2" onClick={(e) => e.stopPropagation()}>
                        <Input
                          className="h-7 w-36"
                          type="number"
                          value={saldosLibros[c.etiqueta] ?? ""}
                          placeholder="Saldo 1.º del mes"
                          onChange={(e) => {
                            setSaldosLibros((x) => ({ ...x, [c.etiqueta]: e.target.value }));
                            setSaldoDeBalance((x) => {
                              const n = new Set(x);
                              n.delete(c.etiqueta);
                              return n;
                            });
                          }}
                        />
                      </td>
                      <td className="p-2 text-right">
                        {c.saldoLibrosFinal != null ? cop(c.saldoLibrosFinal) : "—"}
                      </td>
                      <td className="p-2 text-right">{c.resultado.conciliados.length}</td>
                      <td className="p-2 text-right">
                        {c.resultado.faltaEnLibros.filter((b) => b.valor < 0).length}
                      </td>
                      <td className="p-2 text-right">
                        {c.resultado.faltaEnLibros.filter((b) => b.valor > 0).length +
                          c.resultado.diferencias.length}
                      </td>
                      <td
                        className={`p-2 text-right font-medium ${c.sinExplicar != null && Math.abs(c.sinExplicar) >= 0.01 ? "text-red-700" : "text-emerald-700"}`}
                      >
                        {c.sinExplicar != null ? cop(c.sinExplicar) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={exportar} disabled={!calculos.length}>
              <Download className="mr-1 h-4 w-4" /> Exportar Excel (partidas al corte y listados)
            </Button>
            <Button size="sm" onClick={onGuardar} disabled={!calculos.length}>
              <Save className="mr-1 h-4 w-4" /> Guardar conciliación de {periodo}
            </Button>
          </div>

          {cuentaErrada.length || fuentes.ajustes.some((a) => a.tipo === "reclasificacion") ? (
            <div className="space-y-2 rounded-lg border bg-card p-3 text-xs">
              <div className="font-semibold">RC/RP registrados en otra cuenta bancaria</div>
              <div className="text-muted-foreground">
                El recibo está en los libros de una cuenta sin su movimiento en el extracto, y el
                movimiento está en el extracto de otra cuenta sin registro. Al reclasificar se crea
                en Siigo un comprobante contable por recibo que pasa el valor a la cuenta correcta
                (con el tercero del recibo); el RC/RP original no se modifica.
              </div>
              {cuentaErrada.length ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={cuentaErrada.every((r) => marcadas.has(r.clave))}
                        onChange={(e) =>
                          setMarcadas(
                            e.target.checked
                              ? new Set(cuentaErrada.map((r) => r.clave))
                              : new Set(),
                          )
                        }
                      />
                      Seleccionar todos ({cuentaErrada.length})
                    </label>
                    <Button
                      size="sm"
                      onClick={() => void onReclasificar()}
                      disabled={
                        !cuentaErrada.some((r) => marcadas.has(r.clave)) ||
                        enviando === "reclasificar"
                      }
                    >
                      {enviando === "reclasificar" ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="mr-1 h-4 w-4" />
                      )}
                      Reclasificar seleccionados en Siigo (
                      {cuentaErrada.filter((r) => marcadas.has(r.clave)).length})
                    </Button>
                  </div>
                  <div className="max-h-80 overflow-auto rounded border">
                    {cuentaErrada.map((r) => (
                      <label key={r.clave} className="flex items-center gap-2 border-b px-2 py-1">
                        <input
                          type="checkbox"
                          checked={marcadas.has(r.clave)}
                          onChange={(e) =>
                            setMarcadas((x) => {
                              const n = new Set(x);
                              if (e.target.checked) n.add(r.clave);
                              else n.delete(r.clave);
                              return n;
                            })
                          }
                        />
                        <span className="w-24">{fecha(r.fecha)}</span>
                        <span className="w-28 font-medium">{r.comprobante}</span>
                        <span className="flex-1">
                          {r.tercero ?? ""} {r.terceroNit ?? "(sin NIT)"} · banco:{" "}
                          {fecha(r.banco.fecha)} {r.banco.descripcion}
                        </span>
                        <span className="w-32 text-right">{cop(r.valor)}</span>
                        <span className="w-64">
                          {r.desde.etiqueta} → <b>{r.hacia.etiqueta}</b>
                          <span className="block text-muted-foreground">{r.criterio}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              ) : null}
              {fuentes.ajustes
                .filter((a) => a.tipo === "reclasificacion")
                .map((a) => (
                  <div key={a.clave} className="flex gap-2">
                    <span className="w-24">{fecha(a.fecha)}</span>
                    <span className="flex-1">
                      {a.origen}: {a.cuenta} → {a.cuentaDestino}
                    </span>
                    <span className="w-32 text-right">{cop(a.valor)}</span>
                    <span
                      className={`w-72 ${a.estado === "error" ? "text-red-700" : "text-emerald-700"}`}
                    >
                      {a.siigoNombre ? `En Siigo: ${a.siigoNombre}` : a.estado}
                      {a.error ? ` · ${a.error.slice(0, 160)}` : ""}
                    </span>
                  </div>
                ))}
            </div>
          ) : null}

          {pasarelas.length ? (
            <div className="space-y-3 rounded-lg border bg-card p-3 text-xs">
              <div className="font-semibold">Pasarelas de pago</div>
              <div className="text-muted-foreground">
                Cada cobro contra su RC (valor completo) y contra el abono neto del banco. Lo
                descontado en los abonos del mes (comisión + IVA y retenciones) va en un RP por
                plataforma y cuenta: débito a la CxP cruzando la factura de comisiones, débito a las
                retenciones y crédito al banco.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    ["retefuente", "Retención en la fuente"],
                    ["reteiva", "Retención de IVA"],
                    ["reteica", "Retención de ICA"],
                  ] as const
                ).map(([k, nombre]) => (
                  <div key={k} className="flex items-center gap-1">
                    <span>{nombre}:</span>
                    <AccountCombobox
                      accounts={puc.data ?? []}
                      value={cuentasPas[k]}
                      onChange={(code) => setCuentasPas((x) => ({ ...x, [k]: code }))}
                      placeholder="Cuenta 1355…"
                      className="h-7 w-56"
                    />
                  </div>
                ))}
              </div>
              {pasarelas.map(({ p, r, porCuenta }) => (
                <div key={p.plataforma} className="rounded border p-2">
                  <div className="font-semibold">
                    {p.plataforma}{" "}
                    <span className="font-normal text-muted-foreground">
                      {p.terceroNombre ?? "tercero no encontrado en las CxP ni en terceros"}{" "}
                      {p.terceroNit ?? ""} · facturas con saldo:{" "}
                      {p.facturas.length
                        ? p.facturas.map((f) => `${f.factura} (${cop(f.saldo)})`).join(", ")
                        : "ninguna (causa la factura de comisiones y sincroniza las CxP)"}
                    </span>
                  </div>
                  {p.advertencias.map((w) => (
                    <div key={w} className="text-amber-700">
                      • {w}
                    </div>
                  ))}
                  <div className="mt-1 grid gap-1 md:grid-cols-2">
                    {[...porCuenta].map(([cuenta, a]) => {
                      const rp = p.rp.find((x) => x.cuenta?.toUpperCase() === cuenta.toUpperCase());
                      return (
                        <div key={cuenta} className="rounded bg-muted/40 p-2">
                          <div>
                            <b>{cuenta}</b>: {a.cobros} cobros abonados · valor {cop(a.bruto)} ·
                            neto {cop(a.neto)}
                          </div>
                          <div>
                            Comisión {cop(a.comision)}
                            {a.ivaComision ? ` + IVA ${cop(a.ivaComision)}` : ""} · retefuente{" "}
                            {cop(a.retefuente)} · reteIVA {cop(a.reteiva)} · reteICA{" "}
                            {cop(a.reteica)} → <b>RP por {cop(a.deducciones)}</b>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            {rp?.siigoNombre ? (
                              <span className="text-emerald-700">En Siigo: {rp.siigoNombre}</span>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7"
                                  disabled={enviando === `rp-${p.plataforma}-${cuenta}`}
                                  onClick={() => void onCrearRp(p.plataforma, cuenta, r)}
                                >
                                  {rp
                                    ? "Actualizar RP en Egresos y pagos"
                                    : "Crear RP en Egresos y pagos"}
                                </Button>
                                {rp ? (
                                  <span className="text-muted-foreground">
                                    En Egresos y pagos: {rp.estado} ({cop(rp.valor)})
                                  </span>
                                ) : null}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <Lista
                    titulo={`Abonos de ${p.plataforma} con diferencia o sin cobros identificados`}
                    ayuda="Abono del banco vs suma de los netos de sus cobros. Sin cobros: abonos de cobros de otro mes sin hoja, o sin relación."
                    filas={r.abonos
                      .filter((a) => !a.cobros.length || Math.abs(a.diferencia) >= 0.01)
                      .map((a) => [
                        fecha(a.mov.fecha),
                        `${a.cuenta} · ${a.mov.descripcion}`,
                        cop(a.mov.valor),
                        a.cobros.length
                          ? `Diferencia ${cop(a.diferencia)} (${a.cobros.length} cobros)`
                          : "Sin cobros identificados",
                      ])}
                  />
                  <Lista
                    titulo={`Cobros de ${p.plataforma} sin RC o con RC por otro valor`}
                    ayuda="El RC debe ir por el valor completo que pagó el cliente."
                    filas={[
                      ...r.sinRc.map((c) => [
                        fecha(c.t.fecha),
                        `${c.t.id} · ${c.t.pagador ?? ""} ${c.t.rcs.join(", ")}`,
                        cop(c.t.bruto),
                        c.t.rcs.length ? "RC citado no está en Siigo" : "Sin RC en la relación",
                      ]),
                      ...r.cobros
                        .filter((c) => Math.abs(c.difRc) >= 0.01)
                        .map((c) => [
                          fecha(c.t.fecha),
                          `${c.t.id} · ${c.rc?.comprobantes.join(", ")}`,
                          cop(c.t.bruto),
                          `RC por ${cop(c.rc?.valor ?? 0)} (diferencia ${cop(c.difRc)})`,
                        ]),
                    ]}
                  />
                  <Lista
                    titulo={`Cobros de ${p.plataforma} del mes sin abono (pasan al mes siguiente)`}
                    ayuda="Su RC queda en libros sin banco al corte; el abono y sus descuentos van en el RP del mes en que llegue."
                    filas={r.sinAbono.map((c) => [
                      fecha(c.t.fecha),
                      `${c.t.id} · ${c.t.rcs.join(", ")}`,
                      cop(c.t.neto),
                      c.t.abonoMesSiguiente ? "Marcado para el mes siguiente" : "",
                    ])}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {vista ? (
            <div className="space-y-3">
              {fuenteVista?.advertencias.map((w) => (
                <div key={w} className="text-xs text-amber-700">
                  • {w}
                </div>
              ))}
              {extractosPdf[vista.etiqueta]?.comparacion ? (
                <Lista
                  titulo={`Extracto del banco (PDF) vs hoja del reporte — ${vista.etiqueta}`}
                  ayuda={`${extractosPdf[vista.etiqueta]!.comparacion!.coinciden} movimientos coinciden. Se concilia con el extracto del banco; aquí, lo que la empresa no reportó o reportó distinto.`}
                  filas={[
                    ...extractosPdf[vista.etiqueta]!.comparacion!.faltanEnRelacion.map((m) => [
                      fecha(m.fecha),
                      m.descripcion,
                      cop(m.valor),
                      "No está en la hoja",
                    ]),
                    ...extractosPdf[vista.etiqueta]!.comparacion!.sobranEnRelacion.map((m) => [
                      fecha(m.fecha),
                      m.descripcion,
                      cop(m.valor),
                      "En la hoja y no en el extracto",
                    ]),
                    ...extractosPdf[vista.etiqueta]!.comparacion!.fechaDistinta.map(([o, h]) => [
                      fecha(o.fecha),
                      o.descripcion,
                      cop(o.valor),
                      `En la hoja con fecha ${fecha(h.fecha)}`,
                    ]),
                  ]}
                />
              ) : null}
              {vista.ajustes.length ||
              fuentes.ajustes.some(
                (a) => a.cuenta === vista.etiqueta && a.tipo !== "reclasificacion",
              ) ? (
                <div className="rounded-lg border bg-card p-3 text-xs">
                  <div className="font-semibold">
                    Ajustes al peso — {vista.etiqueta} (tope {cop(fuentes.ajusteCuentas.tope)})
                  </div>
                  <div className="text-muted-foreground">
                    Diferencias entre el RC/RP y el banco dentro del tope: comprobante contable en
                    Siigo (banco contra {fuentes.ajusteCuentas.credito ?? "—"} si entró de más, o{" "}
                    {fuentes.ajusteCuentas.debito ?? "—"} contra el banco si entró de menos), con el
                    tercero del recibo.
                  </div>
                  <div className="mt-2 space-y-1">
                    {fuentes.ajustes
                      .filter((a) => a.cuenta === vista.etiqueta && a.tipo !== "reclasificacion")
                      .map((a) => (
                        <div key={a.clave} className="flex gap-2">
                          <span className="w-24">{fecha(a.fecha)}</span>
                          <span className="flex-1">{a.origen}</span>
                          <span className="w-32 text-right">{cop(a.valor)}</span>
                          <span
                            className={`w-72 ${a.estado === "error" ? "text-red-700" : "text-emerald-700"}`}
                          >
                            {a.siigoNombre ? `En Siigo: ${a.siigoNombre}` : a.estado}
                            {a.error ? ` · ${a.error.slice(0, 160)}` : ""}
                          </span>
                        </div>
                      ))}
                    {vista.ajustes.map((a) => (
                      <div key={a.clave} className="flex items-center gap-2">
                        <span className="w-24">{fecha(a.fecha)}</span>
                        <span className="flex-1">
                          {a.origen} · {a.tercero ?? ""} {a.terceroNit ?? "(sin NIT)"}
                        </span>
                        <span className="w-32 text-right">{cop(a.valor)}</span>
                        <span className="w-72">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            disabled={!a.terceroNit || enviando === a.clave}
                            onClick={() => void onEnviarAjuste(vista.etiqueta, a)}
                          >
                            <Send className="mr-1 h-3 w-3" /> Enviar ajuste a Siigo
                          </Button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <Lista
                {...propsLote(
                  vista.etiqueta,
                  "salida",
                  vista.resultado.faltaEnLibros.filter((b) => b.valor < 0).map(itemBanco),
                )}
                titulo={`RP que faltan en Siigo — ${vista.etiqueta}`}
                ayuda="Salidas del extracto sin registro en Siigo. Si el pago está en Egresos y pagos sin enviar, se indica su estado."
                filas={vista.resultado.faltaEnLibros
                  .filter((b) => b.valor < 0)
                  .map((b) => {
                    const eg = fuentes.egresosPendientes.find(
                      (e) =>
                        e.cuenta?.toUpperCase() === vista.etiqueta.toUpperCase() &&
                        e.fecha === b.fecha &&
                        Math.abs(e.valor + b.valor) < 0.01,
                    );
                    return [
                      fecha(b.fecha),
                      b.descripcion,
                      cop(-b.valor),
                      b.previa
                        ? "Del mes anterior"
                        : eg
                          ? `En Egresos y pagos: ${eg.estado}`
                          : "No está en Egresos y pagos",
                    ];
                  })}
                acciones={vista.resultado.faltaEnLibros
                  .filter((b) => b.valor < 0)
                  .map((b) =>
                    accion(vista.etiqueta, "salida", partidaDeBanco(b), {
                      id: b.id,
                      registrar: (f) =>
                        void onRegistrar(vista.etiqueta, { tipo: "salida", mov: b }, f),
                    }),
                  )}
              />
              <Lista
                {...propsLote(
                  vista.etiqueta,
                  "entrada",
                  vista.resultado.faltaEnLibros.filter((b) => b.valor > 0).map(itemBanco),
                )}
                titulo={`Ingresos sin RC en Siigo — ${vista.etiqueta}`}
                ayuda="Entradas del extracto sin recibo de caja en Siigo (ni en el auxiliar ni en la API)."
                filas={vista.resultado.faltaEnLibros
                  .filter((b) => b.valor > 0)
                  .map((b) => [
                    fecha(b.fecha),
                    b.descripcion,
                    cop(b.valor),
                    (b.refs ?? []).join(", ") || (b.previa ? "Del mes anterior" : ""),
                  ])}
                acciones={vista.resultado.faltaEnLibros
                  .filter((b) => b.valor > 0)
                  .map((b) =>
                    accion(vista.etiqueta, "entrada", partidaDeBanco(b), {
                      id: b.id,
                      registrar: (f) =>
                        void onRegistrar(vista.etiqueta, { tipo: "entrada", mov: b }, f),
                    }),
                  )}
              />
              <Lista
                {...propsLote(
                  vista.etiqueta,
                  "diferencia",
                  vista.resultado.diferencias.map((d) => {
                    const partida = partidaDeDiferencia(d);
                    const a =
                      d.libros.length && !d.pasarela ? ajusteDeDiferencia(d, vista.etiqueta) : null;
                    return {
                      clave: a?.clave ?? clavePartida(partida),
                      partida,
                      linea: a
                        ? {
                            clave: a.clave,
                            fecha: a.fecha,
                            descripcion: a.descripcion,
                            valor: a.valor,
                            origen: a.origen,
                          }
                        : null,
                    };
                  }),
                )}
                titulo={`Diferencias de valor (RC/RP vs banco) — ${vista.etiqueta}`}
                ayuda="Cruzan por comprobante pero el valor no es el del banco: ajustar en Siigo (p. ej. RC por el bruto y abono neto de comisión)."
                filas={vista.resultado.diferencias.map((d) => [
                  fecha(d.banco[0]?.fecha ?? ""),
                  `${d.banco.map((b) => b.descripcion).join(" + ")} → ${d.libros.map((l) => l.comprobante).join(", ")}`,
                  `${cop(d.banco.reduce((s, b) => s + b.valor, 0))} vs ${cop(d.libros.reduce((s, l) => s + l.valor, 0))}`,
                  `Diferencia ${cop(d.diferencia)}`,
                ])}
                acciones={vista.resultado.diferencias.map((d) => {
                  const a =
                    d.libros.length && !d.pasarela ? ajusteDeDiferencia(d, vista.etiqueta) : null;
                  return accion(
                    vista.etiqueta,
                    a ? "diferencia" : "libros",
                    partidaDeDiferencia(d),
                    {
                      id: a?.clave ?? "",
                      sugerido: { nit: a?.terceroNit ?? null, nombre: a?.tercero ?? null },
                      ...(a
                        ? {
                            registrar: (f: FormRegistro) =>
                              void onRegistrar(
                                vista.etiqueta,
                                { tipo: "diferencia", ajuste: a },
                                f,
                              ),
                          }
                        : {}),
                    },
                  );
                })}
              />
              <Lista
                {...propsLote(
                  vista.etiqueta,
                  "libros",
                  vista.resultado.sobraEnLibros.map((l) => {
                    const partida = partidaDeLibro(l);
                    return { clave: clavePartida(partida), partida, linea: null };
                  }),
                )}
                titulo={`En Siigo y no en el extracto — ${vista.etiqueta}`}
                ayuda="Partidas en tránsito (cheques, pagos registrados que el banco aún no refleja) o errores de registro."
                filas={vista.resultado.sobraEnLibros.map((l) => [
                  fecha(l.fecha),
                  `${l.comprobante} · ${l.tercero ?? l.descripcion ?? ""}`,
                  cop(l.valor),
                  l.previa ? "Del mes anterior" : (l.origen ?? ""),
                ])}
                acciones={vista.resultado.sobraEnLibros.map((l) =>
                  accion(vista.etiqueta, "libros", partidaDeLibro(l), { id: l.id }),
                )}
              />
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-lg border bg-card p-6 text-center text-xs text-muted-foreground">
          Elige el mes y pulsa «Cargar extractos y movimientos». Los extractos se toman de la
          bandeja de egresos (carpeta de Drive) del mes.
        </div>
      )}
    </div>
  );
}

function Lista({
  titulo,
  ayuda,
  filas,
  acciones,
  seleccion,
  lote,
}: {
  titulo: string;
  ayuda: string;
  filas: string[][];
  /** Acciones por fila (registrar en Siigo o dejar como partida conciliatoria). */
  acciones?: React.ReactNode[];
  /** Selección de filas para las acciones en lote (una clave por fila). */
  seleccion?: {
    claves: string[];
    marcadas: Set<string>;
    onCambiar: (claves: string[], marcar: boolean) => void;
  };
  /** Barra de acciones en lote de las filas marcadas. */
  lote?: React.ReactNode;
}) {
  const todas =
    !!seleccion?.claves.length && seleccion.claves.every((c) => seleccion.marcadas.has(c));
  return (
    <div className="rounded-lg border bg-card p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">
          {titulo} ({filas.length})
        </span>
        {seleccion && filas.length ? (
          <label className="flex items-center gap-1 text-muted-foreground">
            <input
              type="checkbox"
              checked={todas}
              onChange={(e) => seleccion.onCambiar(seleccion.claves, e.target.checked)}
            />
            Seleccionar todos
          </label>
        ) : null}
      </div>
      <div className="text-muted-foreground">{ayuda}</div>
      {lote}
      {filas.length ? (
        <div className="mt-2 max-h-96 overflow-auto rounded border">
          {filas.map((f, i) => {
            const clave = seleccion?.claves[i];
            return (
              <div key={`${f.join("|")}#${i}`} className="border-b px-2 py-1">
                <div className="flex gap-2">
                  {seleccion && clave ? (
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={seleccion.marcadas.has(clave)}
                      onChange={(e) => seleccion.onCambiar([clave], e.target.checked)}
                    />
                  ) : null}
                  <span className="w-24">{f[0]}</span>
                  <span className="flex-1">{f[1]}</span>
                  <span className="w-48 text-right">{f[2]}</span>
                  <span className="w-56 text-muted-foreground">{f[3]}</span>
                </div>
                {acciones?.[i] ?? null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Acciones en lote de las líneas marcadas de una lista: dejarlas como partida conciliatoria
 * con una nota, o registrarlas en Siigo en UN documento con la misma cuenta y tercero.
 */
function LoteBar({
  tipo,
  n,
  total,
  noRegistrables,
  puc,
  terceros,
  ocupado,
  onPartida,
  onRegistrar,
}: {
  tipo: "salida" | "entrada" | "diferencia" | "libros";
  n: number;
  total: number;
  noRegistrables: number;
  puc: PucOption[];
  terceros: TerceroOption[];
  ocupado: boolean;
  onPartida: (nota: string) => void;
  onRegistrar?: (f: FormRegistro) => void;
}) {
  const [nota, setNota] = useState("");
  const [f, setF] = useState<FormRegistro>({
    terceroNit: "",
    terceroNombre: null,
    cuenta: "",
    descripcion: "",
    enviar: true,
  });
  const documento =
    tipo === "salida"
      ? "un recibo de pago (RP) detallado: débito a la cuenta por cada movimiento y crédito al banco por el total"
      : tipo === "entrada"
        ? "un recibo de caja (RC) detallado: débito al banco por el total y crédito a la cuenta por cada movimiento"
        : "un comprobante contable: banco contra la cuenta, un par de renglones por diferencia";
  return (
    <div className="mt-2 space-y-2 rounded border border-blue-200 bg-blue-50/60 p-2 dark:bg-blue-950/30">
      <div className="font-medium">
        {n} marcada(s) · {cop(total)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-80"
          placeholder="Nota (p. ej. consignaciones por identificar)"
          value={nota}
          onChange={(e) => setNota(e.target.value)}
        />
        <Button size="sm" variant="outline" className="h-8" onClick={() => onPartida(nota)}>
          Dejar como partida conciliatoria
        </Button>
      </div>
      {onRegistrar ? (
        <div className="space-y-1">
          <div className="text-muted-foreground">
            Registrar en Siigo en {documento}, fechado el último día del mes.
            {noRegistrables
              ? ` ${noRegistrables} marcada(s) no se pueden registrar así y se omiten.`
              : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TerceroCombobox
              terceros={terceros}
              value={f.terceroNit}
              onChange={(nit, nombre) =>
                setF((x) => ({ ...x, terceroNit: nit, terceroNombre: nombre }))
              }
            />
            <AccountCombobox
              accounts={puc}
              value={f.cuenta}
              onChange={(code) => setF((x) => ({ ...x, cuenta: code }))}
              placeholder="Cuenta contable…"
              className="h-8 w-72"
            />
            <Input
              className="h-8 w-72"
              placeholder="Descripción del documento"
              value={f.descripcion}
              onChange={(e) => setF((x) => ({ ...x, descripcion: e.target.value }))}
            />
            <Button
              size="sm"
              className="h-8"
              disabled={ocupado || !f.terceroNit || !f.cuenta}
              onClick={() => onRegistrar(f)}
            >
              {ocupado ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Send className="mr-1 h-3 w-3" />
              )}
              Enviar en un solo documento
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type FormRegistro = {
  terceroNit: string;
  terceroNombre: string | null;
  cuenta: string;
  descripcion: string;
  enviar: boolean;
};

/**
 * Acciones de una línea de la conciliación: registrarla en Siigo escogiendo la cuenta y el
 * tercero (salida → RP detallado, entrada → RC detallado, diferencia → comprobante contable)
 * o dejarla como partida conciliatoria con una nota que sale en el Excel exportado.
 */
function AccionLinea({
  tipo,
  nota,
  onNota,
  puc,
  terceros,
  sugerido,
  descripcion,
  ocupado,
  onRegistrar,
}: {
  tipo: "salida" | "entrada" | "diferencia" | "libros";
  nota: string;
  onNota: (n: string) => void;
  puc: PucOption[];
  terceros: TerceroOption[];
  sugerido: { nit: string | null; nombre: string | null };
  descripcion: string;
  ocupado: boolean;
  onRegistrar?: (f: FormRegistro) => void;
}) {
  const [modo, setModo] = useState<null | "registrar" | "partida">(nota ? "partida" : null);
  const [f, setF] = useState<FormRegistro>({
    terceroNit: sugerido.nit ?? "",
    terceroNombre: sugerido.nombre,
    cuenta: "",
    descripcion,
    enviar: true,
  });
  const etiqueta =
    tipo === "salida"
      ? "Registrar RP en Siigo"
      : tipo === "entrada"
        ? "Registrar RC en Siigo"
        : "Ajustar en Siigo";
  const ayuda =
    tipo === "salida"
      ? "Débito a la cuenta escogida y crédito al banco (recibo de pago detallado)."
      : tipo === "entrada"
        ? "Débito al banco y crédito a la cuenta escogida (recibo de caja detallado)."
        : "Comprobante contable: banco contra la cuenta escogida por la diferencia.";
  return (
    <div className="mt-1 pl-24">
      <div className="flex flex-wrap items-center gap-2">
        {tipo !== "libros" && onRegistrar ? (
          <button
            type="button"
            className={`underline ${modo === "registrar" ? "font-semibold text-blue-800" : "text-blue-700"}`}
            onClick={() => setModo(modo === "registrar" ? null : "registrar")}
          >
            {etiqueta}
          </button>
        ) : null}
        <button
          type="button"
          className={`underline ${modo === "partida" ? "font-semibold text-slate-800" : "text-slate-600"}`}
          onClick={() => setModo(modo === "partida" ? null : "partida")}
        >
          {nota ? `Partida conciliatoria: ${nota}` : "Dejar como partida conciliatoria"}
        </button>
      </div>
      {modo === "partida" ? (
        <div className="mt-1 flex items-center gap-2">
          <Input
            className="h-7 max-w-xl"
            placeholder="Nota para el reporte (p. ej. cheque en tránsito, consignación por identificar)"
            value={nota}
            onChange={(e) => onNota(e.target.value)}
          />
          <span className="text-muted-foreground">Queda en las partidas al corte del Excel.</span>
        </div>
      ) : null}
      {modo === "registrar" && onRegistrar ? (
        <div className="mt-1 space-y-1 rounded border bg-muted/30 p-2">
          <div className="text-muted-foreground">{ayuda}</div>
          <div className="flex flex-wrap items-center gap-2">
            <TerceroCombobox
              terceros={terceros}
              value={f.terceroNit}
              onChange={(nit, nombre) =>
                setF((x) => ({ ...x, terceroNit: nit, terceroNombre: nombre }))
              }
            />
            <AccountCombobox
              accounts={puc}
              value={f.cuenta}
              onChange={(code) => setF((x) => ({ ...x, cuenta: code }))}
              placeholder="Cuenta contable…"
              className="h-8 w-72"
            />
            <Input
              className="h-8 w-72"
              value={f.descripcion}
              onChange={(e) => setF((x) => ({ ...x, descripcion: e.target.value }))}
            />
            {tipo === "salida" ? (
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={f.enviar}
                  onChange={(e) => setF((x) => ({ ...x, enviar: e.target.checked }))}
                />
                Enviar ya a Siigo (si no, queda listo en Egresos y pagos)
              </label>
            ) : null}
            <Button
              size="sm"
              className="h-8"
              disabled={ocupado || !f.terceroNit || !f.cuenta}
              onClick={() => onRegistrar(f)}
            >
              {ocupado ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Send className="mr-1 h-3 w-3" />
              )}
              {tipo === "salida" && !f.enviar ? "Crear en Egresos y pagos" : "Enviar a Siigo"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
