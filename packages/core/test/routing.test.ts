import {describe, expect, it} from 'vitest';
import {MAX_PATH_LENGTH, normalizePath, RoutingError} from '../src/routing/normalizePath.ts';
import {createFileIndex, fileIndexOf} from '../src/routing/fileIndex.ts';
import {
  checkRoutingConfig,
  mapUrl as mapUrlRaw,
  type MapUrlOptions,
  type RouteResult as RawRouteResult,
  type RoutingConfig,
} from '../src/routing/mapUrl.ts';

/** A route result with the file lookup (`key`, `bound`) projected away. */
type RouteResult = Exclude<RawRouteResult, {kind: 'file'}> | {kind: 'file'; path: string};

/**
 * mapUrl over a set of exact keys (indexed with createFileIndex). The lookup part of a 'file'
 * result is checked here (the key is the path when listed, else null; nothing is bound) and
 * projected away, so the tables below state only the routing decision.
 */
function mapUrl(
  url: string | URL,
  routing: RoutingConfig,
  files: ReadonlySet<string>,
  status: number,
  options?: MapUrlOptions,
): RouteResult {
  const r = mapUrlRaw(
    url,
    routing,
    createFileIndex(files, () => undefined),
    status,
    options,
  );
  if (r.kind !== 'file') return r;
  expect(r.key).toBe(files.has(r.path) ? r.path : null);
  expect(r.bound).toEqual({});
  return {kind: 'file', path: r.path};
}

describe('normalizePath', () => {
  const valid: Array<[string, string]> = [
    ['/', '/'],
    ['/index.html', '/index.html'],
    ['/a/b/', '/a/b/'],
    // Unreserved escapes are decoded.
    ['/%41%62c', '/Abc'],
    ['/%7euser/a%2Djs/x%5f/file%2ejs', '/~user/a-js/x_/file.js'],
    // Escapes of sub-delims, ':' and '@' are decoded too: static servers decode
    // the whole path, so "/a%21b.js" and "/a!b.js" are one file.
    ['/%21', '/!'],
    ['/a%3a%40', '/a:@'],
    ['/x/a%40b.js', '/x/a@b.js'],
    ['/%21%24%26%27%28%29%2A%2B%2C%3B%3D', "/!$&'()*+,;="],
    // Other escapes are kept, with uppercase hex.
    ['/%c4%99', '/%C4%99'],
    ['/a%20b', '/a%20b'],
    ['/%25', '/%25'],
    // Raw characters RFC 3986 forbids in a path are encoded, so both spellings meet.
    ['/a b', '/a%20b'],
    ['/[id].js', '/%5Bid%5D.js'],
    ['/%5bid%5d.js', '/%5Bid%5D.js'],
    ['/a^b`c{d}e|f"g<h>i', '/a%5Eb%60c%7Bd%7De%7Cf%22g%3Ch%3Ei'],
    ['/zdjęcia', '/zdj%C4%99cia'],
    ['/😀', '/%F0%9F%98%80'],
    ['/%f0%9f%98%80', '/%F0%9F%98%80'],
    // Raw sub-delims, ':' and '@' are allowed as they are.
    ["/a!$&'()*+,;=:@b", "/a!$&'()*+,;=:@b"],
    // Case is preserved.
    ['/Case/MiXeD.JS', '/Case/MiXeD.JS'],
    [
      '/_next/static/5Fi8v_CHtjLINKGoeu1Bw/_buildManifest.js',
      '/_next/static/5Fi8v_CHtjLINKGoeu1Bw/_buildManifest.js',
    ],
    // Double encoding is decoded once only: a literal "%2e" segment, never a dot segment.
    ['/%252e%252e/x', '/%252e%252e/x'],
    ['/%252E', '/%252E'],
    ['/a/%252f', '/a/%252f'],
    // Dots inside names are fine.
    ['/...', '/...'],
    ['/a..b', '/a..b'],
    ['/.well-known/change-password', '/.well-known/change-password'],
  ];

  it.each(valid)('normalises %j to %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
    expect(normalizePath(expected)).toBe(expected); // idempotent
  });

  const rejected: Array<[string, string]> = [
    ['', 'start with'],
    ['a/b', 'start with'],
    ['https://example.com/', 'start with'],
    ['/%', 'malformed'],
    ['/%2', 'malformed'],
    ['/%zz', 'malformed'],
    ['/%g0', 'malformed'],
    ['/%%41', 'malformed'],
    ['/a%2Fb', 'encoded "/"'],
    ['/a%2fb', 'encoded "/"'],
    ['/..%2f', 'encoded "/"'],
    ['/a%5Cb', 'encoded "\\"'],
    ['/a%5cb', 'encoded "\\"'],
    ['/a\\b', 'backslash'],
    ['/a\\..\\b', 'backslash'],
    ['/a%00b', 'control'],
    ['/a\u0000b', 'control'],
    ['/a%0Ab', 'control'],
    ['/a\nb', 'control'],
    ['/%7F', 'control'],
    ['/a?b', '"?"'],
    ['/a#b', '"#"'],
    ['/..', 'dot segment'],
    ['/.', 'dot segment'],
    ['/a/../b', 'dot segment'],
    ['/./a', 'dot segment'],
    ['/a/.', 'dot segment'],
    ['/a/./', 'dot segment'],
    ['/%2e%2e/x', 'dot segment'],
    ['/%2E%2E/', 'dot segment'],
    ['/.%2e/x', 'dot segment'],
    ['/%2e./x', 'dot segment'],
    ['/a/%2e', 'dot segment'],
    ['/a/%2e/', 'dot segment'],
    ['//a', 'empty'],
    ['/a//b', 'empty'],
    ['/a//', 'empty'],
    ['//', 'empty'],
    // Overlong '.', lone continuation byte, truncated sequence, encoded surrogate.
    ['/%C0%AE%C0%AE/x', 'UTF-8'],
    ['/%FF', 'UTF-8'],
    ['/%80', 'UTF-8'],
    ['/%C4', 'UTF-8'],
    ['/%ED%A0%80', 'UTF-8'],
    ['/\uD800', 'surrogate'],
    ['/a\uDC00', 'surrogate'],
    ['/' + 'a'.repeat(MAX_PATH_LENGTH), 'longer'],
  ];

  it.each(rejected)('rejects %j', (input, reason) => {
    expect(() => normalizePath(input)).toThrow(RoutingError);
    expect(() => normalizePath(input)).toThrow(reason);
  });

  it('gives every spelling of one decoded path the same key', () => {
    // Every byte that may appear raw in a path, raw and percent-encoded (upper and lower hex).
    const raw = "!$&'()*+,;=:@-._~AZaz09";
    for (const ch of raw) {
      const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
      const key = normalizePath(`/a${ch}b.js`);
      expect(normalizePath(`/a%${hex}b.js`)).toBe(key);
      expect(normalizePath(`/a%${hex.toUpperCase()}b.js`)).toBe(key);
    }
    // encodeURIComponent output (Next.js chunk paths) meets the raw file name.
    const segment = "@modal+(group)[id]$x=1&y';z,!*";
    expect(normalizePath('/_next/' + encodeURIComponent(segment) + '.js')).toBe(
      normalizePath('/_next/' + segment + '.js'),
    );
  });

  it('rejects non-strings', () => {
    expect(() => normalizePath(undefined as unknown as string)).toThrow(RoutingError);
  });
});

type Case = [url: string, status: number, expected: RouteResult];

const file = (path: string): RouteResult => ({kind: 'file', path});
const notFound = (path: string): RouteResult => ({kind: 'not-found-document', path});
const outside: RouteResult = {kind: 'outside-base'};

function expectInvalid(result: RouteResult, reason: string): void {
  expect(result.kind).toBe('invalid');
  if (result.kind === 'invalid') expect(result.reason).toContain(reason);
}

describe('mapUrl: static-exact (vault.bitwarden.com, Azure Blob)', () => {
  const routing: RoutingConfig = {
    hosting: 'static-exact',
    base_path: '/',
    index: '/index.html',
    not_found: '/404.html',
  };
  const files = new Set([
    '/index.html',
    '/404.html',
    '/duo-redirect-connector.html',
    '/app/main.e6e5863d81ffec268583.js',
    '/locales/en/messages.json',
    '/Images/Logo.svg',
  ]);
  const o = 'https://vault.bitwarden.com';

  const cases: Case[] = [
    [`${o}`, 200, file('/index.html')],
    [`${o}/`, 200, file('/index.html')],
    [`${o}/index.html`, 200, file('/index.html')],
    [`${o}/?x=1`, 200, file('/index.html')],
    [`${o}/#/login`, 200, file('/index.html')],
    [`${o}/index.html?x=1#/vault`, 200, file('/index.html')],
    [`${o}/locales/en/messages.json?cache=w4e0z`, 200, file('/locales/en/messages.json')],
    [`${o}/duo-redirect-connector.html?data=abc`, 200, file('/duo-redirect-connector.html')],
    [`${o}/app/main.e6e5863d81ffec268583.js`, 304, file('/app/main.e6e5863d81ffec268583.js')],
    [`${o}/app/main.e6e5863d81ffec268583.js`, 206, file('/app/main.e6e5863d81ffec268583.js')],
    // Every 2xx carries content: a 201 or 203 body is the file's.
    [`${o}/locales/en/messages.json`, 201, file('/locales/en/messages.json')],
    [`${o}/locales/en/messages.json`, 203, file('/locales/en/messages.json')],
    [`${o}/app/main.e6e5863d81ffec268583.js`, 203, file('/app/main.e6e5863d81ffec268583.js')],
    [`${o}/does-not-exist`, 299, file('/does-not-exist')],
    [`${o}/%61pp/main.e6e5863d81ffec268583.js`, 200, file('/app/main.e6e5863d81ffec268583.js')],
    // Case preserved: a lowercased path is a different (unknown) key.
    [`${o}/Images/Logo.svg`, 200, file('/Images/Logo.svg')],
    [`${o}/images/logo.svg`, 200, file('/images/logo.svg')],
    // Unknown paths: 404 must be 404.html; a 200 maps to the path (caller: MISMATCH).
    [`${o}/does-not-exist`, 404, notFound('/404.html')],
    [`${o}/does-not-exist`, 200, file('/does-not-exist')],
    [`${o}/index.html`, 404, notFound('/404.html')],
    [`${o}/app/`, 200, file('/app/index.html')],
    // The WHATWG URL parser resolves (encoded) dot segments and '\' before the
    // request is sent, exactly as the browser does, so this is what is served.
    [`${o}/app/%2e%2e/index.html`, 200, file('/index.html')],
    [`${o}/app\\..\\index.html`, 200, file('/index.html')],
    // Double encoding stays a literal segment.
    [`${o}/app/%252e%252e/index.html`, 200, file('/app/%252e%252e/index.html')],
  ];

  it.each(cases)('%s (%i)', (url, status, expected) => {
    expect(mapUrl(url, routing, files, status)).toEqual(expected);
  });

  const invalidCases: Array<[string, number, string]> = [
    [`${o}/app%2Fmain.e6e5863d81ffec268583.js`, 200, 'encoded "/"'],
    [`${o}/app%2fmain.js`, 404, 'encoded "/"'],
    [`${o}/app%5Cmain.js`, 200, 'encoded "\\"'],
    [`${o}/a%00`, 200, 'control'],
    [`${o}/a%C0%AE%C0%AE/`, 200, 'UTF-8'],
    [`${o}//index.html`, 200, 'empty'],
    // Redirects are the header guard's.
    [`${o}/index.html`, 301, 'unexpected status 301'],
    [`${o}/`, 302, 'unexpected status 302'],
    [`${o}/`, 500, 'unexpected status 500'],
    [`${o}/`, 403, 'unexpected status 403'],
    [`${o}/`, 99, 'not an HTTP status'],
    [`${o}/`, 600, 'not an HTTP status'],
    [`${o}/`, 200.5, 'not an HTTP status'],
    ['/index.html', 200, 'not an absolute URL'],
    ['not a url', 200, 'not an absolute URL'],
    ['blob:https://vault.bitwarden.com/0b5d2c1e', 200, 'unsupported scheme'],
    ['data:text/html,<script>1</script>', 200, 'unsupported scheme'],
  ];

  it.each(invalidCases)('%s (%i) is invalid', (url, status, reason) => {
    expectInvalid(mapUrl(url, routing, files, status), reason);
  });

  it('accepts URL objects', () => {
    expect(mapUrl(new URL(`${o}/?cache=1`), routing, files, 200)).toEqual(file('/index.html'));
  });

  it('a 404 needs a declared not-found document', () => {
    const noDoc: RoutingConfig = {hosting: 'static-exact', base_path: '/', index: '/index.html'};
    expectInvalid(mapUrl(`${o}/x`, noDoc, files, 404), 'no not-found document');
    expect(mapUrl(`${o}/`, noDoc, files, 200)).toEqual(file('/index.html'));
  });
});

describe('mapUrl: bitwarden-selfhost (ASP.NET Core static files)', () => {
  const routing: RoutingConfig = {
    hosting: 'bitwarden-selfhost',
    base_path: '/vault/',
    index: '/index.html',
    not_found: '/404.html',
  };
  const files = new Set(['/index.html', '/404.html', '/app/main.js', '/docs/index.html']);
  const o = 'https://bw.example.org';

  const cases: Case[] = [
    [`${o}/vault/`, 200, file('/index.html')],
    [`${o}/vault/index.html`, 200, file('/index.html')],
    [`${o}/vault/?x=1#/login`, 200, file('/index.html')],
    [`${o}/vault/app/main.js?v=1`, 200, file('/app/main.js')],
    [`${o}/vault/nope`, 404, notFound('/404.html')],
    [`${o}/vault/nope`, 200, file('/nope')],
    [`${o}/vault/docs`, 200, file('/docs')],
    [`${o}/vault/docs/`, 200, file('/docs/index.html')],
    // Outside the base path: other apps on the origin, case-sensitive.
    [`${o}/`, 200, outside],
    [`${o}/vault`, 301, outside],
    [`${o}/Vault/`, 200, outside],
    [`${o}/vaultx/index.html`, 200, outside],
    [`${o}/admin/`, 200, outside],
    // The URL parser resolves this before it is sent: the request is /admin.
    [`${o}/vault/%2e%2e/admin`, 200, outside],
  ];

  it.each(cases)('%s (%i)', (url, status, expected) => {
    expect(mapUrl(url, routing, files, status)).toEqual(expected);
  });

  it('leaves every redirect to the header guard', () => {
    expectInvalid(mapUrl(`${o}/vault/docs`, routing, files, 301), 'unexpected status 301');
    expectInvalid(mapUrl(`${o}/vault/docs`, routing, files, 308), 'unexpected status 308');
  });

  it('works at the origin root', () => {
    const root: RoutingConfig = {...routing, base_path: '/'};
    expect(mapUrl(`${o}/`, root, files, 200)).toEqual(file('/index.html'));
    expect(mapUrl(`${o}/docs/`, root, files, 200)).toEqual(file('/docs/index.html'));
    expect(mapUrl(`${o}/app/main.js`, root, files, 200)).toEqual(file('/app/main.js'));
  });
});

describe('mapUrl: vaultwarden-rocket (Vaultwarden server, Rocket 0.5)', () => {
  const routing: RoutingConfig = {
    hosting: 'vaultwarden-rocket',
    base_path: '/',
    index: '/index.html',
  };
  const files = new Set([
    '/index.html',
    '/404.html',
    '/.nojekyll',
    '/app-id.json',
    '/sso-connector.html',
    '/app/main.1176a28a68b7b4809391.js',
    '/images/icon-white.svg',
    '/locales/en/messages.json',
  ]);
  const o = 'https://vw.example.org';
  const serverNotFound: RouteResult = {kind: 'server-not-found'};
  const missing = (path: string): RouteResult => ({kind: 'missing-file', path, key: path});

  const cases: Case[] = [
    // web_index: "/" serves index.html byte-for-byte.
    [`${o}/`, 200, file('/index.html')],
    [`${o}/?x=1#/login`, 304, file('/index.html')],
    // web_files: every other path is the file itself (Rocket answers /index.html with a 303 to
    // the base path, which the header guard allows; genuine bytes there match too).
    [`${o}/index.html`, 200, file('/index.html')],
    [`${o}/app/main.1176a28a68b7b4809391.js`, 200, file('/app/main.1176a28a68b7b4809391.js')],
    [`${o}/sso-connector.html?data=x`, 200, file('/sso-connector.html')],
    [`${o}/404.html`, 200, file('/404.html')],
    [`${o}/app-id.json`, 200, file('/app-id.json')],
    // Content for a path the build does not have (key null: the caller's MISMATCH).
    [`${o}/css/vaultwarden.css`, 200, file('/css/vaultwarden.css')],
    [`${o}/does-not-exist.js`, 200, file('/does-not-exist.js')],
    // A 404 for an unlisted path carries a server-rendered body (404.hbs).
    [`${o}/does-not-exist.js`, 404, serverNotFound],
    [`${o}/x-connector.html`, 404, serverNotFound],
    // Rocket serves every reachable listed file, so a 404 for one means the
    // served folder is not the release (the caller's MISMATCH), whatever the
    // body: an app that fetches /locales/*/messages.json would read the
    // admin's 404 template instead.
    [`${o}/app/main.1176a28a68b7b4809391.js`, 404, missing('/app/main.1176a28a68b7b4809391.js')],
    [`${o}/locales/en/messages.json`, 404, missing('/locales/en/messages.json')],
    [`${o}/404.html`, 404, missing('/404.html')],
    [`${o}/`, 404, missing('/index.html')],
    [`${o}/?x=1`, 404, missing('/index.html')],
    // Rocket never serves the empty /.nojekyll (a segment starting with "."): its 404 is misjudged
    // as a missing file, and nothing requests that file.
    [`${o}/.nojekyll`, 404, missing('/.nojekyll')],
    [`${o}/.well-known/x`, 404, serverNotFound],
    // A directory: content is not a listed file (key null), a 404 is a quiet miss.
    [`${o}/app`, 200, file('/app')],
    [`${o}/app/`, 200, file('/app/')],
    [`${o}/app`, 404, serverNotFound],
    [`${o}/locales/en/`, 404, serverNotFound],
  ];

  it.each(cases)('%s (%i)', (url, status, expected) => {
    expect(mapUrl(url, routing, files, status)).toEqual(expected);
  });

  const invalidCases: Array<[string, number, string]> = [
    [`${o}/index.html`, 303, 'unexpected status 303'],
    // Rocket collapses "//", the canonical form refuses it.
    [`${o}//app/main.1176a28a68b7b4809391.js`, 200, 'empty'],
    [`${o}/app/main.1176a28a68b7b4809391.js`, 302, 'unexpected status 302'],
    [`${o}/`, 303, 'unexpected status 303'],
    [`${o}/`, 500, 'unexpected status 500'],
  ];

  it.each(invalidCases)('%s (%i) is invalid', (url, status, reason) => {
    expectInvalid(mapUrl(url, routing, files, status), reason);
  });

  it('keeps a slot-path match a server-not-found 404 (a pattern, not a file)', () => {
    const template = {masked_sha256: 'x'};
    const slotted = fileIndexOf({
      '/index.html': {class: 'document', sha256: 'a'},
      '/app/main.{MAIN}.js': {class: 'script', template},
    });
    expect(mapUrlRaw(`${o}/app/main.1acba9cab2a37e1e33ca.js`, routing, slotted, 404)).toEqual(
      serverNotFound,
    );
    expect(mapUrlRaw(`${o}/`, routing, slotted, 404)).toEqual(missing('/index.html'));
  });

  it('works under a DOMAIN sub-path', () => {
    const opts = {basePath: '/vw/'};
    expect(mapUrl(`${o}/vw/`, routing, files, 200, opts)).toEqual(file('/index.html'));
    expect(mapUrl(`${o}/vw/index.html`, routing, files, 200, opts)).toEqual(file('/index.html'));
    expect(mapUrl(`${o}/vw/app/main.1176a28a68b7b4809391.js`, routing, files, 200, opts)).toEqual(
      file('/app/main.1176a28a68b7b4809391.js'),
    );
    expect(mapUrl(`${o}/vw/nope`, routing, files, 404, opts)).toEqual(serverNotFound);
    // Rocket also serves the index at "/vw", but relative URLs break there.
    expect(mapUrl(`${o}/vw`, routing, files, 200, opts)).toEqual(outside);
    expect(mapUrl(`${o}/admin`, routing, files, 200, opts)).toEqual(outside);
  });

  it('does not take a not_found document', () => {
    const withNotFound: RoutingConfig = {...routing, not_found: '/404.html'};
    expect(() => checkRoutingConfig(withNotFound)).toThrow('no not_found');
    expectInvalid(mapUrl(`${o}/x`, withNotFound, files, 404), 'routing config');
  });
});

describe('routing config validation', () => {
  const base: RoutingConfig = {hosting: 'static-exact', base_path: '/', index: '/index.html'};
  /** A config with a field of a hosting type the code does not model. */
  const extra = (field: string, value: unknown): RoutingConfig =>
    ({...base, [field]: value}) as unknown as RoutingConfig;

  const bad: Array<[string, RoutingConfig]> = [
    ['unknown hosting', {...base, hosting: 'apache' as RoutingConfig['hosting']}],
    [
      'another hosting type the code does not model',
      {...base, hosting: 'cloudflare-pages' as RoutingConfig['hosting']},
    ],
    ['base_path without trailing slash', {...base, base_path: '/vault'}],
    ['relative base_path', {...base, base_path: 'vault/'}],
    ['base_path with dot segment', {...base, base_path: '/%2e%2e/'}],
    ['base_path with empty segment', {...base, base_path: '/a//'}],
    ['non-canonical base_path', {...base, base_path: '/%7evault/'}],
    ['directory index', {...base, index: '/'}],
    ['relative index', {...base, index: 'index.html'}],
    ['non-canonical not_found', {...base, not_found: '/%34%30%34.html'}],
    ['an SPA fallback', extra('spa_fallback', '/index.html')],
    [
      'an SPA fallback on bitwarden-selfhost',
      {...extra('spa_fallback', '/index.html'), hosting: 'bitwarden-selfhost'},
    ],
    ['try_files', extra('try_files', ['$uri'])],
    ['pages_rules', extra('pages_rules', [])],
  ];

  it.each(bad)('rejects %s', (_name, routing) => {
    expect(() => checkRoutingConfig(routing)).toThrow(RoutingError);
    expectInvalid(
      mapUrl('https://example.com/', routing, new Set(['/index.html']), 200),
      'routing config',
    );
  });

  it('never throws on malformed input', () => {
    const files = new Set(['/index.html']);
    expectInvalid(
      mapUrl('https://example.com/', null as unknown as RoutingConfig, files, 200),
      'routing config',
    );
    expectInvalid(
      mapUrl('https://example.com/', extra('try_files', 7), files, 200),
      'routing config',
    );
  });

  it('accepts the configs used above', () => {
    expect(() => checkRoutingConfig(base)).not.toThrow();
    expect(() => checkRoutingConfig({...base, not_found: '/404.html'})).not.toThrow();
    expect(() =>
      checkRoutingConfig({
        hosting: 'bitwarden-selfhost',
        base_path: '/vault/',
        index: '/index.html',
      }),
    ).not.toThrow();
  });
});
