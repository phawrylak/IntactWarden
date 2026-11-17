/**
 * Origin taint: liveness that only a confirmed end can stop,
 * windows a taint source opens, and the sources beyond the document class (a document
 * that ran unverified code).
 *
 * A page outside the release (an admin or sign-in page) is always denied, and a denied page never
 * runs and taints nothing. The sources here are vault pages of a build nobody can check
 * (BUILD_UNVERIFIED: the server names no version), which run because the user chose "Proceed once".
 */

import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {describe, expect, it} from 'vitest';
import {details, FakeArea, FakeTimers} from './helpers/fakeExt.ts';
import type {ProtectedOrigin} from '../../src/contracts.ts';
import {bytes, createWorld, VW_ORIGIN, vwCore, vwOrigin, type World} from './helpers/world.ts';

const INDEX = bytes('<!doctype html><html></html>');
const core = (): ReturnType<typeof vwCore> => vwCore('2026.10.1', {'/index.html': INDEX});
const HTML = [{name: 'Content-Type', value: 'text/html'}];
const JS = [{name: 'Content-Type', value: 'text/javascript'}];
let seq = 1;

/** A page of an unverifiable build, released by "Proceed once" in its tab. */
const SOURCE = bytes('<html>unverified build</html>');

async function proceedOnce(w: World, tab: number, body = SOURCE): Promise<void> {
  await w.engine.allowForTab(tab, {k: 'proceed-once', sha256: await sha256Hex(body)});
}

async function source(w: World, tab: number, body = SOURCE): Promise<string> {
  await proceedOnce(w, tab, body);
  return open(w, tab, '/', body);
}

async function open(w: World, tab: number, path = '/', body = INDEX): Promise<string> {
  const req = `t${seq++}`;
  const url = `${VW_ORIGIN}${path}`;
  const d = details({requestId: req, url, type: 'main_frame', tabId: tab});
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
  w.env.filters.get(req)!.respond(body);
  await w.settle();
  return w.backend.docKeyFor({tab, frame: 0, url})!;
}

async function frame(
  w: World,
  tab: number,
  frameId: number,
  parentUrl: string,
  path = '/',
  body = INDEX,
): Promise<string> {
  if (body !== INDEX) await proceedOnce(w, tab, body);
  const req = `f${seq++}`;
  const url = `${VW_ORIGIN}${path}`;
  const d = details({
    requestId: req,
    url,
    type: 'sub_frame',
    tabId: tab,
    frameId,
    parentFrameId: 0,
    documentUrl: parentUrl,
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: tab, frameId, parentFrameId: 0, url, timeStamp: 0});
  w.env.filters.get(req)!.respond(body);
  await w.settle();
  return w.backend.docKeyFor({tab, frame: frameId, url})!;
}

/** The persisted taint entries of the vault origin: source DocKeys and `opened:<tab>` holds. */
function taintKeys(w: World): string[] {
  const rec = w.env.session.data.get(`s:v1:taint:${VW_ORIGIN}`) as
    {sources: Record<string, unknown>} | undefined;
  return Object.keys(rec?.sources ?? {}).sort();
}

describe('taint liveness', () => {
  // A source ends only when its frame commits another document, Firefox reports the frame gone
  // (webNavigation.getFrame) or its tab closes; nothing the page itself does can end it.
  it('a source whose frame still shows it keeps tainting: a vault opened later is not VERIFIED', async () => {
    const w = await createWorld({cores: [core()]});
    await source(w, 2);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    await open(w, 1);
    expect((await w.tab(1))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // The source's own tab still shows it (not "This site is not protected").
    expect((await w.tab(2))?.state).toBe('BUILD_UNVERIFIED');
  });

  it('a denied page never runs and taints nothing', async () => {
    const w = await createWorld({cores: [core()]});
    const req = `t${seq++}`;
    const url = `${VW_ORIGIN}/evil.html`;
    const d = details({requestId: req, url, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get(req)!.respond(bytes('<html>evil</html>'));
    await w.settle();
    expect(w.env.filters.get(req)!.written).toHaveLength(0);
    expect(taintKeys(w)).toEqual([]);
    await open(w, 1);
    // Not co-resident, and no alert: nothing of the denied page ran.
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', top: {coResident: null}});
  });

  it('an /admin page is denied (no allowance can release it) and taints nothing', async () => {
    const w = await createWorld({cores: [core()]});
    const req = `t${seq++}`;
    const url = `${VW_ORIGIN}/admin`;
    const d = details({requestId: req, url, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get(req)!.respond(bytes('<html>admin</html>'));
    await w.settle();
    expect(w.env.filters.get(req)!.written).toHaveLength(0);
    expect((await w.tab(2))?.state).toBe('NOT_COVERED');
    expect(taintKeys(w)).toEqual([]);
    await open(w, 1);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('a source that frames the vault does not get a green tab', async () => {
    const w = await createWorld({cores: [core()]});
    await source(w, 2);
    await frame(w, 2, 9, `${VW_ORIGIN}/`);
    const rec = await w.tab(2);
    expect(rec?.state).not.toBe('VERIFIED');
    expect(rec?.frames.find(f => f.frame === 9)?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a page run by "Proceed once" that loads a script and frames the vault is not VERIFIED', async () => {
    const w = await createWorld({cores: [core()]});
    const page = `${VW_ORIGIN}/`;
    const sso = bytes('<html><script src="/evil.js"></script></html>');
    await proceedOnce(w, 2, sso);
    const d = details({requestId: 'a1', url: page, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url: page, timeStamp: 0});
    w.env.filters.get('a1')!.respond(sso);
    await w.settle();
    const s = details({
      requestId: 'a2',
      url: `${VW_ORIGIN}/evil.js`,
      type: 'script',
      tabId: 2,
      documentUrl: page,
    });
    await w.env.webRequest.onBeforeRequest.fire(s);
    await w.env.webRequest.onHeadersReceived.fire({...s, statusCode: 200, responseHeaders: JS});
    w.env.filters.get('a2')?.respond(bytes('/* page script */'));
    await w.settle();
    await frame(w, 2, 11, page);
    expect((await w.tab(2))?.state).not.toBe('VERIFIED');
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  // A source in a frame can script its whole tab (a same-origin parent, a sibling frame it
  // navigates to about:blank), so its tab holds the taint until it closes; the source entry itself
  // still ends only on a confirmed end.
  it('a removed iframe source ends once the frame is confirmed gone; its tab holds the taint until it closes', async () => {
    const w = await createWorld({cores: [core()]});
    await open(w, 1);
    const src = await frame(w, 1, 5, `${VW_ORIGIN}/`, '/', SOURCE);
    expect(taintKeys(w)).toEqual(expect.arrayContaining([src, 'opened:1']));
    // The frame is removed (no navigation event says so): the next document of the origin to
    // start checks the sources, and Firefox confirms this one gone.
    w.env.goneFrames.add('1:5');
    await open(w, 2);
    expect(taintKeys(w)).toEqual(['opened:1']);
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    w.env.tabsOnRemoved.emit(1, {windowId: 1, isWindowClosing: false});
    await w.settle();
    expect(taintKeys(w)).toEqual([]);
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('VERIFIED');
  });

  it('a source the backend’s frame map moved away from is still displayed, so it keeps tainting', async () => {
    // The frame map follows a navigation before its commit when a request names the new document
    // (DocKeys.forFrame); a navigation that never commits (a download) leaves it there. Only
    // Firefox decides that a document is gone, so the source must stay.
    const w = await createWorld({cores: [core()]});
    const src = await source(w, 2);
    const nav = details({
      requestId: `t${seq++}`,
      url: `${VW_ORIGIN}/file.bin`,
      type: 'main_frame',
      tabId: 2,
    });
    await w.env.webRequest.onBeforeRequest.fire(nav);
    await w.env.webRequest.onBeforeRequest.fire(
      details({
        requestId: `t${seq++}`,
        url: `${VW_ORIGIN}/app/x.js`,
        type: 'script',
        tabId: 2,
        documentUrl: `${VW_ORIGIN}/file.bin`,
      }),
    );
    await w.settle();
    expect(w.backend.docKeyFor({tab: 2, frame: 0, url: null})).not.toBe(src);
    expect(await w.backend.documentGone(2, 0)).toBe(false);
    await open(w, 3);
    expect(taintKeys(w)).toContain(src);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });
});

describe('taint is per origin', () => {
  it('a source on one origin leaves a vault of another origin of the same site VERIFIED', async () => {
    const OTHER = 'http://127.0.0.1:8082';
    const base = vwOrigin();
    const other: ProtectedOrigin = {
      ...base,
      origin: OTHER,
      instance: {...base.instance!, origin: OTHER, id: '1111111111111111'},
    };
    const w = await createWorld({cores: [core()], origins: [base, other]});
    await source(w, 1);
    expect(taintKeys(w)).toHaveLength(1);
    const req = `t${seq++}`;
    const url = `${OTHER}/`;
    const d = details({requestId: req, url, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get(req)!.respond(INDEX);
    await w.settle();
    expect((await w.tab(2))?.state).toBe('VERIFIED');
    expect(w.env.session.data.has(`s:v1:taint:${OTHER}`)).toBe(false);
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });
});

describe('windows a taint source opens', () => {
  it('a popup opened by a source keeps the taint after the source navigates to the vault, until the popup closes', async () => {
    const w = await createWorld({cores: [core()]});
    await source(w, 2);
    // window.open('about:blank'): no request names the popup, only the navigation event does.
    w.env.onCreatedNavigationTarget.emit({
      sourceTabId: 2,
      sourceFrameId: 0,
      tabId: 3,
      url: 'about:blank',
      timeStamp: 0,
    });
    await w.settle();
    // The source navigates its own tab to the vault; the popup keeps a handle to that frame.
    await open(w, 2);
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // The popup opens another window: the hold follows it.
    w.env.onCreatedNavigationTarget.emit({
      sourceTabId: 3,
      sourceFrameId: 0,
      tabId: 4,
      url: 'about:blank',
      timeStamp: 0,
    });
    await w.settle();
    w.env.tabsOnRemoved.emit(3, {windowId: 1, isWindowClosing: false});
    await w.settle();
    await open(w, 5);
    expect((await w.tab(5))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    w.env.tabsOnRemoved.emit(4, {windowId: 1, isWindowClosing: false});
    await w.settle();
    // The popup could navigate its opener (the source's tab) to about:blank and script it, so that
    // tab holds the taint too until it closes.
    expect(taintKeys(w)).toEqual(['opened:2']);
    await open(w, 6);
    expect((await w.tab(6))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    w.env.tabsOnRemoved.emit(2, {windowId: 1, isWindowClosing: false});
    await w.settle();
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
    await open(w, 7);
    expect((await w.tab(7))?.state).toBe('VERIFIED');
  });

  it('a window opened by a verified vault document holds nothing', async () => {
    const w = await createWorld({cores: [core()]});
    await open(w, 1);
    w.env.onCreatedNavigationTarget.emit({
      sourceTabId: 1,
      sourceFrameId: 0,
      tabId: 2,
      url: 'about:blank',
      timeStamp: 0,
    });
    await w.settle();
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('VERIFIED');
  });

  it('a restart releases holds of tabs that closed meanwhile', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core()], session, local, timers});
    await source(w1, 2);
    w1.env.onCreatedNavigationTarget.emit({
      sourceTabId: 2,
      sourceFrameId: 0,
      tabId: 7,
      url: 'about:blank',
      timeStamp: 0,
    });
    await w1.settle();
    w1.env.tabsOnRemoved.emit(2, {windowId: 1, isWindowClosing: false});
    await w1.settle();
    expect(session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    // The event page stops; tab 7 closes while nothing listens.
    const w2 = await createWorld({cores: [core()], session, local, timers});
    w2.env.removedTabs.add(7);
    await w2.engine.start();
    await w2.settle();
    expect(session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
  });
});

/**
 * A `blob:` document has the origin of the document that created it and can script that origin's
 * windows, but no request and no content script names it. A taint source that navigates its own
 * tab to a blob: URL it made must not lose its taint at the commit, or a vault the blob page then
 * opens would read VERIFIED.
 */
describe('a same-origin blob: document keeps its tab tainting', () => {
  const BLOB = `blob:${VW_ORIGIN}/0b0f6f0e-1111-4222-8333-444455556666`;
  const commitBlob = async (w: World, tab: number, url = BLOB): Promise<void> => {
    w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    await w.settle();
  };
  const opens = async (w: World, from: number, to: number): Promise<void> => {
    w.env.onCreatedNavigationTarget.emit({
      sourceTabId: from,
      sourceFrameId: 0,
      tabId: to,
      url: `${VW_ORIGIN}/`,
      timeStamp: 0,
    });
    await w.settle();
  };

  it('a source that becomes a blob: page and opens the vault: not VERIFIED', async () => {
    const w = await createWorld({cores: [core()]});
    await source(w, 2);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    await commitBlob(w, 2);
    await opens(w, 2, 3);
    await open(w, 3);
    const t = await w.tab(3);
    expect(t?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect(t?.top?.coResident).toEqual({class: 'unverifiable', sourcePath: 'blob:'});
    // A vault the user opens in an unrelated tab is flagged too, as for any live source.
    await open(w, 5);
    expect((await w.tab(5))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a blob: page in a vault tab taints the origin until its tab closes', async () => {
    const w = await createWorld({cores: [core()]});
    await open(w, 1);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await commitBlob(w, 1);
    await opens(w, 1, 3);
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // The opened window keeps its own hold; once both tabs are closed nothing taints any more.
    w.env.tabsOnRemoved.emit(1, {windowId: 1, isWindowClosing: false});
    w.env.tabsOnRemoved.emit(3, {windowId: 1, isWindowClosing: false});
    await w.settle();
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
    await open(w, 4);
    expect((await w.tab(4))?.state).toBe('VERIFIED');
  });

  it('a restart keeps the holds of tabs still open: the blob: tab and the window it opened', async () => {
    // The event page rests whenever it is idle: a restart must release only holds of closed tabs.
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core()], session, local, timers});
    await open(w1, 1);
    await commitBlob(w1, 1);
    await opens(w1, 1, 3);
    expect(taintKeys(w1)).toEqual(['opened:1', 'opened:3']);
    const w2 = await createWorld({cores: [core()], session, local, timers});
    await w2.settle();
    expect(taintKeys(w2)).toEqual(['opened:1', 'opened:3']);
    await open(w2, 5);
    expect((await w2.tab(5))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // The window keeps its own hold after the blob: tab closes, and the taint ends with it.
    w2.env.tabsOnRemoved.emit(1, {windowId: 1, isWindowClosing: false});
    await w2.settle();
    expect(taintKeys(w2)).toEqual(['opened:3']);
    w2.env.tabsOnRemoved.emit(3, {windowId: 1, isWindowClosing: false});
    await w2.settle();
    await open(w2, 6);
    expect((await w2.tab(6))?.state).toBe('VERIFIED');
  });

  it('a blob: document of another origin taints nothing', async () => {
    const w = await createWorld({cores: [core()]});
    await commitBlob(w, 2, 'blob:https://example.org/0b0f6f0e-1111-4222-8333-444455556666');
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('VERIFIED');
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
  });
});

/**
 * A document a page navigates to `about:blank` takes the origin of the page that navigated it, and
 * its URL names nothing. A source could navigate its opener to about:blank, script it and close
 * itself; the about:blank page could then open the vault. So the tabs that opened a source's tab
 * hold its taint until they close.
 */
describe('the tab that opened a taint source holds its taint', () => {
  const opens = async (w: World, from: number, to: number, url: string): Promise<void> => {
    w.env.onCreatedNavigationTarget.emit({
      sourceTabId: from,
      sourceFrameId: 0,
      tabId: to,
      url,
      timeStamp: 0,
    });
    await w.settle();
  };
  const commit = async (w: World, tab: number, url: string): Promise<void> => {
    w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    await w.settle();
  };

  it('a source that makes its opener an about:blank page and closes: the vault it opens is not VERIFIED', async () => {
    const w = await createWorld({cores: [core()]});
    await commit(w, 1, 'https://attacker.example/');
    await opens(w, 1, 2, `${VW_ORIGIN}/`);
    await source(w, 2);
    // opener.location = 'about:blank', then the source writes its script into it and closes.
    await commit(w, 1, 'about:blank');
    w.env.tabsOnRemoved.emit(2, {windowId: 1, isWindowClosing: false});
    await w.settle();
    await opens(w, 1, 3, `${VW_ORIGIN}/`);
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    // Once the opener tab closes, nothing taints any more.
    w.env.tabsOnRemoved.emit(1, {windowId: 1, isWindowClosing: false});
    w.env.tabsOnRemoved.emit(3, {windowId: 1, isWindowClosing: false});
    await w.settle();
    expect(taintKeys(w)).toEqual([]);
    await open(w, 4);
    expect((await w.tab(4))?.top?.coResident).toBeNull();
  });

  it('the opener relation survives an event-page restart', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core()], session, local, timers});
    await commit(w1, 1, 'https://attacker.example/');
    await opens(w1, 1, 2, `${VW_ORIGIN}/`);
    const w2 = await createWorld({cores: [core()], session, local, timers});
    await w2.settle();
    await source(w2, 2);
    expect(taintKeys(w2)).toContain('opened:1');
  });

  it('a source in a frame of another site holds that tab: a sibling frame it scripted outlives it', async () => {
    const w = await createWorld({cores: [core()]});
    await commit(w, 1, 'https://attacker.example/');
    const src = await frame(w, 1, 5, 'https://attacker.example/', '/', SOURCE);
    expect(taintKeys(w)).toEqual(expect.arrayContaining([src, 'opened:1']));
    // The attacker's page removes the source's frame; a sibling about:blank frame stays.
    w.env.goneFrames.add('1:5');
    await opens(w, 1, 3, `${VW_ORIGIN}/`);
    await open(w, 3);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });
});

describe('a verified document that ran unverified code is a taint source', () => {
  const PAGE = bytes('<!doctype html><script src="/app/main.js"></script>');
  const MAIN = bytes('console.log(1)');
  const vw = (): ReturnType<typeof vwCore> =>
    vwCore('2026.10.1', {'/index.html': PAGE, '/app/main.js': MAIN});

  async function openWithScript(w: World, tab: number, scriptFails: boolean): Promise<void> {
    await open(w, tab, '/', PAGE);
    const sreq = `s${seq++}`;
    if (scriptFails)
      w.env.filterError = id => (id === sreq ? new Error('Invalid request ID') : null);
    const s = details({
      requestId: sreq,
      url: `${VW_ORIGIN}/app/main.js`,
      type: 'script',
      tabId: tab,
      documentUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(s);
    await w.env.webRequest.onHeadersReceived.fire({...s, statusCode: 200, responseHeaders: JS});
    if (!scriptFails) w.env.filters.get(sreq)!.respond(MAIN);
    await w.env.webRequest.onCompleted.fire({...s, statusCode: 200});
    w.env.filterError = null;
    await w.settle();
  }

  it('a vault tab whose script a service worker served taints the other vault tabs', async () => {
    const w = await createWorld({cores: [vw()]});
    await openWithScript(w, 1, false);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await openWithScript(w, 2, true);
    expect((await w.tab(2))?.state).toBe('PROTECTION_LOST');
    expect((await w.tab(1))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    await openWithScript(w, 3, false);
    expect((await w.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect((await w.tab(3))?.top?.coResident).toEqual({class: 'unverifiable', sourcePath: '/'});
  });
});

describe('a protected frame inside another site', () => {
  async function framed(w: World, body: Uint8Array): Promise<void> {
    const tab = 7;
    const top = details({
      requestId: `x${seq++}`,
      url: 'https://attacker.example/login',
      type: 'main_frame',
      tabId: tab,
    });
    await w.env.webRequest.onBeforeRequest.fire(top);
    w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url: top.url, timeStamp: 0});
    const req = `x${seq++}`;
    const fr = details({
      requestId: req,
      url: `${VW_ORIGIN}/`,
      type: 'sub_frame',
      tabId: tab,
      frameId: 42,
      parentFrameId: 0,
      documentUrl: top.url,
      frameAncestors: [{url: top.url, frameId: 0}],
    });
    await w.env.webRequest.onBeforeRequest.fire(fr);
    await w.env.webRequest.onHeadersReceived.fire({...fr, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: tab, frameId: 42, parentFrameId: 0, url: fr.url, timeStamp: 0});
    w.env.filters.get(req)!.respond(body);
    await w.settle();
  }

  it('a verified vault frame never makes the other site’s tab VERIFIED', async () => {
    const w = await createWorld({cores: [core()]});
    await framed(w, INDEX);
    expect(await w.tab(7)).toBeNull();
  });

  it('a mismatching vault frame still shows on the other site’s tab', async () => {
    const w = await createWorld({cores: [core()]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    await framed(w, bytes('<html>tampered</html>'));
    const rec = await w.tab(7);
    expect(rec?.state).toBe('MISMATCH');
    expect(rec?.origin).toBe(VW_ORIGIN);
  });
});

describe('a document whose bytes were not held still taints', () => {
  it('a document whose StreamFilter fails (onerror) is a source: another vault tab stays CO_RESIDENT_UNVERIFIED, also after the alert is closed', async () => {
    const w = await createWorld({cores: [core()]});
    const url = `${VW_ORIGIN}/`;
    const d2 = details({requestId: 'onerror1', url, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d2);
    await w.env.webRequest.onHeadersReceived.fire({...d2, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    // The filter is gone: Firefox delivers whatever the server sends, unheld.
    w.env.filters.get('onerror1')!.onerror?.({});
    await w.settle();
    const t2 = await w.tab(2);
    expect(t2).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    expect(t2?.flags).not.toContain('BLOCKED');
    expect(taintKeys(w)).toHaveLength(1);
    await w.engine.acknowledgeAlert(VW_ORIGIN);
    await open(w, 1);
    expect(await w.tab(1)).toMatchObject({
      state: 'CO_RESIDENT_UNVERIFIED',
      top: {coResident: {class: 'unverifiable'}},
    });
  });

  it('a new build loaded while a source is open waits for its release on the blocked page (NEW_BUILD, retry)', async () => {
    const w = await createWorld({cores: [core()]});
    await source(w, 2);
    w.registry.hint = {version: '2026.11.0', at: 0};
    await open(w, 1, '/', bytes('<html>new build</html>'));
    // The tab's own state is the co-resident amber; the denial comes from the document's NEW_BUILD.
    expect(await w.tab(1)).toMatchObject({state: 'CO_RESIDENT_UNVERIFIED'});
    const inc = (await w.engine.listIncidents(10)).find(i => i.state === 'NEW_BUILD');
    expect(inc).toMatchObject({kind: 'build-unverified', reasons: ['catching-up']});
    expect(await w.engine.blockedView(inc!.id)).toMatchObject({
      state: 'NEW_BUILD',
      retry: true,
      canProceedOnce: false,
    });
  });
});
