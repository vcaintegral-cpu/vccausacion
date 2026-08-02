export const cop = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Number(n ?? 0));

export const num = (n: number | null | undefined) =>
  new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(Number(n ?? 0));

export const fecha = (d: string | null | undefined) =>
  d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("es-CO") : "—";

export const fechaHora = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("es-CO") : "—";