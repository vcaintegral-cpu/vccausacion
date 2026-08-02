import { createFileRoute, Link } from "@tanstack/react-router";
import { BrainCircuit, FileCheck2, FileSpreadsheet, ScanLine } from "lucide-react";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Causación automática de facturas de compra con IA" },
      {
        name: "description",
        content:
          "Carga la factura en PDF, XML o imagen y obtén el asiento contable propuesto, con retenciones calculadas y exportación a Contai.",
      },
      { property: "og:title", content: "Causación automática de facturas de compra con IA" },
      {
        property: "og:description",
        content: "Lectura inteligente, motor contable parametrizable y comprobantes listos para exportar.",
      },
    ],
  }),
  component: Index,
});

const FEATURES = [
  { icon: ScanLine, title: "Lectura inteligente", text: "PDF, XML DIAN, JPG o PNG. Encabezado y detalle extraídos automáticamente." },
  { icon: BrainCircuit, title: "Motor contable", text: "Reglas por proveedor, NIT o palabra clave que el sistema aprende de tus decisiones." },
  { icon: FileCheck2, title: "Aprobación", text: "Revisa débitos, créditos y diferencias antes de contabilizar." },
  { icon: FileSpreadsheet, title: "Exportación", text: "Comprobante en Excel, CSV o TXT listo para importar en Contai." },
];

function Index() {
  return (
    <div className="min-h-screen bg-navy text-navy-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="text-sm font-semibold tracking-tight">Asistente de Causación</span>
        <Button asChild variant="secondary" size="sm">
          <Link to="/auth">Ingresar</Link>
        </Button>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-16 pt-10">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent">Contabilidad asistida por IA</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Causa tus facturas de compra en segundos, no en horas
        </h1>
        <p className="mt-5 max-w-2xl text-base text-navy-foreground/70">
          Cargas la factura y el sistema extrae los datos, valida el tercero, aplica tus reglas contables, calcula las
          retenciones y propone el comprobante listo para aprobar y exportar.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/auth">Comenzar ahora</Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="border-navy-foreground/25 bg-transparent text-navy-foreground hover:bg-navy-foreground/10">
            <Link to="/auth">Ya tengo cuenta</Link>
          </Button>
        </div>

        <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-lg border border-navy-foreground/12 bg-navy-foreground/5 p-5">
              <f.icon className="size-5 text-accent" />
              <h2 className="mt-3 text-sm font-semibold">{f.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-navy-foreground/65">{f.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
