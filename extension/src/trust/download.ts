/**
 * Verified downloads for deep verify: a fetch
 * into one buffer of the listed size, a hard size cap, and an idle and a total timeout. The size
 * and sha256 must equal GitHub's listed values before the caller parses a single byte. The listed
 * size is checked against the cap before anything is downloaded, and a byte past it ends the
 * download, so a hostile server cannot make the extension hold more than the cap.
 */

import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';

/** Runs `fn` with a signal that aborts after `ms`; clears the timer afterwards. */
export async function withDeadline<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a response body up to `max` bytes; null when it is larger, fails or is aborted. */
export async function readBodyCapped(
  res: Response,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const declared = contentLength(res);
  if (declared !== null && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted === true) throw new Error('aborted');
      const {done, value} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw new Error('too large');
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** True for an `https:` URL on one of `hosts` (no userinfo). */
export function isAllowedHttpsUrl(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    hosts.includes(parsed.host)
  );
}

function contentLength(res: Response): number | null {
  const raw = res.headers.get('content-length');
  if (raw === null || !/^[0-9]{1,15}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export interface DownloadOptions {
  readonly url: string;
  /** The request's Accept header, if any. */
  readonly accept?: string;
  /** Lowercase hex sha256 the bytes must hash to (GitHub's listed digest). */
  readonly sha256: string;
  /** Exact size the bytes must have (GitHub's listed size). */
  readonly size: number;
  /** Refuse anything larger without downloading it. */
  readonly maxBytes: number;
  /** Hosts the final response URL (after redirects) may have. */
  readonly allowedHosts: readonly string[];
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  /** Called after every chunk with the bytes so far and the expected total. */
  readonly onProgress?: (bytes: number, total: number) => void;
}

export type DownloadFailure =
  /** Bytes, size or Content-Length disagree with the listed digest and size. */
  | 'digest-mismatch'
  /** The listed size exceeds the cap. */
  | 'too-large'
  /** The download ended on a host outside `allowedHosts`. */
  | 'bad-host'
  /** Network error, HTTP error, timeout, or no memory for the buffer (transient). */
  | 'network';

export type DownloadResult =
  | {readonly ok: true; readonly bytes: Uint8Array}
  | {readonly ok: false; readonly failure: DownloadFailure};

/** Downloads `url` into memory and checks its size and sha256 before returning it. Never throws. */
export async function downloadVerified(
  fetchFn: typeof fetch,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const {size, maxBytes} = options;
  if (!Number.isSafeInteger(size) || size < 0) return {ok: false, failure: 'digest-mismatch'};
  if (size > maxBytes) return {ok: false, failure: 'too-large'};

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const total = setTimeout(abort, options.totalTimeoutMs);
  let idle = setTimeout(abort, options.idleTimeoutMs);
  const touch = (): void => {
    clearTimeout(idle);
    idle = setTimeout(abort, options.idleTimeoutMs);
  };
  try {
    let res: Response;
    try {
      res = await fetchFn(options.url, {
        method: 'GET',
        ...(options.accept === undefined ? {} : {headers: {Accept: options.accept}}),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch {
      return {ok: false, failure: 'network'};
    }
    touch();
    const fail = (failure: DownloadFailure): DownloadResult => {
      void res.body?.cancel().catch(() => undefined);
      return {ok: false, failure};
    };
    if (!res.ok) return fail('network');
    if (!isAllowedHttpsUrl(res.url, options.allowedHosts)) return fail('bad-host');
    const declared = res.headers.get('content-encoding') === null ? contentLength(res) : null;
    if (declared !== null && declared !== size) return fail('digest-mismatch');
    let out: Uint8Array;
    try {
      out = new Uint8Array(size);
    } catch {
      // No memory for the asset (a low-memory device): transient, never a mismatch.
      return fail('network');
    }
    let at = 0;
    if (res.body !== null) {
      const reader = res.body.getReader();
      const stop = (failure: DownloadFailure): DownloadResult => {
        void reader.cancel().catch(() => undefined);
        return {ok: false, failure};
      };
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch {
          return stop('network');
        }
        if (step.done) break;
        const value = step.value;
        touch();
        if (at + value.length > size) return stop('digest-mismatch');
        out.set(value, at);
        at += value.length;
        options.onProgress?.(at, size);
      }
    }
    if (at !== size) return {ok: false, failure: 'digest-mismatch'};
    if ((await sha256Hex(out)) !== options.sha256) return {ok: false, failure: 'digest-mismatch'};
    return {ok: true, bytes: out};
  } catch {
    return {ok: false, failure: 'network'};
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}
