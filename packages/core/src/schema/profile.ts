/**
 * App profiles: the bundled, code-reviewed policy for one protected app, written as typed
 * constants in packages/profiles. Remote data can never add origins, loosen a floor or allow a
 * third party, so everything here ships in the package. Matching helpers for the glob and
 * URL-pattern grammars used by profiles live here too; none of them builds a RegExp from data
 * (R8).
 */

import type {Assurance} from '../verdict/states.ts';

/** webRequest resource types. */
export type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'media'
  | 'websocket'
  | 'other';

export type CspDirectiveName =
  'base-uri' | 'script-src' | 'script-src-attr' | 'worker-src' | 'form-action';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Upstream {
  /** "<owner>/<repo>" on github.com. */
  readonly repo: string;
  /**
   * Numeric GitHub repository id; pins the repository against renames and
   * delete-and-recreate.
   */
  readonly repo_id: number;
  /** Literal tag name with exactly one "{version}", e.g. "web-v{version}". */
  readonly tag_pattern: string;
  /** The app's one release asset, with exactly one "{version}"; every variant is built from it. */
  readonly asset: string;
  /** Directory of the web vault inside the asset, e.g. "build/". */
  readonly archive_root: string;
}

export interface Variant {
  /** The class this variant reaches when everything succeeds. */
  readonly assurance: Assurance;
}

export type ServerRenderedClass = 'admin-portal' | 'auth-flow';

export interface ServerRendered {
  readonly path: string;
  readonly class: ServerRenderedClass;
}

export interface AppDeployment {
  readonly id: string;
  readonly kind: 'cloud' | 'self-hosted';
  /** Canonical origins, or "user" for user-added self-hosted instances. */
  readonly origins: readonly string[] | 'user';
  /** The one variant whose cores this deployment's pages bind to. */
  readonly variant: string;
  readonly server_rendered?: readonly ServerRendered[];
}

export interface Identify {
  /** Path globs of the app's documents: an unbound navigation elsewhere is an unknown document. */
  readonly documents?: readonly string[];
  readonly hint_endpoints?: readonly string[];
}

/** A same-origin path the server generates (API, data): never part of a core, never code. */
export interface DynamicPath {
  readonly path: string;
  readonly deployments?: readonly string[];
}

export interface NotCoveredPath {
  readonly path: string;
  readonly reason: string;
  readonly deployments?: readonly string[];
}

/**
 * A stylesheet the server generates itself (never part of a core). Its bytes
 * are checked by a closed validator (style/serverStyle.ts); anything the
 * validator does not accept is UNVERIFIED_STYLE.
 */
export interface ServerStyle {
  /** Exact path (no glob), relative to the deployment base path. */
  readonly path: string;
  readonly deployments?: readonly string[];
}

export interface Resources {
  readonly dynamic_same_origin: readonly DynamicPath[];
  readonly not_covered_paths: readonly NotCoveredPath[];
  readonly server_styles?: readonly ServerStyle[];
}

/** Decides what a matching cross-origin request does (extension/src/policy/verifyItem.ts). */
export type ThirdPartyKind =
  'unpinnable-script' | 'cross-origin-frame' | 'data' | 'passive' | 'unexpected';

export interface ThirdParty {
  readonly id: string;
  /** URL patterns: "https://" + host (optionally "*." prefixed) + path, "*" matching anything. */
  readonly match: readonly string[];
  readonly kind: ThirdPartyKind;
  /**
   * CSP sources added back to the floor of the one document the user allows this for (kind
   * "unpinnable-script" only).
   */
  readonly csp_allowance?: Readonly<Partial<Record<CspDirectiveName, readonly string[]>>>;
}

export interface HeaderPolicy {
  /**
   * Same-origin subresource paths that may answer with a redirect to another
   * origin (Vaultwarden's external icon service behind `/icons/**`). Only
   * passive types, and only on dynamic paths.
   */
  readonly subresource_redirects?: readonly SubresourceRedirect[];
}

export interface SubresourceRedirect {
  readonly path: string;
  readonly types: readonly ('image' | 'media')[];
}

/** Enforced CSP directives: name → space-separated source list. */
export type CspDirectives = Readonly<Partial<Record<CspDirectiveName, string>>>;

export interface AppProfile {
  /** App id, unique across the package; the id used in build ids. */
  readonly app: string;
  readonly upstream: Upstream;
  readonly variants: Readonly<Record<string, Variant>>;
  readonly deployments: readonly AppDeployment[];
  readonly identify: Identify;
  readonly resources: Resources;
  readonly third_party: readonly ThirdParty[];
  readonly headers?: HeaderPolicy;
  /** The appended, enforced CSP floor; it can only tighten. */
  readonly csp_floor: CspDirectives;
}

// ---------------------------------------------------------------------------
// Matching helpers (no RegExp built from data)
// ---------------------------------------------------------------------------

const ONE = 0;
const RUN = 1;
type GlobToken = string | typeof ONE | typeof RUN;

/**
 * Wildcard match where "*" matches a run of at least `starMin` characters.
 * Iterative greedy matching with one backtrack point, so hostile input cannot
 * cause exponential work.
 */
function wildcardMatch(pattern: string, text: string, starMin: 0 | 1): boolean {
  const tokens: GlobToken[] = [];
  for (const c of pattern) {
    if (c !== '*') tokens.push(c);
    else if (starMin === 1) tokens.push(ONE, RUN);
    else tokens.push(RUN);
  }
  const chars = [...text];
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < chars.length) {
    const token = tokens[p];
    if (p < tokens.length && token !== RUN && (token === ONE || token === chars[t])) {
      p++;
      t++;
    } else if (p < tokens.length && token === RUN) {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < tokens.length && tokens[p] === RUN) p++;
  return p === tokens.length;
}

/**
 * Matches a profile path glob against a normalised URL path:
 * "*" matches one or more bytes inside one segment, and a final "**" segment
 * matches zero or more remaining segments ("/api/**" matches "/api", "/api/"
 * and "/api/a/b").
 */
export function matchPathGlob(glob: string, path: string): boolean {
  if (!glob.startsWith('/') || !path.startsWith('/')) return false;
  const g = glob.split('/');
  const s = path.split('/');
  for (let i = 0; i < g.length; i++) {
    const seg = g[i]!;
    if (seg === '**' && i === g.length - 1) return s.length >= i;
    if (i >= s.length || !wildcardMatch(seg, s[i]!, 1)) return false;
  }
  return g.length === s.length;
}

/**
 * Matches a third-party URL pattern ("https://[*.]host/path*") against a URL.
 * The pattern's path part is matched against pathname + search; "*" matches
 * anything. Non-https URLs, explicit ports and userinfo never match.
 */
export function matchUrlPattern(pattern: string, url: string): boolean {
  const m = /^https:\/\/((?:\*\.)?[a-z0-9.-]+)(\/.*)$/.exec(pattern);
  if (m === null) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '')
    return false;
  const host = m[1]!;
  if (host.startsWith('*.')) {
    const suffix = host.slice(1); // ".duosecurity.com"
    if (!u.hostname.endsWith(suffix) || u.hostname.length <= suffix.length) return false;
  } else if (u.hostname !== host) {
    return false;
  }
  return wildcardMatch(m[2]!, u.pathname + u.search, 0);
}

/** Every canonical origin a profile claims, with its deployment ("user" deployments claim none). */
export function profileOrigins(p: AppProfile): {origin: string; deployment: string}[] {
  const out: {origin: string; deployment: string}[] = [];
  for (const d of p.deployments) {
    if (d.origins !== 'user') for (const origin of d.origins) out.push({origin, deployment: d.id});
  }
  return out;
}
