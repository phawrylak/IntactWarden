/**
 * Privacy invariant: every URL that is
 * persisted, logged or messaged passes through redactUrl(), which keeps scheme, host, port and
 * path only. Query strings and fragments are dropped because they can carry
 * secrets (Bitwarden Send keeps its decryption key in the fragment), and
 * userinfo is dropped because it is a credential.
 */

export const INVALID_URL = '<invalid-url>';

/** Schemes whose whole payload is content or a nested URL: only the scheme survives. */
const SCHEME_ONLY = new Set(['data:', 'blob:', 'javascript:', 'about:']);

/**
 * Returns `scheme://host[:port]/path` for hierarchical URLs, `scheme:` for
 * data:, blob:, javascript:, about: and any other URL without an authority
 * (opaque paths such as mailto:), and "<invalid-url>" for anything that does
 * not parse. Default ports are omitted and hosts are normalised (lowercase,
 * IDNA) by the WHATWG URL parser. Never throws.
 */
export function redactUrl(url: unknown): string {
  if (typeof url !== 'string') return INVALID_URL;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return INVALID_URL;
  }
  if (SCHEME_ONLY.has(u.protocol)) return u.protocol;
  // Opaque-path URLs (no "//" authority) may hold arbitrary payloads.
  if (u.host === '' && !u.pathname.startsWith('/')) return u.protocol;
  return `${u.protocol}//${u.host}${u.pathname}`;
}
