/**
 * Canonical JSON (RFC 8785, JCS) of plain JSON data: object keys sorted by UTF-16 code
 * units, no whitespace, strings and numbers as JSON.stringify writes them.
 *
 * A core is stored and hashed as the exact bytes produced here.
 * The input must be plain data, as the builders produce it: anything else (undefined, a
 * function, a symbol, a bigint, NaN, a sparse array, a class instance) throws a TypeError
 * instead of being dropped or coerced.
 */

const encoder = new TextEncoder();

/** Canonical JSON text of `value`. Throws TypeError on input that is not plain JSON data. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  // Array.from visits holes as undefined, which throws below.
  if (Array.isArray(value)) return `[${Array.from(value, v => canonicalize(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const object = value as Record<string, unknown>;
      // The default sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
      const members = Object.keys(object)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
      return `{${members.join(',')}}`;
    }
  }
  throw new TypeError(`canonicalize: not plain JSON data (${typeof value})`);
}

/** UTF-8 encoding of canonicalize(value): the bytes that are hashed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}
