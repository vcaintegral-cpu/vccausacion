// Alertas del piloto automático en un repositorio PRIVADO de GitHub (los errores pueden traer
// datos del cliente; nunca van al repositorio público de la aplicación).
// Secretos de la aplicación:
//   GITHUB_ALERTAS_TOKEN  token de GitHub con permiso de «Issues» (lectura y escritura) solo
//                         sobre el repositorio de alertas
//   GITHUB_ALERTAS_REPO   «propietario/repositorio» (por defecto vcaintegral-cpu/vccausacion-alertas)
// Ciclo: el piloto abre un caso «piloto-error» → la revisión automática de Claude lo corrige,
// fusiona la corrección y le pone «listo-para-publicar» → el piloto le avisa a la usuaria que
// publique («aviso-enviado») → cuando ella confirma, reintenta los pasos con error.

const repo = () => process.env["GITHUB_ALERTAS_REPO"] || "vcaintegral-cpu/vccausacion-alertas";

export const alertasConfiguradas = () => !!process.env["GITHUB_ALERTAS_TOKEN"];

async function gh<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  const token = process.env["GITHUB_ALERTAS_TOKEN"] ?? "";
  if (!token) throw new Error("Falta el secreto GITHUB_ALERTAS_TOKEN.");
  const r = await fetch(`https://api.github.com/repos/${repo()}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "vccausacion-piloto",
      ...(cuerpo ? { "Content-Type": "application/json" } : {}),
    },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`GitHub respondió ${r.status}: ${texto.slice(0, 300)}`);
  return (texto ? JSON.parse(texto) : {}) as T;
}

type Issue = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
};
const etiquetas = (i: Issue) => i.labels.map((l) => (typeof l === "string" ? l : l.name));

/**
 * Abre un caso de error (o comenta el que ya existe abierto con el mismo título, para no
 * repetir). Devuelve el número del caso.
 */
export async function crearAlerta(p: { titulo: string; cuerpo: string }): Promise<number> {
  const abiertos = await gh<Issue[]>("GET", `/issues?state=open&labels=piloto-error&per_page=100`);
  const mismo = abiertos.find((i) => i.title === p.titulo);
  if (mismo) {
    await gh("POST", `/issues/${mismo.number}/comments`, { body: `Se repitió:\n\n${p.cuerpo}` });
    return mismo.number;
  }
  const nuevo = await gh<Issue>("POST", "/issues", {
    title: p.titulo.slice(0, 250),
    body: p.cuerpo,
    labels: ["piloto-error"],
  });
  return nuevo.number;
}

/** Correcciones fusionadas que aún no se le han avisado a la usuaria. */
export async function correccionesPorAvisar(): Promise<Issue[]> {
  const listas = await gh<Issue[]>(
    "GET",
    `/issues?state=all&labels=listo-para-publicar&per_page=100`,
  );
  return listas.filter((i) => !etiquetas(i).includes("aviso-enviado"));
}

export async function agregarEtiqueta(numero: number, etiqueta: string): Promise<void> {
  await gh("POST", `/issues/${numero}/labels`, { labels: [etiqueta] });
}

export async function comentar(numero: number, texto: string): Promise<void> {
  await gh("POST", `/issues/${numero}/comments`, { body: texto });
}
