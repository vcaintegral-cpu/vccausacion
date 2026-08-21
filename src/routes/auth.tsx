import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { setActiveCompany, setCompanyLocked } from "@/lib/active-company";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Ingresar — Asistente de Causación" },
      { name: "description", content: "Accede a tu cuenta para causar facturas de compra con inteligencia artificial." },
      { property: "og:title", content: "Ingresar — Asistente de Causación" },
      { property: "og:description", content: "Accede a tu cuenta para causar facturas de compra con IA." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [nit, setNit] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/panel", replace: true });
    });
  }, [navigate]);

  const soloDigitos = (v: string) => v.replace(/\D/g, "");

  async function vincularEmpresaPorNit(): Promise<boolean> {
    const objetivo = soloDigitos(nit);
    const { data, error } = await supabase.from("companies").select("id, nit, name");
    if (error) {
      toast.error(error.message);
      return false;
    }
    const empresa = (data ?? []).find((c) => soloDigitos(c.nit ?? "").replace(/^0+/, "") === objetivo.replace(/^0+/, ""));
    if (!empresa) {
      await supabase.auth.signOut();
      toast.error("El NIT no corresponde a ninguna empresa de tu cuenta.");
      return false;
    }
    setActiveCompany(empresa.id);
    setCompanyLocked(true);
    return true;
  }

  async function recuperarContrasena(): Promise<void> {
    if (!email) {
      toast.error("Escribe tu correo para enviarte el enlace de recuperación.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Te enviamos un correo con el enlace para restablecer tu contraseña.");
  }

  async function signIn(e: React.FormEvent): Promise<void> {

    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      toast.error(error.message);
      return;
    }
    const ok = await vincularEmpresaPorNit();
    setLoading(false);
    if (!ok) return;
    navigate({ to: "/panel", replace: true });
  }

  async function signUp(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin, data: { full_name: fullName } },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (data.session) {
      setCompanyLocked(false);
      navigate({ to: "/empresas", replace: true });
    }
    else toast.success("Cuenta creada. Revisa tu correo para confirmarla.");
  }

  async function google(): Promise<void> {
    const result = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (result.error) {
      toast.error("No fue posible iniciar sesión con Google.");
      return;
    }
    if (result.redirected) return;
    setCompanyLocked(false);
    navigate({ to: "/panel", replace: true });
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-navy p-10 text-navy-foreground lg:flex">
        <span className="text-sm font-semibold">Asistente de Causación</span>
        <div>
          <h1 className="text-3xl font-semibold leading-tight">Menos digitación, más control contable.</h1>
          <p className="mt-4 max-w-md text-sm text-navy-foreground/70">
            Lectura con IA, reglas por proveedor, retenciones automáticas y comprobantes auditables por empresa.
          </p>
        </div>
        <span className="font-mono text-xs text-navy-foreground/45">PUC · Terceros · Retenciones · Contai</span>
      </div>

      <div className="flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">Bienvenida</h2>
          <p className="mt-1 text-sm text-muted-foreground">Ingresa o crea tu cuenta para continuar.</p>

          <Tabs defaultValue="login" className="mt-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Ingresar</TabsTrigger>
              <TabsTrigger value="signup">Crear cuenta</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form onSubmit={signIn} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Correo</Label>
                  <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Contraseña</Label>
                  <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nit">NIT de la empresa</Label>
                  <Input id="nit" required value={nit} onChange={(e) => setNit(e.target.value)} placeholder="900123456" />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  Ingresar
                </Button>
                <button
                  type="button"
                  onClick={recuperarContrasena}
                  className="w-full text-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  ¿Olvidaste tu contraseña?
                </button>
              </form>

            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={signUp} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Nombre completo</Label>
                  <Input id="name" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email2">Correo</Label>
                  <Input id="email2" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password2">Contraseña</Label>
                  <Input id="password2" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  Crear cuenta
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> o <span className="h-px flex-1 bg-border" />
          </div>
          <Button variant="outline" className="w-full" onClick={google}>
            Continuar con Google
          </Button>
        </div>
      </div>
    </div>
  );
}