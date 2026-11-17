/**
 * The origin alert flow end to end: one flag, one action. A red state with evidence raises the
 * alert; while it is open no page of the origin is green (RECOVERING, which replaces only
 * VERIFIED); Acknowledge closes it, also while the red document is still open, and neither a
 * re-evaluation nor an event-page restart reopens it. Co-resident pages leave no alert.
 */

import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {describe, expect, it} from 'vitest';
import {details, FakeArea, FakeTimers, type FakeStreamFilter} from './helpers/fakeExt.ts';
import {bytes, createWorld, VW_ORIGIN, vwCore, type World} from './helpers/world.ts';

const MAIN_PATH = '/app/main.0123456789abcdef0123.js';
const INDEX = bytes(
  '<!doctype html><html><head><script src="app/main.0123456789abcdef0123.js"></script></head></html>',
);
const NEW_INDEX = bytes(
  '<!doctype html><html><head><script src="app/main.ffffffffffffffffffff.js"></script></head></html>',
);
const MAIN = bytes('console.log("vault");');
const HTML = [{name: 'Content-Type', value: 'text/html; charset=utf-8'}];
const JS = [{name: 'Content-Type', value: 'text/javascript'}];
let seq = 1;

const cores = () => [vwCore('2026.10.1', {'/index.html': INDEX, [MAIN_PATH]: MAIN})];
const world = (more: Parameters<typeof createWorld>[0] = {}) =>
  createWorld({cores: cores(), ...more});

async function navigate(
  w: World,
  html: Uint8Array,
  {tab = 1, path = '/', status = 200}: {tab?: number; path?: string; status?: number} = {},
): Promise<FakeStreamFilter | undefined> {
  const d = details({
    requestId: `a${seq++}`,
    url: `${VW_ORIGIN}${path}`,
    type: 'main_frame',
    tabId: tab,
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  const filter = w.env.filters.get(d.requestId);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: status, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
  filter?.respond(html);
  await w.settle();
  return filter;
}

async function script(w: World, body: Uint8Array, tab = 1): Promise<void> {
  const d = details({
    requestId: `a${seq++}`,
    url: `${VW_ORIGIN}${MAIN_PATH}`,
    type: 'script',
    tabId: tab,
    documentUrl: `${VW_ORIGIN}/`,
    originUrl: `${VW_ORIGIN}/`,
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
  w.env.filters.get(d.requestId)?.respond(body);
  await w.settle();
}

/**
 * A lazy chunk of the vault in tab 1 whose StreamFilter fails after it held the response; the
 * request then completes (the rest went to the page).
 */
async function chunkFilterFails(w: World): Promise<void> {
  const d = details({
    requestId: `a${seq++}`,
    url: `${VW_ORIGIN}${MAIN_PATH}`,
    type: 'script',
    tabId: 1,
    documentUrl: `${VW_ORIGIN}/`,
    originUrl: `${VW_ORIGIN}/`,
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
  w.env.filters.get(d.requestId)!.onerror?.({});
  await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
  await w.settle();
}

const alerts = async (w: World) =>
  (await w.engine.listAlerts()).map(a => `${a.state} ${a.acknowledged ? 'closed' : 'open'}`);
const written = (f: FakeStreamFilter | undefined) => f?.output.length ?? -1;

describe('origin alerts', () => {
  it('a reload with genuine bytes is RECOVERING while the alert is open, VERIFIED once it is closed', async () => {
    const w = await world();
    await navigate(w, INDEX);
    await script(w, bytes('evil()'));
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('RECOVERING');
    await w.engine.acknowledgeAlert(VW_ORIGIN);
    await w.settle();
    // No reload needed: the open document turns green when the alert closes.
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    expect(await alerts(w)).toEqual(['MISMATCH closed']);
  });

  it('Acknowledge while the red document is still open sticks; a new red incident opens a new alert', async () => {
    const w = await world();
    await navigate(w, INDEX);
    await script(w, bytes('evil()'));
    await w.engine.acknowledgeAlert(VW_ORIGIN);
    await w.settle();
    expect(await alerts(w)).toEqual(['MISMATCH closed']);
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await navigate(w, INDEX);
    await script(w, bytes('evil2()'));
    expect(await alerts(w)).toEqual(['MISMATCH open']);
  });

  it('an event-page restart with the red document still open does not reopen a closed alert', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await world({session, local, timers});
    await navigate(w1, INDEX);
    await script(w1, bytes('evil()'));
    await w1.engine.acknowledgeAlert(VW_ORIGIN);
    await w1.settle();
    const w2 = await world({session, local, timers});
    await w2.settle();
    expect((await w2.tab(1))?.state).toBe('MISMATCH');
    expect(await alerts(w2)).toEqual(['MISMATCH closed']);
    expect(w2.sinks.alerts).toEqual([]);
  });

  it('a document already PROTECTION_LOST for a reason that raises nothing still raises the alert when evidence that code ran joins it', async () => {
    // An engine fault (internal-error, no alert), then a lazy chunk whose filter fails after it
    // held the response (the rest goes to the page unverified). The state stays PROTECTION_LOST,
    // but the alert's condition is met only now, so the alert opens and a later genuine reload is
    // not green.
    const w = await world();
    await navigate(w, INDEX);
    const doc = w.backend.docKeyFor({tab: 1, frame: 0, url: `${VW_ORIGIN}/`})!;
    await w.engine.push({k: 'engine-fault', fault: 'internal-error', doc});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
    expect(await alerts(w)).toEqual([]);
    await chunkFilterFails(w);
    expect((await w.tab(1))?.reasons).toContain('filter-failed');
    expect(await alerts(w)).toEqual(['PROTECTION_LOST open']);
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('RECOVERING');
  });

  it('a chunk whose filter could not be attached is cancelled: nothing of it ran, so no alert and no taint', async () => {
    const w = await world();
    await navigate(w, INDEX);
    await script(w, MAIN);
    w.env.filterError = () => new Error('filter failed');
    await script(w, MAIN);
    w.env.filterError = null;
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    expect(await alerts(w)).toEqual([]);
    expect(w.sinks.alerts.map(a => a.state)).toEqual(['PROTECTION_LOST']);
    // The vault next to it is not co-resident with anything that ran.
    await navigate(w, INDEX, {tab: 2});
    await script(w, MAIN, 2);
    expect((await w.tab(2))?.state).toBe('VERIFIED');
  });

  it('a chunk denied after R4 leaves its document red, with no alert and no taint', async () => {
    const w = await world();
    await navigate(w, INDEX);
    await script(w, MAIN);
    const d = details({
      requestId: `a${seq++}`,
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
    w.timers.advance(61_000);
    await w.settle();
    expect(w.env.filters.get(d.requestId)!.written).toHaveLength(0);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['timeout']});
    expect(await alerts(w)).toEqual([]);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
    await navigate(w, INDEX, {tab: 2});
    await script(w, MAIN, 2);
    expect((await w.tab(2))?.state).toBe('VERIFIED');
  });

  it("a server's own 404 page on the vault host: the blocked page, no alert, no incident, the vault next to it VERIFIED", async () => {
    const w = await world();
    await navigate(w, INDEX);
    await script(w, MAIN);
    const notFound = bytes('<!DOCTYPE html><html><body><h1>Page not found!</h1></body></html>');
    const f = await navigate(w, notFound, {tab: 2, path: '/no-such-page', status: 404});
    expect(written(f)).toBe(0);
    expect(await w.tab(2)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['unverifiable-active'],
    });
    const shown = w.env.tabsUpdated.find(u => u.tab === 2);
    expect(shown?.url).toMatch(/\/ui\/blocked\.html#[0-9a-f]{16}$/);
    const id = decodeURIComponent(shown!.url.slice(shown!.url.indexOf('#') + 1));
    expect(await w.engine.blockedView(id)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['unverifiable-active'],
      path: '/no-such-page',
      canProceedOnce: false,
    });
    expect(await alerts(w)).toEqual([]);
    expect(await w.engine.listIncidents(10)).toEqual([]);
    expect(w.sinks.alerts).toEqual([]);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    // A vault opened afterwards is green too.
    await navigate(w, INDEX, {tab: 3});
    await script(w, MAIN, 3);
    expect((await w.tab(3))?.state).toBe('VERIFIED');
  });

  it('a blob: frame the content script reports still raises the alert: code nobody verified may have run', async () => {
    const w = await world();
    await navigate(w, INDEX);
    await script(w, MAIN);
    const doc = w.backend.docKeyFor({tab: 1, frame: 0, url: `${VW_ORIGIN}/`})!;
    await w.engine.contentDom(
      {tab: 1, frame: 0, url: `${VW_ORIGIN}/`},
      {doc, event: 'blob-frame', detail: {count: 1}},
    );
    await w.settle();
    expect(await w.tab(1)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['unverifiable-active'],
    });
    expect(await alerts(w)).toEqual(['PROTECTION_LOST open']);
    expect((await w.engine.listIncidents(10)).map(i => i.kind)).toEqual(['protection-lost']);
    await navigate(w, INDEX, {tab: 2});
    await script(w, MAIN, 2);
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('an unverifiable build run by "Proceed once" next to the vault: amber while it is open, no stored alert, green again after it closes', async () => {
    const w = await world();
    await navigate(w, INDEX);
    await script(w, MAIN);
    const page = bytes('<html>unverified build</html>');
    await w.engine.allowForTab(2, {k: 'proceed-once', sha256: await sha256Hex(page)});
    await navigate(w, page, {tab: 2});
    expect((await w.tab(1))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect(await alerts(w)).toEqual([]);
    w.env.removedTabs.add(2);
    w.env.tabsOnRemoved.emit(2, {windowId: 1, isWindowClosing: false});
    await w.settle();
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('a server-chosen unknown document is denied: PROTECTION_LOST, but nothing of it ran, so no alert and the next genuine load is green', async () => {
    const w = await world();
    const f = await navigate(w, bytes('<html><form>fake login</form></html>'), {
      path: '/nope',
      status: 404,
    });
    expect(written(f)).toBe(0);
    expect((await w.tab(1))?.state).toBe('PROTECTION_LOST');
    expect(await alerts(w)).toEqual([]);
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('an open alert never releases a document that is denied (/admin, a new build)', async () => {
    const recovering = async (): Promise<World> => {
      const w = await world();
      await navigate(w, INDEX);
      await script(w, bytes('evil()'));
      await navigate(w, INDEX);
      await script(w, MAIN);
      expect((await w.tab(1))?.state).toBe('RECOVERING');
      return w;
    };
    const w1 = await recovering();
    const admin = await navigate(w1, bytes('<html><script>steal()</script></html>'), {
      tab: 2,
      path: '/admin/',
    });
    expect(written(admin)).toBe(0);
    expect((await w1.tab(2))?.state).toBe('NOT_COVERED');
    const w2 = await recovering();
    w2.registry.hint = {version: '2026.11.0', at: 0};
    const nb = await navigate(w2, NEW_INDEX, {tab: 3});
    expect(written(nb)).toBe(0);
    expect((await w2.tab(3))?.state).toBe('NEW_BUILD');
  });
});
