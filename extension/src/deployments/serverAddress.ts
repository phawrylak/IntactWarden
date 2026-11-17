/**
 * Instance input parsing and the look-alike check. Pure: the options page also runs both before it
 * requests the host permission.
 *
 * - https always; http only for this computer (loopback), where Firefox gives the vault the
 *   secure context its crypto needs.
 * - Hosts whose permission the extension requires (the official cloud hosts and the GitHub hosts
 *   of deep verify) are refused by host name, on any port: an instance there would share the
 *   required permission pattern, and removing the instance's permission would remove the
 *   required one.
 * - Look-alike hosts need an explicit confirmation, here in the page and again where the
 *   instance is stored (deployments/index.ts).
 */

import {OFFICIAL_ORIGINS} from '@intactwarden/profiles';
import {GITHUB_HOSTS, type Origin, type AddInstanceRefusal} from '../contracts.ts';

const OFFICIAL_HOSTS: readonly string[] = OFFICIAL_ORIGINS.map(o => new URL(o).hostname);
/** "bitwarden.com", "bitwarden.eu": the official hosts without their first label. */
const OFFICIAL_DOMAINS: readonly string[] = [
  ...new Set(OFFICIAL_HOSTS.map(h => h.split('.').slice(1).join('.')).filter(d => d.includes('.'))),
];
const GITHUB_HOST_NAMES: ReadonlySet<string> = new Set(
  Object.values(GITHUB_HOSTS).map(o => new URL(o).hostname),
);

/** localhost, *.localhost, 127.0.0.0/8 and [::1], as `URL.hostname` spells them. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export type ParsedInstance =
  | {
      readonly ok: true;
      readonly origin: Origin;
      /** "/" or "/<segments>/". */
      readonly basePath: string;
    }
  | {readonly ok: false; readonly code: AddInstanceRefusal};

/**
 * Normalises typed input ("vault.example.org/vw") to origin and base path, and refuses the
 * official and GitHub hosts (any port), http other than loopback, and a host with `*` (its match
 * pattern would be a wildcard, not this one server).
 */
export function parseInstanceInput(input: string): ParsedInstance {
  const raw = input.trim();
  if (raw === '' || raw.length > 2048) return {ok: false, code: 'invalid-input'};
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return {ok: false, code: 'invalid-input'};
  }
  if (u.username !== '' || u.password !== '') return {ok: false, code: 'invalid-input'};
  if (u.hostname.includes('*')) return {ok: false, code: 'invalid-input'};
  const host = u.hostname.replace(/\.$/, '');
  if (OFFICIAL_HOSTS.includes(host)) return {ok: false, code: 'refused-official-origin'};
  if (GITHUB_HOST_NAMES.has(host)) return {ok: false, code: 'invalid-input'};
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    return {ok: false, code: 'http-not-loopback'};
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return {ok: false, code: 'invalid-input'};
  let path = u.pathname;
  if (path.includes('/../') || path.includes('/./') || path.includes('//')) {
    return {ok: false, code: 'invalid-input'};
  }
  if (path.endsWith('/index.html')) path = path.slice(0, -'index.html'.length);
  if (!path.endsWith('/')) path += '/';
  return {ok: true, origin: u.origin, basePath: path};
}

/** Host-permission match pattern for an origin ("https://host/*", ports are not part of patterns). */
export function matchPatternFor(origin: Origin): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Levenshtein distance, bounded for short host names. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** ASCII skeleton of a host: digits that pass for letters, and rn → m, vv → w. */
const skeleton = (h: string): string =>
  h
    .replace(/[0135]/g, d => ({'0': 'o', '1': 'l', '3': 'e', '5': 's'})[d]!)
    .replaceAll('rn', 'm')
    .replaceAll('vv', 'w');

/**
 * True when a host (ASCII, as `URL.hostname` gives it) may imitate an official host: the vendor's
 * own domain anywhere in the host (the domain itself and its subdomains are never a self-hosted
 * server; "vault.bitwarden.com.example.org" only starts like one); any internationalised (`xn--`)
 * label, since a non-ASCII character can imitate any Latin letter; or an edit distance of at most
 * 2 to an official host or domain, on the raw host or on its skeleton.
 */
export function isLookalikeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (OFFICIAL_DOMAINS.some(d => `.${h}.`.includes(`.${d}.`))) return true;
  if (h.split('.').some(label => label.startsWith('xn--'))) return true;
  return [...OFFICIAL_HOSTS, ...OFFICIAL_DOMAINS].some(
    o => editDistance(h, o) <= 2 || editDistance(skeleton(h), skeleton(o)) <= 2,
  );
}
