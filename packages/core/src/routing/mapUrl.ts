/**
 * URL → manifest path, per hosting type.
 *
 * Given the URL a response was served for and its HTTP status, mapUrl names
 * what the body must be checked against. It never decides a verdict itself:
 * - { kind: 'file' }: the file the hosting serves for this path. `key` is the
 *   `files` key it is listed under (the path itself, or a slot path such as
 *   `/app/main.{MAIN}.js` with the slot values in `bound`), or null when the
 *   path is not listed (an unknown path answered with content). The caller must
 *   never treat null as "not covered": an active request (a `.wasm` fetch
 *   included) is a MISMATCH (`unknown-path`), a passive one (image, media,
 *   data, source map) is only counted, and a navigation binds nowhere (an
 *   unknown document, or at a declared document path an unknown build).
 * - { kind: 'not-found-document' }: a 404 whose body must equal that entry.
 * - { kind: 'server-not-found' }: a 404 whose body the server renders itself
 *   (vaultwarden-rocket), for a path the core does not list. It is never
 *   compared with the build: for a subresource it is a non-executing miss
 *   (browsers neither run scripts nor apply stylesheets from non-ok
 *   responses); for a navigation it is a document of unknown class, denied:
 *   it never runs and taints nothing.
 * - { kind: 'missing-file' }: a 404 for a file the core lists exactly
 *   (`key` = `path`), on a hosting that serves every listed file
 *   (vaultwarden-rocket). The served folder differs from the release, and an
 *   app that reads the body (a `fetch` of `/locales/*.json`) would read the
 *   server's template instead: the caller MUST treat it as a MISMATCH
 *   (`bytes`), whatever the body. (Rocket never serves the empty
 *   `/.nojekyll`, so its 404 is misjudged too; nothing requests that file.)
 * - { kind: 'outside-base' }: the path is not under the deployment base path.
 * - { kind: 'invalid' }: the URL, status or routing config cannot be mapped
 *   (every redirect status among them: the header guard decides redirects).
 *   Fail closed: the response is unverified.
 *
 * Query strings and fragments never take part in the mapping. The statuses
 * that carry content are every 2xx and 304: a server that answers a listed
 * path with 201 or 203 still hands the page a body it reads as ok, so the body
 * is the file's (the caller handles partial and not-modified bodies).
 * The origin is not checked here: the caller has
 * already matched it to the deployment. Same-origin paths outside the base
 * path are still the origin's documents and must not be treated as safe.
 *
 * The base path belongs to the deployment, not to the build (one release core serves
 * self-hosted instances at "/" and at "/vault/"), so the caller passes the deployment's or
 * instance's `basePath`; the core's `routing.base_path` is only the default.
 *
 * Hosting behaviour modelled here (sources in the tests):
 * - static-exact (Azure Blob static website behind Fastly; vault.bitwarden.com)
 *   and bitwarden-selfhost (bitwarden/server util/Server: ASP.NET Core
 *   StaticFiles under `base_path`): '/' → index, every other path exact, a
 *   directory path 'd/' → 'd/<index name>'; unknown → 404 with `not_found`.
 *   Only the cloud sends it: util/Server answers an unknown path with an empty
 *   404 (Bitwarden lite: nginx's page), which never matches.
 * - vaultwarden-rocket (vaultwarden 1.37.5 src/api/web.rs on Rocket 0.5):
 *   '/' → index (byte-for-byte NamedFile);
 *   every other path is served exactly from the build, so a 404 for a listed
 *   file is `missing-file`; any other 404 carries a server-rendered body
 *   (template `404.hbs`), never `not_found`. Paths the server generates itself
 *   (`/css/vaultwarden.css`, `/app-id.json`, `/api/**`, ...) are profile data:
 *   the caller classifies them (profile `resources.server_styles` and
 *   `dynamic_same_origin`) before it asks mapUrl, so
 *   here they are ordinary paths and content for one that the core does not
 *   list maps to key null.
 */

import type {FileIndex} from './fileIndex.ts';
import {normalizePath, RoutingError} from './normalizePath.ts';

/** The hosting types routing models; the one closed list in code. */
export const HOSTING_KINDS = ['static-exact', 'bitwarden-selfhost', 'vaultwarden-rocket'] as const;
export type Hosting = (typeof HOSTING_KINDS)[number];

export interface RoutingConfig {
  hosting: Hosting;
  /** '/' or '/vault/' etc.: normalised, starts and ends with '/'. */
  base_path: string;
  /** e.g. '/index.html'; its last segment is also the directory index name. */
  index: string;
  /** e.g. '/404.html': the body of a 404 response. */
  not_found?: string;
}

export type RouteResult =
  | {kind: 'file'; path: string; key: string | null; bound: Readonly<Record<string, string>>}
  | {kind: 'not-found-document'; path: string}
  | {kind: 'server-not-found'}
  | {kind: 'missing-file'; path: string; key: string}
  | {kind: 'outside-base'}
  | {kind: 'invalid'; reason: string};

type Invalid = {kind: 'invalid'; reason: string};

export interface MapUrlOptions {
  /**
   * The deployment's (or self-hosted instance's) base path, e.g. "/vault/".
   * Defaults to `routing.base_path`.
   */
  readonly basePath?: string;
}

/**
 * What the hosting does for a path (relative to the base path): a content status serves `path`;
 * a 404 must carry `notFound`, or carries a server-rendered body when `notFound` is 'server'.
 */
interface Resolution {
  readonly path: string;
  readonly notFound: string | null | 'server';
}

const HOSTINGS: ReadonlySet<string> = new Set(HOSTING_KINDS);
const ROUTING_KEYS: ReadonlySet<string> = new Set(['hosting', 'base_path', 'index', 'not_found']);

export function mapUrl(
  url: string | URL,
  core: RoutingConfig,
  files: FileIndex,
  status: number,
  options: MapUrlOptions = {},
): RouteResult {
  const routing = options.basePath === undefined ? core : {...core, base_path: options.basePath};
  try {
    checkRoutingConfig(routing);
  } catch (e) {
    return invalid(`routing config: ${errorMessage(e)}`);
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return invalid(`not an HTTP status: ${String(status)}`);
  }

  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return invalid('not an absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return invalid(`unsupported scheme ${parsed.protocol}`);
  }

  let path: string;
  try {
    path = normalizePath(parsed.pathname);
  } catch (e) {
    return invalid(errorMessage(e));
  }
  if (!path.startsWith(routing.base_path)) return {kind: 'outside-base'};
  const rel = '/' + path.slice(routing.base_path.length);

  try {
    return reconcile(resolve(rel, routing), status, files);
  } catch (e) {
    if (e instanceof RoutingError) return invalid(e.message);
    throw e;
  }
}

/** Throws RoutingError unless `routing` is internally consistent. */
export function checkRoutingConfig(routing: RoutingConfig): void {
  for (const key of Object.keys(routing)) {
    // Fail closed on fields of hosting types this code does not model.
    if (!ROUTING_KEYS.has(key)) throw new RoutingError(`unknown routing field ${key}`);
  }
  if (!HOSTINGS.has(routing.hosting)) throw new RoutingError('unknown hosting');
  const base = routing.base_path;
  if (typeof base !== 'string' || !base.endsWith('/') || normalizePath(base) !== base) {
    throw new RoutingError('base_path must be a normalised path ending with "/"');
  }
  checkFilePath('index', routing.index);
  if (routing.not_found !== undefined) {
    checkFilePath('not_found', routing.not_found);
    // Rocket renders its own 404 body; a build file never answers a 404.
    if (routing.hosting === 'vaultwarden-rocket') {
      throw new RoutingError('vaultwarden-rocket has no not_found document');
    }
  }
}

function checkFilePath(name: string, value: string): void {
  if (typeof value !== 'string' || value.endsWith('/') || normalizePath(value) !== value) {
    throw new RoutingError(`${name} must be a normalised file path`);
  }
}

function resolve(rel: string, routing: RoutingConfig): Resolution {
  const index = routing.index;
  if (routing.hosting === 'vaultwarden-rocket') {
    return {path: rel === '/' ? index : rel, notFound: 'server'};
  }
  const notFound = routing.not_found ?? null;
  if (rel === '/') return {path: index, notFound};
  if (rel.endsWith('/')) return {path: rel + index.slice(index.lastIndexOf('/') + 1), notFound};
  return {path: rel, notFound};
}

function reconcile(res: Resolution, status: number, files: FileIndex): RouteResult {
  if ((status >= 200 && status < 300) || status === 304) {
    const match = files.lookup(res.path);
    return {kind: 'file', path: res.path, key: match?.key ?? null, bound: match?.bound ?? {}};
  }
  if (status === 404) {
    if (res.notFound === 'server') {
      // Rocket serves every listed file, so a 404 for one means the served folder is not the
      // release. A slot path is a pattern, not a file the folder must hold.
      const match = files.lookup(res.path);
      if (match !== null && match.key === res.path) {
        return {kind: 'missing-file', path: res.path, key: match.key};
      }
      return {kind: 'server-not-found'};
    }
    if (res.notFound !== null) return {kind: 'not-found-document', path: res.notFound};
    return invalid('404 but the routing declares no not-found document');
  }
  return invalid(`unexpected status ${status}`);
}

function invalid(reason: string): Invalid {
  return {kind: 'invalid', reason};
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
