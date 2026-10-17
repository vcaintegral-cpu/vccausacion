/** A rejected dynamic import remains cached until the document is reloaded. */
export function isModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Failed to fetch dynamically imported module|Importing a module script failed|Failed to load module script|Loading chunk .* failed|ChunkLoadError/i.test(error.message);
}