// Bases mínimas de retención: tabla legal por año (global para todas las
// empresas) y concepto de cada retención configurada en la empresa activa.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { invalidateBulkDeps } from "@/lib/bulk-runner";
import { cop } from "@/lib/format";
import {
  baseMinimaDe,
  tablasVigentes,
  uvtAPesos,
  type ConceptoBase,
  type ImpuestoConfigurado,
  type TablaBases,
} from "@/lib/precedente-tributario";
import { cargarTablasBases, invalidarTablasBases } from "@/lib/precedente-tributario.data";

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const slug = (s: string) =>
  sinTildes(s)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60) || "concepto";

/** Número escrito en formato colombiano o anglosajón ("1.234,5", "1,234.5", "52374"). */
export function numero(v: unknown): number {
  if (typeof v === "number") return v;
  const t = String(v ?? "").replace(/[$%\s]/g, "");
  if (!t) return 0;
  const coma = t.lastIndexOf(",");
  const punto = t.lastIndexOf(".");
  let normal: string;
  if (coma >= 0 && punto >= 0)
    normal = coma > punto ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  // Un solo separador repetido en grupos de 3 cifras es de miles ("52.374", "1,234,567").
  else if (punto >= 0) normal = /^-?\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : t;
  else if (coma >= 0)
    normal = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  else normal = t;
  const n = Number(normal);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Lee la tabla de bases mínimas de una hoja (Excel o CSV). Reconoce columnas por
 * nombre: concepto; base en UVT; base en pesos; tarifa (declarante / no declarante).
 */
export function leerTablaBases(filas: unknown[][], uvt: number): ConceptoBase[] {
  const idx = filas.findIndex((f) => f.some((c) => /concepto/i.test(String(c ?? ""))));
  if (idx < 0) throw new Error('No encontré una columna "Concepto" en el archivo.');
  const enc = filas[idx]!.map((c) => sinTildes(String(c ?? "")));
  const col = (re: RegExp, excluir?: RegExp) =>
    enc.findIndex((h) => re.test(h) && !(excluir && excluir.test(h)));
  const cConcepto = col(/concepto/);
  const cUvt = col(/uvt/);
  const cPesos = col(/(base|pesos|\$)/, /uvt/);
  const cNoDecl = col(/no\s*declarante/);
  const cDecl = col(/(declarante|tarifa|%)/, /no\s*declarante/);
  const usados = new Set<string>();
  const out: ConceptoBase[] = [];
  for (const f of filas.slice(idx + 1)) {
    const concepto = String(f[cConcepto] ?? "").trim();
    if (!concepto) continue;
    let baseUvt = cUvt >= 0 ? numero(f[cUvt]) : 0;
    if (!baseUvt && cPesos >= 0 && uvt > 0)
      baseUvt = Math.round((numero(f[cPesos]) / uvt) * 100) / 100;
    let id = slug(concepto);
    for (let n = 2; usados.has(id); n++) id = `${slug(concepto)}_${n}`;
    usados.add(id);
    out.push({
      id,
      concepto,
      base_uvt: baseUvt,
      tarifa_declarante: cDecl >= 0 ? numero(f[cDecl]) || null : null,
      tarifa_no_declarante: cNoDecl >= 0 ? numero(f[cNoDecl]) || null : null,
      notas: null,
    });
  }
  return out;
}

const VACIAS = new Set([
  "de",
  "la",
  "el",
  "en",
  "por",
  "y",
  "o",
  "a",
  "los",
  "las",
  "del",
  "con",
  "sin",
  "para",
  "retencion",
  "rete",
  "fuente",
  "retefuente",
  "rte",
  "rtf",
  "ret",
  "tarifa",
  "otros",
  "otras",
  "otro",
  "varios",
  "general",
  "generales",
  "pagos",
  "valor",
  "impuesto",
]);
const palabras = (t: string) =>
  sinTildes(t)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !VACIAS.has(w) && !/^\d/.test(w));

/**
 * Concepto sugerido para una retención: palabras en común entre el nombre del
 * impuesto y el concepto (por raíz), más la tarifa igual a la del concepto. Si
 * el nombre no dice "no declarante", se prefiere el concepto general de
 * declarantes. Solo sugiere si hay un único mejor candidato.
 */
export function sugerirConcepto(
  tax: Pick<ImpuestoConfigurado, "name" | "rate">,
  conceptos: ConceptoBase[],
): string | null {
  const delImpuesto = palabras(tax.name);
  if (!delImpuesto.length) return null;
  const noDeclarante = /no\s*declarante/.test(sinTildes(tax.name));
  const raiz = (w: string) => w.slice(0, 5);
  const puntajes = conceptos.map((c) => {
    const delConcepto = new Set(palabras(c.concepto).map(raiz));
    const comunes = delImpuesto.filter((w) => delConcepto.has(raiz(w))).length;
    if (!comunes) return { c, p: 0 };
    const tarifa = noDeclarante
      ? c.tarifa_no_declarante
      : (c.tarifa_declarante ?? c.tarifa_no_declarante);
    let p = comunes * 10;
    if (tarifa != null && Number(tarifa) === Number(tax.rate)) p += 5;
    else if (
      Number(c.tarifa_declarante) === Number(tax.rate) ||
      Number(c.tarifa_no_declarante) === Number(tax.rate)
    )
      p += 2;
    const concepto = sinTildes(c.concepto);
    if (/general/.test(concepto)) p += 2;
    if (/no declarante/.test(concepto) !== noDeclarante) p -= 1;
    return { c, p };
  });
  const orden = puntajes.filter((x) => x.p > 0).sort((a, b) => b.p - a.p);
  if (!orden.length || (orden.length > 1 && orden[0]!.p === orden[1]!.p)) return null;
  return orden[0]!.c.id;
}

export function BasesMinimasPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const archivo = useRef<HTMLInputElement>(null);
  const hoy = new Date().toISOString().slice(0, 10);
  /** Tabla seleccionada (su fecha "desde") o "nueva". */
  const [seleccion, setSeleccion] = useState<string>("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [uvt, setUvt] = useState("");
  const [conceptos, setConceptos] = useState<ConceptoBase[]>([]);
  const [fuente, setFuente] = useState("");
  const [guardando, setGuardando] = useState(false);

  const tablas = useQuery({ queryKey: ["tablas-bases"], queryFn: cargarTablasBases });
  const impuestos = useQuery({
    queryKey: ["retenciones-empresa", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tax_rates")
        .select("*")
        .eq("company_id", companyId)
        .in("kind", ["retefuente", "reteiva", "reteica"])
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as ImpuestoConfigurado[];
    },
  });

  // Por defecto, la tabla general vigente hoy (o la más reciente).
  const lista = tablas.data ?? [];
  useEffect(() => {
    if (seleccion || !lista.length) return;
    const vigente = tablasVigentes(lista, hoy).at(-1) ?? lista[0]!;
    setSeleccion(vigente.valid_from);
  }, [lista, seleccion, hoy]);
  const tabla = lista.find((t) => t.valid_from === seleccion) ?? null;
  useEffect(() => {
    if (seleccion === "nueva") return;
    setDesde(tabla?.valid_from ?? "");
    setHasta(tabla?.valid_to ?? "");
    setUvt(tabla ? String(tabla.uvt) : "");
    setConceptos(tabla ? tabla.concepts.map((c) => ({ ...c })) : []);
    setFuente("");
  }, [tabla, seleccion]);

  const uvtNum = numero(uvt);
  const anio = Number(desde.slice(0, 4)) || new Date().getFullYear();
  const tablaEditada: TablaBases = {
    year: anio,
    valid_from: desde,
    valid_to: hasta || null,
    uvt: uvtNum,
    concepts: conceptos,
  };
  /** Todas las tablas, con la que se edita en lugar de la guardada (para calcular bases en vivo). */
  const tablasConEdicion = [
    ...lista.filter((t) => t.valid_from !== seleccion),
    ...(desde ? [tablaEditada] : []),
  ];
  /** Fecha de referencia para la base mínima de las retenciones de la empresa. */
  const fechaRef = desde && desde <= hoy && (!hasta || hoy <= hasta) ? hoy : desde || hoy;
  /** Conceptos de todas las tablas (sin repetir), para asociar retenciones. */
  const todosConceptos = [
    ...new Map(
      [...lista.flatMap((t) => t.concepts), ...conceptos].map((c) => [c.id, c] as const),
    ).values(),
  ];

  async function importar(file: File) {
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const hoja = wb.Sheets[wb.SheetNames[0]!]!;
      const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true });
      const leidos = leerTablaBases(filas, uvtNum);
      if (!leidos.length) throw new Error("El archivo no trae conceptos.");
      setConceptos(leidos);
      setFuente(file.name);
      toast.success(`${leidos.length} conceptos leídos. Revisa y guarda.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible leer el archivo.");
    } finally {
      if (archivo.current) archivo.current.value = "";
    }
  }

  async function guardarTabla() {
    if (!(uvtNum > 0)) {
      toast.error("Escribe el valor de la UVT del año.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || (hasta && hasta < desde)) {
      toast.error("Revisa la vigencia: fecha desde obligatoria y hasta igual o posterior.");
      return;
    }
    const invalidos = conceptos.filter((c) => !c.concepto.trim() || !(Number(c.base_uvt) >= 0));
    if (invalidos.length) {
      toast.error("Cada concepto necesita nombre y base en UVT (0 si no tiene base).");
      return;
    }
    setGuardando(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase.from("retention_base_tables" as never).upsert(
        {
          year: anio,
          valid_from: desde,
          valid_to: hasta || null,
          uvt: uvtNum,
          concepts: conceptos,
          ...(fuente ? { source: fuente } : {}),
          updated_by: auth.user?.id ?? null,
          updated_at: new Date().toISOString(),
        } as never,
        { onConflict: "valid_from" },
      );
      if (error) throw error;
      invalidarTablasBases();
      invalidateBulkDeps();
      await queryClient.invalidateQueries({ queryKey: ["tablas-bases"] });
      setSeleccion(desde);
      toast.success(`Tabla vigente desde ${desde} guardada para todas las empresas.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible guardar.");
    } finally {
      setGuardando(false);
    }
  }

  async function asignarConcepto(tax: ImpuestoConfigurado, concepto: string | null) {
    const { error } = await supabase
      .from("tax_rates")
      .update({ retention_concept: concepto } as never)
      .eq("id", tax.id)
      .eq("company_id", companyId);
    if (error) {
      toast.error(error.message);
      return;
    }
    invalidateBulkDeps(companyId);
    await queryClient.invalidateQueries({ queryKey: ["retenciones-empresa", companyId] });
  }

  async function sugerirTodos() {
    const sinConcepto = (impuestos.data ?? []).filter((t) => !t.retention_concept);
    let n = 0;
    for (const t of sinConcepto) {
      const id = sugerirConcepto(t, todosConceptos);
      if (id) {
        await asignarConcepto(t, id);
        n += 1;
      }
    }
    toast.success(
      n
        ? `${n} retención(es) asociadas a su concepto. Verifícalas.`
        : "No hubo coincidencias claras; asígnalas a mano.",
    );
  }

  const set = (i: number, patch: Partial<ConceptoBase>) =>
    setConceptos((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Tabla de bases mínimas (todas las empresas)</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Valor de la UVT y base mínima de cada concepto de retención en la fuente para el año
              gravable. Al causar, la retención solo se practica si la base de la factura alcanza la
              base mínima de su concepto.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Tabla</Label>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={seleccion}
                onChange={(e) => {
                  const v = e.target.value;
                  setSeleccion(v);
                  if (v === "nueva") {
                    // Parte de la tabla abierta para no reescribir todos los conceptos.
                    setDesde("");
                    setHasta("");
                  }
                }}
              >
                {lista.map((t) => (
                  <option key={t.valid_from} value={t.valid_from}>
                    {t.year} · {t.valid_from} → {t.valid_to ?? "sin fin"}
                  </option>
                ))}
                <option value="nueva">+ Nueva tabla o excepción…</option>
              </select>
            </div>
            <div className="w-36 space-y-1">
              <Label className="text-xs">Vigente desde</Label>
              <Input
                type="date"
                value={desde}
                disabled={seleccion !== "nueva"}
                onChange={(e) => setDesde(e.target.value)}
              />
            </div>
            <div className="w-36 space-y-1">
              <Label className="text-xs">Hasta</Label>
              <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
            </div>
            <div className="w-32 space-y-1">
              <Label className="text-xs">UVT ($)</Label>
              <Input
                value={uvt}
                onChange={(e) => setUvt(e.target.value)}
                placeholder="Ej. 52.374"
              />
            </div>
            <input
              ref={archivo}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && void importar(e.target.files[0])}
            />
            <Button variant="outline" onClick={() => archivo.current?.click()}>
              <FileUp className="size-4" /> Importar Excel
            </Button>
            <Button onClick={() => void guardarTabla()} disabled={guardando}>
              <Save className="size-4" /> Guardar
            </Button>
          </div>
        </div>
        {!lista.length && !conceptos.length ? (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
            No hay tablas de bases mínimas. Mientras tanto se usa la base mínima fija de cada
            retención (si la tiene) y se avisa en el borrador.
          </p>
        ) : null}
        {tabla?.source || fuente ? (
          <p className="mt-2 text-xs text-muted-foreground">Fuente: {fuente || tabla?.source}</p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          Bases en pesos redondeadas al múltiplo de mil más cercano (art. 868 E.T.). Base 0: se
          retiene sobre cualquier valor. Una excepción (p. ej. del 8 de mayo al 30 de junio de 2026)
          solo necesita los conceptos que cambian; los demás siguen la tabla general.
        </p>

        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Concepto</TableHead>
                <TableHead className="w-28">Base (UVT)</TableHead>
                <TableHead className="w-36 text-right">Base en pesos</TableHead>
                <TableHead className="w-28">Tarifa declarante %</TableHead>
                <TableHead className="w-28">Tarifa no declarante %</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {conceptos.map((c, i) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Input
                      value={c.concepto}
                      onChange={(e) => set(i, { concepto: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={String(c.base_uvt)}
                      onChange={(e) => set(i, { base_uvt: numero(e.target.value) })}
                    />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {uvtNum > 0 ? cop(uvtAPesos(c.base_uvt, uvtNum)) : "—"}
                  </TableCell>
                  <TableCell>
                    <Input
                      value={c.tarifa_declarante ?? ""}
                      onChange={(e) =>
                        set(i, {
                          tarifa_declarante: e.target.value ? numero(e.target.value) : null,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={c.tarifa_no_declarante ?? ""}
                      onChange={(e) =>
                        set(i, {
                          tarifa_no_declarante: e.target.value ? numero(e.target.value) : null,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Quitar concepto"
                      onClick={() => setConceptos((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() =>
            setConceptos((prev) => {
              let id = "concepto_nuevo";
              for (let n = 2; prev.some((c) => c.id === id); n++) id = `concepto_nuevo_${n}`;
              return [
                ...prev,
                {
                  id,
                  concepto: "",
                  base_uvt: 0,
                  tarifa_declarante: null,
                  tarifa_no_declarante: null,
                },
              ];
            })
          }
        >
          <Plus className="size-4" /> Agregar concepto
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Concepto de cada retención de la empresa</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Asocia cada retención configurada (sincronizada de Siigo) con su concepto legal para
              conocer su base mínima al {fechaRef}.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => void sugerirTodos()}
            disabled={!todosConceptos.length}
          >
            <Sparkles className="size-4" /> Sugerir conceptos
          </Button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Retención</TableHead>
                <TableHead className="w-20">Tarifa</TableHead>
                <TableHead>Concepto</TableHead>
                <TableHead className="text-right">Base mínima al {fechaRef}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(impuestos.data ?? []).map((t) => {
                const minima = baseMinimaDe(t, fechaRef, tablasConEdicion);
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      {t.name}
                      {t.active === false ? (
                        <span className="text-xs text-muted-foreground"> (inactiva)</span>
                      ) : null}
                    </TableCell>
                    <TableCell>{t.rate}%</TableCell>
                    <TableCell>
                      <select
                        className="h-9 w-full min-w-48 rounded-md border border-input bg-background px-3 text-sm"
                        value={t.retention_concept ?? ""}
                        onChange={(e) => void asignarConcepto(t, e.target.value || null)}
                      >
                        <option value="">Sin concepto</option>
                        {todosConceptos.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.concepto}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {minima ? (
                        <span title={minima.origen} className="font-mono tabular-nums">
                          {cop(minima.valor)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Sin base</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {impuestos.data?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                    La empresa no tiene retenciones configuradas. Sincronízalas desde Integraciones
                    → Siigo.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
