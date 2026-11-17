/**
 * Service-worker check: a registration on a protected origin, or a
 * worker that controls the document, is MISMATCH (`service-worker`). Runs on every load.
 */

export interface SwEnv {
  readonly getRegistrations: (() => Promise<readonly unknown[]>) | null;
  /** Whether a service worker controls this document (`navigator.serviceWorker.controller`). */
  readonly controlled: () => boolean;
}

/**
 * Number of service workers this document has to do with: the registrations of its origin, or 1
 * when none is listed but a worker controls the document (a worker that unregisters itself goes on
 * controlling the pages it already controls). 0 when the API is unavailable.
 */
export async function countServiceWorkers(env: SwEnv): Promise<number> {
  let registrations = 0;
  try {
    if (env.getRegistrations !== null) registrations = (await env.getRegistrations()).length;
  } catch {
    registrations = 0;
  }
  if (registrations > 0) return registrations;
  try {
    return env.controlled() ? 1 : 0;
  } catch {
    return 0;
  }
}
