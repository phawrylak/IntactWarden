/**
 * Fail-closed logging helpers (rule R1). Errors are logged by name only: an error message can
 * carry a URL or page content, so it is never logged. The fail-closed fallbacks themselves live
 * where the listeners are: the engine's #dispatchSafe/#headersSafe, the Firefox backend's
 * guarded() and the router's rejection handler.
 */

/** The error's constructor name ("TypeError"), never its message. */
export function errorName(e: unknown): string {
  if (e instanceof Error) return e.name || 'Error';
  return typeof e;
}

/** Logs a diagnostic; never includes a full URL (only redactUrl output), never page content. */
export function logWarn(
  code: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): void {
  try {
    console.warn('[IntactWarden]', code, detail ?? {});
  } catch {
    // Logging must never throw.
  }
}
