/**
 * Canonical form of a URL path, used for every manifest key.
 *
 * RFC 3986 §6.2.2 normalisation, made strict so that two spellings of one
 * request can never map to different keys and no spelling can escape the
 * deployment root. Every modelled hosting type (Azure Blob, ASP.NET Core
 * static files, Rocket) percent-decodes the whole path before it looks up a file, so
 * the canonical form is the minimal encoding of the decoded bytes:
 * - a byte that RFC 3986 allows raw in a path segment (unreserved
 *   `ALPHA DIGIT - . _ ~`, sub-delims `! $ & ' ( ) * + , ; =`, `:` and `@`)
 *   is written raw, also when it was percent-encoded: `/a%21b.js`,
 *   `/a%40b.js` (as `encodeURIComponent` writes it) and `/a!b.js`, `/a@b.js`
 *   share a key;
 * - every other byte is percent-encoded with uppercase hex: raw characters
 *   that RFC 3986 does not allow in a path (space, `[`, `^`, non-ASCII, ...)
 *   are encoded as UTF-8, so `/[id].js` and `/%5Bid%5D.js` share a key;
 * - the input is rejected (RoutingError) for: no leading '/', malformed
 *   escapes, escapes that are not valid UTF-8 (e.g. overlong `%C0%AE`),
 *   encoded '/' or '\', raw '\', NUL and other control characters (raw or
 *   encoded), raw '?' or '#', lone surrogates, '.' and '..' segments (also
 *   when spelled `%2e`), and empty segments ('//'). A single trailing '/' is
 *   allowed.
 *
 * Escapes are decoded once: `%252e` stays a literal `%252e` segment, never '.'.
 * Letters are never case-folded.
 */

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

/** Upper bound on the input length, to bound work on hostile URLs. */
export const MAX_PATH_LENGTH = 8192;

const HEX_UPPER = '0123456789ABCDEF';

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/** RFC 3986 unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~". */
function isUnreserved(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    (b >= 0x30 && b <= 0x39) ||
    b === 0x2d ||
    b === 0x2e ||
    b === 0x5f ||
    b === 0x7e
  );
}

/** Characters RFC 3986 allows raw in a path besides unreserved: sub-delims, ':', '@', '/'. */
const RAW_PATH_CHARS = "!$&'()*+,;=:@/";

/** True for the ASCII bytes the canonical form writes raw (pchar and '/'). */
function isRawPathByte(b: number): boolean {
  return isUnreserved(b) || (b < 0x80 && RAW_PATH_CHARS.includes(String.fromCharCode(b)));
}

function isControl(b: number): boolean {
  return b < 0x20 || b === 0x7f;
}

function utf8Bytes(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [
    0xf0 | (cp >> 18),
    0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  ];
}

const strictUtf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

export function normalizePath(rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) {
    throw new RoutingError('path must start with "/"');
  }
  if (rawPath.length > MAX_PATH_LENGTH) {
    throw new RoutingError(`path longer than ${MAX_PATH_LENGTH} characters`);
  }

  // Decoded bytes, and for each whether the canonical form percent-encodes it.
  const bytes: number[] = [];
  const encode: boolean[] = [];

  for (let i = 0; i < rawPath.length;) {
    const c = rawPath.charCodeAt(i);
    if (c === 0x25) {
      const hi = hexValue(rawPath.charCodeAt(i + 1));
      const lo = hexValue(rawPath.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) throw new RoutingError('malformed percent-escape');
      const b = hi * 16 + lo;
      if (b === 0x2f) throw new RoutingError('encoded "/" (%2F) in path');
      if (b === 0x5c) throw new RoutingError('encoded "\\" (%5C) in path');
      if (isControl(b)) throw new RoutingError('encoded control character in path');
      bytes.push(b);
      encode.push(!isRawPathByte(b));
      i += 3;
      continue;
    }
    if (c === 0x5c) throw new RoutingError('backslash in path');
    if (isControl(c)) throw new RoutingError('control character in path');
    if (c === 0x3f || c === 0x23) throw new RoutingError('"?" or "#" in path');
    if (c < 0x80) {
      bytes.push(c);
      encode.push(!isRawPathByte(c));
      i += 1;
      continue;
    }
    const cp = rawPath.codePointAt(i)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new RoutingError('lone surrogate in path');
    for (const b of utf8Bytes(cp)) {
      bytes.push(b);
      encode.push(true);
    }
    i += cp > 0xffff ? 2 : 1;
  }

  try {
    strictUtf8.decode(Uint8Array.from(bytes));
  } catch {
    throw new RoutingError('percent-escapes do not form valid UTF-8');
  }

  let out = '';
  for (let k = 0; k < bytes.length; k++) {
    const b = bytes[k]!;
    out += encode[k] ? '%' + HEX_UPPER[b >> 4]! + HEX_UPPER[b & 0x0f]! : String.fromCharCode(b);
  }

  const segments = out.slice(1).split('/');
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]!;
    if (segment === '' && s !== segments.length - 1) {
      throw new RoutingError('empty path segment');
    }
    if (segment === '.' || segment === '..') {
      throw new RoutingError('dot segment in path');
    }
  }
  return out;
}
