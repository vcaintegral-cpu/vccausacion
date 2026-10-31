import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { title: "Restablecer contraseña — Asistente de Causación" },
      {
        name: "description",
        content: "Define una nueva contraseña para tu cuenta del asistente de causación de facturas.",
      },
      { property: "og:title", content: "Restablecer contraseña — Asistente de Causación" },
      { property: "og:description", content: "Define una nueva contraseña para acceder a tu cuenta." },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const isRecovery = hash.get("type") === "recovery";
    if (hash.has("error") || hash.has("error_code")) {
      setMessage("El enlace de recuperación venció o no es válido. Solicita un enlace nuevo.");
      return;
    }
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (active && event === "PASSWORD_RECOVERY") { setReady(true); setMessage(""); }
    });
    void supabase.auth.getSession().then(async ({ data: s, error }) => {
      if (!active) return;
      if (error) throw error;
      if (s.session) {
        const { data: verified, error: verificationError } = await supabase.auth.getUser();
        if (!active) return;
        if (verificationError) throw verificationError;
        setReady(!!verified.user);
      } else if (!isRecovery) {
        setMessage("El enlace de recuperación venció o no es válido. Solicita un enlace nuevo.");
      }
    }).catch(() => { if (active) setMessage("No se pudo comprobar el enlace. Revisa tu conexión y abre nuevamente el correo de recuperación."); });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready || loading) return;
    if (password !== confirm) {
      setMessage("Las contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) { setMessage(error.message); return; }
      toast.success("Contraseña actualizada. Inicia sesión nuevamente.");
      await supabase.auth.signOut();
      navigate({ to: "/auth", replace: true });
    } catch {
      setMessage("No se pudo actualizar la contraseña. Comprueba tu conexión y vuelve a intentarlo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold">Nueva contraseña</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {ready
            ? "Escribe tu nueva contraseña para continuar."
            : "Abre este enlace desde el correo de recuperación para poder cambiar tu contraseña."}
        </p>
        {message && <p role="alert" className="mt-4 text-sm text-destructive">{message}</p>}

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-password">Contraseña</Label>
            <PasswordInput
              id="new-password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirmar contraseña</Label>
            <PasswordInput
              id="confirm-password"
              required
              minLength={6}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading || !ready}>
            {loading ? "Guardando…" : "Guardar contraseña"}
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => navigate({ to: "/auth" })}>Volver a ingresar</Button>
        </form>
      </div>
    </div>
  );
}
