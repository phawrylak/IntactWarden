/**
 * The deep-verify job: download the release
 * asset into memory with a size cap, check it against GitHub's listed size and digest **before**
 * parsing, fetch the config files at the tag commit, and build the one requested variant with the
 * CoreBuilder (the code `npm run recompute` runs). Returns the core's bytes; pins, release state
 * and the write to IndexedDB stay with the store. The asset lives only in memory, for the length
 * of the job. Every URL is built here from the plan, and every response must end on an allowed
 * GitHub host after redirects.
 */

import {
  BuildError,
  type BuildRequest,
  type BuiltCore,
  type CoreBuilder,
} from '@intactwarden/builders/api.ts';
import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import type {JobPhase, ReleaseJobResult, ReleaseJobSpec} from '../contracts.ts';
import {DOWNLOAD_HOSTS, RAW_HOST, rawFileUrl, releaseDownloadUrl} from './common.ts';
import {downloadVerified, isAllowedHttpsUrl, readBodyCapped, withDeadline} from './download.ts';

export interface JobLimits {
  /** Largest release asset deep verify downloads (held in memory during the job). */
  readonly maxAssetBytes: number;
  readonly maxConfigBytes: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly smallFileTimeoutMs: number;
}

export const DEFAULT_JOB_LIMITS: JobLimits = Object.freeze({
  maxAssetBytes: 128 * 1024 * 1024,
  maxConfigBytes: 1024 * 1024,
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 15 * 60_000,
  smallFileTimeoutMs: 30_000,
});

export interface JobProgress {
  readonly phase: JobPhase;
  readonly bytes?: number;
  readonly total?: number;
}

export interface JobDeps {
  readonly fetch: typeof fetch;
  readonly builder: CoreBuilder;
  readonly onProgress?: (progress: JobProgress) => void;
  readonly limits?: Partial<JobLimits>;
}

type Failure = Extract<ReleaseJobResult, {ok: false}>;

const fail = (failure: Failure['failure'], detail?: Failure['detail']): Failure =>
  detail === undefined ? {ok: false, failure} : {ok: false, failure, detail};

/**
 * Fetches a small file whose final URL is on one of `hosts`, at most `max` bytes; the caller
 * checks its digest. A body that cannot be read to its end, or is larger, is a network failure.
 */
async function fetchSmall(
  fetchFn: typeof fetch,
  url: string,
  hosts: readonly string[],
  max: number,
  timeoutMs: number,
): Promise<{ok: true; bytes: Uint8Array} | {ok: false; status: number | 'network' | 'bad-host'}> {
  return withDeadline(timeoutMs, async inner => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: inner,
      });
    } catch {
      return {ok: false, status: 'network'} as const;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return {ok: false, status: res.status} as const;
    }
    if (!isAllowedHttpsUrl(res.url, hosts)) {
      void res.body?.cancel().catch(() => undefined);
      return {ok: false, status: 'bad-host'} as const;
    }
    const bytes = await readBodyCapped(res, max, inner);
    if (bytes === null) return {ok: false, status: 'network'} as const;
    return {ok: true, bytes} as const;
  });
}

/** Runs one job. Never throws; every outcome is a ReleaseJobResult. */
export async function runReleaseJob(
  spec: ReleaseJobSpec,
  deps: JobDeps,
): Promise<ReleaseJobResult> {
  try {
    return await run(spec, deps);
  } catch {
    deps.onProgress?.({phase: 'failed'});
    return fail('build-refused', 'unsupported');
  }
}

async function run(spec: ReleaseJobSpec, deps: JobDeps): Promise<ReleaseJobResult> {
  const limits: JobLimits = {...DEFAULT_JOB_LIMITS, ...deps.limits};
  const progress = (p: JobProgress): void => deps.onProgress?.(p);
  const failed = (f: Failure): Failure => {
    progress({phase: 'failed'});
    return f;
  };
  const {plan} = spec;

  // 1. The asset: size-capped, in memory, verified before anything parses it.
  progress({phase: 'downloading', bytes: 0, total: spec.asset.size});
  let lastReport = 0;
  const download = await downloadVerified(deps.fetch, {
    url: releaseDownloadUrl(plan.repo, plan.tag, spec.asset.name),
    sha256: spec.asset.sha256,
    size: spec.asset.size,
    maxBytes: limits.maxAssetBytes,
    allowedHosts: DOWNLOAD_HOSTS,
    idleTimeoutMs: limits.idleTimeoutMs,
    totalTimeoutMs: limits.totalTimeoutMs,
    onProgress: (bytes, total) => {
      if (bytes - lastReport >= 512 * 1024 || bytes === total) {
        lastReport = bytes;
        progress({phase: 'downloading', bytes, total});
      }
    },
  });
  if (!download.ok) {
    switch (download.failure) {
      case 'digest-mismatch':
        return failed(fail('digest-mismatch'));
      case 'too-large':
        return failed(fail('build-refused', 'size-mismatch'));
      case 'bad-host':
        return failed(fail('build-refused', 'unsupported'));
      case 'network':
        return failed(fail('network'));
    }
  }
  progress({phase: 'verifying'});

  // 2. Config files at the tag commit (cloud derivation), checked against their pins.
  const configs: Record<string, Uint8Array> = {};
  const configDigests: {path: string; sha256: string}[] = [];
  for (const c of spec.configs) {
    const r = await fetchSmall(
      deps.fetch,
      rawFileUrl(plan.repo, spec.commit, c.path),
      [RAW_HOST],
      limits.maxConfigBytes,
      limits.smallFileTimeoutMs,
    );
    if (!r.ok) {
      // The commit has no such file, or the answer came from another host: no retry helps.
      if (r.status === 404 || r.status === 'bad-host') {
        return failed(fail('build-refused', 'derivation-failed'));
      }
      return failed(fail('network'));
    }
    const digest = await sha256Hex(r.bytes);
    if (c.sha256 !== undefined && digest !== c.sha256) return failed(fail('digest-mismatch'));
    configs[c.path] = r.bytes;
    configDigests.push({path: c.path, sha256: digest});
  }

  // 3. Build with the same builder code as the recompute CLI.
  progress({phase: 'building'});
  const request: BuildRequest = {
    app: plan.app,
    variant: plan.variant,
    version: plan.version,
    release: {
      tag: plan.tag,
      commit: spec.commit,
      ...(spec.tagObject === undefined ? {} : {tagObject: spec.tagObject}),
    },
    asset: {
      name: spec.asset.name,
      sha256: spec.asset.sha256,
      size: spec.asset.size,
      bytes: download.bytes,
    },
    ...(spec.configs.length === 0 ? {} : {configs}),
  };
  let built: BuiltCore;
  try {
    built = await deps.builder.build(request);
  } catch (e) {
    // The download verified size and digest: the builder disagreeing is transient, never a
    // mismatch.
    if (e instanceof BuildError) {
      return failed(
        e.code === 'digest-mismatch' || e.code === 'size-mismatch'
          ? fail('network')
          : fail('build-refused', e.code),
      );
    }
    return failed(fail('build-refused', 'unsupported'));
  }
  // The store checks identity and content address before it keeps the core.
  progress({phase: 'storing'});
  return {ok: true, core: {sha256: built.sha256, bytes: built.bytes}, configs: configDigests};
}
