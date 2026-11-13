// Envío de correos de la aplicación (avisos del piloto automático) con Resend.
// Configuración en los secretos de la aplicación (nunca en el código):
//   RESEND_API_KEY            clave de la cuenta de Resend
//   PILOTO_CORREO_REMITENTE   remitente verificado («Piloto <piloto@sudominio.com>»);
//                             sin dominio propio, Resend solo entrega desde onboarding@resend.dev
//                             al correo dueño de la cuenta.

export type ResultadoCorreo = { ok: boolean; id?: string; error?: string };

export async function enviarCorreo(p: {
  para: string;
  asunto: string;
  html: string;
}): Promise<ResultadoCorreo> {
  const clave = process.env["RESEND_API_KEY"] ?? "";
  if (!clave) return { ok: false, error: "Falta configurar el correo (secreto RESEND_API_KEY)." };
  const remitente =
    process.env["PILOTO_CORREO_REMITENTE"] || "Piloto automático <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${clave}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: remitente, to: [p.para], subject: p.asunto, html: p.html }),
    });
    const texto = await r.text();
    if (!r.ok) return { ok: false, error: `Resend respondió ${r.status}: ${texto.slice(0, 300)}` };
    const j = JSON.parse(texto || "{}") as { id?: string };
    return { ok: true, ...(j.id ? { id: j.id } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
