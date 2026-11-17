/**
 * URL helpers for the engine and the backend. Everything returned is derived from a redacted
 * URL: origin and normalised path only.
 */

import {normalizePath} from '@intactwarden/core/routing/normalizePath.ts';
import {redactUrl} from '@intactwarden/core/privacy/redactUrl.ts';
import type {Origin, RedactedUrl} from '../contracts.ts';

/** Exact origin serialisation of a URL, or null for opaque or invalid URLs. */
export function originOf(url: string | null | undefined): Origin | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Normalised path of a URL, or null when it cannot be normalised. */
export function pathOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return null;
  }
}

/** For anything persisted, logged or messaged. */
export function redact(url: string | null | undefined): RedactedUrl {
  return redactUrl(url);
}

/** "x.y.z" comparison; non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Random lowercase hex id of `bytes` bytes. */
export function randomHex(bytes = 8): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
