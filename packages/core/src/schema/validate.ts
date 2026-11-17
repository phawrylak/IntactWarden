/**
 * Small checks shared by the builders, the cloud derivation and the core postcondition
 * (schema/manifest.ts coreProblem).
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Characters that may appear unescaped in a WHATWG-serialised URL path, plus
// percent escapes. Notably excluded: space " # < > ? ` { } \ and non-ASCII.
const PATH_SYNTAX = /^\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@[\]|^/]|%[0-9A-Fa-f]{2})*$/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Checks a manifest file path: absolute, no query or fragment, no empty, "."
 * or ".." segments (including their percent-encoded forms), no trailing "/".
 * Returns a reason string, or null if the path is acceptable.
 */
export function pathProblem(path: string): string | null {
  if (path.length < 2 || path.length > 2048) return 'path length must be 2..2048';
  if (!PATH_SYNTAX.test(path))
    return 'expected an absolute URL path without query, fragment or unescaped specials';
  const segments = path.slice(1).split('/');
  for (const seg of segments) {
    if (seg === '') return 'empty path segment (or trailing "/")';
    if (DOT_SEGMENT.test(seg)) return 'dot segment in path';
  }
  return null;
}
