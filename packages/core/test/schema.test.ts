import {describe, expect, it} from 'vitest';
import {coreProblem, type CoreManifest} from '../src/schema/manifest.ts';
import {matchPathGlob, matchUrlPattern} from '../src/schema/profile.ts';
import {pathProblem} from '../src/schema/validate.ts';

const H = (c: string): string => c.repeat(64);
const COMMIT = '91214c3b978edb5496a32a946451960fe7d44531';

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);

describe('shared primitives', () => {
  it('pathProblem() accepts normalised absolute paths only', () => {
    for (const ok of [
      '/index.html',
      '/app/main.e6e5863d81ffec268583.js',
      '/_next/static/abc/_buildManifest.js',
      '/a%20b',
    ]) {
      expect(pathProblem(ok)).toBeNull();
    }
    for (const bad of [
      '/',
      'index.html',
      '/a?x=1',
      '/a#f',
      '/a//b',
      '/a/',
      '/a/../b',
      '/./a',
      '/a/%2e%2E/b',
      '/a/.%2e',
      '/a b',
      '/a\\b',
      '/é',
      '/a{b}',
      '/a"b',
    ]) {
      expect(pathProblem(bad), bad).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Core manifests
// ---------------------------------------------------------------------------

/** Bitwarden cloud-US core with illustrative template lengths. */
function bitwardenCloudCore(): Json {
  return {
    schema: 'intactwarden.manifest/1',
    build_id: 'bitwarden-web@2026.10.1+cloud-us',
    app: 'bitwarden-web',
    variant: 'cloud-us',
    version: {label: '2026.10.1'},
    source: {
      repo: 'https://github.com/bitwarden/clients',
      repo_id: 53538899,
      tag: 'web-v2026.10.1',
      commit: COMMIT,
    },
    artifact: {
      kind: 'github-release-asset',
      name: 'web-2026.10.1-selfhosted-COMMERCIAL.zip',
      sha256: '8ae50b7dd15c213b9ce43fbc93cd85af061d95ad0782651d80c5e68f3f3824a6',
      size: 50220770,
      root: 'build/',
    },
    derivation: {
      env: 'cloud',
      inputs: [
        {path: 'apps/web/config/base.json', commit: COMMIT, sha256: H('1')},
        {path: 'apps/web/config/cloud.json', commit: COMMIT, sha256: H('2')},
      ],
    },
    routing: {
      hosting: 'static-exact',
      base_path: '/',
      index: '/index.html',
      not_found: '/404.html',
    },
    files: {
      '/index.html': {
        class: 'document',
        template: {
          masked_sha256: H('a'),
          length_without_slots: 4609,
          parts: [{lit: 3121}, {slot: 'MAIN'}, {lit: 1488}],
        },
      },
      '/404.html': {
        sha256: 'bc6b4374b4057e451e727aa62851acff0f8ba8572b17e636aa0c41e78fd84e09',
        size: 1500,
        class: 'document',
      },
      '/app/main.{MAIN}.js': {
        class: 'script',
        template: {
          masked_sha256: H('b'),
          length_without_slots: 1834552 + 4848210 + 23104 + 7,
          parts: [
            {lit: 1834552},
            {slot: 'CACHE_TAG'},
            {lit: 4848210},
            {slot: 'CACHE_TAG'},
            {lit: 23104},
            {slot: 'MAIN'},
            {lit: 7},
          ],
        },
      },
      '/541.f38c2a08966cd91bbade.js': {
        sha256: '6abb120c1babf14b2d78a9e4f0363131b6802fbfeb7108d35f283cba5a3ad3a5',
        size: 284661,
        class: 'script',
      },
      '/edbccabf45fa994a91dc.module.wasm': {
        sha256: 'f8ce5e9bc6dbf47c04d89e07a8d54d2b7b1d44902b22cb2eb16a8e9fd04ef73d',
        size: 1000,
        class: 'wasm',
      },
      '/app/main.e6e5863d81ffec268583.js.map': {sha256: H('c'), size: 10, class: 'sourcemap'},
    },
  };
}

/** A Vaultwarden release core. */
function vaultwardenCore(): Json {
  return {
    schema: 'intactwarden.manifest/1',
    build_id: 'vaultwarden-web@2026.10.1+release',
    app: 'vaultwarden-web',
    variant: 'release',
    version: {label: '2026.10.1'},
    source: {
      repo: 'https://github.com/dani-garcia/bw_web_builds',
      repo_id: 161632059,
      tag: 'v2026.10.1',
      commit: 'f35c1cbb7b582781243d1166f5cad21f6988ab5f',
      tag_object: '878e7d7a00f5989f1d743cd0c2d7b9aa460107c5',
    },
    artifact: {
      kind: 'github-release-asset',
      name: 'bw_web_v2026.10.1.tar.gz',
      sha256: '354de9056c871e48db84975985e7d57c111ac6537bd4e4720488019e8638060f',
      size: 41793283,
      root: 'web-vault/',
    },
    routing: {hosting: 'vaultwarden-rocket', base_path: '/', index: '/index.html'},
    files: {
      '/index.html': {sha256: H('1'), size: 10, class: 'document'},
      '/404.html': {sha256: H('2'), size: 10, class: 'document'},
      '/.nojekyll': {sha256: H('3'), size: 0, class: 'data'},
    },
  };
}

function withChange(base: Json, change: (m: Json) => void): CoreManifest {
  const m = clone(base);
  change(m);
  return m as unknown as CoreManifest;
}

function files(m: Json): Json {
  return m.files as Json;
}

function templateOf(m: Json, key: string): Json {
  return (files(m)[key] as Json).template as Json;
}

describe("coreProblem (the builders' postcondition)", () => {
  it('accepts a Bitwarden cloud core and a Vaultwarden release core', () => {
    expect(coreProblem(withChange(bitwardenCloudCore(), () => {}))).toBeNull();
    expect(coreProblem(withChange(vaultwardenCore(), () => {}))).toBeNull();
  });

  const cases: [string, Json, (m: Json) => void, string][] = [
    [
      'a not_found document on vaultwarden-rocket',
      vaultwardenCore(),
      m => ((m.routing as Json).not_found = '/404.html'),
      'vaultwarden-rocket has no not_found document',
    ],
    [
      'build id of another app',
      bitwardenCloudCore(),
      m => (m.build_id = 'other-app@2026.10.1+cloud-us'),
      'build_id must be',
    ],
    [
      'build id of another variant',
      bitwardenCloudCore(),
      m => (m.build_id = 'bitwarden-web@2026.10.1+cloud-eu'),
      'build_id must be',
    ],
    [
      'build id with a suffix',
      bitwardenCloudCore(),
      m => (m.build_id = 'bitwarden-web@2026.10.1+cloud-us#x'),
      'build_id must be',
    ],
    [
      'query in a path',
      bitwardenCloudCore(),
      m => (files(m)['/x.js?v=1'] = {sha256: H('1'), size: 1, class: 'script'}),
      '"?" or "#"',
    ],
    [
      'fragment in a path',
      bitwardenCloudCore(),
      m => (files(m)['/x.js#f'] = {sha256: H('1'), size: 1, class: 'script'}),
      '"?" or "#"',
    ],
    [
      'dot segment',
      bitwardenCloudCore(),
      m => (files(m)['/a/../x.js'] = {sha256: H('1'), size: 1, class: 'script'}),
      'dot segment',
    ],
    [
      'relative path',
      bitwardenCloudCore(),
      m => (files(m)['x.js'] = {sha256: H('1'), size: 1, class: 'script'}),
      'must start with "/"',
    ],
    [
      'placeholder in an exact entry',
      bitwardenCloudCore(),
      m => (files(m)['/x.{MAIN}.js'] = {sha256: H('1'), size: 1, class: 'script'}),
      'slot MAIN is not allowed in this key',
    ],
    [
      'slot not allowlisted',
      bitwardenCloudCore(),
      m => (templateOf(m, '/index.html').parts = [{lit: 3121}, {slot: 'API_ORIGIN'}, {lit: 1488}]),
      'not allowlisted',
    ],
    [
      'template without slots',
      bitwardenCloudCore(),
      m => {
        templateOf(m, '/index.html').parts = [{lit: 4609}];
      },
      'a template needs at least one slot',
    ],
    [
      'length mismatch',
      bitwardenCloudCore(),
      m => (templateOf(m, '/index.html').length_without_slots = 4608),
      'length_without_slots',
    ],
    [
      'adjacent slots',
      bitwardenCloudCore(),
      m =>
        (templateOf(m, '/app/main.{MAIN}.js').parts = [
          {lit: 1},
          {slot: 'CACHE_TAG'},
          {slot: 'MAIN'},
          {lit: 1},
        ]),
      'alternate',
    ],
    [
      'placeholder followed by a charset byte',
      bitwardenCloudCore(),
      m => {
        files(m)['/app/main.{MAIN}a.js'] = files(m)['/app/main.{MAIN}.js'];
        delete files(m)['/app/main.{MAIN}.js'];
      },
      "outside the slot's charset",
    ],
    [
      'two placeholders in one segment',
      bitwardenCloudCore(),
      m => {
        files(m)['/app/{CACHE_TAG}.{MAIN}.js'] = files(m)['/app/main.{MAIN}.js'];
        delete files(m)['/app/main.{MAIN}.js'];
      },
      'malformed "{SLOT}" placeholder',
    ],
    [
      'placeholder whose slot is not in the template',
      bitwardenCloudCore(),
      m => (files(m)['/connectors/duo-redirect.{DUO_JS}.js'] = files(m)['/app/main.{MAIN}.js']),
      'placeholder {DUO_JS} does not occur in the template',
    ],
    [
      'slot path overlapping an exact key',
      bitwardenCloudCore(),
      m =>
        (files(m)['/app/main.e6e5863d81ffec268583.js'] = {
          sha256: H('1'),
          size: 1,
          class: 'script',
        }),
      'overlap',
    ],
    [
      'non-canonical key (encoded unreserved)',
      bitwardenCloudCore(),
      m => (files(m)['/a%41.js'] = {sha256: H('2'), size: 1, class: 'script'}),
      'not in canonical form',
    ],
    [
      'non-canonical key (lowercase hex)',
      bitwardenCloudCore(),
      m => (files(m)['/a%c4%99.js'] = {sha256: H('2'), size: 1, class: 'script'}),
      'not in canonical form',
    ],
    [
      'non-canonical key (encoded sub-delim)',
      bitwardenCloudCore(),
      m => (files(m)['/a%21.js'] = {sha256: H('2'), size: 1, class: 'script'}),
      'not in canonical form',
    ],
    [
      'non-canonical key (raw bracket)',
      bitwardenCloudCore(),
      m => (files(m)['/[id].js'] = {sha256: H('2'), size: 1, class: 'script'}),
      'not in canonical form',
    ],
    [
      'encoded slash in a key',
      bitwardenCloudCore(),
      m => (files(m)['/a%2Fb.js'] = {sha256: H('2'), size: 1, class: 'script'}),
      'encoded "/"',
    ],
    [
      'missing index',
      bitwardenCloudCore(),
      m => ((m.routing as Json).index = '/main.html'),
      '"/main.html" must be a document entry',
    ],
    [
      'a 404 body that is a script',
      bitwardenCloudCore(),
      m => ((m.routing as Json).not_found = '/541.f38c2a08966cd91bbade.js'),
      'must be a document entry',
    ],
    [
      'a hosting type this code does not model',
      bitwardenCloudCore(),
      m => ((m.routing as Json).hosting = 'cloudflare-pages'),
      'unknown hosting',
    ],
    [
      'no files at all',
      vaultwardenCore(),
      m => (m.files = {}),
      '"/index.html" must be a document entry',
    ],
  ];

  for (const [name, base, change, expected] of cases) {
    it(`rejects: ${name}`, () => {
      expect(coreProblem(withChange(base, change))).toContain(expected);
    });
  }
});

describe('profile matching helpers', () => {
  it('matchPathGlob()', () => {
    expect(matchPathGlob('/api/**', '/api/ciphers')).toBe(true);
    expect(matchPathGlob('/api/**', '/api/a/b')).toBe(true);
    expect(matchPathGlob('/api/**', '/api/')).toBe(true);
    // "**" matches zero or more segments, "*" one or more bytes.
    expect(matchPathGlob('/api/**', '/api')).toBe(true);
    expect(matchPathGlob('/*-connector.html', '/-connector.html')).toBe(false);
    expect(matchPathGlob('/*.wasm', '/.wasm')).toBe(false);
    expect(matchPathGlob('/a*b', '/ab')).toBe(false);
    expect(matchPathGlob('/a*b', '/axb')).toBe(true);
    expect(matchPathGlob('/a*b*c', '/axbyc')).toBe(true);
    expect(matchPathGlob('/a*b*c', '/abbc')).toBe(false); // each "*" needs a byte
    expect(matchPathGlob('/a*b*c', '/axbbyc')).toBe(true);
    expect(matchPathGlob('/a/*/c', '/a//c')).toBe(false);
    expect(matchPathGlob('/api/**', '/apix/a')).toBe(false);
    expect(matchPathGlob('/*-connector.html', '/sso-connector.html')).toBe(true);
    expect(matchPathGlob('/*-connector.html', '/a/sso-connector.html')).toBe(false);
    expect(matchPathGlob('/*.wasm', '/edbccabf45fa994a91dc.module.wasm')).toBe(true);
    expect(matchPathGlob('/locales/**', '/locales/en/messages.json')).toBe(true);
    expect(matchPathGlob('/**', '/')).toBe(true);
    expect(matchPathGlob('/', '/')).toBe(true);
    expect(matchPathGlob('/', '/x')).toBe(false);
    expect(matchPathGlob('/index.html', '/index.html')).toBe(true);
    expect(matchPathGlob('/index.html', '/index.htm')).toBe(false);
  });

  it('matchUrlPattern()', () => {
    expect(matchUrlPattern('https://js.stripe.com/v3*', 'https://js.stripe.com/v3/')).toBe(true);
    expect(
      matchUrlPattern(
        'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js*',
        'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1',
      ),
    ).toBe(true);
    expect(
      matchUrlPattern('https://*.duosecurity.com/*', 'https://api-1234.duosecurity.com/frame'),
    ).toBe(true);
    expect(matchUrlPattern('https://*.duosecurity.com/*', 'https://duosecurity.com/frame')).toBe(
      false,
    );
    expect(
      matchUrlPattern('https://*.duosecurity.com/*', 'https://evilduosecurity.com/frame'),
    ).toBe(false);
    expect(matchUrlPattern('https://js.stripe.com/v3*', 'https://js.stripe.com.evil.com/v3')).toBe(
      false,
    );
    expect(matchUrlPattern('https://js.stripe.com/v3*', 'http://js.stripe.com/v3')).toBe(false);
    expect(matchUrlPattern('https://js.stripe.com/v3*', 'https://js.stripe.com:8443/v3')).toBe(
      false,
    );
    expect(matchUrlPattern('https://js.stripe.com/v3*', 'https://user@js.stripe.com/v3')).toBe(
      false,
    );
    expect(
      matchUrlPattern(
        'https://api.2fa.directory/v3/totp.json',
        'https://api.2fa.directory/v3/totp.json#x',
      ),
    ).toBe(true);
    expect(
      matchUrlPattern(
        'https://api.2fa.directory/v3/totp.json',
        'https://api.2fa.directory/v3/totp.json?x',
      ),
    ).toBe(false);
    expect(matchUrlPattern('not a pattern', 'https://a.com/')).toBe(false);
    expect(matchUrlPattern('https://a.com/*', 'not a url')).toBe(false);
    // Pathological wildcard input stays fast (no exponential backtracking).
    const t0 = Date.now();
    expect(
      matchUrlPattern(`https://a.com/${'*a'.repeat(30)}b`, `https://a.com/${'a'.repeat(5000)}`),
    ).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
