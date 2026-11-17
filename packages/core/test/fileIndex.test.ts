import {describe, expect, it} from 'vitest';
import {
  createFileIndex,
  fileIndexOf,
  keysMayOverlap,
  matchKey,
  parseKey,
  placeholderNames,
  type ParsedKey,
  type SlotResolver,
} from '../src/routing/fileIndex.ts';
import {mapUrl, type RoutingConfig} from '../src/routing/mapUrl.ts';
import {RoutingError} from '../src/routing/normalizePath.ts';
import {getSlotSpec} from '../src/template/slots.ts';

const bitwarden: SlotResolver = (_key, slot) => getSlotSpec(slot);

function parsed(key: string, resolve: SlotResolver = bitwarden): ParsedKey {
  const p = parseKey(key, resolve);
  if (typeof p === 'string') throw new Error(p);
  return p;
}

const MAIN = '1acba9cab2a37e1e33ca';
const DUO = '25df43e178f0cf2fa02e';

describe('slot paths', () => {
  it('lists placeholder names and rejects malformed braces', () => {
    expect(placeholderNames('/app/main.{MAIN}.js')).toEqual(['MAIN']);
    expect(placeholderNames('/a/{MAIN}/b.{DUO_JS}.js')).toEqual(['MAIN', 'DUO_JS']);
    expect(placeholderNames('/plain.js')).toEqual([]);
    for (const bad of [
      '/a{MAIN}{DUO_JS}.js',
      '/a{MAIN.js',
      '/a}MAIN{.js',
      '/a{main}.js',
      '/a{}.js',
      '/a{MAIN}}.js',
      '/a{{MAIN}.js',
    ]) {
      expect(placeholderNames(bad), bad).toBeNull();
    }
  });

  it('parses keys and refuses slots that cannot be bound from a path', () => {
    expect(parsed('/app/main.{MAIN}.js').segments).toHaveLength(2);
    expect(parseKey('/app/main.{NOPE}.js', bitwarden)).toContain('not allowed');
    // The byte after the placeholder must end the value unambiguously.
    expect(parseKey('/app/main.{MAIN}a.js', bitwarden)).toContain('outside');
    expect(parseKey('/app/{CACHE_TAG}0.js', bitwarden)).toContain('outside');
    expect(parseKey('app/{MAIN}.js', bitwarden)).toContain('start with');
  });

  it('matches and binds, honouring charset and length bounds', () => {
    const main = parsed('/app/main.{MAIN}.js');
    expect(matchKey(main, `/app/main.${MAIN}.js`)).toEqual({MAIN});
    expect(matchKey(main, `/app/main.${MAIN}0.js`)).toBeNull(); // 21 hex
    expect(matchKey(main, `/app/main.${MAIN.slice(1)}.js`)).toBeNull(); // 19 hex
    expect(matchKey(main, `/app/main.${MAIN.toUpperCase()}.js`)).toBeNull();
    expect(matchKey(main, `/app/main.${MAIN}.js.map`)).toBeNull();
    expect(matchKey(main, `/app/x/main.${MAIN}.js`)).toBeNull();
    expect(matchKey(main, `/App/main.${MAIN}.js`)).toBeNull();
    const tag = parsed('/t/{CACHE_TAG}');
    expect(matchKey(tag, '/t/w4e0z')).toEqual({CACHE_TAG: 'w4e0z'});
    expect(matchKey(tag, '/t/')).toBeNull();
    expect(matchKey(tag, '/t/abcdefghijkl')).toBeNull(); // 12 > 11
  });

  it('requires one value for a slot that occurs twice', () => {
    const twice = parsed('/{MAIN}/main.{MAIN}.js');
    expect(matchKey(twice, `/${MAIN}/main.${MAIN}.js`)).toEqual({MAIN});
    expect(matchKey(twice, `/${MAIN}/main.${DUO}.js`)).toBeNull();
  });

  it('detects keys that one request path could match', () => {
    const k = (key: string) => parsed(key);
    expect(keysMayOverlap(k('/app/main.{MAIN}.js'), k('/app/main.{DUO_JS}.js'))).toBe(true);
    expect(keysMayOverlap(k('/app/main.{MAIN}.js'), k(`/app/main.${MAIN}.js`))).toBe(true);
    expect(keysMayOverlap(k('/app/main.{MAIN}.js'), k('/app/vendor.{DUO_JS}.js'))).toBe(false);
    expect(keysMayOverlap(k('/app/main.{MAIN}.js'), k('/app/main.{DUO_JS}.css'))).toBe(false);
    expect(keysMayOverlap(k('/a/{MAIN}.js'), k('/a/b/{MAIN}.js'))).toBe(false);
    expect(keysMayOverlap(k('/a/m{MAIN}.js'), k('/a/{DUO_JS}.js'))).toBe(true); // conservative
  });
});

describe('createFileIndex', () => {
  const keys = [
    '/index.html',
    '/404.html',
    '/app/main.{MAIN}.js',
    '/connectors/duo-redirect.{DUO_JS}.js',
    '/app/vendor.9515864ec4d3ce1acf45.js',
  ];

  it('looks up exact keys and slot paths', () => {
    const index = createFileIndex(keys, bitwarden);
    expect(index.lookup('/index.html')).toEqual({key: '/index.html', bound: {}});
    expect(index.lookup(`/app/main.${MAIN}.js`)).toEqual({
      key: '/app/main.{MAIN}.js',
      bound: {MAIN},
    });
    expect(index.lookup(`/connectors/duo-redirect.${DUO}.js`)).toEqual({
      key: '/connectors/duo-redirect.{DUO_JS}.js',
      bound: {DUO_JS: DUO},
    });
    // The placeholder key itself is not a request path.
    expect(index.lookup('/app/main.{MAIN}.js')).toBeNull();
    expect(index.lookup('/app/main.js')).toBeNull();
  });

  it('refuses malformed slot paths and overlapping keys', () => {
    expect(() => createFileIndex(['/a.{NOPE}.js'], bitwarden)).toThrow(RoutingError);
    expect(() => createFileIndex(['/app/main.{MAIN}.js'], () => undefined)).toThrow(RoutingError);
    expect(() =>
      createFileIndex(['/app/main.{MAIN}.js', `/app/main.${MAIN}.js`], bitwarden),
    ).toThrow('overlap');
    expect(() =>
      createFileIndex(['/app/main.{MAIN}.js', '/app/main.{DUO_JS}.js'], bitwarden),
    ).toThrow('overlap');
  });

  it('allows placeholders only in template keys, with allowlisted slots (fileIndexOf)', () => {
    const template = {masked_sha256: 'x'};
    expect(
      fileIndexOf({'/app/main.{MAIN}.js': {class: 'script', template}}).lookup(
        `/app/main.${MAIN}.js`,
      ),
    ).toEqual({key: '/app/main.{MAIN}.js', bound: {MAIN}});
    expect(() => fileIndexOf({'/app/main.{MAIN}.js': {class: 'script', sha256: 'x'}})).toThrow(
      RoutingError,
    );
    // A slot outside the closed allowlist is refused even in a template key.
    expect(() => fileIndexOf({'/app/main.{EVIL}.js': {class: 'script', template}})).toThrow(
      RoutingError,
    );
  });
});

describe('mapUrl with slot paths (Bitwarden cloud core)', () => {
  const routing: RoutingConfig = {
    hosting: 'static-exact',
    base_path: '/',
    index: '/index.html',
    not_found: '/404.html',
  };
  const template = {masked_sha256: 'x'};
  const index = fileIndexOf({
    '/index.html': {class: 'document', template},
    '/404.html': {class: 'document', sha256: 'a'},
    '/app/main.{MAIN}.js': {class: 'script', template},
    '/connectors/duo-redirect.{DUO_JS}.js': {class: 'script', template},
  });
  const o = 'https://vault.bitwarden.com';

  it('binds MAIN from the request path', () => {
    expect(mapUrl(`${o}/app/main.${MAIN}.js?x=1`, routing, index, 200)).toEqual({
      kind: 'file',
      path: `/app/main.${MAIN}.js`,
      key: '/app/main.{MAIN}.js',
      bound: {MAIN},
    });
    expect(mapUrl(`${o}/connectors/duo-redirect.${DUO}.js`, routing, index, 200)).toMatchObject({
      key: '/connectors/duo-redirect.{DUO_JS}.js',
      bound: {DUO_JS: DUO},
    });
  });

  it('reports an unlisted path with key null', () => {
    expect(mapUrl(`${o}/app/main.${MAIN}0.js`, routing, index, 200)).toEqual({
      kind: 'file',
      path: `/app/main.${MAIN}0.js`,
      key: null,
      bound: {},
    });
    expect(mapUrl(`${o}/app/main.${MAIN}0.js`, routing, index, 404)).toEqual({
      kind: 'not-found-document',
      path: '/404.html',
    });
  });

  it('takes the base path from the deployment', () => {
    const selfhost: RoutingConfig = {...routing, hosting: 'bitwarden-selfhost'};
    const s = 'https://bw.example.org';
    expect(
      mapUrl(`${s}/vault/app/main.${MAIN}.js`, selfhost, index, 200, {basePath: '/vault/'}),
    ).toMatchObject({key: '/app/main.{MAIN}.js', bound: {MAIN}});
    expect(mapUrl(`${s}/app/main.${MAIN}.js`, selfhost, index, 200, {basePath: '/vault/'})).toEqual(
      {kind: 'outside-base'},
    );
    expect(mapUrl(`${s}/vault/`, selfhost, index, 200, {basePath: 'vault'})).toMatchObject({
      kind: 'invalid',
    });
    // A hosting type that is not modelled is refused whatever the base path.
    expect(
      mapUrl(
        `${s}/x/`,
        {...routing, hosting: 'cloudflare-pages' as RoutingConfig['hosting']},
        index,
        200,
        {basePath: '/x/'},
      ),
    ).toMatchObject({kind: 'invalid'});
  });
});
