/**
 * The pure verification kernel (extension/src/policy): classification, binding, item verification,
 * header guard, evaluation (R2, R5, R6, R13, green requirements, document actions, taint sources)
 * and the CSP floor.
 */

import {describe, expect, it} from 'vitest';
import type {
  DocumentSessionRecord,
  EvaluateInput,
  HeadersObs,
  ItemOutcome,
  ItemRecord,
  ProtectedOrigin,
  RequestObs,
} from '../../src/contracts.ts';
import {newSession} from '../../src/engine/sessions.ts';
import {bindDocument} from '../../src/policy/bind.ts';
import {classifyServerPath} from '../../src/policy/classify.ts';
import {itemContribution} from '../../src/policy/contribution.ts';
import {cspFloor} from '../../src/policy/cspFloor.ts';
import {decisionFor, evaluateSession} from '../../src/policy/evaluate.ts';
import {contentTypeAllowed, headerGuard} from '../../src/policy/headerGuard.ts';
import {taintSourceClass} from '../../src/policy/taint.ts';
import {verifyItem} from '../../src/policy/verifyItem.ts';
import {
  BW_ORIGIN,
  bwCloudOrigin,
  bwSelfhostCore,
  bwSelfhostOrigin,
  bytes,
  sha,
  VW_ORIGIN,
  vwCore,
  vwOrigin,
} from '../engine/helpers/world.ts';

const INDEX = bytes(
  '<html><script src="app/main.0123456789abcdef0123.js"></script><link href="styles.0123456789abcdef0123.css"></html>',
);
const MAIN = bytes('main()');
const MAIN_PATH = '/app/main.0123456789abcdef0123.js';
const core = vwCore('2026.10.1', {'/index.html': INDEX, [MAIN_PATH]: MAIN});
const po = vwOrigin();

const req = (url: string, type: RequestObs['type'], doc = 'd1'): RequestObs => ({
  k: 'request',
  at: 0,
  req: 'r1',
  doc,
  tab: 1,
  frame: 0,
  url,
  type,
});
const hdrs = (status: number, headers: [string, string][]): HeadersObs => ({
  req: 'r1',
  status,
  headers,
});

describe('classifyServerPath', () => {
  it('server stylesheet, dynamic, not covered, server-rendered, build, outside, cross-origin', () => {
    expect(classifyServerPath(po, `${VW_ORIGIN}/css/vaultwarden.css`, 'stylesheet').k).toBe(
      'server-style',
    );
    expect(classifyServerPath(po, `${VW_ORIGIN}/api/sync`, 'xmlhttprequest').k).toBe('dynamic');
    expect(classifyServerPath(po, `${VW_ORIGIN}/vw_static/admin.js`, 'script').k).toBe(
      'not-covered',
    );
    expect(classifyServerPath(po, `${VW_ORIGIN}/admin`, 'main_frame')).toEqual({
      k: 'server-rendered',
      class: 'admin-portal',
    });
    expect(classifyServerPath(po, `${VW_ORIGIN}/identity/connect/authorize`, 'main_frame')).toEqual(
      {
        k: 'server-rendered',
        class: 'auth-flow',
      },
    );
    expect(classifyServerPath(po, `${VW_ORIGIN}/identity/connect/token`, 'xmlhttprequest').k).toBe(
      'dynamic',
    );
    expect(classifyServerPath(po, `${VW_ORIGIN}${MAIN_PATH}`, 'script').k).toBe('build');
    expect(classifyServerPath({...po, basePath: '/vw/'}, `${VW_ORIGIN}/other`, 'script').k).toBe(
      'outside-base',
    );
    expect(classifyServerPath(po, 'https://cdn.example/x.js', 'script').k).toBe('cross-origin');
  });
});

describe('bindDocument', () => {
  const body = (b: Uint8Array) => ({sha256: sha(b), size: b.length, bytes: b});
  it('binds exactly', async () => {
    const r = await bindDocument({
      origin: po,
      url: `${VW_ORIGIN}/`,
      status: 200,
      body: body(INDEX),
      candidates: [core],
      now: 5,
    });
    expect(r.k).toBe('bound');
    if (r.k === 'bound')
      expect(r.binding).toMatchObject({
        key: '/index.html',
        variant: 'release',
        retro: false,
        boundAt: 5,
      });
  });
  it('unbound bytes at a manifest path report differsAtManifestPath', async () => {
    const r = await bindDocument({
      origin: po,
      url: `${VW_ORIGIN}/`,
      status: 200,
      body: body(bytes('<x>')),
      candidates: [core],
      now: 0,
    });
    expect(r).toMatchObject({
      k: 'unbound',
      tried: [{buildId: core.ref.buildId, differsAtManifestPath: true}],
    });
  });
  it('a Rocket 404 navigation is an unknown document (invalid); a subresource path as a document is invalid', async () => {
    const r404 = await bindDocument({
      origin: po,
      url: `${VW_ORIGIN}/nope`,
      status: 404,
      body: body(bytes('x')),
      candidates: [core],
      now: 0,
    });
    expect(r404.k).toBe('invalid');
    const rJs = await bindDocument({
      origin: po,
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      status: 200,
      body: body(MAIN),
      candidates: [core],
      now: 0,
    });
    expect(rJs.k).toBe('invalid');
  });
  it('only a document path takes part in unknown-build resolution', async () => {
    const bind = (origin: typeof po, url: string, status: number, b: Uint8Array, c = [core]) =>
      bindDocument({origin, url, status, body: body(b), candidates: c, now: 0});
    // Vaultwarden: paths outside the manifest answered with content are unknown documents.
    for (const p of ['/evil.html', '/app/', '/.x/evil.html', '/totally/unknown']) {
      expect((await bind(po, `${VW_ORIGIN}${p}`, 200, bytes('<html>x</html>'))).k, p).toBe(
        'invalid',
      );
    }
    // A declared document path (identify.documents) with other bytes, also with no candidate at all.
    expect((await bind(po, `${VW_ORIGIN}/`, 200, bytes('<x>'))).k).toBe('unbound');
    // /index.html is the index document itself, like "/" (Rocket redirects it; genuine bytes bind).
    expect((await bind(po, `${VW_ORIGIN}/index.html`, 200, bytes('<x>'))).k).toBe('unbound');
    expect((await bind(po, `${VW_ORIGIN}/index.html`, 200, INDEX)).k).toBe('bound');
    expect((await bind(po, `${VW_ORIGIN}/`, 200, bytes('<x>'), [])).k).toBe('unbound');
    // ... but not answered with an error page (a 502 from a proxy).
    expect((await bind(po, `${VW_ORIGIN}/`, 502, bytes('<html>bad gateway</html>'))).k).toBe(
      'invalid',
    );
    // Self-hosted Bitwarden: a 404 binds only with the build's not-found document.
    const NF = bytes('<html>build 404</html>');
    const bw = bwSelfhostCore('2026.10.1', {
      '/index.html': {bytes: INDEX},
      '/404.html': {bytes: NF},
    });
    const bwo = bwSelfhostOrigin();
    const missing = `${BW_ORIGIN}/old-bookmark`;
    expect(await bind(bwo, missing, 404, NF, [bw])).toMatchObject({
      k: 'bound',
      binding: {key: '/404.html'},
    });
    for (const b of [bytes('<html><h1>404 Not Found</h1>nginx</html>'), new Uint8Array(0)]) {
      expect((await bind(bwo, missing, 404, b, [bw])).k).toBe('invalid');
    }
    // A document key of the core with other bytes is evidence about the build.
    expect(await bind(bwo, `${BW_ORIGIN}/`, 200, bytes('<x>'), [bw])).toMatchObject({
      k: 'unbound',
      tried: [{differsAtManifestPath: true}],
    });
  });
  it('never binds a core of another profile', async () => {
    const r = await bindDocument({
      origin: bwCloudOrigin(),
      url: 'https://vault.bitwarden.com/',
      status: 200,
      body: body(INDEX),
      candidates: [core],
      now: 0,
    });
    expect(r.k).toBe('unbound');
  });
});

describe('verifyItem', () => {
  const binding = {
    buildId: core.ref.buildId,
    app: core.ref.app,
    variant: core.ref.variant,
    version: core.ref.version,
    assurance: core.ref.assurance,
    coreSha256: core.ref.sha256,
    source: core.ref.source,
    key: '/index.html',
    slots: {},
    boundAt: 0,
    retro: false,
  };
  const run = (
    url: string,
    type: RequestObs['type'],
    b: Uint8Array | null,
    headers: [string, string][],
    status = 200,
  ) =>
    verifyItem({
      origin: po,
      core,
      binding,
      request: req(url, type),
      status,
      headers,
      body: b === null ? null : {sha256: sha(b), size: b.length, bytes: b},
      allowedThirdParty: null,
      now: 0,
    });
  const JS: [string, string][] = [['content-type', 'text/javascript']];
  it('exact ok and mismatch', async () => {
    expect((await run(`${VW_ORIGIN}${MAIN_PATH}`, 'script', MAIN, JS)).outcome).toEqual({
      r: 'ok',
      how: 'exact',
    });
    expect((await run(`${VW_ORIGIN}${MAIN_PATH}`, 'script', bytes('x'), JS)).outcome).toEqual({
      r: 'mismatch',
      reason: 'bytes',
    });
  });
  it('unknown active path → MISMATCH unknown-path; wrong content type → header', async () => {
    expect((await run(`${VW_ORIGIN}/app/evil.js`, 'script', MAIN, JS)).outcome).toEqual({
      r: 'mismatch',
      reason: 'unknown-path',
    });
    expect(
      (await run(`${VW_ORIGIN}${MAIN_PATH}`, 'script', MAIN, [['content-type', 'text/html']]))
        .outcome,
    ).toEqual({
      r: 'mismatch',
      reason: 'header',
    });
  });
  it('dynamic paths: data is passive; executable content type or script request is MISMATCH', async () => {
    expect(
      (
        await run(`${VW_ORIGIN}/api/sync`, 'xmlhttprequest', bytes('{}'), [
          ['content-type', 'application/json'],
        ])
      ).outcome.r,
    ).toBe('passive');
    expect(
      (
        await run(`${VW_ORIGIN}/api/x`, 'xmlhttprequest', bytes('x'), [
          ['content-type', 'text/javascript'],
        ])
      ).outcome,
    ).toEqual({
      r: 'mismatch',
      reason: 'header',
    });
    expect((await run(`${VW_ORIGIN}/api/x.js`, 'script', bytes('x'), JS)).outcome).toEqual({
      r: 'mismatch',
      reason: 'unknown-path',
    });
  });
  it('a self-hosted /app-id.json stays a dynamic path although the release core lists it', async () => {
    const release = bytes('{"trustedFacets":[]}');
    const served = bytes('{"trustedFacets":[{"ids":["https://vault.example.org"]}]}');
    const origins = [
      [po, VW_ORIGIN, vwCore('2026.10.1', {'/index.html': INDEX, '/app-id.json': release})],
      [
        bwSelfhostOrigin(),
        BW_ORIGIN,
        bwSelfhostCore('2026.10.1', {
          '/index.html': {bytes: INDEX},
          '/app-id.json': {bytes: release},
        }),
      ],
    ] as const;
    for (const [origin, at, listing] of origins) {
      const check = (type: RequestObs['type'], b: Uint8Array) =>
        verifyItem({
          origin,
          core: listing,
          binding,
          request: req(`${at}/app-id.json`, type),
          status: 200,
          headers: [['content-type', 'application/json']],
          body: {sha256: sha(b), size: b.length, bytes: b},
          allowedThirdParty: null,
          now: 0,
        });
      expect((await check('xmlhttprequest', served)).outcome, at).toEqual({r: 'passive'});
      expect((await check('script', release)).outcome, at).toEqual({
        r: 'mismatch',
        reason: 'unknown-path',
      });
    }
  });
  it('server paths: active content is MISMATCH unknown-path, data is passive', async () => {
    // Hashing is the only thing that stops a same-origin script the floor (script-src 'self')
    // allows: not covered, server-rendered, outside the base path, the server stylesheet path.
    const css: [string, string][] = [['content-type', 'text/css']];
    const json: [string, string][] = [['content-type', 'application/json']];
    const cases: [string, RequestObs['type'], [string, string][]][] = [
      ['/vw_static/x.js', 'script', JS],
      ['/vw_static/x.css', 'stylesheet', css],
      ['/admin/x.js', 'script', JS],
      ['/css/vaultwarden.css', 'script', css],
      ['/css/vaultwarden.css', 'font', css],
      ['/css/vaultwarden.css', 'object', css],
    ];
    for (const [path, type, h] of cases) {
      expect((await run(`${VW_ORIGIN}${path}`, type, bytes('x'), h)).outcome, path).toEqual({
        r: 'mismatch',
        reason: 'unknown-path',
      });
    }
    expect(
      (await run(`${VW_ORIGIN}/vw_static/x.json`, 'xmlhttprequest', bytes('{}'), json)).outcome,
    ).toEqual({r: 'passive'});
    const outside = {...po, basePath: '/vw/'};
    const item = await verifyItem({
      origin: outside,
      core,
      binding,
      request: req(`${VW_ORIGIN}/other/x.js`, 'script'),
      status: 200,
      headers: JS,
      body: {sha256: sha(MAIN), size: MAIN.length, bytes: MAIN},
      allowedThirdParty: null,
      now: 0,
    });
    expect(item.outcome).toEqual({r: 'mismatch', reason: 'unknown-path'});
  });
  it('server stylesheet: accepted or UNVERIFIED_STYLE', async () => {
    const css: [string, string][] = [['content-type', 'text/css']];
    expect(
      (await run(`${VW_ORIGIN}/css/vaultwarden.css`, 'stylesheet', bytes(''), css)).outcome,
    ).toEqual({r: 'ok', how: 'style-accepted'});
    expect(
      (await run(`${VW_ORIGIN}/css/vaultwarden.css`, 'stylesheet', bytes('body{color:red}'), css))
        .outcome,
    ).toMatchObject({
      r: 'style-rejected',
    });
  });
  it('a Rocket 404 for a listed file is MISMATCH; for an unlisted one non-executing', async () => {
    expect(
      (await run(`${VW_ORIGIN}${MAIN_PATH}`, 'script', bytes('404'), JS, 404)).outcome,
    ).toEqual({r: 'mismatch', reason: 'bytes'});
    expect((await run(`${VW_ORIGIN}/app/x.js`, 'script', bytes('404'), JS, 404)).outcome.r).toBe(
      'non-executing',
    );
  });
  it('an unknown cross-origin script is MISMATCH; an unverifiable active item is PROTECTION_LOST', async () => {
    const item = await run('https://cdn.example/x.js', 'script', bytes('x'), JS);
    expect(item.outcome).toEqual({r: 'mismatch', reason: 'unknown-path'});
    const unverifiable: ItemRecord = {
      ...item,
      cls: 'script',
      outcome: {r: 'unverifiable', reason: 'empty-body'},
    };
    expect(itemContribution(unverifiable, null)).toMatchObject({
      state: 'PROTECTION_LOST',
      reason: 'unverifiable-active',
    });
    expect(
      itemContribution({...unverifiable, outcome: {r: 'unverifiable', reason: 'sw-served'}}, null),
    ).toMatchObject({state: 'PROTECTION_LOST', reason: 'sw-served'});
    expect(itemContribution({...unverifiable, cls: 'image'}, null)).toBeNull();
  });
});

describe('verifyItem: a listed file needs its bytes whatever the status', () => {
  const LOCALE = bytes('{"login":{"message":"Log in"}}');
  const WASM = bytes('\0asm-genuine');
  const NF = bytes('<html>404</html>');
  const EVIL = bytes('{"login":{"message":"Type your master password at evil.example"}}');
  const files = {'/index.html': INDEX, [MAIN_PATH]: MAIN, '/locales/en/messages.json': LOCALE};
  const bw = bwSelfhostCore('2026.10.1', {
    ...Object.fromEntries(Object.entries(files).map(([k, b]) => [k, {bytes: b}])),
    '/app/crypto.wasm': {bytes: WASM},
    '/404.html': {bytes: NF},
  });
  const vw = vwCore('2026.10.1', {...files, '/app/crypto.wasm': WASM});
  const hostings = [
    {name: 'vaultwarden-rocket', po: vwOrigin(), at: VW_ORIGIN, core: vw},
    {name: 'bitwarden-selfhost', po: bwSelfhostOrigin(), at: BW_ORIGIN, core: bw},
    {
      name: 'static-exact',
      po: bwSelfhostOrigin(),
      at: BW_ORIGIN,
      core: {...bw, core: {...bw.core, routing: {...bw.core.routing, hosting: 'static-exact'}}},
    },
  ] as const;
  const kinds = [
    ['data', 'xmlhttprequest', '/locales/en/messages.json', 'application/json'],
    ['wasm', 'xmlhttprequest', '/app/crypto.wasm', 'application/wasm'],
    ['script', 'script', MAIN_PATH, 'text/javascript'],
  ] as const;
  const item = (
    h: (typeof hostings)[number],
    type: RequestObs['type'],
    path: string,
    ctype: string,
    status: number,
    b: Uint8Array,
  ) =>
    verifyItem({
      origin: h.po,
      core: h.core as typeof vw,
      binding: {
        buildId: h.core.ref.buildId,
        app: h.core.ref.app,
        variant: h.core.ref.variant,
        version: h.core.ref.version,
        assurance: h.core.ref.assurance,
        coreSha256: h.core.ref.sha256,
        source: h.core.ref.source,
        key: '/index.html',
        slots: {},
        boundAt: 0,
        retro: false,
      },
      request: req(`${h.at}${path}`, type),
      status,
      headers: [['content-type', ctype]],
      body: {sha256: sha(b), size: b.length, bytes: b},
      allowedThirdParty: null,
      now: 0,
    });
  it.each(hostings.flatMap(h => kinds.map(k => [h.name, ...k] as const)))(
    '%s, listed %s file served tampered',
    async (name, cls, type, path, ctype) => {
      const h = hostings.find(x => x.name === name)!;
      for (const status of [200, 201, 203, 204, 206, 304, 400, 404, 500]) {
        const o = (await item(h, type, path, ctype, status, EVIL)).outcome;
        // A server error on a script stays unverifiable (browsers run no
        // script from a non-ok response); everything else with a body that is not the file's is a
        // MISMATCH, never released as passive. A `.wasm` fetched by fetch() is data the page reads
        // and instantiates whatever the status.
        const expected =
          cls === 'script' && status >= 400 && status !== 404
            ? {r: 'unverifiable', reason: 'internal-error'}
            : {r: 'mismatch', reason: 'bytes'};
        expect(o, `${name} ${cls} ${status}`).toEqual(expected);
      }
    },
  );
  it('exceptions: an empty error body, and a 404 that is the declared not-found document', async () => {
    for (const h of hostings) {
      const o = await item(
        h,
        'xmlhttprequest',
        '/locales/en/messages.json',
        'text/html',
        500,
        bytes(''),
      );
      expect(o.outcome, h.name).toEqual({r: 'non-executing'});
    }
    for (const h of hostings.slice(1)) {
      const o = await item(h, 'xmlhttprequest', '/locales/en/messages.json', 'text/html', 404, NF);
      expect(o.outcome, h.name).toEqual({r: 'non-executing'});
    }
    // An unlisted path answered with an error body stays non-executing data.
    const o = await item(
      hostings[1],
      'xmlhttprequest',
      '/locales/xx/messages.json',
      'text/html',
      404,
      EVIL,
    );
    expect(o.outcome).toEqual({r: 'non-executing'});
    // An unlisted `.wasm` keeps the suffix test: active, so an error body is unverifiable, never
    // released as passive data.
    for (const h of hostings) {
      const w = await item(h, 'xmlhttprequest', '/app/other.wasm', 'text/html', 500, EVIL);
      expect(w.outcome, h.name).toEqual({r: 'unverifiable', reason: 'internal-error'});
    }
  });
});

describe('headerGuard', () => {
  const g = (status: number, headers: [string, string][], type: RequestObs['type'] = 'script') =>
    headerGuard({
      origin: po,
      request: req(`${VW_ORIGIN}${type === 'main_frame' ? '/' : MAIN_PATH}`, type),
      response: hdrs(status, headers),
      isDocument: type === 'main_frame',
      candidates: [core],
      binding: null,
      allowedThirdParty: null,
    });
  it('cancels Refresh and a cross-origin Location; strips every Link header without parsing it', () => {
    expect(g(200, [['refresh', '0']])).toMatchObject({action: 'cancel', violation: 'refresh'});
    expect(g(302, [['location', 'https://evil.example/']])).toMatchObject({
      action: 'cancel',
      violation: 'location',
    });
    // A hostile target, a listed file, and values a hand-written parser could split differently
    // from Firefox: all removed, none raises a violation.
    for (const link of [
      '<https://evil.example/x.css>; rel=stylesheet',
      `<${MAIN_PATH}>; rel=preload`,
      '</listed.js>x", <https://evil.example/x.css>; rel=stylesheet; y="',
      'garbage',
    ]) {
      for (const type of ['script', 'main_frame'] as const) {
        const r = g(
          200,
          [
            ['content-type', 'text/javascript'],
            ['link', link],
          ],
          type,
        );
        expect(r.strip, link).toContain('link');
        expect(r.violation === 'content-type' || r.violation === null, link).toBe(true);
        expect(r.action, link).toBe('allow');
      }
    }
  });
  it('allows a same-origin navigation redirect to exactly the base path; a CSP sandbox is no violation', () => {
    const redirect = (
      origin: ProtectedOrigin,
      path: string,
      location: string,
      type: RequestObs['type'] = 'main_frame',
    ) =>
      headerGuard({
        origin,
        request: req(`${VW_ORIGIN}${path}`, type),
        response: hdrs(path === '/index.html' ? 303 : 301, [['location', location]]),
        isDocument: type === 'main_frame' || type === 'sub_frame',
        candidates: [core],
        binding: null,
        allowedThirdParty: null,
      }).action;
    // Rocket's 303 from /index.html to the base path, with a query and fragment.
    expect(redirect(po, '/index.html', '/')).toBe('allow');
    expect(redirect(po, '/index.html', '/?x=1#/login')).toBe('allow');
    // A reverse proxy's 301 from a sub-path typed without its trailing slash.
    const sub: ProtectedOrigin = {...po, basePath: '/vw/'};
    expect(redirect(sub, '/vw', '/vw/')).toBe('allow');
    expect(redirect(sub, '/vw', `${VW_ORIGIN}/vw/#/login`)).toBe('allow');
    // Anything else stays cancelled: another path, another origin, the origin root of a sub-path
    // instance, and every subresource redirect.
    expect(redirect(po, '/index.html', '/evil.html')).toBe('cancel');
    expect(redirect(po, '/index.html', 'https://evil.example/')).toBe('cancel');
    expect(redirect(sub, '/vw', '/')).toBe('cancel');
    expect(redirect(sub, '/vw', '/vw/x')).toBe('cancel');
    expect(redirect(po, MAIN_PATH, '/', 'script')).toBe('cancel');
    // A server-rendered page redirects like any server does (the admin portal to its login page):
    // a same-origin target is judged on its own; another origin stays cancelled.
    expect(redirect(po, '/admin', '/admin/login')).toBe('allow');
    expect(redirect(po, '/admin', `${VW_ORIGIN}/admin/login?next=%2Fadmin`)).toBe('allow');
    expect(redirect(po, '/admin', '/evil.html')).toBe('allow');
    expect(redirect(po, '/admin', 'https://evil.example/admin/login')).toBe('cancel');
    expect(redirect(po, '/admin', '/admin/login', 'sub_frame')).toBe('allow');
    expect(redirect(po, '/admin', '/admin/login', 'script')).toBe('cancel');
    // A release path still redirects only to the base path.
    expect(redirect(po, '/index.html', '/admin/login')).toBe('cancel');
    expect(redirect(po, '/', '/admin')).toBe('cancel');
    const html: [string, string][] = [
      ['content-type', 'text/html'],
      ['content-security-policy', "default-src 'self'; sandbox"],
    ];
    // The directive only removes capabilities from the page: nothing to cancel.
    expect(g(200, html, 'main_frame')).toMatchObject({action: 'allow', violation: null});
  });
  it('strips Speculation-Rules, appends the floor on documents, rewrites code to no-store on Firefox', () => {
    const r = g(
      200,
      [
        ['content-type', 'text/html; charset=utf-8'],
        ['speculation-rules', '"/x.json"'],
      ],
      'main_frame',
    );
    expect(r.strip).toContain('speculation-rules');
    // Only the enforced floor is appended: no report-only CSP, no COOP.
    expect(r.append.map(([n]) => n)).toEqual(['content-security-policy']);
    expect(r.noStore).toBe(true);
    expect(
      g(200, [['content-type', 'text/html; charset=iso-8859-1']], 'main_frame').violation,
    ).toBe('charset');
  });
  const at = (url: string, type: RequestObs['type'], status: number, headers: [string, string][]) =>
    headerGuard({
      origin: po,
      request: req(url, type),
      response: hdrs(status, headers),
      isDocument: type === 'main_frame' || type === 'sub_frame',
      candidates: [core],
      binding: null,
      allowedThirdParty: null,
    });
  it('a subresource redirect is allowed only for a declared type on a declared path', () => {
    const away: [string, string][] = [['location', 'https://icons.example/x.png']];
    expect(at(`${VW_ORIGIN}/icons/example.com/icon.png`, 'image', 302, away).action).toBe('allow');
    // A script would load from a host IntactWarden cannot filter.
    for (const [path, type] of [
      ['/icons/example.com/icon.png', 'script'],
      ['/icons/example.com/icon.png', 'media'],
      ['/images/logo.png', 'image'],
    ] as const) {
      expect(at(`${VW_ORIGIN}${path}`, type, 302, away), `${type} ${path}`).toMatchObject({
        action: 'cancel',
        violation: 'location',
      });
    }
  });
  it('a 304 is a revalidation, not a redirect: allowed without a Location', () => {
    // What a server sends for a revalidation: validators, no Location, no Refresh.
    const notModified: [string, string][] = [
      ['etag', '"abc"'],
      ['cache-control', 'max-age=0, must-revalidate'],
    ];
    for (const [path, type] of [
      ['/', 'main_frame'],
      [MAIN_PATH, 'script'],
      ['/images/logo.png', 'image'],
      ['/api/sync', 'xmlhttprequest'],
    ] as const) {
      expect(at(`${VW_ORIGIN}${path}`, type, 304, notModified), `${type} ${path}`).toMatchObject({
        action: 'allow',
        violation: null,
      });
    }
    // A Refresh on a 304 cancels, and so does every other 3xx without an accepted Location.
    expect(at(`${VW_ORIGIN}/`, 'main_frame', 304, [['refresh', '0;url=/evil']])).toMatchObject({
      action: 'cancel',
      violation: 'refresh',
    });
    for (const status of [300, 301, 302, 303, 305, 307, 308]) {
      expect(at(`${VW_ORIGIN}${MAIN_PATH}`, 'script', status, []), `${status}`).toMatchObject({
        action: 'cancel',
        violation: 'location',
      });
    }
  });
  it('a 304 document gets no-store but no CSP floor; the cached response reported after it gets the floor', () => {
    // Firefox copies the headers of a 304 into the cached response and reports that response to
    // onHeadersReceived again (status 200): a floor appended to the 304 would replace the
    // vendor's CSP there.
    expect(g(304, [['etag', '"x"']], 'main_frame')).toMatchObject({append: [], noStore: true});
    const merged = g(200, [['content-type', 'text/html']], 'main_frame');
    expect(merged.append.map(([n]) => n)).toEqual(['content-security-policy']);
  });
  it('a dynamic path answered with an executable content type is a violation (no body check runs)', () => {
    for (const ctype of ['text/javascript', 'text/html', 'text/css', 'application/wasm']) {
      expect(
        at(`${VW_ORIGIN}/api/x`, 'xmlhttprequest', 200, [['content-type', ctype]]),
        ctype,
      ).toMatchObject({action: 'allow', violation: 'content-type'});
    }
    expect(
      at(`${VW_ORIGIN}/api/x`, 'xmlhttprequest', 200, [['content-type', 'application/json']])
        .violation,
    ).toBeNull();
  });
  it('a frame document gets the floor too (connector pages carry no vendor CSP)', () => {
    const r = at(`${VW_ORIGIN}/webauthn-connector.html`, 'sub_frame', 200, [
      ['content-type', 'text/html'],
    ]);
    expect(r.append.map(([n]) => n)).toEqual(['content-security-policy']);
  });
  it('content types per class', () => {
    expect(contentTypeAllowed('wasm', 'application/wasm')).toBe(true);
    expect(contentTypeAllowed('script', 'application/json')).toBe(false);
    expect(contentTypeAllowed('font', 'font/woff2')).toBe(true);
  });
});

function session(over: Partial<DocumentSessionRecord> = {}): DocumentSessionRecord {
  const s = newSession(
    {
      k: 'doc-start',
      at: 0,
      doc: 'd1',
      tab: 1,
      frame: 0,
      parentDoc: null,
      req: 'r0',
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
    },
    po,
    0,
  );
  return {...s, ...over} as DocumentSessionRecord;
}

const bound = {
  buildId: core.ref.buildId,
  app: core.ref.app,
  variant: core.ref.variant,
  version: core.ref.version,
  assurance: core.ref.assurance,
  coreSha256: core.ref.sha256,
  source: core.ref.source,
  key: '/index.html',
  slots: {},
  boundAt: 0,
  retro: false,
} as const;

function ev(over: Partial<EvaluateInput> = {}, s: Partial<DocumentSessionRecord> = {}) {
  return evaluateSession({
    session: session({docClass: 'manifest', binding: bound, docVerified: true, ...s}),
    trust: {ready: true, loaded: true, githubBackoffUntil: null},
    buildStatus: 'current',
    originAlert: null,
    engineHealthy: true,
    permissionGranted: true,
    rollback: false,
    ...over,
  });
}

describe('evaluateSession', () => {
  it('green when the document and every active item match', () => {
    expect(ev().state).toBe('VERIFIED');
  });
  it('R5 trust store failed, R2 untracked, revoked permission', () => {
    expect(
      ev({
        trust: {ready: true, loaded: false, githubBackoffUntil: null},
      }),
    ).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['internal-error'],
    });
    expect(ev({}, {untracked: true}).reasons).toContain('untracked');
    expect(ev({permissionGranted: false}).reasons).toContain('permission-revoked');
  });
  it('R13 taint before green; R6 monotonic; NEW_BUILD resolves', () => {
    expect(ev({}, {coResident: {class: 'unverifiable', since: 0, sourcePath: '/'}}).state).toBe(
      'CO_RESIDENT_UNVERIFIED',
    );
    expect(ev({}, {peakState: 'MISMATCH'}).state).toBe('MISMATCH');
    expect(ev({}, {peakState: 'NEW_BUILD', binding: {...bound, retro: true}}).state).toBe(
      'VERIFIED',
    );
    expect(ev({}, {peakState: 'NEW_BUILD', binding: {...bound, retro: true}}).flags).toContain(
      'RETRO',
    );
  });
  it('an unverifiable document (R3) and a not-covered document', () => {
    expect(ev({}, {binding: null, docVerified: false, docClass: 'unknown'})).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['unverifiable-active'],
    });
    expect(
      ev(
        {},
        {
          binding: null,
          docVerified: false,
          docClass: 'server-rendered',
          docClassDetail: 'admin-portal',
        },
      ).state,
    ).toBe('NOT_COVERED');
  });
  it('pending items set CHECKING, which withholds green (the engine applies R4)', () => {
    const pending = {r9: {path: MAIN_PATH, type: 'script' as const, since: 0}};
    expect(ev({}, {pending})).toMatchObject({state: 'VERIFIED', flags: ['CHECKING']});
  });
  it('an active item still recorded under a bound document is PROTECTION_LOST internal-error', () => {
    // Green is decided once: a recorded item (kept for retro-verification) that was never judged
    // after the document bound is a fault, even while other items are pending.
    const recorded = {
      req: 'r',
      path: MAIN_PATH,
      url: '',
      type: 'script' as const,
      cls: 'script' as const,
      key: null,
      outcome: {r: 'recorded' as const},
      at: 0,
    };
    expect(ev({}, {items: {[MAIN_PATH]: recorded}})).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['internal-error'],
    });
    const pending = {r9: {path: '/other.js', type: 'script' as const, since: 0}};
    expect(ev({}, {items: {[MAIN_PATH]: recorded}, pending}).state).toBe('PROTECTION_LOST');
    // Unbound, it is evidence kept for later: no contribution.
    expect(itemContribution(recorded, null)).toBeNull();
    expect(itemContribution({...recorded, cls: 'image'}, bound)).toBeNull();
  });
  it('actions: deny, deny with retry, proceed once', () => {
    const mismatch = ev(
      {},
      {
        items: {
          [MAIN_PATH]: {
            req: 'r',
            path: MAIN_PATH,
            url: '',
            type: 'script',
            cls: 'script',
            key: null,
            outcome: {r: 'mismatch', reason: 'bytes'},
            at: 0,
          },
        },
      },
    );
    expect(mismatch.action).toBe('deny');
    expect(decisionFor(mismatch, null, null)).toMatchObject({act: 'block', state: 'MISMATCH'});
    // Which page shows the incident is not the kernel's choice (BlockedView.retry says it).
    expect(decisionFor(mismatch, null, null)).not.toHaveProperty('page');
    const unbound = {binding: null, docVerified: false, docClass: 'manifest' as const};
    const nb = ev(
      {},
      {
        ...unbound,
        unknownBuild: {
          since: 0,
          sha256: 'a'.repeat(64),
          size: 1,
          hint: null,
          attempts: [],
          decision: {
            k: 'wait',
            retryAt: null,
            contribution: {state: 'NEW_BUILD', reason: 'catching-up'},
          },
        },
      },
    );
    expect(nb.action).toBe('deny-with-retry');
    expect(decisionFor(nb, null, null)).toMatchObject({act: 'block', state: 'NEW_BUILD'});
    const bu = ev(
      {},
      {
        ...unbound,
        unknownBuild: {
          since: 0,
          sha256: 'a'.repeat(64),
          size: 1,
          hint: null,
          attempts: [],
          decision: {
            k: 'final',
            contribution: {state: 'BUILD_UNVERIFIED', reason: 'selfhost-unpublished'},
          },
        },
      },
    );
    // Every BUILD_UNVERIFIED reason is denied; "Proceed once" is the only way past.
    expect(bu.action).toBe('deny');
    const doc = 'c'.repeat(64);
    const allowances = {
      tab: 1,
      thirdPartyGrant: null,
      serverStyles: [],
      proceedOnce: [doc],
    };
    expect(decisionFor(bu, allowances, doc).act).toBe('allow');
    expect(decisionFor(bu, null, doc).act).toBe('block');
    // The allowance is for one document hash: a different document stays denied.
    expect(decisionFor(bu, {...allowances, proceedOnce: ['e'.repeat(64)]}, doc).act).toBe('block');
    expect(decisionFor(bu, allowances, null).act).toBe('block');
    // "Proceed once" never releases a red state: no row but BUILD_UNVERIFIED offers it.
    expect(decisionFor(mismatch, {...allowances, proceedOnce: [doc]}, doc).act).toBe('block');
  });
  it('ROLLBACK: a bound build older than the last one seen is amber and allowed', () => {
    // The engine produces ROLLBACK (alerts.isRollback), so its lattice row must be reachable from
    // evaluateSession.
    const r = ev({rollback: true});
    expect(r).toMatchObject({state: 'ROLLBACK', reasons: [], action: 'allow', alert: null});
    // Only a bound build can be a rollback; red evidence still wins over it.
    expect(ev({rollback: true}, {binding: null, docVerified: false}).state).not.toBe('ROLLBACK');
    expect(ev({rollback: true, buildStatus: 'disputed'}).state).toBe('DISPUTED');
    expect(ev({rollback: false}).state).toBe('VERIFIED');
  });
  it('red states write sticky alerts and report newRed once', () => {
    const items = {
      [MAIN_PATH]: {
        req: 'r',
        path: MAIN_PATH,
        url: '',
        type: 'script' as const,
        cls: 'script' as const,
        key: null,
        outcome: {r: 'mismatch' as const, reason: 'bytes' as const},
        at: 0,
      },
    };
    const first = ev({}, {items});
    expect(first.alert).toEqual({state: 'MISMATCH', reasons: ['bytes']});
    expect(first.newRed).toBe(true);
    expect(ev({}, {items, state: 'MISMATCH'}).newRed).toBe(false);
  });
  it('only red states with evidence raise the origin alert', () => {
    expect(ev({buildStatus: 'disputed'}).alert).toEqual({
      state: 'DISPUTED',
      reasons: ['pin-changed'],
    });
    // A persisted filter the previous instance never closed; a cleared item is not one.
    const restarted = ev({}, {engineFault: 'verifier-restarted'});
    expect(restarted.alert).toMatchObject({state: 'PROTECTION_LOST'});
    expect(restarted.unverifiedCode).toBe('ran');
    expect(ev({}, {engineFault: 'internal-error'}).alert).toBeNull();
    expect(ev({permissionGranted: false}).alert).toBeNull();
    // A co-resident unverified page is amber while it is open and leaves no stored alert.
    const co = ev({}, {coResident: {class: 'unverifiable', sourcePath: '/', since: 0}});
    expect(co.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect(co.alert).toBeNull();
  });
  it('a denied document or item raises no alert; evidence that code nobody verified ran does', () => {
    const script = (outcome: ItemOutcome) => ({
      [MAIN_PATH]: {
        req: 'r',
        path: MAIN_PATH,
        url: '',
        type: 'script' as const,
        cls: 'script' as const,
        key: null,
        outcome,
        at: 0,
      },
    });
    const denied = (s: Partial<DocumentSessionRecord>) => {
      const r = ev({}, s);
      expect(r.state).toBe('PROTECTION_LOST');
      expect(r.alert).toBeNull();
      expect(r.unverifiedCode).toBeNull();
    };
    // An unknown document (a server's own 404 page, a typo) and a dynamic path: denied, never ran.
    denied({binding: null, docVerified: false, docClass: 'unknown'});
    denied({binding: null, docVerified: false, docClass: 'dynamic-document'});
    // Items the backend withheld: a timeout, an empty body, a cut-off over the budget, a filter
    // that could not be attached (the request is cancelled), an unbound or unattributable one.
    for (const reason of [
      'timeout',
      'empty-body',
      'too-large',
      'filter-failed',
      'unbound',
      'no-host-permission',
      'internal-error',
    ] as const) {
      denied({items: script({r: 'unverifiable', reason})});
    }
    const ran = (s: Partial<DocumentSessionRecord>) => {
      const r = ev({}, s);
      expect(r.state).toBe('PROTECTION_LOST');
      expect(r.alert).toMatchObject({state: 'PROTECTION_LOST'});
      expect(r.unverifiedCode).toBe('ran');
    };
    // A filter that failed after it held a response: what followed went to the page unverified.
    ran({items: script({r: 'unverifiable', reason: 'filter-failed', delivered: true})});
    ran({items: script({r: 'unverifiable', reason: 'sw-served', delivered: true})});
    // Content-sensor evidence of unverified frames and elements.
    for (const event of [
      'blob-frame',
      'data-frame',
      'srcdoc',
      'object-element',
      'base-element',
    ] as const) {
      ran({sensors: [{event, count: 1, at: 0}]});
    }
    // A session that lost count of what it saw cannot show that nothing ran.
    ran({overflow: true});
    // The evidence stays with the document: a later evaluation still meets the condition.
    const sticky = ev(
      {},
      {state: 'PROTECTION_LOST', peakState: 'PROTECTION_LOST', unverifiedCode: 'ran'},
    );
    expect(sticky.alert).toMatchObject({state: 'PROTECTION_LOST'});
    // Code IntactWarden can no longer vouch for, with no evidence that it ran: no alert.
    for (const s of [{untracked: true}, {engineFault: 'internal-error'}] as const) {
      const r = ev({}, s);
      expect(r.alert).toBeNull();
      expect(r.unverifiedCode).toBe('unchecked');
    }
    expect(ev({permissionGranted: false}).unverifiedCode).toBe('unchecked');
    // Attack evidence raises the alert whatever ran.
    expect(ev({}, {items: script({r: 'mismatch', reason: 'bytes'})}).alert).toMatchObject({
      state: 'MISMATCH',
    });
  });
  it('an open origin alert withholds green, and only green', () => {
    const open = {
      origin: VW_ORIGIN,
      at: 0,
      state: 'MISMATCH' as const,
      reasons: ['bytes'],
      incident_id: '0123456789abcdef',
      acknowledged: false,
    };
    // A reload with genuine bytes is amber while the alert is open, green once it is closed,
    // also for the document that already showed RECOVERING (R6 does not hold it).
    expect(ev({originAlert: open})).toMatchObject({state: 'RECOVERING', alert: null});
    expect(ev({originAlert: {...open, acknowledged: true}}).state).toBe('VERIFIED');
    expect(ev({originAlert: {...open, acknowledged: true}}, {peakState: 'RECOVERING'}).state).toBe(
      'VERIFIED',
    );
    // It never stands in for a state that is denied: NEW_BUILD keeps its waiting blocked page and
    // a not-covered page stays denied.
    const nb = ev(
      {originAlert: open},
      {
        binding: null,
        docVerified: false,
        unknownBuild: {
          since: 0,
          sha256: 'a'.repeat(64),
          size: 1,
          hint: null,
          attempts: [],
          decision: {
            k: 'wait',
            retryAt: null,
            contribution: {state: 'NEW_BUILD', reason: 'catching-up'},
          },
        },
      },
    );
    expect(nb).toMatchObject({state: 'NEW_BUILD', action: 'deny-with-retry'});
    const admin = ev(
      {originAlert: open},
      {
        binding: null,
        docVerified: false,
        docClass: 'server-rendered',
        docClassDetail: 'admin-portal',
      },
    );
    expect(admin).toMatchObject({state: 'NOT_COVERED', action: 'deny'});
    // "Proceed once" never releases it.
    const sha = 'd'.repeat(64);
    const allowances = {tab: 1, thirdPartyGrant: null, serverStyles: [], proceedOnce: [sha]};
    expect(decisionFor(admin, allowances, sha).act).toBe('block');
  });
  it('is total: malformed input fails closed', () => {
    const r = evaluateSession(null as unknown as EvaluateInput);
    expect(r.state).toBe('PROTECTION_LOST');
  });
  it('is total: a manifest document with no evidence is PROTECTION_LOST, never allowed', () => {
    const bare = {binding: null, docVerified: false, unknownBuild: null, items: {}};
    expect(ev({}, bare)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['internal-error'],
      action: 'deny',
    });
    // A document still being classified only withholds green.
    expect(ev({}, {...bare, docClass: 'pending'})).toMatchObject({state: 'NOT_PROTECTED'});
    // R3 whatever else contributes: a lower-ranked contribution never stands in for the missing
    // document evidence (a third party, a co-resident flag, a binding without verified bytes).
    for (const extra of [
      {
        items: {
          tp: {
            req: 'tp',
            path: 'https://cdn.example/x.js',
            url: 'https://cdn.example/x.js',
            type: 'script' as const,
            cls: 'third-party' as const,
            key: null,
            outcome: {
              r: 'third-party' as const,
              id: 'x',
              host: 'cdn.example',
              kind: 'unpinnable-script' as const,
              allowed: false,
            },
            at: 0,
          },
        },
      },
      {coResident: {class: 'unverifiable' as const, since: 0, sourcePath: '/'}},
      {binding: bound},
    ]) {
      expect(ev({rollback: true}, {...bare, ...extra})).toMatchObject({
        state: 'PROTECTION_LOST',
        reasons: ['internal-error'],
        action: 'deny',
      });
    }
  });
  it('taint sources', () => {
    // A denied class that ran all the same (its StreamFilter failed) ran unverified code.
    expect(
      taintSourceClass(session({docClass: 'server-rendered', docClassDetail: 'admin-portal'})),
    ).toBe('unverifiable');
    expect(
      taintSourceClass(
        session({docClass: 'server-rendered', docClassDetail: 'admin-portal', blocked: true}),
      ),
    ).toBeNull();
    expect(
      taintSourceClass(
        session({docClass: 'manifest', state: 'MISMATCH', binding: bound, docVerified: true}),
      ),
    ).toBe('released-mismatch');
    expect(taintSourceClass(session({docClass: 'manifest', binding: null}))).toBe('unverifiable');
    expect(
      taintSourceClass(
        session({docClass: 'manifest', binding: bound, docVerified: true, state: 'VERIFIED'}),
      ),
    ).toBeNull();
    expect(taintSourceClass(session({docClass: 'unknown', blocked: true}))).toBeNull();
    // A verified document in which code nobody verified may have run, or for which IntactWarden can
    // no longer vouch, is a source; one that is red only because an item of it was denied is not.
    const lost = {
      docClass: 'manifest',
      binding: bound,
      docVerified: true,
      state: 'PROTECTION_LOST',
    } as const;
    expect(taintSourceClass(session({...lost, unverifiedCode: 'ran'}))).toBe('unverifiable');
    expect(taintSourceClass(session({...lost, unverifiedCode: 'unchecked'}))).toBe('unverifiable');
    expect(taintSourceClass(session({...lost, unverifiedCode: null}))).toBeNull();
    expect(
      taintSourceClass(
        session({docClass: 'manifest', binding: bound, docVerified: true, state: 'DISPUTED'}),
      ),
    ).toBe('unverifiable');
    expect(
      taintSourceClass(
        session({
          docClass: 'manifest',
          binding: bound,
          docVerified: true,
          state: 'THIRD_PARTY_CODE',
        }),
      ),
    ).toBeNull();
    // A document allowed to run a payment script taints its origin while it lives.
    expect(
      taintSourceClass(
        session({
          docClass: 'manifest',
          binding: bound,
          docVerified: true,
          state: 'THIRD_PARTY_CODE',
          allowedThirdParty: {id: 'stripe', host: 'js.stripe.com'},
        }),
      ),
    ).toBe('third-party-code');
  });
  it('a document allowed to run a payment script is THIRD_PARTY_CODE and released', () => {
    const r = ev({}, {allowedThirdParty: {id: 'stripe', host: 'js.stripe.com'}});
    expect(r).toMatchObject({
      state: 'THIRD_PARTY_CODE',
      reasons: ['js.stripe.com'],
      action: 'allow',
    });
    expect(r.alert).toBeNull();
  });
});

describe('CSP floor', () => {
  it('one enforced floor, no report-only directives', () => {
    expect(cspFloor(bwCloudOrigin(), null)).toBe(
      "base-uri 'self'; script-src-attr 'none'; script-src 'self' 'wasm-unsafe-eval'",
    );
  });

  it('Bitwarden script-src is enforced: payment hosts only for the one document allowed one', () => {
    const scriptSrc = (policy: string | null): string | undefined =>
      (policy ?? '')
        .split('; ')
        .find(d => d.startsWith('script-src '))
        ?.slice('script-src '.length);
    expect(scriptSrc(cspFloor(bwCloudOrigin(), null))).toBe("'self' 'wasm-unsafe-eval'");
    expect(scriptSrc(cspFloor(bwCloudOrigin(), 'stripe'))).toBe(
      "'self' 'wasm-unsafe-eval' https://js.stripe.com",
    );
    // Only a payment script is ever added: another kind or an unknown id changes nothing.
    expect(scriptSrc(cspFloor(bwCloudOrigin(), 'duo'))).toBe("'self' 'wasm-unsafe-eval'");
    expect(scriptSrc(cspFloor(bwCloudOrigin(), 'nope'))).toBe("'self' 'wasm-unsafe-eval'");
  });
});
