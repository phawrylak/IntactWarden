/**
 * Engine behaviour beyond a single load: liveness (a document ends only on a confirmed end), a
 * back/forward cache restore failing closed, taint ending with the source (more in taint.test.ts),
 * the content handlers' DocKey check, allowances, and the storage privacy invariant (no query or
 * fragment in any stored URL).
 */

import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {describe, expect, it} from 'vitest';
import {registerEngineHandlers} from '../../src/engine/handlers.ts';
import type {Handler, Router} from '../../src/platform/messaging.ts';
import type {HintResult, MessageType} from '../../src/contracts.ts';
import {details} from './helpers/fakeExt.ts';
import {
  BW_ORIGIN,
  bwSelfhostCore,
  bwSelfhostOrigin,
  bytes,
  createWorld,
  VW_ORIGIN,
  vwCore,
  type World,
} from './helpers/world.ts';

const INDEX = bytes('<!doctype html><html></html>');
const core = (): ReturnType<typeof vwCore> => vwCore('2026.10.1', {'/index.html': INDEX});
const HTML = [{name: 'Content-Type', value: 'text/html'}];
let seq = 1;

async function open(w: World, tab: number, path = '/', body = INDEX): Promise<string> {
  const req = `n${seq++}`;
  const url = `${VW_ORIGIN}${path}?q=secret#frag`;
  const d = details({requestId: req, url, type: 'main_frame', tabId: tab});
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
  w.env.filters.get(req)!.respond(body);
  await w.settle();
  return w.backend.docKeyFor({tab, frame: 0, url: `${VW_ORIGIN}${path}`})!;
}

describe('engine', () => {
  it('liveness: a taint source lives while its frame does, whatever time passes; the tab removal ends it', async () => {
    const w = await createWorld({cores: [core()]});
    const vault = await open(w, 1);
    // A page of a build nobody can check runs only because the user chose "Proceed once".
    const page = bytes('<html>unverified build</html>');
    await w.engine.allowForTab(2, {k: 'proceed-once', sha256: await sha256Hex(page)});
    await open(w, 2, '/', page);
    expect((await w.tab(1))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // Nothing the page does ends it (a forged pagehide, say): the frame still shows it, so a vault
    // opened later is co-resident too.
    w.timers.advance(10 * 60_000);
    await open(w, 3);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect((await w.tab(2))?.state).toBe('BUILD_UNVERIFIED');
    // The tab is closed: a confirmed end.
    w.env.removedTabs.add(2);
    w.env.tabsOnRemoved.emit(2, {windowId: 1, isWindowClosing: false});
    await w.settle();
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
    // The vault session keeps its flag for its lifetime.
    expect((await w.tab(1))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // A new vault load is clean again.
    await open(w, 1);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    expect(vault).not.toBe('');
  });

  it('a bound core whose release became disputed is DISPUTED pin-changed (red, with evidence)', async () => {
    const c = core();
    const w = await createWorld({cores: [c]});
    await open(w, 1);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    w.trust.cores = [{...c, ref: {...c.ref, status: 'disputed'}}];
    await w.engine.releaseDisputed(
      {app: c.ref.app, variant: c.ref.variant, version: c.ref.version},
      'pin-changed',
    );
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'DISPUTED', reasons: ['pin-changed']});
    // The details page shows the evidence the trust store kept.
    const disputed = {
      k: 'disputed' as const,
      reason: 'pin-changed' as const,
      at: 1,
      evidence: {recorded: 'a'.repeat(64), observed: 'b'.repeat(64)},
    };
    w.trust.releaseState = () => disputed;
    expect((await w.engine.details(1))?.docs[0]?.dispute).toEqual(disputed);
  });

  it('ROLLBACK: an origin that served a newer release before now serves an older one (amber, released)', async () => {
    // The producer path (alerts.lastSeen → isRollback → evaluate) end to end.
    const NEW = bytes('<!doctype html><html>2026.10.1</html>');
    const OLD = bytes('<!doctype html><html>2026.9.0</html>');
    const cores = () => [
      vwCore('2026.10.1', {'/index.html': NEW}),
      vwCore('2026.9.0', {'/index.html': OLD}),
    ];
    const w = await createWorld({cores: cores()});
    const label = 'rollback';
    // An older release before any newer one was seen is not a rollback.
    await open(w, 1, '/', OLD);
    expect((await w.tab(1))?.state, label).toBe('VERIFIED');
    await open(w, 1, '/', NEW);
    expect((await w.tab(1))?.state, label).toBe('VERIFIED');
    expect(w.env.local.data.get('l:v1:lastSeen'), label).toMatchObject({
      [VW_ORIGIN]: {version: '2026.10.1'},
    });
    const req = `n${seq}`;
    const d = details({requestId: req, url: `${VW_ORIGIN}/`, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({
      tabId: 2,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/`,
      timeStamp: 0,
    });
    seq++;
    w.env.filters.get(req)!.respond(OLD);
    await w.settle();
    const t = await w.tab(2);
    expect(t?.state, label).toBe('ROLLBACK');
    expect(t?.top?.binding?.version, label).toBe('2026.9.0');
    expect(w.sinks.alerts, label).toEqual([]);
    const out = w.env.filters.get(req)!.output;
    // ROLLBACK is amber and never denied.
    expect(out.length > 0 && Buffer.from(out).equals(Buffer.from(OLD)), label).toBe(true);
    // The rollback does not lower the newest build seen.
    expect(w.env.local.data.get('l:v1:lastSeen'), label).toMatchObject({
      [VW_ORIGIN]: {version: '2026.10.1'},
    });
  });

  // A protected document is never restored from the back/forward cache: the header guard makes
  // it no-store, which Firefox keeps out of that cache (e2e
  // vw-back-forward). Should a Firefox ever restore one, nothing brings its ended session back:
  // the restored page is not green. A restore reported as a commit is a document no request
  // announced (R2: PROTECTION_LOST untracked); without a commit its requests are denied.
  for (const [leave, reported] of [
    ['another site', true],
    ['another site', false],
    ['another vault page', true],
  ] as const) {
    it(`a document restored from the back/forward cache after ${leave} (restore ${reported ? 'reported as a commit' : 'not reported'}) fails closed`, async () => {
      const LAZY = '/app/lazy.js';
      const w = await createWorld({
        cores: [vwCore('2026.10.1', {'/index.html': INDEX, [LAZY]: bytes('lazy()')})],
      });
      const sender = {tab: 1, frame: 0, url: `${VW_ORIGIN}/`};
      const doc = await open(w, 1);
      expect((await w.tab(1))?.state).toBe('VERIFIED');
      // Leaving the page ends its document: the frame commits another one.
      if (leave === 'another site') {
        w.env.onCommitted.emit({
          tabId: 1,
          frameId: 0,
          parentFrameId: -1,
          url: 'https://example.org/',
          timeStamp: 0,
        });
        await w.settle();
        expect(await w.tab(1)).toBeNull();
      } else {
        expect(await open(w, 1)).not.toBe(doc);
      }
      // "Back" restores the document from the cache: no request, and a commit of its URL (Firefox
      // reports a restore as a commit, e2e vw-back-forward). Without one, after another site, the
      // frame has no document.
      const d = details({
        requestId: `restored-${leave}-${reported}`,
        url: `${VW_ORIGIN}${LAZY}`,
        type: 'script',
        tabId: 1,
        documentUrl: `${VW_ORIGIN}/`,
      });
      if (reported) {
        w.env.onCommitted.emit({
          tabId: 1,
          frameId: 0,
          parentFrameId: -1,
          url: sender.url,
          timeStamp: 0,
        });
        await w.settle();
        // The commit no request preceded is a new, untracked document, never the ended one.
        const restored = w.backend.docKeyFor(sender);
        expect(restored).not.toBeNull();
        expect(restored).not.toBe(doc);
        expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
        // A file of its own build is held by a filter and denied: the document is not verified.
        await w.env.webRequest.onBeforeRequest.fire(d);
        const f = w.env.filters.get(d.requestId)!;
        f.respond(bytes('lazy()'));
        await w.settle();
        expect(f.closed).toBe(true);
        expect(f.written).toHaveLength(0);
      } else {
        expect(w.backend.docKeyFor(sender)).toBeNull();
        expect(await w.tab(1)).toBeNull();
        // The restored page loads a file of its own build: no document owns it (R2): denied.
        const [r] = await w.env.webRequest.onBeforeRequest.fire(d);
        expect(w.env.filters.get(d.requestId)).toBeUndefined();
        expect(r?.cancel).toBe(true);
      }
      // Its content script still names the old DocKey: what it reports is ignored.
      await w.engine.contentDom(sender, {doc, event: 'inline-script', detail: {count: 1}});
      await w.settle();
      if (!reported) expect(await w.tab(1)).toBeNull();
      // No content script runs again on a restore; a hello would be an untracked document (R2).
      expect(await w.engine.hello(sender)).toMatchObject({protected: true});
      await w.settle();
      expect(await w.tab(1)).toMatchObject({
        state: 'PROTECTION_LOST',
        reasons: expect.arrayContaining(['untracked']),
      });
    });
  }

  it('a service-worker registration the content script reports is MISMATCH service-worker with an alert', async () => {
    // A worker can answer later requests unfiltered (bug 1817450): the registration itself is red.
    const w = await createWorld({cores: [core()]});
    const doc = await open(w, 1);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const sender = {tab: 1, frame: 0, url: `${VW_ORIGIN}/`};
    await w.engine.contentDom(sender, {doc, event: 'sw-register', detail: {count: 1}});
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toContain('service-worker');
    expect(w.sinks.alerts.map(a => a.state)).toEqual(['MISMATCH']);
  });

  it('a service-worker script request names no document: denied, and no session changes (R2)', async () => {
    const w = await createWorld({cores: [core()]});
    await open(w, 1);
    const d = details({
      requestId: `sw${seq++}`,
      url: `${VW_ORIGIN}/sw.js`,
      type: 'script',
      tabId: -1,
      originUrl: `${VW_ORIGIN}/`,
    });
    const [r] = await w.env.webRequest.onBeforeRequest.fire(d);
    expect(r?.cancel).toBe(true);
    expect(w.env.filters.has(d.requestId)).toBe(false);
    await w.settle();
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('content handlers: a claimed DocKey that is not the sender’s is ignored; allowances are validated', async () => {
    const w = await createWorld({cores: [core()]});
    const doc = await open(w, 1);
    const handlers = new Map<string, Handler<MessageType>>();
    const router: Router = {
      handle: (t, h) => void handlers.set(t, h as unknown as Handler<MessageType>),
      start: () => undefined,
    };
    registerEngineHandlers(router, w.engine);
    const sender = {
      kind: 'content' as const,
      tab: 1,
      frame: 0,
      url: `${VW_ORIGIN}/`,
    };
    const dom = handlers.get('CS_DOM')!;
    await dom({doc: '9:9:9', event: 'inline-script', detail: {count: 1}} as never, sender);
    await w.settle();
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await dom({doc, event: 'inline-script', detail: {count: 1}} as never, sender);
    await w.settle();
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    expect((await w.tab(1))?.reasons).toContain('inline-code');
    const allow = handlers.get('UI_ALLOW_FOR_TAB')!;
    const page = {
      kind: 'page' as const,
      tab: null,
      frame: null,
      url: null,
    };
    await expect(
      allow({tab: 1, allowance: {k: 'proceed-once', sha256: 'nope'}} as never, page),
    ).rejects.toThrow();
    // There is no "Allow for this tab" for a document.
    await expect(
      allow({tab: 1, allowance: {k: 'document', sha256: 'a'.repeat(64)}} as never, page),
    ).rejects.toThrow();
  });

  it('a header guard that fails cancels every response (R1); PROTECTION_LOST', async () => {
    // A header decision answered without the guard must not follow an undeclared redirect.
    const cases: [string, number, {name: string; value: string}[]][] = [
      ['ordinary', 200, HTML],
      ['redirect', 302, [{name: 'Location', value: 'https://evil.example/x'}]],
      ['refresh', 200, [...HTML, {name: 'Refresh', value: '0; url=https://evil.example/'}]],
      ['link', 200, [...HTML, {name: 'Link', value: '<https://evil.example/a.css>; rel=preload'}]],
    ];
    for (const [what, status, responseHeaders] of cases) {
      const w = await createWorld({cores: [core()]});
      w.trust.candidates = () => Promise.reject(new Error('IndexedDB failed'));
      const d = details({
        requestId: `g${seq++}`,
        url: `${VW_ORIGIN}/`,
        type: 'main_frame',
        tabId: 1,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      const [answer] = await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: status,
        responseHeaders,
      });
      expect(answer, what).toEqual({cancel: true});
      await w.settle();
      expect((await w.tab(1))?.state, what).toBe('PROTECTION_LOST');
    }
  });

  it('a listed locale served with status 203 and other bytes is MISMATCH and withheld', async () => {
    const LOCALE_PATH = '/locales/en/messages.json';
    const LOCALE = bytes('{"login":{"message":"Log in"}}');
    const EVIL = bytes('{"login":{"message":"Type your master password at evil.example"}}');
    {
      const w = await createWorld({
        cores: [vwCore('2026.10.1', {'/index.html': INDEX, [LOCALE_PATH]: LOCALE})],
      });
      await open(w, 1);
      expect((await w.tab(1))?.state).toBe('VERIFIED');
      const d = details({
        requestId: `l${seq++}`,
        url: `${VW_ORIGIN}${LOCALE_PATH}`,
        type: 'xmlhttprequest',
        tabId: 1,
        documentUrl: `${VW_ORIGIN}/`,
        originUrl: `${VW_ORIGIN}/`,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 203,
        responseHeaders: [{name: 'Content-Type', value: 'application/json'}],
      });
      const filter = w.env.filters.get(d.requestId)!;
      filter.respond(EVIL);
      await w.settle();
      expect(await w.tab(1)).toMatchObject({state: 'MISMATCH', reasons: ['bytes']});
      expect(filter.output.length).toBe(0);
    }
  });

  it('a listed locale that reaches the page unverified (a service worker answered it, its filter failed) is PROTECTION_LOST', async () => {
    const LOCALE_PATH = '/locales/en/messages.json';
    const start = async (): Promise<World> => {
      const w = await createWorld({
        cores: [vwCore('2026.10.1', {'/index.html': INDEX, [LOCALE_PATH]: bytes('{"a":"b"}')})],
      });
      await open(w, 1);
      expect((await w.tab(1))?.state).toBe('VERIFIED');
      return w;
    };
    const locale = (): ReturnType<typeof details> =>
      details({
        requestId: `l${seq++}`,
        url: `${VW_ORIGIN}${LOCALE_PATH}`,
        type: 'xmlhttprequest',
        tabId: 1,
        documentUrl: `${VW_ORIGIN}/`,
        originUrl: `${VW_ORIGIN}/`,
      });
    {
      // Firefox gives no filter for a response a service worker answers; it reaches the page.
      const w = await start();
      w.env.filterError = () => new Error('Invalid request ID');
      await w.env.webRequest.onBeforeRequest.fire(locale());
      await w.settle();
      expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['sw-served']});
      expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['PROTECTION_LOST']);
    }
    {
      // The filter fails after it held the response: the rest goes to the page unfiltered.
      const w = await start();
      const d = locale();
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'application/json'}],
      });
      w.env.filters.get(d.requestId)!.onerror?.({});
      await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
      await w.settle();
      expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
      expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['PROTECTION_LOST']);
    }
  });

  it('an auth-flow page that has content is denied, and its redirect is still followed', async () => {
    const w = await createWorld({cores: [core()]});
    const page = `${VW_ORIGIN}/identity/connect/authorize`;
    // A 302 to the identity provider has no body: the header guard exempts auth-flow paths.
    const r = details({requestId: `af${seq++}`, url: page, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(r);
    const [hop] = await w.env.webRequest.onHeadersReceived.fire({
      ...r,
      statusCode: 302,
      responseHeaders: [{name: 'Location', value: 'https://idp.example/authorize'}],
    });
    expect(hop?.cancel).not.toBe(true);
    // The same path answered with a page of the server's own and a same-origin script.
    const d = details({requestId: `af${seq++}`, url: page, type: 'main_frame', tabId: 3});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 3, frameId: 0, parentFrameId: -1, url: page, timeStamp: 0});
    const filter = w.env.filters.get(d.requestId)!;
    filter.respond(bytes('<html><form>login</form><script src="/app/evil.js"></script></html>'));
    await w.settle();
    expect(filter.output.length).toBe(0);
    expect(await w.tab(3)).toMatchObject({state: 'NOT_COVERED', reasons: ['auth-flow']});
    expect((await w.tab(3))?.flags).toContain('BLOCKED');
  });

  it('a live taint source never lets a not-covered page through as CO_RESIDENT_UNVERIFIED', async () => {
    // A vault tab turned red (a tampered script, denied) is a taint source; a page the lattice denies
    // on its own (auth-flow with content, /admin) is still denied, not released as an amber
    // co-resident, whose action is 'allow'.
    const MAIN = bytes('console.log(1)');
    const page = bytes('<!doctype html><script src="/app/main.js"></script>');
    const w = await createWorld({
      cores: [vwCore('2026.10.1', {'/index.html': page, '/app/main.js': MAIN})],
    });
    await open(w, 1, '/', page);
    const s = details({
      requestId: `bs${seq++}`,
      url: `${VW_ORIGIN}/app/main.js`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(s);
    await w.env.webRequest.onHeadersReceived.fire({
      ...s,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}],
    });
    w.env.filters.get(s.requestId)!.respond(bytes('evil()'));
    await w.settle();
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    for (const [tab, path] of [
      [2, '/identity/connect/authorize'],
      [3, '/admin'],
    ] as const) {
      const d = details({
        requestId: `bs${seq++}`,
        url: `${VW_ORIGIN}${path}`,
        type: 'main_frame',
        tabId: tab,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
      w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
      const f = w.env.filters.get(d.requestId)!;
      f.respond(bytes('<html><form>login</form><script src="/app/evil.js"></script></html>'));
      await w.settle();
      expect(f.output.length, path).toBe(0);
      expect((await w.tab(tab))?.flags, path).toContain('BLOCKED');
    }
  });

  it('a navigation outside the manifest is an unknown document, never an unknown build', async () => {
    const nav = async (
      w: World,
      origin: string,
      path: string,
      status: number,
      body: Uint8Array,
    ) => {
      const d = details({
        requestId: `x${seq++}`,
        url: `${origin}${path}`,
        type: 'main_frame',
        tabId: 4,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: status,
        responseHeaders: HTML,
      });
      w.env.onCommitted.emit({tabId: 4, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
      const f = w.env.filters.get(d.requestId)!;
      f.respond(body);
      await w.settle();
      return {f, rec: await w.tab(4)};
    };
    {
      // Vaultwarden: an HTML page at a path no core maps fetches no hint and is red, not amber.
      const w = await createWorld({cores: [core()]});
      w.registry.hint = {version: null, at: 0};
      const evil = bytes('<html><script>steal()</script></html>');
      const {f, rec} = await nav(w, VW_ORIGIN, '/evil.html', 200, evil);
      expect(rec).toMatchObject({state: 'PROTECTION_LOST', reasons: ['unverifiable-active']});
      expect(w.registry.hintCalls).toBe(0);
      expect(f.output.length).toBe(0);
      // Self-hosted Bitwarden: a dead link answered by a proxy's own 404 page is not a tamper alarm.
      const NF = bytes('<html>build 404</html>');
      const bw = await createWorld({
        cores: [
          bwSelfhostCore('2026.10.1', {
            '/index.html': {bytes: INDEX},
            '/404.html': {bytes: NF},
          }),
        ],
        origins: [bwSelfhostOrigin()],
      });
      bw.registry.hint = {version: '2026.10.1', at: 0};
      const own = await nav(bw, BW_ORIGIN, '/old-bookmark', 404, NF);
      expect(own.rec?.state).not.toBe('PROTECTION_LOST');
      const foreign = await nav(bw, BW_ORIGIN, '/old-bookmark', 404, bytes('<html>nginx</html>'));
      expect(foreign.rec).toMatchObject({
        state: 'PROTECTION_LOST',
        reasons: ['unverifiable-active'],
      });
      // An empty body under any content status is unverifiable, never a MISMATCH release-differs
      // against the hinted release.
      const vw = await createWorld({cores: [core()]});
      vw.registry.hint = {version: '2026.10.1', at: 0};
      for (const status of [200, 203, 204]) {
        const empty = await nav(vw, VW_ORIGIN, '/', status, bytes(''));
        expect(empty.rec?.state, `${status}`).toBe('PROTECTION_LOST');
        expect(empty.rec?.reasons, `${status}`).not.toContain('release-differs');
      }
    }
  });

  it('self-hosted Bitwarden: an attachment download is not held or buffered', async () => {
    const w = await createWorld({
      cores: [bwSelfhostCore('2026.10.1', {'/index.html': {bytes: INDEX}})],
      origins: [bwSelfhostOrigin()],
    });
    const nav = details({
      requestId: `at${seq++}`,
      url: `${BW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(nav);
    await w.env.webRequest.onHeadersReceived.fire({...nav, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: nav.url, timeStamp: 0});
    w.env.filters.get(nav.requestId)!.respond(INDEX);
    await w.settle();
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    for (const path of ['/attachments/c1/a1', '/events/collect']) {
      const d = details({
        requestId: `at${seq++}`,
        url: `${BW_ORIGIN}${path}`,
        type: 'xmlhttprequest',
        tabId: 1,
        documentUrl: `${BW_ORIGIN}/`,
        originUrl: `${BW_ORIGIN}/`,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      // No StreamFilter: a download over the 64 MiB budget is not cut to zero bytes.
      expect(w.env.filters.get(d.requestId), path).toBeUndefined();
    }
  });

  it('privacy: no stored URL carries a query or a fragment', async () => {
    const w = await createWorld({cores: []});
    w.registry.hint = {version: '2026.11.0', at: 0};
    await open(w, 1);
    await w.settle();
    const dump = JSON.stringify([...w.env.session.data.entries(), ...w.env.local.data.entries()]);
    expect(dump).toContain(VW_ORIGIN);
    expect(dump).not.toContain('secret');
    expect(dump).not.toContain('#frag');
    expect(dump).not.toMatch(/https?:\/\/[^"]*[?#]/);
  });
});

describe('engine: retro binding, CHECKING and dispute evidence', () => {
  const PAGE = bytes(
    '<!doctype html><html><head><script src="app/main.0123456789abcdef0123.js"></script></head></html>',
  );
  const MAIN = bytes('console.log("vault");');
  const MAIN_PATH = '/app/main.0123456789abcdef0123.js';
  const JS = [{name: 'Content-Type', value: 'text/javascript'}];

  function scriptRequest(tab: number): ReturnType<typeof details> {
    return details({
      requestId: `s${seq++}`,
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: tab,
      documentUrl: `${VW_ORIGIN}/`,
    });
  }

  it('a binding after the fact becomes visible only with its retro results: an evaluation in between leaves the page BUILD_UNVERIFIED + RETRO', async () => {
    const w = await createWorld({cores: []});
    const key = {app: 'vaultwarden-web', variant: 'release', version: '2026.11.0'} as const;
    w.registry.hint = {version: '2026.11.0', at: 0};
    w.trust.fail(key, 'release-not-found');
    await w.engine.allowForTab(1, {k: 'proceed-once', sha256: await sha256Hex(PAGE)});
    await open(w, 1, '/', PAGE);
    expect(await w.tab(1)).toMatchObject({state: 'BUILD_UNVERIFIED'});
    const s = scriptRequest(1);
    await w.env.webRequest.onBeforeRequest.fire(s);
    await w.env.webRequest.onHeadersReceived.fire({...s, statusCode: 200, responseHeaders: JS});
    w.env.filters.get(s.requestId)!.respond(MAIN);
    await w.settle();
    w.trust.cores.push(vwCore('2026.11.0', {'/index.html': PAGE, [MAIN_PATH]: MAIN}));
    // An unrelated evaluation (an allowance) runs while the retro pass awaits its hashes.
    await Promise.all([
      w.engine.releaseKnown(w.trust.cores.map(c => c.ref)),
      w.engine.allowForTab(1, {k: 'proceed-once', sha256: 'ab'.repeat(32)}),
    ]);
    await w.settle();
    const t = await w.tab(1);
    expect(t).toMatchObject({state: 'BUILD_UNVERIFIED'});
    expect(t?.flags).toContain('RETRO');
  });

  it('a release that becomes known while a held document waits for the version hint: the document binds before it is released (VERIFIED, not RETRO)', async () => {
    const w = await createWorld({cores: []});
    let answer!: (hint: HintResult) => void;
    w.registry.fetchHint = () => new Promise<HintResult>(resolve => (answer = resolve));
    const d = details({
      requestId: `n${seq++}`,
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
    const filter = w.env.filters.get(d.requestId)!;
    filter.respond(PAGE);
    await w.settle();
    // Held: no known release has these bytes, and the server's hint is still on its way.
    expect(filter.closed).toBe(false);
    // Another tab's deep verify makes the release known meanwhile.
    const known = vwCore('2026.11.0', {'/index.html': PAGE});
    w.trust.cores.push(known);
    const rebound = w.engine.releaseKnown([known.ref]);
    await w.settle();
    answer({version: '2026.11.0', at: 0});
    await rebound;
    await w.settle();
    expect(filter.output).toEqual(PAGE);
    const t = await w.tab(1);
    expect(t).toMatchObject({state: 'VERIFIED', flags: []});
    expect(t?.top?.binding).toMatchObject({version: '2026.11.0', retroAt: null});
    expect(await w.engine.listIncidents(10)).toEqual([]);
  });

  it('a covered script still waiting for its response headers withholds green (CHECKING)', async () => {
    const w = await createWorld({
      cores: [vwCore('2026.10.1', {'/index.html': PAGE, [MAIN_PATH]: MAIN})],
    });
    await open(w, 1, '/', PAGE);
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', flags: []});
    await w.env.webRequest.onBeforeRequest.fire(scriptRequest(1));
    await w.settle();
    w.timers.advance(2_000);
    await w.settle();
    expect((await w.tab(1))?.flags).toContain('CHECKING');
  });

  it('a page load of a release already disputed shows the dispute evidence on the blocked page', async () => {
    const c = core();
    const disputedCore = {...c, ref: {...c.ref, status: 'disputed' as const}};
    const w = await createWorld({cores: [disputedCore]});
    const evidence = {recorded: 'a'.repeat(64), observed: 'b'.repeat(64)};
    w.trust.releaseState = () => ({k: 'disputed', reason: 'pin-changed', at: 1, evidence});
    await open(w, 1);
    const inc = (await w.engine.listIncidents(10)).find(i => i.kind === 'release-disputed');
    expect(inc).toMatchObject({state: 'DISPUTED', buildId: c.ref.buildId});
    expect(await w.engine.blockedView(inc!.id)).toMatchObject({
      state: 'DISPUTED',
      dispute: evidence,
    });
  });
});
