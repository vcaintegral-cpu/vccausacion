// Egresos y recibos de pago (RP) en Siigo — núcleo global (todas las empresas).
// 1. Cuentas por pagar de Siigo (saldos por factura).
// 2. Pagos del mes: del reporte de pagos de la empresa (Drive automático o carga manual).
// 3. Propuesta por pago (pago de facturas, abono, anticipo, RP detallado) con su motivo;
//    lo que la usuaria corrige se recuerda para los demás pagos y el mes siguiente.
// 4. Aprobación y envío a Siigo uno a uno, sin reenvíos.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw, Send, Upload } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany } from "@/components/app-shell";
import { usePerfilActivo } from "@/empresas/use-perfil";
import { ComprasPorPagarPanel } from "@/components/compras-por-pagar-panel";
import { AccountCombobox, type PucOption } from "@/components/account-combobox";
import { TerceroCombobox, type TerceroOption } from "@/components/tercero-combobox";
import { cop, fecha } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { siigoRecibosConfig } from "@/lib/siigo-pagos.functions";
import {
  egresosAprobar,
  egresosEnviar,
  egresosGuardarBanco,
  egresosGuardarEdicion,
  egresosImportarReporte,
  egresosProponer,
  egresosReintentar,
  egresosAnalizarDiferencia,
  egresosCorregirCompra,
  type DiferenciaItem,
  egresosSincronizarCxP,
  egresosEnviarGrupoBancario,
  egresosReplicar,
  egresosCuentasAjuste,
  egresosGuardarCuentasAjuste,
} from "@/lib/egresos.functions";
import type { CuentaDetallada, ItemPago, Propuesta, TipoEgreso } from "@/lib/egresos";
import { normalizar, patronConcepto } from "@/lib/egresos";

export const Route = createFileRoute("/_authenticated/egresos")({
  head: () => ({
    meta: [
      { title: "Egresos y pagos · Recibos de pago en Siigo" },
      {
        name: "description",
        content: "Pagos del mes, cuentas por pagar de Siigo y recibos de pago/egreso.",
      },
    ],
  }),
  component: Egresos,
});

type Fila = {
  id: string;
  period: string;
  fecha: string;
  descripcion: string | null;
  tercero_nombre: string | null;
  tercero_nit: string | null;
  valor: number;
  cuenta_etiqueta: string | null;
  relacion: string | null;
  aplicacion: string | null;
  observaciones: string | null;
  tipo: TipoEgreso;
  propuesta: Propuesta | null;
  estado: string;
  motivos: string[];
  editado_por_usuaria: boolean;
  siigo_id: string | null;
  siigo_nombre: string | null;
  siigo_error: string | null;
};

const ESTADOS: Array<{ id: string; label: string }> = [
  { id: "por_revisar", label: "Por revisar" },
  { id: "listo", label: "Listos" },
  { id: "aprobado", label: "Aprobados" },
  { id: "error", label: "Con error" },
  { id: "enviado", label: "En Siigo" },
  { id: "omitido", label: "Sin RP" },
];
const TIPO_LABEL: Record<string, string> = {
  por_definir: "Por definir",
  pago_facturas: "Pago de facturas",
  anticipo: "Anticipo",
  detallado: "RP detallado",
  omitir: "Sin recibo",
};

const mesAnterior = () => {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

function Egresos() {
  const companyId = useActiveCompany();
  const { funcion } = usePerfilActivo();
  const qc = useQueryClient();
  const [periodo, setPeriodo] = useState(mesAnterior());
  const [estado, setEstado] = useState("por_revisar");
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [editando, setEditando] = useState<Fila | null>(null);
  const [enviando, setEnviando] = useState<{ hechos: number; total: number } | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  const sincronizar = useServerFn(egresosSincronizarCxP);
  const importar = useServerFn(egresosImportarReporte);
  const proponer = useServerFn(egresosProponer);
  const guardarBanco = useServerFn(egresosGuardarBanco);
  const aprobar = useServerFn(egresosAprobar);
  const enviar = useServerFn(egresosEnviar);
  const reintentar = useServerFn(egresosReintentar);
  const analizar = useServerFn(egresosAnalizarDiferencia);
  const corregir = useServerFn(egresosCorregirCompra);
  const enviarGrupoBancario = useServerFn(egresosEnviarGrupoBancario);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [buscarCxp, setBuscarCxp] = useState("");
  const onAnalizar = async (f: Fila) => {
    setTrabajando(f.id);
    try {
      const r = await analizar({ data: { egresoId: f.id } });
      if (!r.diferencias.length) toast.info("Lo pagado coincide con el saldo de cada factura.");
      refrescar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(null);
    }
  };
  const onCorregir = async (f: Fila, d: DiferenciaItem, i: number) => {
    const c = d.causas[i]!;
    const texto =
      `Se editará la compra ${d.compraNombre} en Siigo:\n\n${c.descripcion}\n\n` +
      `${c.accion!.tipo === "agregar" ? "Se AGREGARÁ" : "Se QUITARÁ"} ${c.accion!.impuestos.map((t) => t.name).join(" + ")} ` +
      `y la cuenta por pagar cambiará en ${cop(c.valor)}. ¿Confirmas la corrección?`;
    if (!window.confirm(texto)) return;
    setTrabajando(f.id);
    try {
      const r = await corregir({
        data: { egresoId: f.id, compraId: d.compraId!, causaIndex: i, confirmado: true },
      });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      refrescar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(null);
    }
  };
  const cargarConfig = useServerFn(siigoRecibosConfig);

  const filas = useQuery({
    queryKey: ["egresos", companyId, periodo],
    enabled: !!companyId,
    queryFn: async () => {
      const out: Fila[] = [];
      for (let desde = 0; ; desde += 1000) {
        const { data, error } = await supabase
          .from("egresos")
          .select(
            "id, period, fecha, descripcion, tercero_nombre, tercero_nit, valor, cuenta_etiqueta, relacion, aplicacion, observaciones, tipo, propuesta, estado, motivos, editado_por_usuaria, siigo_id, siigo_nombre, siigo_error",
          )
          .eq("company_id", companyId!)
          .eq("period", periodo)
          .order("fecha")
          .range(desde, desde + 999);
        if (error) throw error;
        out.push(...((data ?? []) as unknown as Fila[]));
        if ((data ?? []).length < 1000) break;
      }
      return out;
    },
  });
  const cxp = useQuery({
    queryKey: ["siigo-cxp", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("siigo_cuentas_por_pagar")
        .select(
          "prefix, consecutive, quote, due_date, balance, provider_nit, provider_name, factura_proveedor, synced_at",
        )
        .eq("company_id", companyId!)
        .order("due_date")
        .limit(5000);
      if (error) throw error;
      return data;
    },
  });
  // Terceros y PUC de la empresa para buscar por NIT/nombre y por código/nombre de cuenta.
  const catalogos = useQuery({
    queryKey: ["egresos-catalogos", companyId],
    enabled: !!companyId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const leer = async <T,>(
        consulta: (a: number, b: number) => PromiseLike<{ data: unknown }>,
      ) => {
        const out: T[] = [];
        for (let a = 0; ; a += 1000) {
          const { data } = await consulta(a, a + 999);
          out.push(...((data ?? []) as T[]));
          if (((data ?? []) as T[]).length < 1000) break;
        }
        return out;
      };
      const [terceros, puc] = await Promise.all([
        leer<TerceroOption>((a, b) =>
          supabase
            .from("providers")
            .select("nit, name")
            .eq("company_id", companyId!)
            .order("name")
            .range(a, b),
        ),
        leer<PucOption>((a, b) =>
          supabase
            .from("puc_accounts")
            .select("code, name, active, level, parent_code, has_children, is_movement")
            .eq("company_id", companyId!)
            .order("code")
            .range(a, b),
        ),
      ]);
      return { terceros: terceros.filter((t) => t.nit && t.name), puc };
    },
  });
  const leerAjustes = useServerFn(egresosCuentasAjuste);
  const ajustesEmpresa = useQuery({
    queryKey: ["egreso-ajustes", companyId],
    enabled: !!companyId,
    queryFn: () => leerAjustes({ data: { companyId: companyId! } }),
  });
  const reglasBanco = useQuery({
    queryKey: ["egreso-bancos", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("egreso_reglas")
        .select("patron, payment_type_id, cuenta_banco, notas")
        .eq("company_id", companyId!)
        .eq("clase", "banco");
      if (error) throw error;
      return data;
    },
  });
  const config = useQuery({
    queryKey: ["siigo-rp-config", companyId],
    enabled: !!companyId,
    staleTime: 10 * 60 * 1000,
    queryFn: () => cargarConfig({ data: { companyId: companyId! } }),
  });

  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ["egresos", companyId, periodo] });
    qc.invalidateQueries({ queryKey: ["siigo-cxp", companyId] });
    qc.invalidateQueries({ queryKey: ["egreso-bancos", companyId] });
  };

  const mSincronizar = useMutation({
    mutationFn: () => sincronizar({ data: { companyId: companyId!, periodo } }),
    onSuccess: (r) => {
      toast.success(
        `Cuentas por pagar de Siigo: ${r.vencimientos} vencimientos por ${cop(r.saldo)}${r.agregadasDeCompras ? `; ${r.agregadasDeCompras} tomadas del saldo de las compras porque el reporte de CxP de Siigo no las traía` : ""}${r.sinFactura ? ` (${r.sinFactura} sin número de factura del proveedor)` : ""}.`,
      );
      refrescar();
    },
    onError: (e) =>
      toast.error(
        e instanceof Error ? e.message : "No se pudieron leer las cuentas por pagar de Siigo.",
      ),
  });
  const mImportar = useMutation({
    mutationFn: async (file: File) => {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return importar({ data: { companyId: companyId!, nombre: file.name, base64: btoa(bin) } });
    },
    onSuccess: (r) => {
      if (r.periodo) setPeriodo(r.periodo);
      toast.success(
        `${r.nuevos} pagos nuevos, ${r.actualizados} actualizados. ${r.listos} listos y ${r.porRevisar} por revisar.`,
      );
      for (const a of r.advertencias) toast.warning(a);
      if (r.bancosSugeridos.length)
        toast.info(`Formas de pago sugeridas: ${r.bancosSugeridos.join("; ")}. Revísalas abajo.`);
      refrescar();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "No se pudo leer el reporte."),
  });
  const mProponer = useMutation({
    mutationFn: () => proponer({ data: { companyId: companyId!, periodo } }),
    onSuccess: (r) => {
      toast.success(`${r.listos} listos y ${r.porRevisar} por revisar.`);
      refrescar();
    },
  });

  const lista = useMemo(() => filas.data ?? [], [filas.data]);
  const conteo = useMemo(() => {
    const c: Record<string, { n: number; v: number }> = {};
    for (const f of lista) {
      const k = c[f.estado] ?? { n: 0, v: 0 };
      k.n += 1;
      k.v += Number(f.valor);
      c[f.estado] = k;
    }
    return c;
  }, [lista]);
  const visibles = lista.filter(
    (f) => f.estado === estado || (estado === "enviado" && f.estado === "enviando"),
  );
  const etiquetas = useMemo(
    () => [...new Set(lista.map((f) => f.cuenta_etiqueta).filter((x): x is string => !!x))].sort(),
    [lista],
  );

  // RP únicos del mes de gastos bancarios, uno por cuenta bancaria.
  const gruposBancarios = (() => {
    const m = new Map<string, { grupo: string; banco: string; filas: Fila[] }>();
    for (const f of lista) {
      const g = f.propuesta?.grupo;
      if (!g) continue;
      const x = m.get(g) ?? { grupo: g, banco: g.slice("bancario|".length), filas: [] };
      x.filas.push(f);
      m.set(g, x);
    }
    return [...m.values()].sort((a, b) => a.banco.localeCompare(b.banco));
  })();

  if (!companyId) return <EmptyCompany />;

  const enviarGrupo = async (g: { grupo: string; banco: string; filas: Fila[] }) => {
    const total = g.filas.reduce((s, f) => s + Number(f.valor), 0);
    if (
      !window.confirm(
        `Se creará en Siigo UN recibo de pago con los ${g.filas.length} gastos bancarios de ${g.banco} de ${periodo} por ${cop(total)}. ¿Continuar?`,
      )
    )
      return;
    setTrabajando(g.grupo);
    try {
      const r = await enviarGrupoBancario({ data: { companyId, periodo, grupo: g.grupo } });
      if (r.ok) toast.success(r.message);
      else toast.error(`Siigo rechazó el RP de ${g.banco}: ${r.message}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTrabajando(null);
      refrescar();
    }
  };

  const enviarAprobados = async () => {
    const ids = lista
      .filter(
        (f) =>
          f.estado === "aprobado" &&
          !f.propuesta?.grupo &&
          (seleccion.size === 0 || seleccion.has(f.id)),
      )
      .map((f) => f.id);
    if (!ids.length) {
      toast.info("No hay egresos aprobados para enviar.");
      return;
    }
    if (
      !window.confirm(
        `Se crearán ${ids.length} recibos de pago reales en Siigo, uno a uno. ¿Continuar?`,
      )
    )
      return;
    setEnviando({ hechos: 0, total: ids.length });
    // El envío sigue aunque un recibo falle: los errores quedan en la pestaña «Con error».
    // Solo se detiene con 3 errores seguidos (credenciales, conexión o Siigo caído).
    let ok = 0;
    let errores = 0;
    let seguidos = 0;
    let detenido = false;
    for (const [i, id] of ids.entries()) {
      let exito = false;
      // Un rechazo de validación de Siigo (400, 404, 409, 422) es propio de ese recibo: no
      // cuenta para detener el envío. Sí cuentan los errores generales (red, 401, 5xx).
      let general = true;
      try {
        const r = await enviar({ data: { egresoId: id } });
        exito = r.ok;
        if (!r.ok && (r.validacion || /respondi[oó] (400|404|409|422)/.test(r.message)))
          general = false;
      } catch {
        exito = false;
      }
      if (exito) {
        ok += 1;
        seguidos = 0;
      } else {
        errores += 1;
        seguidos = general ? seguidos + 1 : 0;
      }
      setEnviando({ hechos: i + 1, total: ids.length });
      if (seguidos >= 3) {
        detenido = true;
        break;
      }
    }
    setEnviando(null);
    if (ok) toast.success(`${ok} recibos creados en Siigo.`);
    if (errores)
      toast.error(
        detenido
          ? `${errores} recibos con error y 3 seguidos: el envío se detuvo para revisar (puede ser la conexión o las credenciales de Siigo). Revísalos en «Con error».`
          : `${errores} recibos con error; quedaron en la pestaña «Con error» para revisarlos.`,
      );
    setSeleccion(new Set());
    refrescar();
  };

  const formas = (config.data?.formas ?? []).filter((f) => f.active && !f.dueDate);
  const sincronizadoEl = cxp.data?.[0]?.synced_at ?? null;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Egresos y pagos</h1>
          <p className="text-xs text-muted-foreground">
            Recibos de pago/egreso (RP) en Siigo a partir de los pagos del mes y las cuentas por
            pagar de Siigo.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="month"
            value={periodo}
            onChange={(e) => setPeriodo(e.target.value)}
            className="h-8 w-40"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => mSincronizar.mutate()}
            disabled={mSincronizar.isPending}
          >
            {mSincronizar.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            Sincronizar CxP de Siigo
          </Button>
          {funcion("lector_consolidado_pagos") ? (
            <>
              <input
                ref={archivo}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) mImportar.mutate(f);
                  e.target.value = "";
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => archivo.current?.click()}
                disabled={mImportar.isPending}
              >
                {mImportar.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-1 h-4 w-4" />
                )}
                Cargar reporte de pagos
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => mProponer.mutate()}
            disabled={mProponer.isPending || !lista.length}
          >
            Volver a proponer
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-3 text-xs">
          <div className="font-semibold">Cuentas por pagar en Siigo</div>
          <div className="mt-1 text-muted-foreground">
            {cxp.data?.length
              ? `${cxp.data.length} vencimientos · saldo ${cop(cxp.data.reduce((s, c) => s + Number(c.balance), 0))} · leídas ${fecha(sincronizadoEl)}`
              : "Aún no se han leído. Usa «Sincronizar CxP de Siigo»."}
          </div>
          {cxp.data?.length ? (
            <div className="mt-2">
              <Input
                className="h-7"
                placeholder="Buscar en las CxP de Siigo: FC-1-…, factura del proveedor, NIT o nombre"
                value={buscarCxp}
                onChange={(e) => setBuscarCxp(e.target.value)}
              />
              {buscarCxp.trim().length >= 2 ? (
                <div className="mt-1 max-h-48 overflow-auto rounded border">
                  {(() => {
                    const q = buscarCxp.trim().toUpperCase().replace(/\s+/g, "");
                    const hallados = cxp.data.filter((c) =>
                      [
                        `${c.prefix}-${c.consecutive}`,
                        c.factura_proveedor,
                        c.provider_nit,
                        c.provider_name,
                      ]
                        .map((x) =>
                          String(x ?? "")
                            .toUpperCase()
                            .replace(/\s+/g, ""),
                        )
                        .some((x) => x.includes(q)),
                    );
                    if (!hallados.length)
                      return (
                        <div className="p-1 text-amber-700">
                          No está en el reporte de CxP de Siigo.
                        </div>
                      );
                    return hallados.slice(0, 40).map((c) => (
                      <div
                        key={`${c.prefix}-${c.consecutive}-${c.quote}`}
                        className="flex gap-2 border-b px-1 py-0.5"
                      >
                        <span className="w-24">
                          {c.prefix}-{c.consecutive}
                        </span>
                        <span className="w-28">{c.factura_proveedor ?? "sin factura"}</span>
                        <span className="w-24">{c.provider_nit}</span>
                        <span className="flex-1 truncate">{c.provider_name}</span>
                        <span className={Number(c.balance) > 0 ? "" : "text-red-700"}>
                          {cop(Number(c.balance))}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              ) : null}
            </div>
          ) : null}
          {funcion("lector_consolidado_pagos") ? (
            <div className="mt-2 text-muted-foreground">
              El reporte de pagos del mes («{"<MES> <AÑO>"}», hoja Consolidado) se lee solo desde la
              carpeta de egresos en Fuentes de documentos, o cárgalo aquí.
            </div>
          ) : (
            <div className="mt-2 text-amber-700">
              El lector del reporte de pagos de esta empresa aún no está configurado; se valida con
              su formato.
            </div>
          )}
        </div>
        <div className="rounded-lg border bg-card p-3 text-xs">
          <div className="font-semibold">Origen del pago → forma de pago de Siigo</div>
          {etiquetas.length === 0 ? (
            <div className="mt-1 text-muted-foreground">Sin pagos cargados en este mes.</div>
          ) : null}
          <div className="mt-1 space-y-1">
            {etiquetas.map((et) => {
              const r = reglasBanco.data?.find((x) => x.patron === et.toUpperCase().trim());
              return (
                <div key={et} className="flex flex-wrap items-center gap-2">
                  <span className="w-28 font-medium">{et}</span>
                  <select
                    className="h-7 min-w-56 rounded border bg-background px-1"
                    value={r?.payment_type_id ?? ""}
                    onChange={async (e) => {
                      const f = formas.find((x) => String(x.id) === e.target.value);
                      try {
                        await guardarBanco({
                          data: {
                            companyId,
                            etiqueta: et,
                            paymentTypeId: f ? String(f.id) : null,
                            cuentaBanco: f?.accountCode ?? r?.cuenta_banco ?? null,
                            periodo,
                          },
                        });
                        toast.success(`«${et}» → ${f?.name ?? "sin forma de pago"}`);
                        refrescar();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    <option value="">— Elegir —</option>
                    {formas.map((f) => (
                      <option key={f.id} value={String(f.id)}>
                        {f.name}
                        {f.accountCode ? ` (${f.accountCode})` : ""}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-muted-foreground">
                    Cuenta banco/caja
                    <Input
                      key={`${et}-${r?.cuenta_banco ?? ""}`}
                      className="h-7 w-28"
                      defaultValue={r?.cuenta_banco ?? ""}
                      placeholder="p. ej. 11100501"
                      onBlur={async (e) => {
                        const v = e.target.value.replace(/\D/g, "");
                        if (v === (r?.cuenta_banco ?? "")) return;
                        try {
                          await guardarBanco({
                            data: {
                              companyId,
                              etiqueta: et,
                              paymentTypeId: r?.payment_type_id ?? null,
                              cuentaBanco: v || null,
                              periodo,
                            },
                          });
                          toast.success(`«${et}»: cuenta ${v || "vacía (se toma del PUC)"}`);
                          refrescar();
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    />
                  </label>
                  {r?.notas ? <span className="text-amber-700">{r.notas}</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <CuentasAjuste companyId={companyId} periodo={periodo} onCambio={refrescar} />

      {gruposBancarios.length ? (
        <div className="rounded-lg border bg-card p-3 text-xs">
          <div className="font-semibold">
            RP de gastos bancarios del mes (uno por cuenta bancaria)
          </div>
          <div className="text-muted-foreground">
            Comisiones, cuota de manejo, IVA bancario y 4x1000 de cada banco van juntos en un solo
            recibo de pago, fechado el último día del mes.
          </div>
          <div className="mt-2 space-y-1">
            {gruposBancarios.map((g) => {
              const total = g.filas.reduce((s, f) => s + Number(f.valor), 0);
              const enviado = g.filas.find((f) => f.siigo_nombre)?.siigo_nombre;
              const pendientes = g.filas.filter(
                (f) => !["listo", "aprobado", "enviado", "enviando"].includes(f.estado),
              ).length;
              return (
                <div key={g.grupo} className="flex flex-wrap items-center gap-2">
                  <span className="w-28 font-medium">{g.banco}</span>
                  <span className="w-40">
                    {g.filas.length} movimientos · {cop(total)}
                  </span>
                  {enviado ? (
                    <span className="font-medium text-emerald-700">En Siigo: {enviado}</span>
                  ) : pendientes ? (
                    <span className="text-amber-700">
                      {pendientes} por revisar (cuenta débito o tercero) en «Por revisar»
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      className="h-7"
                      disabled={trabajando === g.grupo}
                      onClick={() => enviarGrupo(g)}
                    >
                      {trabajando === g.grupo ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="mr-1 h-3 w-3" />
                      )}
                      Enviar RP de {g.banco}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {funcion("compras_por_pagar") ? (
        <ComprasPorPagarPanel
          companyId={companyId}
          periodo={periodo}
          onCambio={() => {
            refrescar();
            mProponer.mutate();
          }}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {ESTADOS.map((e) => (
          <Button
            key={e.id}
            size="sm"
            variant={estado === e.id ? "default" : "outline"}
            onClick={() => {
              setEstado(e.id);
              setSeleccion(new Set());
            }}
          >
            {e.label} ({conteo[e.id]?.n ?? 0}){conteo[e.id] ? ` · ${cop(conteo[e.id]!.v)}` : ""}
          </Button>
        ))}
        <div className="ml-auto flex gap-2">
          {estado === "listo" ? (
            <Button
              size="sm"
              onClick={async () => {
                const ids = seleccion.size ? [...seleccion] : visibles.map((f) => f.id);
                const r = await aprobar({ data: { ids, aprobar: true } });
                toast.success(`${r.cambiados} aprobados.`);
                setSeleccion(new Set());
                refrescar();
              }}
              disabled={!visibles.length}
            >
              Aprobar {seleccion.size ? `${seleccion.size} seleccionados` : "todos"}
            </Button>
          ) : null}
          {estado === "aprobado" ? (
            <Button size="sm" onClick={enviarAprobados} disabled={!!enviando || !visibles.length}>
              {enviando ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-1 h-4 w-4" />
              )}
              {enviando
                ? `Enviando ${enviando.hechos}/${enviando.total}`
                : `Enviar a Siigo ${seleccion.size ? `(${seleccion.size})` : "(todos)"}`}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2"></th>
              <th className="p-2">Fecha</th>
              <th className="p-2">Pago</th>
              <th className="p-2 text-right">Valor</th>
              <th className="p-2">Origen</th>
              <th className="p-2">Relación / instrucción</th>
              <th className="p-2">Propuesta</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {filas.isLoading ? (
              <tr>
                <td colSpan={8} className="p-4 text-center text-muted-foreground">
                  Cargando…
                </td>
              </tr>
            ) : visibles.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-4 text-center text-muted-foreground">
                  Sin egresos en este estado.
                </td>
              </tr>
            ) : (
              visibles.map((f) => (
                <tr key={f.id} className="border-t align-top">
                  <td className="p-2">
                    {["listo", "aprobado"].includes(f.estado) ? (
                      <Checkbox
                        checked={seleccion.has(f.id)}
                        onCheckedChange={(v) =>
                          setSeleccion((s) => {
                            const n = new Set(s);
                            if (v) n.add(f.id);
                            else n.delete(f.id);
                            return n;
                          })
                        }
                      />
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap p-2">{fecha(f.fecha)}</td>
                  <td className="p-2">
                    <div className="font-medium">{f.tercero_nombre ?? f.descripcion}</div>
                    <div className="text-muted-foreground">
                      {f.descripcion}
                      {f.tercero_nit ? ` · NIT ${f.tercero_nit}` : ""}
                    </div>
                  </td>
                  <td className="whitespace-nowrap p-2 text-right font-medium">
                    {cop(Number(f.valor))}
                  </td>
                  <td className="p-2">{f.cuenta_etiqueta}</td>
                  <td className="max-w-72 whitespace-pre-line p-2">
                    {f.relacion}
                    {f.aplicacion ? <div className="text-blue-700">{f.aplicacion}</div> : null}
                    {f.observaciones ? (
                      <div className="text-muted-foreground">{f.observaciones}</div>
                    ) : null}
                  </td>
                  <td className="max-w-80 p-2">
                    <Badge variant="outline">{TIPO_LABEL[f.tipo] ?? f.tipo}</Badge>
                    {f.editado_por_usuaria ? (
                      <Badge variant="secondary" className="ml-1">
                        Editado
                      </Badge>
                    ) : null}
                    {f.propuesta?.items?.map((i) => (
                      <div key={`${i.prefix}-${i.consecutive}-${i.quote}`}>
                        {i.factura ?? `${i.prefix}-${i.consecutive}`} → {i.prefix}-{i.consecutive}:{" "}
                        {cop(i.valor)}
                        {i.valor < i.saldo ? (
                          <span className="text-muted-foreground">
                            {" "}
                            (abono; saldo {cop(i.saldo)})
                          </span>
                        ) : null}
                      </div>
                    ))}
                    {f.propuesta?.lineas?.map((l, i) => (
                      <div key={`l${i}`}>
                        {l.movimiento === "Debit" ? "Débito" : "Crédito"} {l.code}:{" "}
                        {cop(Number(l.valor))}
                        {l.descripcion ? ` · ${l.descripcion}` : ""}
                      </div>
                    ))}
                    {f.propuesta?.anticipo ? (
                      <div>
                        + Recibo de anticipo aparte (excedente): {cop(f.propuesta.anticipo.valor)}
                      </div>
                    ) : null}
                    {f.propuesta?.ajuste ? (
                      <div>
                        Ajuste al peso {f.propuesta.ajuste.valor > 0 ? "débito" : "crédito"}{" "}
                        {f.propuesta.ajuste.cuenta}: {cop(Math.abs(f.propuesta.ajuste.valor))}
                      </div>
                    ) : null}
                    {f.propuesta?.cuentas?.map((c) => (
                      <div key={`${c.code}-${c.movimiento}`}>
                        {c.movimiento === "Debit" ? "Débito" : "Crédito"} {c.code}: {cop(c.valor)}
                      </div>
                    ))}
                    {f.motivos?.map((m) => (
                      <div key={m} className="text-amber-700">
                        • {m}
                      </div>
                    ))}
                    {f.propuesta?.notas?.map((m) => (
                      <div key={m} className="text-muted-foreground">
                        {m}
                      </div>
                    ))}
                    {f.siigo_nombre ? (
                      <div className="font-medium text-emerald-700">Siigo {f.siigo_nombre}</div>
                    ) : null}
                    {f.siigo_error ? <div className="text-red-700">{f.siigo_error}</div> : null}
                    {!f.siigo_id &&
                    f.motivos?.some((m) => m.startsWith("Diferencia con la CxP")) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="mt-1"
                        disabled={trabajando === f.id}
                        onClick={() => onAnalizar(f)}
                      >
                        {trabajando === f.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : null}
                        Analizar diferencia
                      </Button>
                    ) : null}
                    {(
                      (f.propuesta as { diferencias?: DiferenciaItem[] } | null)?.diferencias ?? []
                    ).map((d) => (
                      <div
                        key={`${d.prefix}-${d.consecutive}`}
                        className="mt-1 rounded border border-amber-300 bg-amber-50 p-1"
                      >
                        <div className="font-medium">
                          {d.factura ?? d.compraNombre} ({d.compraNombre}): saldo {cop(d.saldo)} ·
                          pagado {cop(d.pagado)} ·{" "}
                          {d.diferencia > 0
                            ? `pagó ${cop(d.diferencia)} menos`
                            : `pagó ${cop(-d.diferencia)} más`}
                        </div>
                        {d.error ? <div className="text-red-700">{d.error}</div> : null}
                        {d.causas.length === 0 && !d.error ? (
                          <div>
                            No se encontró una causa que explique la diferencia; revísala con el
                            proveedor.
                          </div>
                        ) : null}
                        {d.causas.map((c, i) => (
                          <div key={i} className="flex items-start gap-1">
                            <span>{c.exacta ? "✔" : "≈"}</span>
                            <span className="flex-1">{c.descripcion}</span>
                            {c.accion && d.compraId ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2"
                                disabled={trabajando === f.id}
                                onClick={() => onCorregir(f, d, i)}
                              >
                                Corregir en Siigo
                              </Button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </td>
                  <td className="whitespace-nowrap p-2">
                    {!f.siigo_id && f.estado !== "enviando" ? (
                      <Button size="sm" variant="outline" onClick={() => setEditando(f)}>
                        Revisar
                      </Button>
                    ) : null}
                    {f.estado === "error" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await reintentar({ data: { egresoId: f.id } });
                          refrescar();
                        }}
                      >
                        Reintentar
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editando ? (
        <EditarEgreso
          fila={editando}
          cxp={(cxp.data ?? []) as Cxp[]}
          pendientes={lista}
          tope={ajustesEmpresa.data?.tope ?? 1000}
          terceros={catalogos.data?.terceros ?? []}
          puc={catalogos.data?.puc ?? []}
          onClose={() => setEditando(null)}
          onSaved={() => {
            setEditando(null);
            refrescar();
          }}
        />
      ) : null}
    </div>
  );
}

type Cxp = {
  prefix: string;
  consecutive: number;
  quote: number;
  due_date: string | null;
  balance: number;
  provider_nit: string | null;
  provider_name: string | null;
  factura_proveedor: string | null;
};

/** Pagos pendientes parecidos al de origen: mismo concepto, tercero o descripción. */
function pagosParecidos(origen: Fila, pendientes: Fila[]): Fila[] {
  const patron = patronConcepto({ relacion: origen.relacion, descripcion: origen.descripcion });
  const tercero = normalizar(origen.tercero_nombre);
  const nit = String(origen.tercero_nit ?? "");
  const desc = normalizar(origen.descripcion)
    .replace(/\d+/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return pendientes.filter(
    (f) =>
      f.id !== origen.id &&
      !f.siigo_id &&
      ["por_revisar", "listo"].includes(f.estado) &&
      (patronConcepto({ relacion: f.relacion, descripcion: f.descripcion }) === patron ||
        (!!tercero && normalizar(f.tercero_nombre) === tercero) ||
        (!!nit && f.tercero_nit === nit) ||
        (!!desc &&
          normalizar(f.descripcion)
            .replace(/\d+/g, "")
            .split(" ")
            .filter(Boolean)
            .slice(0, 3)
            .join(" ") === desc)),
  );
}

function EditarEgreso({
  fila,
  cxp,
  pendientes,
  tope,
  terceros,
  puc,
  onClose,
  onSaved,
}: {
  fila: Fila;
  cxp: Cxp[];
  pendientes: Fila[];
  /** Tope del ajuste al peso de la empresa. */
  tope: number;
  terceros: TerceroOption[];
  puc: PucOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const guardar = useServerFn(egresosGuardarEdicion);
  const replicar = useServerFn(egresosReplicar);
  const [parecidos, setParecidos] = useState<Fila[] | null>(null);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [replicando, setReplicando] = useState(false);
  const base =
    fila.propuesta ??
    ({
      tipo: "por_definir",
      items: [],
      cuentas: [],
      motivos: [],
      notas: [],
    } as unknown as Propuesta);
  const [tipo, setTipo] = useState<TipoEgreso>(fila.tipo);
  const [nit, setNit] = useState(base.terceroNit ?? fila.tercero_nit ?? "");
  const [items, setItems] = useState<ItemPago[]>(base.items ?? []);
  // Líneas adicionales del pago de facturas: otras cuentas y valores para completar el RP.
  const [lineas, setLineas] = useState<CuentaDetallada[]>(
    base.lineas ??
      // RP detallado ya guardado: [débito principal, ...otras líneas, crédito al banco].
      (base.tipo === "detallado" && (base.cuentas ?? []).length > 2
        ? base.cuentas.slice(1, -1)
        : []),
  );
  const [cuentaDebito, setCuentaDebito] = useState(
    base.cuentas?.find((c) => c.movimiento === "Debit")?.code ?? "",
  );
  const [cuentaBanco, setCuentaBanco] = useState(
    base.cuentaBanco ?? base.cuentas?.find((c) => c.movimiento === "Credit")?.code ?? "",
  );
  const [aprender, setAprender] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const valor = Number(fila.valor);
  const [buscarFactura, setBuscarFactura] = useState("");
  // Con texto en el buscador se busca en todas las CxP (NIT, nombre, factura o FC); sin texto,
  // las del NIT del tercero. Las facturas ya elegidas siempre se muestran.
  const q = buscarFactura.trim().toUpperCase().replace(/\s+/g, "");
  const elegidas = new Set(items.map((i) => `${i.prefix}-${i.consecutive}-${i.quote}`));
  const delTercero = cxp.filter((c) => {
    if (elegidas.has(`${c.prefix}-${c.consecutive}-${c.quote}`)) return true;
    if (q.length >= 2)
      return [c.provider_nit, c.provider_name, c.factura_proveedor, `${c.prefix}-${c.consecutive}`]
        .map((x) =>
          String(x ?? "")
            .toUpperCase()
            .replace(/\s+/g, ""),
        )
        .some((x) => x.includes(q));
    return !nit || String(c.provider_nit ?? "") === nit.replace(/\D/g, "");
  });
  const netoOtras = lineas.reduce(
    (s, l) => s + (l.movimiento === "Debit" ? 1 : -1) * Number(l.valor || 0),
    0,
  );
  const suma = items.reduce((s, i) => s + Number(i.valor || 0), 0) + netoOtras;
  // RP detallado: la cuenta débito principal lleva lo que no cubren las otras líneas.
  const valorPrincipal = Math.round((valor - netoOtras) * 100) / 100;

  const onGuardar = async () => {
    setGuardando(true);
    const desc = String(fila.descripcion ?? "Egreso").slice(0, 100);
    const p: Propuesta = {
      ...base,
      tipo,
      terceroNit: nit || null,
      terceroNombre: fila.tercero_nombre,
      items: tipo === "pago_facturas" ? items : [],
      lineas: tipo === "pago_facturas" ? lineas.filter((l) => l.code || Number(l.valor)) : null,
      // RP detallado: débito principal por lo que no cubren las otras líneas, las otras
      // líneas y el crédito al banco/caja por lo pagado.
      cuentas:
        tipo === "detallado" && cuentaDebito && cuentaBanco
          ? [
              ...(valorPrincipal > 0.009
                ? [
                    {
                      code: cuentaDebito.trim(),
                      movimiento: "Debit" as const,
                      valor: valorPrincipal,
                      descripcion: desc,
                    },
                  ]
                : []),
              ...lineas.filter((l) => l.code || Number(l.valor)),
              { code: cuentaBanco.trim(), movimiento: "Credit", valor, descripcion: desc },
            ]
          : [],
      cuentaBanco: cuentaBanco || null,
      listo: false,
      motivos: [],
      notas: base.notas ?? [],
    };
    try {
      const r = await guardar({
        data: { egresoId: fila.id, propuesta: p, aprender: aprender && tipo !== "pago_facturas" },
      });
      if (r.errores.length) toast.warning(r.errores.join(" "));
      else toast.success(tipo === "omitir" ? "Marcado sin recibo de pago." : "Aprobado.");
      if (r.repropuestos)
        toast.info(`Aprendido: ${r.repropuestos.listos} pagos del mes quedaron listos.`);
      // Otros pagos pendientes parecidos: se ofrece replicar este tratamiento.
      const similares = r.errores.length
        ? []
        : pagosParecidos({ ...fila, tercero_nit: nit || fila.tercero_nit }, pendientes);
      if (similares.length) {
        setParecidos(similares);
        setMarcados(new Set(similares.map((f) => f.id)));
        return;
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  };

  const onReplicar = async () => {
    setReplicando(true);
    try {
      const r = await replicar({ data: { origenId: fila.id, destinoIds: [...marcados] } });
      toast.success(
        `Tratamiento replicado: ${r.aprobados} aprobados${r.porRevisar ? `, ${r.porRevisar} quedan por revisar` : ""}.`,
      );
      for (const m of r.mensajes.slice(0, 5)) toast.warning(m);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setReplicando(false);
    }
  };

  if (parecidos)
    return (
      <Dialog open onOpenChange={(o) => !o && onSaved()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>¿Replicar este tratamiento en otros pagos?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-xs">
            <div className="text-muted-foreground">
              {TIPO_LABEL[tipo]} · tercero {nit || "—"}
              {tipo === "detallado" && cuentaDebito ? ` · débito ${cuentaDebito}` : ""}
              {tipo === "pago_facturas"
                ? " · cada pago se aplica a las facturas con saldo de este tercero (de la más antigua a la más nueva)"
                : ""}
              .
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2"
                onClick={() => setMarcados(new Set(parecidos.map((f) => f.id)))}
              >
                Todos ({parecidos.length})
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2"
                onClick={() => setMarcados(new Set())}
              >
                Ninguno
              </Button>
            </div>
            <div className="max-h-80 overflow-auto rounded border">
              {parecidos.map((f) => (
                <label key={f.id} className="flex items-center gap-2 border-b px-2 py-1">
                  <Checkbox
                    checked={marcados.has(f.id)}
                    onCheckedChange={(v) =>
                      setMarcados((x) => {
                        const n = new Set(x);
                        if (v) n.add(f.id);
                        else n.delete(f.id);
                        return n;
                      })
                    }
                  />
                  <span className="w-20">{fecha(f.fecha)}</span>
                  <span className="flex-1 truncate">{f.tercero_nombre ?? f.descripcion}</span>
                  <span className="w-28 truncate text-muted-foreground">{f.relacion}</span>
                  <span className="w-20">{f.cuenta_etiqueta}</span>
                  <span className="w-28 text-right">{cop(Number(f.valor))}</span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onSaved}>
              No replicar
            </Button>
            <Button onClick={onReplicar} disabled={replicando || marcados.size === 0}>
              {replicando ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Aplicar a {marcados.size} pagos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {fecha(fila.fecha)} · {fila.tercero_nombre ?? fila.descripcion} · {cop(valor)}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          <div className="rounded border bg-muted/30 p-2 whitespace-pre-line">
            <b>Relación:</b> {fila.relacion ?? "—"}
            {fila.aplicacion ? (
              <div>
                <b>Aplicación:</b> {fila.aplicacion}
              </div>
            ) : null}
            {fila.observaciones ? (
              <div>
                <b>Observaciones:</b> {fila.observaciones}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-1">
              Tipo
              <select
                className="h-7 rounded border bg-background px-1"
                value={tipo}
                onChange={(e) => setTipo(e.target.value as TipoEgreso)}
              >
                {(["pago_facturas", "anticipo", "detallado", "omitir"] as const).map((t) => (
                  <option key={t} value={t}>
                    {TIPO_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-80 items-center gap-1">
              Tercero
              <TerceroCombobox terceros={terceros} value={nit} onChange={(n) => setNit(n)} />
            </label>
          </div>

          {tipo === "pago_facturas" ? (
            <div className="space-y-1">
              <div className="font-medium">
                Facturas a pagar (cuentas por pagar de Siigo
                {nit && q.length < 2 ? ` del NIT ${nit}` : ""})
              </div>
              <Input
                className="h-7"
                placeholder="Buscar factura por NIT, nombre del proveedor, número de factura o FC"
                value={buscarFactura}
                onChange={(e) => setBuscarFactura(e.target.value)}
              />
              <div className="max-h-64 overflow-auto rounded border">
                {delTercero.slice(0, 200).map((c) => {
                  const k = `${c.prefix}-${c.consecutive}-${c.quote}`;
                  const it = items.find((i) => `${i.prefix}-${i.consecutive}-${i.quote}` === k);
                  return (
                    <div key={k} className="flex items-center gap-2 border-b px-2 py-1">
                      <Checkbox
                        checked={!!it}
                        onCheckedChange={(v) => {
                          // Sin NIT del tercero, se toma el del proveedor de la factura elegida.
                          if (v && !nit && c.provider_nit) setNit(String(c.provider_nit));
                          setItems((xs) =>
                            v
                              ? [
                                  ...xs,
                                  {
                                    prefix: c.prefix,
                                    consecutive: c.consecutive,
                                    quote: c.quote,
                                    valor: Math.min(Number(c.balance), Math.max(0, valor - suma)),
                                    factura: c.factura_proveedor,
                                    saldo: Number(c.balance),
                                    vence: c.due_date,
                                  },
                                ]
                              : xs.filter((x) => `${x.prefix}-${x.consecutive}-${x.quote}` !== k),
                          );
                        }}
                      />
                      <span className="w-40">
                        {c.factura_proveedor ?? "—"} ({c.prefix}-{c.consecutive})
                      </span>
                      <span className="w-48 truncate text-muted-foreground">{c.provider_name}</span>
                      <span className="w-28 text-right">saldo {cop(Number(c.balance))}</span>
                      {it ? (
                        <Input
                          className="h-7 w-32"
                          type="number"
                          value={it.valor}
                          onChange={(e) =>
                            setItems((xs) =>
                              xs.map((x) =>
                                `${x.prefix}-${x.consecutive}-${x.quote}` === k
                                  ? { ...x, valor: Number(e.target.value) }
                                  : x,
                              ),
                            )
                          }
                        />
                      ) : null}
                    </div>
                  );
                })}
                {delTercero.length === 0 ? (
                  <div className="p-2 text-muted-foreground">
                    No hay cuentas por pagar{nit ? " de este NIT" : ""}. Sincroniza las CxP de
                    Siigo.
                  </div>
                ) : null}
              </div>
              <EditorLineas
                lineas={lineas}
                setLineas={setLineas}
                puc={puc}
                faltante={valor - suma}
                descripcion={String(fila.descripcion ?? "")}
              />
              <div
                className={Math.abs(suma - valor) > 0.009 ? "text-amber-700" : "text-emerald-700"}
              >
                Aplicado {cop(suma)} de {cop(valor)}
                {lineas.length
                  ? ` (facturas ${cop(suma - netoOtras)} + otras líneas ${cop(netoOtras)})`
                  : ""}
              </div>
              {valor - suma > tope && items.length ? (
                <div className="text-blue-700">
                  Al enviar, el excedente de {cop(valor - suma)} (pago mayor que las facturas) va en
                  un recibo de ANTICIPO aparte al proveedor, desde el mismo banco; los dos recibos
                  suman lo pagado.
                </div>
              ) : null}
              {Math.abs(valor - suma) >= 0.01 && Math.abs(valor - suma) <= tope ? (
                <div className="text-blue-700">
                  Al guardar se agrega un ajuste al peso{" "}
                  {valor > suma ? "débito (se pagó de más)" : "crédito (se pagó de menos)"} de{" "}
                  {cop(Math.abs(valor - suma))} para que el recibo cuadre con el banco.
                </div>
              ) : null}
            </div>
          ) : null}

          {tipo === "detallado" ? (
            <div className="flex flex-wrap gap-3">
              <label className="flex min-w-96 items-center gap-1">
                Cuenta débito
                <AccountCombobox
                  accounts={puc}
                  value={cuentaDebito}
                  onChange={(code) => setCuentaDebito(code)}
                  placeholder="Código o nombre de la cuenta…"
                  className="h-7"
                />
              </label>
              <label className="flex items-center gap-1">
                Crédito (banco/caja)
                <Input
                  className="h-7 w-32"
                  value={cuentaBanco}
                  onChange={(e) => setCuentaBanco(e.target.value.replace(/\D/g, ""))}
                />
              </label>
              <div className="w-full space-y-1">
                <EditorLineas
                  lineas={lineas}
                  setLineas={setLineas}
                  puc={puc}
                  faltante={0}
                  descripcion={String(fila.descripcion ?? "")}
                />
                {lineas.length ? (
                  <div className={valorPrincipal < -0.009 ? "text-amber-700" : "text-emerald-700"}>
                    Cuenta débito principal {cuentaDebito || "—"}: {cop(valorPrincipal)} · otras
                    líneas {cop(netoOtras)} · crédito {cuentaBanco || "banco"}: {cop(valor)}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tipo !== "pago_facturas" ? (
            <label className="flex items-center gap-2">
              <Checkbox checked={aprender} onCheckedChange={(v) => setAprender(!!v)} />
              Recordar para los pagos con este mismo concepto (este mes y los siguientes)
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={onGuardar} disabled={guardando}>
            {guardando ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Guardar y aprobar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Cuentas del ajuste al peso de los recibos (débito si se pagó de más, crédito si de menos) y CxP cruzada. */
function CuentasAjuste({
  companyId,
  periodo,
  onCambio,
}: {
  companyId: string;
  periodo: string;
  onCambio: () => void;
}) {
  const leer = useServerFn(egresosCuentasAjuste);
  const guardar = useServerFn(egresosGuardarCuentasAjuste);
  const cuentas = useQuery({
    queryKey: ["egreso-ajustes", companyId],
    queryFn: () => leer({ data: { companyId } }),
  });
  const [form, setForm] = useState<{
    debito: string;
    credito: string;
    cxp: string;
    anticipo: string;
    tope: string;
  } | null>(null);
  const v = form ?? {
    debito: cuentas.data?.debito ?? "",
    credito: cuentas.data?.credito ?? "",
    cxp: cuentas.data?.cxp ?? "",
    anticipo: cuentas.data?.anticipo ?? "",
    tope: cuentas.data?.tope != null ? String(cuentas.data.tope) : "1000",
  };
  const onGuardar = async () => {
    try {
      await guardar({
        data: {
          companyId,
          debito: v.debito || null,
          credito: v.credito || null,
          cxp: v.cxp || null,
          anticipo: v.anticipo || null,
          tope: v.tope === "" ? null : Number(v.tope),
          periodo,
        },
      });
      toast.success("Cuentas del ajuste al peso guardadas; pagos del mes vueltos a proponer.");
      setForm(null);
      cuentas.refetch();
      onCambio();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const campo = (k: "debito" | "credito" | "cxp" | "anticipo" | "tope", etiqueta: string) => (
    <label className="flex items-center gap-1">
      {etiqueta}
      <Input
        className="h-7 w-28"
        value={v[k]}
        onChange={(e) => setForm({ ...v, [k]: e.target.value.replace(/\D/g, "") })}
      />
    </label>
  );
  return (
    <div className="rounded-lg border bg-card p-3 text-xs">
      <div className="font-semibold">Ajuste al peso de los recibos de pago</div>
      <div className="text-muted-foreground">
        Si lo pagado no coincide con las facturas por hasta {cop(cuentas.data?.tope ?? 1000)}, el
        recibo lleva un ajuste al peso: débito si se pagó de más y crédito si se pagó de menos,
        cruzando la CxP de cada factura (recibo detallado).
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {campo("debito", "Débito (pagó de más)")}
        {campo("credito", "Crédito (pagó de menos)")}
        {campo("cxp", "CxP cruzada")}
        {campo("anticipo", "Anticipos (excedente)")}
        {campo("tope", "Tope del ajuste ($)")}
        <Button size="sm" variant="outline" className="h-7" onClick={onGuardar} disabled={!form}>
          Guardar
        </Button>
      </div>
    </div>
  );
}

/** Líneas adicionales del recibo: cuenta, débito/crédito, valor y descripción; agregar y borrar. */
function EditorLineas({
  lineas,
  setLineas,
  puc,
  faltante,
  descripcion,
}: {
  lineas: CuentaDetallada[];
  setLineas: React.Dispatch<React.SetStateAction<CuentaDetallada[]>>;
  puc: PucOption[];
  faltante: number;
  descripcion: string;
}) {
  return (
    <>
      <div className="mt-2 font-medium">
        Otras líneas del recibo (cuentas y valores adicionales)
      </div>
      {lineas.map((l, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <div className="min-w-80 flex-1">
            <AccountCombobox
              accounts={puc}
              value={l.code}
              onChange={(code) =>
                setLineas((xs) => xs.map((x, j) => (j === i ? { ...x, code } : x)))
              }
              placeholder="Código o nombre de la cuenta…"
              className="h-7"
            />
          </div>
          <select
            className="h-7 rounded border bg-background px-1"
            value={l.movimiento}
            onChange={(e) =>
              setLineas((xs) =>
                xs.map((x, j) =>
                  j === i ? { ...x, movimiento: e.target.value as "Debit" | "Credit" } : x,
                ),
              )
            }
          >
            <option value="Debit">Débito</option>
            <option value="Credit">Crédito</option>
          </select>
          <Input
            className="h-7 w-32"
            type="number"
            value={l.valor || ""}
            placeholder="Valor"
            onChange={(e) =>
              setLineas((xs) =>
                xs.map((x, j) => (j === i ? { ...x, valor: Number(e.target.value) } : x)),
              )
            }
          />
          <Input
            className="h-7 w-48"
            value={l.descripcion}
            placeholder="Descripción"
            onChange={(e) =>
              setLineas((xs) =>
                xs.map((x, j) => (j === i ? { ...x, descripcion: e.target.value } : x)),
              )
            }
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-red-700"
            onClick={() => setLineas((xs) => xs.filter((_, j) => j !== i))}
          >
            Borrar
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        onClick={() =>
          setLineas((xs) => [
            ...xs,
            {
              code: "",
              movimiento: "Debit",
              // Por defecto, lo que falta para cuadrar el pago.
              valor: Math.max(0, Math.round(faltante * 100) / 100),
              descripcion: descripcion.slice(0, 100),
            },
          ])
        }
      >
        + Agregar línea
      </Button>
    </>
  );
}
