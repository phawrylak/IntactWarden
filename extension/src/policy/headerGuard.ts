/**
 * Header guard: a redirect without a declared Location and every
 * Refresh cancel; Link and Speculation-Rules, and Content-Disposition on a build document, are
 * removed; Content-Type and charset are checked per entry class (a violation is returned and the
 * engine records MISMATCH `header`); the enforced CSP floor and the no-store rewrite are added.
 * Pure.
 */

import {mapUrl} from '@intactwarden/core/routing/mapUrl.ts';
import {matchPathGlob} from '@intactwarden/core/schema/profile.ts';
import type {
  HeaderGuard,
  HeaderGuardResult,
  HeaderPair,
  HeaderViolation,
  ItemClass,
} from '../contracts.ts';
import {cspFloor} from './cspFloor.ts';
import {classifyServerPath} from './classify.ts';
import {header, isDocumentType, originOfUrl, pathOfUrl, relativePath} from './util.ts';

const JS_ESSENCES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

function essence(contentType: string): string {
  const semi = contentType.indexOf(';');
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

function charsetOk(contentType: string): boolean {
  for (const part of contentType.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    let v = part
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (v !== 'utf-8') return false;
  }
  return true;
}

/** Whether a Content-Type value is acceptable for an entry class. */
export function contentTypeAllowed(cls: ItemClass, contentType: string | null): boolean {
  if (cls === 'image' || cls === 'media' || cls === 'sourcemap') {
    return true;
  }
  if (cls === 'third-party' || cls === 'unknown' || cls === 'dynamic') return true;
  if (contentType === null) return false;
  const e = essence(contentType);
  const textual =
    cls === 'document' || cls === 'script' || cls === 'style' || cls === 'server-style';
  if (textual && !charsetOk(contentType)) return false;
  switch (cls) {
    case 'document':
      return e === 'text/html';
    case 'script':
      return JS_ESSENCES.has(e);
    case 'style':
    case 'server-style':
      return e === 'text/css';
    case 'wasm':
      return e === 'application/wasm';
    case 'font':
      return (
        e.startsWith('font/') ||
        e === 'application/font-woff' ||
        e === 'application/font-woff2' ||
        e === 'application/octet-stream'
      );
    case 'data':
      return e === 'application/json' || e === 'text/plain';
    default:
      return true;
  }
}

/** Whether a content type is executable (JS, HTML, CSS or wasm): never allowed on dynamic paths. */
export function isExecutableContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const e = essence(contentType);
  return JS_ESSENCES.has(e) || e === 'text/html' || e === 'text/css' || e === 'application/wasm';
}

export const headerGuard: HeaderGuard = input => {
  const {origin, request, response, isDocument, candidates, binding} = input;
  const headers = response.headers;
  const strip: string[] = [];
  const append: HeaderPair[] = [];
  let violation: HeaderViolation | null = null;
  const cancel = (v: HeaderViolation): HeaderGuardResult => ({
    action: 'cancel',
    strip,
    append,
    noStore: false,
    violation: v,
  });
  const cores =
    binding === null ? candidates : candidates.filter(c => c.ref.sha256 === binding.coreSha256);
  const pool = cores.length > 0 ? cores : candidates;

  // Location (any 3xx but 304, which is a revalidation and no redirect).
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    const loc = header(headers, 'location');
    let ok = false;
    if (loc !== null) {
      let target: string | null = null;
      try {
        target = new URL(loc, request.url).href;
      } catch {
        target = null;
      }
      if (target !== null && isDocument) {
        const cls = classifyServerPath(origin, request.url, request.type);
        const tPath = pathOfUrl(target);
        const sameOrigin = originOfUrl(target) === origin.origin;
        // A declared auth-flow page redirects to its identity provider and back, on any origin.
        if (cls.k === 'server-rendered' && cls.class === 'auth-flow') ok = true;
        // Any other server-rendered page redirects as server code does (the admin portal to its
        // login page). A same-origin target is a navigation of its own, judged on its own: a
        // server-rendered target is denied as NOT_COVERED, a release path is verified.
        else if (cls.k === 'server-rendered' && sameOrigin) ok = true;
        // A same-origin redirect to exactly the deployment's base path (a reverse proxy's "/vw"
        // to "/vw/", Vaultwarden's "/index.html" to "/"): the landing document is hashed and
        // bound like any other navigation.
        else if (sameOrigin && tPath !== null && relativePath(origin, tPath) === '/') ok = true;
      } else if (target !== null && (request.type === 'image' || request.type === 'media')) {
        const path = pathOfUrl(request.url);
        const rel = path === null ? null : relativePath(origin, path);
        for (const sr of origin.profile.headers?.subresource_redirects ?? []) {
          if (rel !== null && matchPathGlob(sr.path, rel) && sr.types.includes(request.type))
            ok = true;
        }
      }
    }
    if (!ok) return cancel('location');
  }

  if (header(headers, 'refresh') !== null) return cancel('refresh');

  // Headers that would make the browser load something no filter sees before the page asks for
  // it (a Link stylesheet, preload or prefetch; speculation rules) are removed, never parsed: a
  // proxy that adds a harmless Link header does not stop the vault, and a hostile one loads
  // nothing.
  if (header(headers, 'link') !== null) strip.push('link');
  if (header(headers, 'speculation-rules') !== null) strip.push('speculation-rules');

  // A document of the build is shown, never saved: an attachment would leave the tab on the page
  // that started the navigation while the verified download's state stood for that tab.
  if (
    isDocument &&
    header(headers, 'content-disposition') !== null &&
    classifyServerPath(origin, request.url, request.type).k === 'build'
  ) {
    strip.push('content-disposition');
  }

  // Content type per entry class (only for 2xx with a known class).
  const ctype = header(headers, 'content-type');
  let cls: ItemClass | null = null;
  const sp = classifyServerPath(origin, request.url, request.type);
  if (response.status >= 200 && response.status < 300) {
    if (sp.k === 'server-style') cls = 'server-style';
    else if (sp.k === 'dynamic') {
      if (isExecutableContentType(ctype) && violation === null) violation = 'content-type';
    } else if (sp.k === 'build') {
      for (const c of pool) {
        const r = mapUrl(request.url, c.core.routing, c.fileIndex, response.status, {
          basePath: origin.basePath,
        });
        if (r.kind === 'file' && r.key !== null) {
          const e = c.core.files[r.key];
          if (e !== undefined) cls = e.class as ItemClass;
          break;
        }
      }
      if (cls === null && isDocument) cls = 'document';
    }
    if (cls !== null && violation === null && !contentTypeAllowed(cls, ctype)) {
      violation = ctype !== null && !charsetOk(ctype) ? 'charset' : 'content-type';
    }
  }

  // The enforced floor and no-store on protected code and documents.
  const docLike = isDocumentType(request.type);
  // Not on a 304: Firefox copies its headers into the cached response (a CSP added here would
  // replace the vendor's) and then reports that response, which gets the floor.
  if (docLike && sp.k !== 'dynamic' && response.status !== 304) {
    const floor = cspFloor(origin, input.allowedThirdParty);
    if (floor !== null) append.push(['content-security-policy', floor]);
  }
  const codeClass =
    docLike ||
    sp.k === 'server-style' ||
    (sp.k === 'build' &&
      (request.type === 'script' ||
        request.type === 'stylesheet' ||
        request.type === 'font' ||
        request.type === 'xmlhttprequest'));
  return {action: 'allow', strip, append, noStore: codeClass && sp.k !== 'dynamic', violation};
};
