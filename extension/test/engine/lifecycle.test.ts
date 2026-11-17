/**
 * Documents the engine did not see load: protected tabs open when IntactWarden starts (install,
 * update, enable), after an event-page restart (R7), of an origin whose host permission is
 * missing, and a content script whose frame the backend has no record of.
 */

import {describe, expect, it} from 'vitest';
import {details, FakeArea, FakeTimers} from './helpers/fakeExt.ts';
import {bytes, createWorld, VW_ORIGIN, vwCore, vwOrigin} from './helpers/world.ts';

const INDEX = bytes('<!doctype html><html></html>');
const core = (): ReturnType<typeof vwCore> => vwCore('2026.10.1', {'/index.html': INDEX});

describe('protected tabs open at start', () => {
  it('first start (install, update, enable): an open vault tab is PROTECTION_LOST untracked, not "not protected"', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const w = await createWorld({cores: [core()], session, local});
    w.env.tabs.push(
      {id: 1, url: `${VW_ORIGIN}/`, status: 'complete'},
      {id: 2, url: `${VW_ORIGIN}/`, discarded: true},
      {id: 3, url: `${VW_ORIGIN}/`, status: 'loading'},
      {id: 4, url: 'https://example.org/', status: 'complete'},
    );
    // A fresh storage.session: not a restart.
    session.data.clear();
    await w.engine.start();
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    expect(await w.tab(2)).toBeNull();
    expect(await w.tab(3)).toBeNull();
    expect(await w.tab(4)).toBeNull();
  });

  it('restart: a missing permission says so; otherwise the tab is verifier-restarted', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    // A first world, so that the later ones start after a restart.
    await createWorld({cores: [core()], session, local, timers});

    const w2 = await createWorld({
      cores: [core()],
      session,
      local,
      timers,
      origins: [vwOrigin(false)],
    });
    w2.env.tabs.push({id: 1, url: `${VW_ORIGIN}/`, status: 'complete'});
    await w2.engine.start();
    await w2.settle();
    expect(await w2.tab(1)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['permission-revoked'],
      permissionMissing: true,
    });

    const w3 = await createWorld({cores: [core()], session, local, timers});
    w3.env.tabs.push({id: 1, url: `${VW_ORIGIN}/`, status: 'complete'});
    await w3.engine.start();
    await w3.settle();
    expect(await w3.tab(1)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['verifier-restarted'],
    });
  });
});

describe('content-script hello without a backend record', () => {
  it('adopts the document as an untracked session (R2)', async () => {
    const w = await createWorld({cores: [core()]});
    const c = await w.engine.hello({tab: 5, frame: 0, url: `${VW_ORIGIN}/`});
    await w.settle();
    expect(c.protected).toBe(true);
    expect(c.doc).toMatch(/^5:0:\d+$/);
    expect(await w.tab(5)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    // The adopted document is the frame's document from now on.
    expect(w.backend.docKeyFor({tab: 5, frame: 0, url: `${VW_ORIGIN}/`})).toBe(c.doc);
  });

  it('a frame that already has a document is not replaced', async () => {
    const w = await createWorld({cores: [core()]});
    const url = `${VW_ORIGIN}/`;
    const d = details({requestId: 'l1', url, type: 'main_frame', tabId: 6});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
    });
    w.env.onCommitted.emit({tabId: 6, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get('l1')!.respond(INDEX);
    await w.settle();
    // A sender URL that differs from the committed one (pushState): no adoption.
    const c = await w.engine.hello({tab: 6, frame: 0, url: `${VW_ORIGIN}/other`});
    expect(c.protected).toBe(false);
    expect((await w.tab(6))?.state).toBe('VERIFIED');
  });

  // An adopted document can never bind, so its later subresources must not be 'recorded' for a
  // retro-verification that never comes (a tampered chunk would be released).
  {
    it("a covered subresource of an adopted document is unverifiable 'unbound' and denied", async () => {
      const LAZY_PATH = '/app/123.0123456789abcdef0123.js';
      const w = await createWorld({
        cores: [vwCore('2026.10.1', {'/index.html': INDEX, [LAZY_PATH]: bytes('lazy()')})],
      });
      await w.engine.hello({tab: 5, frame: 0, url: `${VW_ORIGIN}/`});
      await w.settle();
      const d = details({
        requestId: 'lazy1',
        url: `${VW_ORIGIN}${LAZY_PATH}`,
        type: 'script',
        tabId: 5,
        documentUrl: `${VW_ORIGIN}/`,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}],
      });
      const f = w.env.filters.get('lazy1')!;
      f.respond(bytes('evil()'));
      await w.settle();
      expect(f.written).toHaveLength(0);
      const item = (await w.engine.details(5))?.docs[0]?.items.find(i => i.path === LAZY_PATH);
      expect(item?.outcome).toEqual({r: 'unverifiable', reason: 'unbound'});
      expect((await w.tab(5))?.state).toBe('PROTECTION_LOST');
    });
  }

  // Before the content script's hello, a request of a page the backend did not see load has no
  // document (R2) and no filter. Every covered type is denied there, not only active ones, so a
  // `.wasm` read by fetch() or a locale does not reach the page unhashed.
  for (const [type, path] of [
    ['xmlhttprequest', '/app.wasm'],
    ['xmlhttprequest', '/locales/en/messages.json'],
    ['image', '/images/logo.png'],
  ] as const) {
    it(`a covered ${type} (${path}) no known document owns is denied`, async () => {
      const w = await createWorld({
        cores: [vwCore('2026.10.1', {'/index.html': INDEX, [path]: bytes('genuine')})],
      });
      const d = details({
        requestId: 'r2',
        url: `${VW_ORIGIN}${path}`,
        type,
        tabId: 5,
        documentUrl: `${VW_ORIGIN}/`,
      });
      const [r] = await w.env.webRequest.onBeforeRequest.fire(d);
      expect(w.env.filters.get(d.requestId)).toBeUndefined();
      expect(r?.cancel).toBe(true);
    });
  }
});

describe('deep-verify budget', () => {
  it('a server cannot make the extension deep verify release after release', async () => {
    const w = await createWorld({cores: []});
    const versions = ['2026.11.0', '2026.11.1', '2026.11.2', '2026.11.3'];
    for (const [i, v] of versions.entries()) {
      w.registry.hint = {version: v, at: 0};
      const url = `${VW_ORIGIN}/`;
      const d = details({requestId: `b${i}`, url, type: 'main_frame', tabId: 10 + i});
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
      });
      w.env.onCommitted.emit({tabId: 10 + i, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
      w.env.filters.get(`b${i}`)!.respond(bytes(`<html>build ${v}</html>`));
      await w.settle();
    }
    expect(w.trust.ensured.map(k => k.version)).toEqual(versions.slice(0, 3));
    const last = await w.tab(13);
    expect(last).toMatchObject({
      state: 'BUILD_UNVERIFIED',
      reasons: ['selfhost-unpublished'],
      unknownBuild: {phase: 'final', failure: 'limit-reached'},
    });
    // A version this origin already started is not a new spend.
    w.registry.hint = {version: '2026.11.1', at: 0};
    const url = `${VW_ORIGIN}/`;
    const d = details({requestId: 'b9', url, type: 'main_frame', tabId: 20});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
    });
    w.env.onCommitted.emit({tabId: 20, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get('b9')!.respond(bytes('<html>build 2026.11.1</html>'));
    await w.settle();
    expect((await w.tab(20))?.unknownBuild?.failure).not.toBe('limit-reached');
  });
});

describe('private-browsing windows', () => {
  it('alerts, incidents and the newest build seen in a private window never reach storage.local, and they are purged with the last private tab', async () => {
    const w = await createWorld({cores: [core()]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    const url = `${VW_ORIGIN}/`;
    const d = details({requestId: 'p1', url, type: 'main_frame', tabId: 30, incognito: true});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
    });
    w.env.onCommitted.emit({tabId: 30, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get('p1')!.respond(bytes('<html>tampered</html>'));
    await w.settle();
    expect((await w.tab(30))?.state).toBe('MISMATCH');
    // Visible while the private session lasts...
    expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['MISMATCH']);
    expect(await w.engine.listIncidents(10)).toHaveLength(1);
    // ...but only in storage.session (memory), never storage.local.
    expect(
      [...w.env.local.data.keys()].filter(k => /originAlerts|incidents|lastSeen/.test(k)),
    ).toEqual([]);
    // A verified private document does not record the last-seen build either.
    const v = details({requestId: 'p2', url, type: 'main_frame', tabId: 31, incognito: true});
    await w.env.webRequest.onBeforeRequest.fire(v);
    await w.env.webRequest.onHeadersReceived.fire({
      ...v,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
    });
    w.env.onCommitted.emit({tabId: 31, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get('p2')!.respond(INDEX);
    await w.settle();
    expect([...w.env.local.data.keys()].filter(k => /lastSeen/.test(k))).toEqual([]);
    // The last private tab closes.
    w.env.tabsOnRemoved.emit(30, {windowId: 2, isWindowClosing: true});
    w.env.tabsOnRemoved.emit(31, {windowId: 2, isWindowClosing: true});
    await w.settle();
    expect(await w.engine.listAlerts()).toEqual([]);
    expect(await w.engine.listIncidents(10)).toEqual([]);
  });

  it('the purge comes with the last private tab, whatever that tab shows, and ends RECOVERING in the other windows', async () => {
    const w = await createWorld({cores: [core()]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    const url = `${VW_ORIGIN}/`;
    // Two private tabs: a tampered vault, and a page of another site.
    w.env.tabs.push(
      {id: 30, url, incognito: true},
      {id: 40, url: 'https://example.org/', incognito: true},
    );
    const d = details({requestId: 'q1', url, type: 'main_frame', tabId: 30, incognito: true});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
    });
    w.env.onCommitted.emit({tabId: 30, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get('q1')!.respond(bytes('<html>tampered</html>'));
    await w.settle();
    expect(await w.engine.listAlerts()).toHaveLength(1);
    // A genuine vault in a normal window meanwhile: the origin's alert is open.
    await load(w, 1, 'q2', INDEX);
    expect((await w.tab(1))?.state).toBe('RECOVERING');
    const close = async (tab: number): Promise<void> => {
      w.env.tabs.splice(
        w.env.tabs.findIndex(t => t.id === tab),
        1,
      );
      w.env.tabsOnRemoved.emit(tab, {windowId: 2, isWindowClosing: false});
      await w.settle();
    };
    // The private vault tab closes first: a private tab is still open, so nothing goes yet.
    await close(30);
    expect(await w.engine.listAlerts()).toHaveLength(1);
    expect(await w.engine.listIncidents(10)).toHaveLength(1);
    // The last private tab never showed a protected page.
    await close(40);
    expect(await w.engine.listAlerts()).toEqual([]);
    expect(await w.engine.listIncidents(10)).toEqual([]);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });
});

/** A storage area whose next read or write of a given key rejects once (a storage API error). */
class FlakyArea extends FakeArea {
  readonly failGet = new Set<string>();
  readonly failSet = new Set<string>();
  override async get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>> {
    const list = typeof keys === 'string' ? [keys] : (keys ?? []);
    if (list.some(k => this.failGet.delete(k))) throw new Error('storage failed');
    return super.get(keys);
  }
  override async set(items: Record<string, unknown>): Promise<void> {
    if (Object.keys(items).some(k => this.failSet.delete(k))) throw new Error('storage failed');
    return super.set(items);
  }
}

/** A top-level document load on the instance; returns what the filter released. */
async function load(
  w: Awaited<ReturnType<typeof createWorld>>,
  tab: number,
  req: string,
  body: Uint8Array,
): Promise<Uint8Array[]> {
  const url = `${VW_ORIGIN}/`;
  const d = details({requestId: req, url, type: 'main_frame', tabId: tab});
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({
    ...d,
    statusCode: 200,
    responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
  });
  w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
  const f = w.env.filters.get(req)!;
  f.respond(body);
  await w.settle();
  return f.written;
}

/**
 * A rejected storage call during engine.start() must not count as ready: everything is denied and
 * no VERIFIED tab record of the previous instance survives.
 */
describe('a failed engine start fails closed', () => {
  const faults: [string, (session: FlakyArea, local: FlakyArea) => void][] = [
    ['the boot record write', s => s.failSet.add('s:v1:boot')],
    ['the origin alerts read', (_s, l) => l.failGet.add('l:v1:originAlerts')],
  ];
  for (const [what, inject] of faults) {
    it(`${what} fails: a genuine document is PROTECTION_LOST internal-error and denied`, async () => {
      const session = new FlakyArea();
      const local = new FlakyArea();
      inject(session, local);
      const w = await createWorld({cores: [core()], session, local});
      const written = await load(w, 1, 'f1', INDEX);
      expect(written).toHaveLength(0);
      expect(await w.tab(1)).toMatchObject({
        state: 'PROTECTION_LOST',
        reasons: expect.arrayContaining(['internal-error']),
      });
    });
  }

  it('after a restart whose start fails, the previous VERIFIED tab record does not survive', async () => {
    const session = new FlakyArea();
    const local = new FlakyArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core()], session, local, timers});
    await load(w1, 1, 'f2', INDEX);
    expect((await w1.tab(1))?.state).toBe('VERIFIED');
    session.failSet.add('s:v1:boot');
    const w2 = await createWorld({cores: [core()], session, local, timers});
    await w2.settle();
    expect(await w2.tab(1)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['internal-error'],
    });
  });

  // While the failed instance runs, the backend still attributes the frame to its document but the
  // engine has no session for it: a tampered chunk is denied unjudged. A later start that succeeds
  // must not rehydrate the untouched pre-failure record and show the tab VERIFIED again (R6).
  for (const [what, inject] of faults) {
    it(`${what} fails on a restart, then a good restart: the tab is never VERIFIED again`, async () => {
      const LAZY = '/app/lazy.js';
      const vw = (): ReturnType<typeof vwCore> =>
        vwCore('2026.10.1', {'/index.html': INDEX, [LAZY]: bytes('lazy()')});
      const session = new FlakyArea();
      const local = new FlakyArea();
      const timers = new FakeTimers();
      const sender = {tab: 1, frame: 0, url: `${VW_ORIGIN}/`};
      const w1 = await createWorld({cores: [vw()], session, local, timers});
      await load(w1, 1, 'e1', INDEX);
      expect(w1.backend.docKeyFor(sender)).not.toBeNull();
      expect((await w1.tab(1))?.state).toBe('VERIFIED');
      inject(session, local);
      const w2 = await createWorld({cores: [vw()], session, local, timers});
      w2.env.tabs.push({id: 1, url: `${VW_ORIGIN}/`, status: 'complete'});
      await w2.settle();
      expect((await w2.tab(1))?.state).toBe('PROTECTION_LOST');
      const d = details({
        requestId: 'e2',
        url: `${VW_ORIGIN}${LAZY}`,
        type: 'script',
        tabId: 1,
        documentUrl: `${VW_ORIGIN}/`,
      });
      await w2.env.webRequest.onBeforeRequest.fire(d);
      await w2.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}],
      });
      const f = w2.env.filters.get('e2')!;
      f.respond(bytes('evil()'));
      await w2.settle();
      expect(f.written).toHaveLength(0);
      const w3 = await createWorld({cores: [vw()], session, local, timers});
      w3.env.tabs.push({id: 1, url: `${VW_ORIGIN}/`, status: 'complete'});
      await w3.settle();
      expect((await w3.tab(1))?.state).toBe('PROTECTION_LOST');
    });
  }
});

/**
 * A storage.session whose quota is used up (Firefox enforces one): once `full`, a tab record with
 * document summaries no longer fits; with `nothingFits`, no tab record does.
 */
class FullTabRecords extends FakeArea {
  full = false;
  nothingFits = false;
  override async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      if (!this.full || !k.startsWith('s:v1:tab:')) continue;
      if (this.nothingFits || (v as {top: unknown}).top !== null) throw new Error('quota exceeded');
    }
    return super.set(items);
  }
}

/**
 * A verdict the engine can no longer store must not leave the tab's record claiming the state it
 * had before (R1): the response is denied and the record becomes PROTECTION_LOST internal-error,
 * or goes when not even that fits.
 */
describe('storage.session rejects the tab record', () => {
  const LAZY = '/app/lazy.js';
  const vw = (): ReturnType<typeof vwCore> =>
    vwCore('2026.10.1', {'/index.html': INDEX, [LAZY]: bytes('lazy()')});
  const script = (req: string): ReturnType<typeof details> =>
    details({
      requestId: req,
      url: `${VW_ORIGIN}${LAZY}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
    });
  const JS = [{name: 'Content-Type', value: 'text/javascript'}];

  for (const nothingFits of [false, true]) {
    const after = nothingFits ? 'the record is removed' : 'the record is PROTECTION_LOST';
    it(`a tampered script on a verified tab is denied and ${after}`, async () => {
      const session = new FullTabRecords();
      const w = await createWorld({cores: [vw()], session});
      await load(w, 1, 's1', INDEX);
      expect((await w.tab(1))?.state).toBe('VERIFIED');
      session.full = true;
      session.nothingFits = nothingFits;
      const d = script('s2');
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
      const f = w.env.filters.get('s2')!;
      f.respond(bytes('evil()'));
      await w.settle();
      expect(f.written).toHaveLength(0);
      if (nothingFits) expect(await w.tab(1)).toBeNull();
      else {
        expect(await w.tab(1)).toMatchObject({
          state: 'PROTECTION_LOST',
          reasons: ['internal-error'],
          top: null,
          frames: [],
        });
      }
      // The UI was told to read the record again.
      expect(w.sinks.changed.at(-1)).toBe(1);
    });
  }

  it('the header stage fails closed the same way', async () => {
    const session = new FullTabRecords();
    const w = await createWorld({cores: [vw()], session});
    await load(w, 1, 'h1', INDEX);
    session.full = true;
    const d = script('h2');
    await w.env.webRequest.onBeforeRequest.fire(d);
    const [answer] = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: JS,
    });
    expect(answer).toEqual({cancel: true});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
  });
});

/**
 * A document that said hello only to the previous background instance (after an event-page restart
 * the content script sends nothing) must still turn red, and its tampered chunk be denied.
 */
describe('a red state after an event-page restart', () => {
  it('a tampered lazy chunk after a restart is MISMATCH and denied', async () => {
    const LAZY_PATH = '/app/lazy.js';
    const vw = (): ReturnType<typeof vwCore> =>
      vwCore('2026.10.1', {'/index.html': INDEX, [LAZY_PATH]: bytes('lazy()')});
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const sender = {tab: 1, frame: 0, url: `${VW_ORIGIN}/`};
    const w1 = await createWorld({cores: [vw()], session, local, timers});
    await load(w1, 1, 'b1', INDEX);
    const doc = w1.backend.docKeyFor(sender)!;
    await w1.engine.hello(sender);
    await w1.settle();
    expect((await w1.tab(1))?.state).toBe('VERIFIED');
    // The event page stops and starts again; the content script sends nothing (no second hello).
    const w2 = await createWorld({cores: [vw()], session, local, timers});
    await w2.settle();
    expect(w2.backend.docKeyFor(sender)).toBe(doc);
    const d = details({
      requestId: 'b2',
      url: `${VW_ORIGIN}${LAZY_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
    });
    await w2.env.webRequest.onBeforeRequest.fire(d);
    await w2.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}],
    });
    const f = w2.env.filters.get('b2')!;
    f.respond(bytes('evil()'));
    await w2.settle();
    expect((await w2.tab(1))?.state).toBe('MISMATCH');
    expect(f.written).toHaveLength(0);
  });
});

/**
 * Removing a server whose tab is open raises nothing (no red PROTECTION_LOST permission-revoked, no
 * notification, incident or "Grant"); adding one marks its open tab untracked, as at start-up,
 * not "not protected".
 */
describe('servers removed or added while their tab is open', () => {
  it('removal: no alert or incident, and the tab shows the default icon, also after a restart', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w = await createWorld({cores: [core()], session, local, timers});
    await load(w, 1, 'r1', INDEX);
    w.env.tabs.push({id: 1, url: `${VW_ORIGIN}/`, status: 'complete'});
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    w.registry.origins = [];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    expect(await w.tab(1)).toBeNull();
    expect(w.sinks.alerts).toEqual([]);
    expect(await w.engine.listIncidents(10)).toEqual([]);
    expect(await w.engine.listAlerts()).toEqual([]);
    const again = await createWorld({cores: [core()], session, local, timers, origins: []});
    await again.settle();
    expect(await again.tab(1)).toBeNull();
    expect(again.sinks.alerts).toEqual([]);
  });

  it('removed and added again with the old tab kept open: the old tab still taints a new one', async () => {
    const w = await createWorld({cores: [core()]});
    await load(w, 1, 'r2', INDEX);
    w.registry.origins = [];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    w.registry.origins = [vwOrigin()];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST'});
    await load(w, 2, 'r3', INDEX);
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    await load(w, 1, 'r4', INDEX);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('adding a server whose tab is open marks the tab untracked, also in a restarted event page', async () => {
    for (const restarted of [false, true]) {
      const session = new FakeArea();
      const local = new FakeArea();
      const timers = new FakeTimers();
      if (restarted) await createWorld({cores: [core()], session, local, timers, origins: []});
      const w = await createWorld({cores: [core()], session, local, timers, origins: []});
      w.env.tabs.push({id: 5, url: `${VW_ORIGIN}/`, status: 'complete'});
      await w.settle();
      expect(await w.tab(5)).toBeNull();
      w.registry.origins = [vwOrigin()];
      await w.engine.originsChanged(w.registry.protectedOrigins());
      await w.settle();
      expect(await w.tab(5), `restarted=${restarted}`).toMatchObject({
        state: 'PROTECTION_LOST',
        reasons: ['untracked'],
      });
    }
  });

  // A document the backend never saw ran whatever its server sent: it taints its origin until it
  // ends, as one adopted at a content-script hello does (no content script reaches a document that
  // was already loaded when its server was added).
  it('the open tab of a server just added taints the origin until it is reloaded', async () => {
    const w = await createWorld({cores: [core()], origins: []});
    w.env.tabs.push({id: 5, url: `${VW_ORIGIN}/`, status: 'complete'});
    w.registry.origins = [vwOrigin()];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    expect(await w.tab(5)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    await load(w, 6, 'add1', INDEX);
    expect((await w.tab(6))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // The reload the guide asks for ends the orphan: the tab verifies, and so does a new one.
    await load(w, 5, 'add2', INDEX);
    expect((await w.tab(5))?.state).toBe('VERIFIED');
    await load(w, 7, 'add3', INDEX);
    expect((await w.tab(7))?.state).toBe('VERIFIED');
  });

  it('a window the open tab of a server just added opens is not VERIFIED', async () => {
    const w = await createWorld({cores: [core()], origins: []});
    w.env.tabs.push({id: 5, url: `${VW_ORIGIN}/`, status: 'complete'});
    w.registry.origins = [vwOrigin()];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    w.env.onCreatedNavigationTarget.emit({sourceTabId: 5, sourceFrameId: 0, tabId: 6});
    await w.settle();
    await load(w, 6, 'open1', INDEX);
    expect((await w.tab(6))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a tab loaded while the host permission was missing taints the origin once it is granted', async () => {
    const w = await createWorld({cores: [core()], origins: [vwOrigin(false)]});
    w.env.tabs.push({id: 5, url: `${VW_ORIGIN}/`, status: 'complete'});
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    expect(await w.tab(5)).toMatchObject({
      reasons: ['permission-revoked'],
      permissionMissing: true,
    });
    w.registry.origins = [vwOrigin(true)];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    expect(await w.tab(5)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    await load(w, 6, 'grant1', INDEX);
    expect((await w.tab(6))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a first start after an update (storage.session cleared) with an instance tab open: a new tab is not VERIFIED', async () => {
    const session = new FakeArea();
    const w = await createWorld({cores: [core()], session});
    w.env.tabs.push({id: 5, url: `${VW_ORIGIN}/`, status: 'complete'});
    session.data.clear();
    await w.engine.start();
    await w.settle();
    expect(await w.tab(5)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    await load(w, 6, 'upd1', INDEX);
    expect((await w.tab(6))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a tab still loading when its server is added is marked untracked too', async () => {
    const w = await createWorld({cores: [core()], origins: []});
    w.env.tabs.push({id: 6, url: `${VW_ORIGIN}/`, status: 'loading'});
    w.registry.origins = [vwOrigin()];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    expect(await w.tab(6)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
  });

  it('removing the server again clears a record no session holds (untracked, permission-revoked)', async () => {
    for (const granted of [true, false]) {
      const w = await createWorld({cores: [core()], origins: []});
      w.env.tabs.push({id: 5, url: `${VW_ORIGIN}/`, status: 'complete'});
      w.registry.origins = [vwOrigin(granted)];
      await w.engine.originsChanged(w.registry.protectedOrigins());
      await w.settle();
      expect(await w.tab(5), `granted=${granted}`).toMatchObject({
        state: 'PROTECTION_LOST',
        reasons: [granted ? 'untracked' : 'permission-revoked'],
      });
      w.registry.origins = [];
      await w.engine.originsChanged(w.registry.protectedOrigins());
      await w.settle();
      expect(await w.tab(5), `granted=${granted}`).toBeNull();
    }
  });
});
