// Importación del reporte de impuestos de Siigo (función «impuestos_excel_siigo»).
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";
import * as XLSX from "xlsx";

import { Button } from "@/components/ui/button";
import {
  impuestosExcelImportar,
  impuestosExcelRevisar,
  type ResultadoImportacion,
  type RevisionImpuestos,
} from "@/lib/impuestos-siigo-excel.functions";
import { FUNCIONES_CUENTA } from "@/lib/impuestos-siigo-excel";

type Archivo = { nombre: string; hoja: string; matriz: unknown[][] };

export function ImpuestosExcelSiigoPanel({ companyId }: { companyId: string }) {
  const revisar = useServerFn(impuestosExcelRevisar);
  const importar = useServerFn(impuestosExcelImportar);
  const qc = useQueryClient();
  const [archivo, setArchivo] = useState<Archivo | null>(null);
  const [rev, setRev] = useState<RevisionImpuestos | null>(null);
  const [res, setRes] = useState<ResultadoImportacion | null>(null);
  const [confirmo, setConfirmo] = useState(false);
  const [busy, setBusy] = useState(false);

  async function elegir(file: File) {
    setBusy(true);
    setRes(null);
    setRev(null);
    setConfirmo(false);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const hoja = wb.SheetNames.includes("Hoja1") ? "Hoja1" : wb.SheetNames[0]!;
      // Valores CRUDOS de las celdas: un código contable nunca pasa por formato de número.
      const matriz = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[hoja]!, {
        header: 1,
        raw: true,
        defval: null,
      });
      const a = { nombre: file.name, hoja, matriz };
      setArchivo(a);
      setRev(await revisar({ data: { companyId, hoja, matriz } }));
    } catch (e) {
      setArchivo(null);
      toast.error(e instanceof Error ? e.message : "No fue posible leer el archivo.");
    } finally {
      setBusy(false);
    }
  }

  async function aprobar() {
    if (!archivo) return;
    setBusy(true);
    try {
      const r = await importar({
        data: {
          companyId,
          hoja: archivo.hoja,
          matriz: archivo.matriz,
          confirmoAdvertencias: confirmo,
        },
      });
      setRes(r);
      if (r.aprobada)
        toast.success("Importación aprobada: todas las cuentas coinciden con el archivo.");
      else toast.error("Importación con diferencias: revise la comparación.");
      await qc.invalidateQueries({ queryKey: ["tax_rates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible importar.");
    } finally {
      setBusy(false);
    }
  }

  const errores = rev?.hallazgos.filter((h) => h.nivel === "error") ?? [];
  const avisos = rev?.hallazgos.filter((h) => h.nivel === "advertencia") ?? [];
  const nombreFuncion = (id?: string) => FUNCIONES_CUENTA.find((f) => f.id === id)?.nombre ?? "";

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
      <div>
        <div className="font-semibold">Importar el Excel de impuestos de Siigo</div>
        <p className="text-xs text-muted-foreground">
          Se conservan exactas las cuatro cuentas de cada impuesto (ventas, compras, devolución en
          ventas y devolución en compras). Antes de guardar se validan contra el catálogo de
          cuentas; nada se corrige automáticamente.
        </p>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        Elegir archivo
        <input
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void elegir(f);
          }}
        />
      </label>
      {archivo ? (
        <span className="ml-2 text-xs text-muted-foreground">{archivo.nombre}</span>
      ) : null}

      {rev && !res ? (
        <div className="space-y-2 text-xs">
          <div>
            {rev.impuestos.length} impuestos leídos · {rev.cuentasCatalogo} cuentas en el catálogo ·{" "}
            <b className={errores.length ? "text-red-700" : "text-green-700"}>
              {errores.length} errores
            </b>{" "}
            · <b className={avisos.length ? "text-amber-700" : ""}>{avisos.length} por validar</b>
          </div>
          {[...errores, ...avisos].map((h, i) => (
            <div key={i} className={h.nivel === "error" ? "text-red-700" : "text-amber-700"}>
              {h.nivel === "error" ? "Error" : "Validar"} · impuesto {h.impuesto}
              {h.funcion ? ` · ${nombreFuncion(h.funcion)}` : ""}: {h.mensaje}
            </div>
          ))}
          {avisos.length && !errores.length ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={confirmo}
                onChange={(e) => setConfirmo(e.target.checked)}
              />
              Revisé las inconsistencias del archivo y confirmo que son correctas.
            </label>
          ) : null}
          <Button
            size="sm"
            disabled={busy || errores.length > 0 || (avisos.length > 0 && !confirmo)}
            onClick={() => void aprobar()}
          >
            Importar
          </Button>
        </div>
      ) : null}

      {res ? (
        <div className="space-y-2 text-xs">
          <div
            className={res.aprobada ? "font-semibold text-green-700" : "font-semibold text-red-700"}
          >
            {res.aprobada
              ? `APROBADA: ${res.comparacion.length} cuentas coinciden exactamente con el archivo.`
              : "NO APROBADA: hay cuentas distintas al archivo."}
          </div>
          {res.sinIdSiigo.length ? (
            <div className="text-amber-700">
              Sin identificador de Siigo (use «Sincronizar desde Siigo» para asignarlo):{" "}
              {res.sinIdSiigo.join(", ")}
            </div>
          ) : null}
          <div className="max-h-96 overflow-auto">
            <table className="w-full">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="pr-2">Cód.</th>
                  <th className="pr-2">Impuesto</th>
                  <th className="pr-2">Función</th>
                  <th className="pr-2">Cuenta Excel</th>
                  <th className="pr-2">Cuenta importada</th>
                  <th>Validación</th>
                </tr>
              </thead>
              <tbody>
                {res.comparacion.map((c, i) => (
                  <tr key={i} className={c.coincide ? "" : "text-red-700"}>
                    <td className="pr-2">{c.codigoImpuesto}</td>
                    <td className="pr-2">{c.impuesto}</td>
                    <td className="pr-2">{nombreFuncion(c.funcion)}</td>
                    <td className="pr-2 font-mono">{c.cuentaExcel ?? "—"}</td>
                    <td className="pr-2 font-mono">{c.cuentaImportada ?? "—"}</td>
                    <td>{c.coincide ? c.validacion : `DIFERENTE · ${c.validacion}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
