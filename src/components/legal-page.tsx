// Estructura común de las páginas públicas legales (/privacy y /terms).
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const LEGAL = {
  app: "VC Causacion",
  empresa: "VC Integral & Asesores",
  correo: "vcaintegral@gmail.com",
  vigencia: "10 de noviembre de 2026",
} as const;

export function LegalPage({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            {LEGAL.app}
          </Link>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link to="/privacy" className="hover:text-foreground" activeProps={{ className: "text-foreground" }}>
              Privacidad
            </Link>
            <Link to="/terms" className="hover:text-foreground" activeProps={{ className: "text-foreground" }}>
              Términos
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">{titulo}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {LEGAL.app} · {LEGAL.empresa} · Vigente desde el {LEGAL.vigencia}
        </p>
        <div className="mt-8 space-y-8 text-[15px] leading-7">{children}</div>
      </main>
      <LegalFooter />
    </div>
  );
}

export function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{titulo}</h2>
      {children}
    </section>
  );
}

export function Correo() {
  return (
    <a href={`mailto:${LEGAL.correo}`} className="font-medium text-primary underline underline-offset-2">
      {LEGAL.correo}
    </a>
  );
}

/** Pie de página con los enlaces legales (también se usa en la página principal). */
export function LegalFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`border-t border-current/10 ${className}`}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm opacity-80 sm:px-6">
        <span>
          © {new Date().getFullYear()} {LEGAL.empresa}
        </span>
        <nav className="flex flex-wrap gap-5">
          <Link to="/privacy" className="underline-offset-2 hover:underline">
            Política de Privacidad
          </Link>
          <Link to="/terms" className="underline-offset-2 hover:underline">
            Términos del Servicio
          </Link>
          <a href={`mailto:${LEGAL.correo}`} className="underline-offset-2 hover:underline">
            Contacto
          </a>
        </nav>
      </div>
    </footer>
  );
}
