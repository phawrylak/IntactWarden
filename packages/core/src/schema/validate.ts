/**
 * Small checks shared by the builders, the cloud derivation and the core postcondition
 * (schema/manifest.ts coreProblem).
 */

import {normalizePath} from '../routing/normalizePath.ts';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks a manifest file path: at most 2048 characters, in canonical form
 * (normalizePath(path) === path, so absolute, no query or fragment, no empty,
 * "." or ".." segments), no trailing "/". Returns a reason string, or null if
 * the path is acceptable.
 */
export function pathProblem(path: string): string | null {
  if (path.length > 2048) return 'path longer than 2048 characters';
  let canonical: string;
  try {
    canonical = normalizePath(path);
  } catch (e) {
    return e instanceof Error ? e.message : 'not a path';
  }
  if (canonical !== path) return `not in canonical form (${JSON.stringify(canonical)})`;
  return path.endsWith('/') ? 'trailing "/"' : null;
}
