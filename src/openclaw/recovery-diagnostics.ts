export type RecoveryStage = "admission" | "binding" | "durability" | "context" | "runtime" | "recover";

const ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "URIError", "AggregateError", "AbortError",
  "CompletionError", "CatalogError", "EpisodeV2Error", "MemoryTransactionError", "ConsciousnessLoadError",
  "ManagedDurableWriteError", "RuntimeProfileError", "RecoveryPointerSyncError",
]);
const ERROR_CODES = new Set([
  "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EBUSY", "ECONNRESET", "EEXIST", "EIO", "ENOENT",
  "ENOTDIR", "EPERM", "ETIMEDOUT", "ABORT_ERR", "ERR_ABORTED", "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE", "ERR_SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_LOCKED",
]);

/** Keep operational causes without publishing paths, exception text, model output or caller data. */
export function recoveryFailureDiagnostic(stage: RecoveryStage, error: unknown) {
  const causes: { name: string; code?: string; exitCode?: number }[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && causes.length < 4 && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current && typeof current.code === "string" && ERROR_CODES.has(current.code) ? current.code : undefined;
    const exitCode = "code" in current && typeof current.code === "number" && Number.isInteger(current.code) && current.code >= 0 && current.code <= 255 ? current.code : undefined;
    causes.push({ name: ERROR_NAMES.has(current.name) ? current.name : "Error", ...(code ? { code } : {}), ...(exitCode === undefined ? {} : { exitCode }) });
    current = current.cause;
  }
  return { stage, causes };
}
