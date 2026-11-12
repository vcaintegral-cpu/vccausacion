// Conciliación bancaria — núcleo global (todas las empresas).
// Cruza por cuenta (bancos y caja): extracto del mes, movimiento de Siigo (auxiliar subido,
// completado con RC de la API y RP enviados) y las partidas del corte anterior. Devuelve los
// RP que faltan, las diferencias en RC/ingresos y las partidas conciliatorias al corte.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { Download, Loader2, RefreshCw, Save, Upload } from "lucide-react";

import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany } from "@/components/app-shell";
import { cop, fecha } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readRawHistory } from "@/lib/history-raw";
import {
  armarConciliacion,
  conciliar,
  diferenciaSinExplicar,
  partidasAlCorte,
  type LineaAuxiliar,
  type MovBanco,
  type PartidaConciliatoria,
  type ResultadoConciliacion,
} from "@/lib/conciliacion";
import {
  leerConciliacionAnterior,
  leerExtractoBancolombia,
  leerExtractoGenerico,
} from "@/lib/lectores-extracto";
import {
  conciliacionFuentes,
  conciliacionGuardar,
  type FuentesConciliacion,
} from "@/lib/conciliacion.functions";

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
};

function Conciliacion() {
  const companyId = useActiveCompany();
  const [periodo, setPeriodo] = useState(mesAnterior());
  const [fuentes, setFuentes] = useState<FuentesConciliacion | null>(null);
  const [auxiliar, setAuxiliar] = useState<{ nombre: string; filas: LineaAuxiliar[] } | null>(null);
  const [anteriorSubida, setAnteriorSubida] = useState<Map<string, PartidaConciliatoria[]>>(
    new Map(),
  );
  const [cuentaAnterior, setCuentaAnterior] = useState("");
  const [extractosManual, setExtractosManual] = useState<
    Record<
      string,
      {
        nombre: string;
        movimientos: MovBanco[];
        saldoInicial: number | null;
        saldoFinal: number | null;
      }
    >
  >({});
  const [saldosLibros, setSaldosLibros] = useState<Record<string, string>>({});
  const [cuentaVista, setCuentaVista] = useState<string | null>(null);
  const refAux = useRef<HTMLInputElement>(null);
  const refAnt = useRef<HTMLInputElement>(null);

  const cargar = useServerFn(conciliacionFuentes);
  const guardar = useServerFn(conciliacionGuardar);
  const mFuentes = useMutation({
    mutationFn: () => cargar({ data: { companyId: companyId!, periodo } }),
    onSuccess: (f) => {
      setFuentes(f);
      setCuentaVista(f.cuentas[0]?.etiqueta ?? null);
      // Saldo inicial de libros: el final guardado del mes anterior.
      const s: Record<string, string> = {};
      for (const a of f.anterior)
        if (a.saldoLibrosFinal != null) s[a.cuenta] = String(a.saldoLibrosFinal);
      setSaldosLibros((x) => ({ ...s, ...x }));
      for (const w of f.advertencias) toast.warning(w);
      toast.success(
        `Fuentes cargadas: ${f.cuentas.filter((c) => c.movimientos.length).length} de ${f.cuentas.length} cuentas con extracto.`,
      );
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const calculos: Calculo[] = useMemo(() => {
    if (!fuentes) return [];
    return fuentes.cuentas.map((c) => {
      const manual = extractosManual[c.etiqueta];
      const extracto = manual?.movimientos ?? c.movimientos;
      const previas =
        fuentes.anterior.find((a) => a.cuenta.toUpperCase() === c.etiqueta.toUpperCase())
          ?.partidas ??
        anteriorSubida.get(c.etiqueta.toUpperCase()) ??
        [];
      const armado = armarConciliacion({
        etiqueta: c.etiqueta,
        cuentaContable: c.cuentaContable,
        periodo,
        extracto,
        auxiliar: auxiliar?.filas ?? [],
        rpEnviados: fuentes.rpEnviados,
        rcApi: fuentes.rcApi,
        previas,
      });
      const resultado = conciliar(armado);
      const partidas = partidasAlCorte(resultado);
      const saldoExtractoFinal = manual?.saldoFinal ?? c.saldoFinal;
      const ini = saldosLibros[c.etiqueta];
      const saldoLibrosInicial = ini != null && ini !== "" ? Number(ini) : null;
      const saldoLibrosFinal =
        saldoLibrosInicial != null
          ? Math.round((saldoLibrosInicial + armado.movimientoLibros) * 100) / 100
          : null;
      return {
        etiqueta: c.etiqueta,
        cuentaContable: c.cuentaContable,
        resultado,
        partidas,
        saldoExtractoInicial: manual?.saldoInicial ?? c.saldoInicial,
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
      };
    });
  }, [fuentes, extractosManual, anteriorSubida, auxiliar, saldosLibros, periodo]);

  if (!companyId) return <EmptyCompany />;

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
      );
      setAnteriorSubida((x) => {
        const n = new Map(x);
        for (const [k, v] of r.porCuenta) n.set(k, v);
        return n;
      });
      for (const w of r.advertencias) toast.warning(w);
      toast.success(
        `Conciliación anterior: ${[...r.porCuenta.values()].reduce((s, v) => s + v.length, 0)} partidas en ${r.porCuenta.size} cuenta(s).`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const subirExtracto = async (etiqueta: string, file: File) => {
    const bytes = await file.arrayBuffer();
    let ext = leerExtractoBancolombia(bytes, etiqueta.slice(0, 3));
    if (!ext.movimientos.length) ext = leerExtractoGenerico(bytes, etiqueta.slice(0, 3));
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
              setPeriodo(e.target.value);
              setFuentes(null);
            }}
            className="h-8 w-40"
          />
          <Button size="sm" onClick={() => mFuentes.mutate()} disabled={mFuentes.isPending}>
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
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => refAux.current?.click()}
          >
            <Upload className="mr-1 h-4 w-4" />{" "}
            {auxiliar ? `Auxiliar: ${auxiliar.nombre}` : "Subir auxiliar de Siigo"}
          </Button>
        </div>
        <div className="rounded-lg border bg-card p-3 text-xs">
          <div className="font-semibold">2. Conciliación del mes anterior</div>
          <div className="text-muted-foreground">
            {fuentes?.anterior.length
              ? `Se usa la conciliación guardada del mes anterior (${fuentes.anterior.map((a) => `${a.cuenta}: ${a.partidas.length} partidas`).join(", ")}).`
              : "Primera vez: sube el Excel de la conciliación del mes anterior con sus partidas conciliatorias. Si el archivo no trae columna de cuenta, elige a qué cuenta corresponde."}
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
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void subirAnterior(f);
                e.target.value = "";
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
                        {extractosManual[c.etiqueta]?.nombre ?? f?.fuente ?? (
                          <span className="text-amber-700">sin extracto</span>
                        )}{" "}
                        · {c.movimientos} mov.
                        <label
                          className="ml-2 cursor-pointer text-blue-700 underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          cargar
                          <input
                            type="file"
                            accept=".xlsx,.xls"
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
                          onChange={(e) =>
                            setSaldosLibros((x) => ({ ...x, [c.etiqueta]: e.target.value }))
                          }
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

          {vista ? (
            <div className="space-y-3">
              {fuenteVista?.advertencias.map((w) => (
                <div key={w} className="text-xs text-amber-700">
                  • {w}
                </div>
              ))}
              <Lista
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
              />
              <Lista
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
              />
              <Lista
                titulo={`Diferencias de valor (RC/RP vs banco) — ${vista.etiqueta}`}
                ayuda="Cruzan por comprobante pero el valor no es el del banco: ajustar en Siigo (p. ej. RC por el bruto y abono neto de comisión)."
                filas={vista.resultado.diferencias.map((d) => [
                  fecha(d.banco[0]?.fecha ?? ""),
                  `${d.banco.map((b) => b.descripcion).join(" + ")} → ${d.libros.map((l) => l.comprobante).join(", ")}`,
                  `${cop(d.banco.reduce((s, b) => s + b.valor, 0))} vs ${cop(d.libros.reduce((s, l) => s + l.valor, 0))}`,
                  `Diferencia ${cop(d.diferencia)}`,
                ])}
              />
              <Lista
                titulo={`En Siigo y no en el extracto — ${vista.etiqueta}`}
                ayuda="Partidas en tránsito (cheques, pagos registrados que el banco aún no refleja) o errores de registro."
                filas={vista.resultado.sobraEnLibros.map((l) => [
                  fecha(l.fecha),
                  `${l.comprobante} · ${l.tercero ?? l.descripcion ?? ""}`,
                  cop(l.valor),
                  l.previa ? "Del mes anterior" : (l.origen ?? ""),
                ])}
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

function Lista({ titulo, ayuda, filas }: { titulo: string; ayuda: string; filas: string[][] }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-xs">
      <div className="font-semibold">
        {titulo} ({filas.length})
      </div>
      <div className="text-muted-foreground">{ayuda}</div>
      {filas.length ? (
        <div className="mt-2 max-h-72 overflow-auto rounded border">
          {filas.map((f, i) => (
            <div key={i} className="flex gap-2 border-b px-2 py-1">
              <span className="w-24">{f[0]}</span>
              <span className="flex-1">{f[1]}</span>
              <span className="w-48 text-right">{f[2]}</span>
              <span className="w-56 text-muted-foreground">{f[3]}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
