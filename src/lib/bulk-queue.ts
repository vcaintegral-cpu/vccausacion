// Cola de trabajos para la carga masiva de facturas: procesa varias facturas en
// paralelo, reintenta errores temporales y reporta progreso en tiempo real.

export type JobState = "pendiente" | "procesando" | "listo" | "error";

export type JobResult = {
  numero: string;
  total: number;
  invoiceId: string;
  score: number;
  needsReview: boolean;
  reason: string;
};

export type Job = {
  id: string;
  name: string;
  state: JobState;
  attempts: number;
  detail: string;
  result?: JobResult;
};

export type QueueProgress = {
  jobs: Job[];
  total: number;
  done: number;
  running: number;
  pending: number;
  failed: number;
  auto: number;
  review: number;
  elapsedMs: number;
  etaMs: number | null;
};

const TRANSIENT =
  /(429|límite de solicitudes|temporal|timeout|canceling statement|statement timeout|57014|network|fetch failed|502|503|504|socket)/i;

/** Un error temporal se reintenta; un error de negocio (duplicado, empresa) no. */
export const isTransient = (error: unknown) =>
  TRANSIENT.test(error instanceof Error ? error.message : String(error ?? ""));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runInvoiceQueue<T>(params: {
  items: T[];
  nameOf: (item: T) => string;
  run: (item: T) => Promise<JobResult>;
  concurrency?: number;
  maxAttempts?: number;
  onProgress: (p: QueueProgress) => void;
}): Promise<QueueProgress> {
  const { items, nameOf, run, onProgress } = params;
  const concurrency = Math.max(1, Math.min(params.concurrency ?? 6, 12));
  const maxAttempts = params.maxAttempts ?? 3;
  const started = Date.now();

  const jobs: Job[] = items.map((item, i) => ({
    id: `${i}-${nameOf(item)}`,
    name: nameOf(item),
    state: "pendiente",
    attempts: 0,
    detail: "",
  }));

  const snapshot = (): QueueProgress => {
    const done = jobs.filter((j) => j.state === "listo").length;
    const failed = jobs.filter((j) => j.state === "error").length;
    const running = jobs.filter((j) => j.state === "procesando").length;
    const elapsedMs = Date.now() - started;
    const terminados = done + failed;
    return {
      jobs: jobs.map((j) => ({ ...j })),
      total: jobs.length,
      done,
      failed,
      running,
      pending: jobs.length - terminados - running,
      auto: jobs.filter((j) => j.result && !j.result.needsReview).length,
      review: jobs.filter((j) => j.result?.needsReview).length,
      elapsedMs,
      etaMs: terminados > 0 ? Math.round((elapsedMs / terminados) * (jobs.length - terminados)) : null,
    };
  };

  let cursor = 0;
  const emit = () => onProgress(snapshot());
  emit();

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const job = jobs[index]!;
      const item = items[index]!;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        job.state = "procesando";
        job.attempts = attempt;
        emit();
        try {
          const result = await run(item);
          job.state = "listo";
          job.result = result;
          job.detail = result.numero;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Error al procesar";
          if (attempt < maxAttempts && isTransient(error)) {
            job.detail = `Reintentando (${attempt}/${maxAttempts})… ${message}`;
            emit();
            await sleep(800 * attempt);
            continue;
          }
          job.state = "error";
          job.detail = message;
          break;
        }
      }
      emit();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const final = snapshot();
  onProgress(final);
  return final;
}