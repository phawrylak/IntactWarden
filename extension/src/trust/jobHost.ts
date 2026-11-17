/**
 * The deep-verify job host: runs `runReleaseJob` in the
 * background event page itself; unit tests substitute a host.
 *
 * Firefox stops an idle event page after `extensions.background.idle.timeout` (30 s by default)
 * whatever ports are open: only extension API calls, events, pending listener promises and active
 * StreamFilters reset the timer, and a `fetch` is none of these. A download that takes longer (a
 * 50 MB asset on a slow line) would be cut off and its recorded documents would end
 * `verifier-restarted`. `withKeepAlive` calls a cheap parent-process API
 * (`runtime.getPlatformInfo`) every KEEPALIVE_MS while a job runs (e2e scenario
 * `deep-verify-idle`).
 */

import type {ReleaseJobResult, ReleaseJobSpec} from '../contracts.ts';
import type {Ext} from '../platform/webext.ts';
import {runReleaseJob, type JobDeps, type JobProgress} from './job.ts';

/** A third of Firefox's default idle timeout. */
export const KEEPALIVE_MS = 10_000;

export interface JobHost {
  run(spec: ReleaseJobSpec, onProgress: (progress: JobProgress) => void): Promise<ReleaseJobResult>;
}

export function createInProcessJobHost(deps: Omit<JobDeps, 'onProgress'>): JobHost {
  return {
    run: (spec, onProgress) => runReleaseJob(spec, {...deps, onProgress}),
  };
}

/** The same host, with the event page kept alive while a job runs. `timers` is a seam for tests. */
export function withKeepAlive(
  host: JobHost,
  ext: Pick<Ext, 'runtime'>,
  timers: {
    readonly every: (fn: () => void, ms: number) => unknown;
    readonly stop: (handle: unknown) => void;
  } = {
    every: (fn, ms) => setInterval(fn, ms),
    stop: h => clearInterval(h as ReturnType<typeof setInterval>),
  },
): JobHost {
  return {
    async run(spec, onProgress) {
      const handle = timers.every(() => {
        try {
          void ext.runtime.getPlatformInfo().catch(() => undefined);
        } catch {
          // The keepalive must never fail a job.
        }
      }, KEEPALIVE_MS);
      try {
        return await host.run(spec, onProgress);
      } finally {
        timers.stop(handle);
      }
    },
  };
}
