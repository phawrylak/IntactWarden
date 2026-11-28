/**
 * Firefox backend + engine: StreamFilter event streams on the fake Ext through the real engine and
 * policy kernel. Covers VERIFIED, MISMATCH (denied), unknown build → deep verify,
 * retro-verification of a document the user proceeded with once, sw-served, the header guard, and
 * restart with an unclosed persisted filter (fail closed).
 */

import {describe, expect, it, vi} from 'vitest';
import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {isOwnRequest} from '../../src/backends/firefox/index.ts';
import {r4Ms, SESSION_LIMITS} from '../../src/contracts.ts';
import {popupView} from '../../src/ui/popup/model.ts';
import type {WebRequestDetails} from '../../src/platform/webext.ts';
import {details, FakeArea, FakeTimers, type FakeStreamFilter} from '../engine/helpers/fakeExt.ts';
import {
  bytes,
  createWorld,
  VW_ORIGIN,
  vwCore,
  vwOrigin,
  type World,
} from '../engine/helpers/world.ts';

const INDEX = bytes(
  '<!doctype html><html><head><script src="app/main.0123456789abcdef0123.js"></script></head></html>',
);
const MAIN = bytes('console.log("vault");');
const MAIN_PATH = '/app/main.0123456789abcdef0123.js';
const core1 = (): ReturnType<typeof vwCore> =>
  vwCore('2026.10.1', {'/index.html': INDEX, [MAIN_PATH]: MAIN});

const HTML = [{name: 'Content-Type', value: 'text/html; charset=utf-8'}];
const JS = [{name: 'Content-Type', value: 'text/javascript'}];

let seq = 100;

const OWN_PAGE = 'moz-extension://test-extension-id/ui/blocked.html';

async function navigate(
  w: World,
  html: Uint8Array,
  opts: {tab?: number; headers?: {name: string; value: string}[]; originUrl?: string} = {},
): Promise<{
  filter: FakeStreamFilter;
  req: string;
}> {
  const tab = opts.tab ?? 1;
  const req = String(seq++);
  const d = details({
    requestId: req,
    url: `${VW_ORIGIN}/`,
    type: 'main_frame',
    tabId: tab,
    ...(opts.originUrl !== undefined ? {originUrl: opts.originUrl} : {}),
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  const filter = w.env.filters.get(req)!;
  const hr = await w.env.webRequest.onHeadersReceived.fire({
    ...d,
    statusCode: 200,
    responseHeaders: opts.headers ?? HTML,
  });
  expect(hr[0]?.cancel).not.toBe(true);
  w.env.onCommitted.emit({
    tabId: tab,
    frameId: 0,
    parentFrameId: -1,
    url: `${VW_ORIGIN}/`,
    timeStamp: 0,
  });
  filter.respond(html);
  await w.settle();
  await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
  await w.settle();
  return {filter, req};
}

async function script(
  w: World,
  body: Uint8Array,
  path = MAIN_PATH,
  tab = 1,
): Promise<FakeStreamFilter | undefined> {
  const req = String(seq++);
  const d: WebRequestDetails = details({
    requestId: req,
    url: `${VW_ORIGIN}${path}`,
    type: 'script',
    tabId: tab,
    documentUrl: `${VW_ORIGIN}/`,
    originUrl: `${VW_ORIGIN}/`,
  });
  const before = await w.env.webRequest.onBeforeRequest.fire(d);
  if (before[0]?.cancel === true) return undefined;
  const filter = w.env.filters.get(req);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
  filter?.respond(body);
  await w.settle();
  return filter;
}

const UNPUBLISHED = {app: 'vaultwarden-web', variant: 'release', version: '2026.11.0'} as const;

/**
 * A document of a build no release explains (BUILD_UNVERIFIED selfhost-unpublished) is denied; the
 * user chooses "Proceed once" and reloads: the one path on which an unbound document runs, so its
 * subresources are recorded for retro-verification.
 */
async function proceedOnceUnbound(w: World): Promise<void> {
  w.registry.hint = {version: '2026.11.0', at: 0};
  w.trust.fail(UNPUBLISHED, 'release-not-found');
  const denied = await navigate(w, INDEX);
  expect(denied.filter.written).toHaveLength(0);
  expect((await w.tab(1))?.state).toBe('BUILD_UNVERIFIED');
  await w.engine.allowForTab(1, {k: 'proceed-once', sha256: await sha256Hex(INDEX)});
  const doc = await navigate(w, INDEX);
  expect(doc.filter.output).toEqual(INDEX);
}

describe('Firefox backend', () => {
  it('VERIFIED: document and script match the bound core; exactly the hashed bytes are written', async () => {
    const w = await createWorld({cores: [core1()]});
    const doc = await navigate(w, INDEX);
    expect(doc.filter.closed).toBe(true);
    expect(doc.filter.output).toEqual(INDEX);
    const js = await script(w, MAIN);
    expect(js?.output).toEqual(MAIN);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.top?.binding?.buildId).toBe('vaultwarden-web@2026.10.1+release');
    expect(t?.top?.counts.scripts).toEqual({ok: 1, total: 1});
    expect(w.sinks.alerts).toHaveLength(0);
  });

  it('a request that ends while its body is being hashed is still judged on its body', async () => {
    // The body takes its place on the request's chain before it is hashed (off the main thread),
    // so the 'completed' that follows cannot overtake it and judge the item without a body.
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const req = String(seq++);
    const d: WebRequestDetails = details({
      requestId: req,
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const filter = w.env.filters.get(req)!;
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
    filter.respond(MAIN);
    void w.env.webRequest.onErrorOccurred.fire({...d, error: 'NS_BINDING_ABORTED'});
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.top?.counts.scripts).toEqual({ok: 1, total: 1});
  });

  it('a navigation an extension page started (tabs.create/update, the blocked page) is verified', async () => {
    // Firefox names the extension page as originUrl of a top-level load it triggered; that load
    // is not the extension's own request and its document is filtered (e2e bw-genuine).
    const w = await createWorld({cores: [core1()]});
    const doc = await navigate(w, INDEX, {originUrl: OWN_PAGE});
    expect(doc.filter.output).toEqual(INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('a document an extension page navigated to is still denied when it mismatches', async () => {
    const other = vwCore('2026.10.1', {'/index.html': bytes('<html>other</html>')});
    const w = await createWorld({cores: [other]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    const doc = await navigate(w, INDEX, {originUrl: OWN_PAGE});
    expect(doc.filter.written).toHaveLength(0);
    expect(w.env.tabsUpdated.at(-1)?.url).toMatch(/\/ui\/blocked\.html#[0-9a-f]{16}$/);
    expect((await w.tab(1))?.state).toBe('MISMATCH');
  });

  it("own requests: the extension's fetches, never a page load it started", () => {
    const base = 'moz-extension://test-extension-id/';
    const bg = `${base}_generated_background_page.html`;
    const page = 'http://127.0.0.1:8080/';
    // Background probe/hint fetches.
    expect(isOwnRequest({type: 'xmlhttprequest', documentUrl: bg, originUrl: bg}, base)).toBe(true);
    // Top-level loads are never own, whoever triggered them.
    expect(isOwnRequest({type: 'main_frame', originUrl: OWN_PAGE}, base)).toBe(false);
    // A frame inside an extension page is own; a frame inside the vault is not.
    expect(
      isOwnRequest({type: 'sub_frame', documentUrl: OWN_PAGE, originUrl: OWN_PAGE}, base),
    ).toBe(true);
    expect(isOwnRequest({type: 'sub_frame', documentUrl: page, originUrl: OWN_PAGE}, base)).toBe(
      false,
    );
    // A page's script, even when an extension principal triggered it.
    expect(isOwnRequest({type: 'script', documentUrl: page, originUrl: base}, base)).toBe(false);
    expect(isOwnRequest({type: 'script', documentUrl: page, originUrl: page}, base)).toBe(false);
  });

  it('host permission revoked while a script is in flight: no false header MISMATCH', async () => {
    // The backend stops reporting headers once the origin is no longer granted, so the body
    // arrives without a headers observation. Its empty Content-Type is no header violation: no red
    // MISMATCH and no origin alert for bytes that match the release (e2e permission-revoked).
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const req = String(seq++);
    const d: WebRequestDetails = details({
      requestId: req,
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const filter = w.env.filters.get(req)!;
    w.registry.origins = [vwOrigin(false)];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
    filter.respond(MAIN);
    await w.settle();
    // Unverifiable without its headers: denied, but not a MISMATCH (red needs evidence).
    expect(filter.written).toHaveLength(0);
    const t = await w.tab(1);
    expect(t?.state).toBe('PROTECTION_LOST');
    expect(t?.reasons).toContain('permission-revoked');
    expect(t?.reasons).not.toContain('header');
    expect(w.sinks.alerts.filter(a => a.state === 'MISMATCH')).toHaveLength(0);
    expect((await w.engine.listAlerts()).filter(a => a.state === 'MISMATCH')).toEqual([]);
    const item = (await w.engine.details(1))?.docs[0]?.items.find(i => i.path === MAIN_PATH);
    expect(item?.outcome).toEqual({r: 'unverifiable', reason: 'no-host-permission'});
  });

  for (const order of ['error-after-redirect', 'error-before-redirect'] as const) {
    it(`a same-origin document redirect (/index.html 303 → /) is one VERIFIED document (${order})`, async () => {
      // Firefox fires onBeforeRequest again with the same request id for the next hop and drops
      // the first hop's StreamFilter (it reports an error). A first-hop session that never gets a
      // body must not stay CHECKING, then turn PROTECTION_LOST (timeout or filter-failed) with a
      // sticky alert (e2e vw-index-redirect).
      const w = await createWorld({cores: [core1()]});
      const req = 'redir1';
      const d1 = details({requestId: req, url: `${VW_ORIGIN}/index.html`, type: 'main_frame'});
      await w.env.webRequest.onBeforeRequest.fire(d1);
      const f1 = w.env.filters.get(req)!;
      const h1 = await w.env.webRequest.onHeadersReceived.fire({
        ...d1,
        statusCode: 303,
        responseHeaders: [{name: 'Location', value: '/'}],
      });
      expect(h1[0]?.cancel).not.toBe(true);
      if (order === 'error-before-redirect') f1.onerror?.({});
      await w.env.webRequest.onBeforeRedirect.fire({
        ...d1,
        statusCode: 303,
        redirectUrl: `${VW_ORIGIN}/`,
      });
      if (order === 'error-after-redirect') f1.onerror?.({});
      await w.settle();
      const d2 = details({requestId: req, url: `${VW_ORIGIN}/`, type: 'main_frame'});
      await w.env.webRequest.onBeforeRequest.fire(d2);
      const f2 = w.env.filters.get(req)!;
      expect(f2).not.toBe(f1);
      await w.env.webRequest.onHeadersReceived.fire({
        ...d2,
        statusCode: 200,
        responseHeaders: HTML,
      });
      w.env.onCommitted.emit({
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        url: `${VW_ORIGIN}/`,
        timeStamp: 0,
      });
      f2.respond(INDEX);
      await w.settle();
      await w.env.webRequest.onCompleted.fire({...d2, statusCode: 200});
      await script(w, MAIN);
      expect(f2.output).toEqual(INDEX);
      let t = await w.tab(1);
      expect(t?.state).toBe('VERIFIED');
      expect(t?.flags).not.toContain('CHECKING');
      expect(t?.top?.path).toBe('/');
      expect(t?.frames).toEqual([]);
      w.timers.advance(61_000);
      await w.settle();
      t = await w.tab(1);
      expect(t?.state).toBe('VERIFIED');
      expect(w.sinks.alerts).toHaveLength(0);
      expect(await w.engine.listAlerts()).toEqual([]);
    });
  }

  it('a sub-path address typed without its slash: the 301 to the base path is followed, the landing VERIFIED', async () => {
    // A reverse proxy answers "/vw" with a 301 to "/vw/".
    const base = vwOrigin();
    const sub = {...base, basePath: '/vw/', instance: {...base.instance!, base_path: '/vw/'}};
    const w = await createWorld({cores: [core1()], origins: [sub]});
    const req = 'slashless';
    const d1 = details({requestId: req, url: `${VW_ORIGIN}/vw`, type: 'main_frame'});
    await w.env.webRequest.onBeforeRequest.fire(d1);
    const h1 = await w.env.webRequest.onHeadersReceived.fire({
      ...d1,
      statusCode: 301,
      responseHeaders: [{name: 'Location', value: '/vw/'}],
    });
    expect(h1[0]?.cancel).not.toBe(true);
    // Any other target is still cancelled.
    const d0 = details({requestId: 'elsewhere', url: `${VW_ORIGIN}/vw`, type: 'main_frame'});
    await w.env.webRequest.onBeforeRequest.fire(d0);
    const h0 = await w.env.webRequest.onHeadersReceived.fire({
      ...d0,
      statusCode: 301,
      responseHeaders: [{name: 'Location', value: '/vw/evil.html'}],
    });
    expect(h0[0]?.cancel).toBe(true);
    await w.env.webRequest.onBeforeRedirect.fire({
      ...d1,
      statusCode: 301,
      redirectUrl: `${VW_ORIGIN}/vw/`,
    });
    w.env.filters.get(req)!.onerror?.({});
    await w.settle();
    const d2 = details({requestId: req, url: `${VW_ORIGIN}/vw/`, type: 'main_frame'});
    await w.env.webRequest.onBeforeRequest.fire(d2);
    const f2 = w.env.filters.get(req)!;
    await w.env.webRequest.onHeadersReceived.fire({...d2, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/vw/`,
      timeStamp: 0,
    });
    f2.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...d2, statusCode: 200});
    await w.settle();
    expect(f2.output).toEqual(INDEX);
    expect((await w.tab(1))?.top?.binding?.buildId).toBe('vaultwarden-web@2026.10.1+release');
  });

  it('MISMATCH: the script is denied (nothing written), red alert, sticky origin alert', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const js = await script(w, bytes('console.log("exfiltrate");'));
    expect(js?.closed).toBe(true);
    expect(js?.written).toHaveLength(0);
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toContain('bytes');
    expect(w.sinks.alerts.at(-1)?.state).toBe('MISMATCH');
    const alerts = await w.engine.listAlerts();
    expect(alerts[0]).toMatchObject({origin: VW_ORIGIN, state: 'MISMATCH', acknowledged: false});
    // The alert survives a reload until acknowledged, and withholds green meanwhile; Acknowledge
    // turns the genuine reload VERIFIED.
    await navigate(w, INDEX);
    expect(await w.tab(1)).toMatchObject({state: 'RECOVERING', alert: {state: 'MISMATCH'}});
    await w.engine.acknowledgeAlert(VW_ORIGIN);
    await w.settle();
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('a body whose session is gone is denied, not released (R1)', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const req = String(seq++);
    const d: WebRequestDetails = details({
      requestId: req,
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
    const filter = w.env.filters.get(req)!;
    w.env.tabsOnRemoved.emit(1, {windowId: 1, isWindowClosing: false});
    await w.settle();
    filter.respond(MAIN);
    await w.settle();
    expect(filter.closed).toBe(true);
    expect(filter.written).toHaveLength(0);
  });

  it('a request outside any tab (another extension) is denied and leaves the vault tabs alone', async () => {
    // An untracked request with tabId -1 must not mark every live session of the origin
    // PROTECTION_LOST (untracked).
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: -1,
      frameId: -1,
      originUrl: 'moz-extension://another-extension/background.html',
    });
    const r = await w.env.webRequest.onBeforeRequest.fire(d);
    await w.settle();
    expect(r[0]?.cancel).toBe(true);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it("a request another site's document makes is denied and marks no vault document", async () => {
    // Another site frames a verified vault document and then loads a vault file from its own
    // document: no document of the vault made that request (R2 marks none of them).
    const w = await createWorld({cores: [core1()]});
    const top = 'https://other.example/';
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: top, timeStamp: 0});
    const req = String(seq++);
    const frame = details({
      requestId: req,
      url: `${VW_ORIGIN}/`,
      type: 'sub_frame',
      tabId: 1,
      frameId: 7,
      parentFrameId: 0,
      documentUrl: top,
      originUrl: top,
    });
    await w.env.webRequest.onBeforeRequest.fire(frame);
    await w.env.webRequest.onHeadersReceived.fire({
      ...frame,
      statusCode: 200,
      responseHeaders: HTML,
    });
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 7,
      parentFrameId: 0,
      url: frame.url,
      timeStamp: 0,
    });
    w.env.filters.get(req)!.respond(INDEX);
    await w.settle();
    const framed = async (): Promise<unknown> =>
      (await w.engine.details(1))?.docs.map(d => [d.summary.state, d.summary.reasons]);
    expect(await framed()).toEqual([['VERIFIED', []]]);
    for (const documentUrl of [top]) {
      const d = details({
        requestId: String(seq++),
        url: `${VW_ORIGIN}${MAIN_PATH}`,
        type: 'script',
        tabId: 1,
        frameId: 0,
        documentUrl,
        originUrl: documentUrl,
      });
      const r = await w.env.webRequest.onBeforeRequest.fire(d);
      await w.settle();
      expect(r[0]?.cancel, documentUrl).toBe(true);
      expect(w.env.filters.has(d.requestId), documentUrl).toBe(false);
    }
    expect(await framed()).toEqual([['VERIFIED', []]]);
    expect(w.sinks.alerts).toEqual([]);
    // No vault document became a taint source: a vault opened in another tab is green.
    await navigate(w, INDEX, {tab: 2});
    await script(w, MAIN, MAIN_PATH, 2);
    expect((await w.tab(2))?.state).toBe('VERIFIED');
  });

  it('denies a mismatching document and sends the tab to the blocked page', async () => {
    const other = vwCore('2026.10.1', {'/index.html': bytes('<html>other</html>')});
    const w = await createWorld({cores: [other]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    const doc = await navigate(w, INDEX);
    // The hinted release is known and its index.html differs: MISMATCH release-differs.
    expect(doc.filter.written).toHaveLength(0);
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toContain('release-differs');
  });

  it('a document that contradicts a known hinted release goes straight to the blocked page', async () => {
    // The decision waits for the hint: decided before it, the document would be denied as
    // NEW_BUILD with the waiting blocked page, and once that document had ended the MISMATCH would
    // never be recorded (no blocked page, no red alert; e2e vw-inline-block).
    const other = vwCore('2026.10.1', {'/index.html': bytes('<html>other</html>')});
    const w = await createWorld({cores: [other]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    const doc = await navigate(w, INDEX);
    expect(doc.filter.written).toHaveLength(0);
    expect(w.env.tabsUpdated.at(-1)?.url).toMatch(/\/ui\/blocked\.html#[0-9a-f]{16}$/);
    expect(w.sinks.alerts.at(-1)?.state).toBe('MISMATCH');
  });

  it('a document denied as NEW_BUILD still starts the deep verify its blocked page waits for', async () => {
    // The denied document ends as soon as Firefox commits the blocked page; the resolution must
    // not stop with it, or the blocked page waits forever (e2e vw-unknown-build).
    const w = await createWorld({cores: []});
    w.registry.hint = {version: '2026.11.0', at: 0};
    let releaseHint!: () => void;
    const slowHint = new Promise<void>(resolve => (releaseHint = resolve));
    const fetchHint = w.registry.fetchHint.bind(w.registry);
    w.registry.fetchHint = async () => {
      await slowHint;
      return fetchHint();
    };
    // Real timer turns (the engine's timers are fake): WebCrypto digests and the 1.6-s CHECKING
    // re-evaluation that advancing the fake clock fires settle between them.
    const ticks = (): Promise<void> => w.settle();
    const req = String(seq++);
    const d = details({requestId: req, url: `${VW_ORIGIN}/`, type: 'main_frame', tabId: 1});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
    const filter = w.env.filters.get(req)!;
    filter.respond(INDEX);
    await ticks();
    w.timers.advance(5_000); // the hint is slow: the decision stops waiting for it
    await ticks();
    expect(filter.written).toHaveLength(0);
    const page = w.env.tabsUpdated.at(-1)?.url ?? '';
    expect(page).toMatch(/\/ui\/blocked\.html#[0-9a-f]{16}$/);
    // Firefox commits the blocked page in the frame: the document ends.
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: page, timeStamp: 0});
    await ticks();
    expect(w.trust.ensured).toEqual([]);
    releaseHint();
    await w.settle();
    expect(w.trust.ensured.map(k => k.version)).toEqual(['2026.11.0']);
  });

  it('unknown build: NEW_BUILD is denied while deep verify runs; once the build is known the reload is VERIFIED', async () => {
    const w = await createWorld({cores: []});
    w.registry.hint = {version: '2026.11.0', at: 0};
    const doc = await navigate(w, INDEX);
    expect(doc.filter.written).toHaveLength(0);
    let t = await w.tab(1);
    expect(t?.state).toBe('NEW_BUILD');
    expect(w.trust.ensured.map(k => k.version)).toEqual(['2026.11.0']);
    expect(t?.unknownBuild?.phase).toBe('deep-verify');
    w.trust.complete(UNPUBLISHED, [vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN})]);
    await w.settle();
    // The blocked page reloads the vault.
    const again = await navigate(w, INDEX);
    expect(again.filter.output).toEqual(INDEX);
    expect((await script(w, MAIN))?.output).toEqual(MAIN);
    t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.top?.binding?.version).toBe('2026.11.0');
    expect(t?.top?.counts.scripts).toEqual({ok: 1, total: 1});
  });

  it('proceed once on an unpublished build: recorded scripts verify after the fact when the release becomes known', async () => {
    const w = await createWorld({cores: []});
    await proceedOnceUnbound(w);
    expect((await script(w, MAIN))?.output).toEqual(MAIN);
    w.trust.cores.push(vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN}));
    await w.engine.releaseKnown(w.trust.cores.map(c => c.ref));
    await w.settle();
    const t = await w.tab(1);
    // R6: a build that was BUILD_UNVERIFIED stays amber, but every recorded file now checks out.
    expect(t?.state).toBe('BUILD_UNVERIFIED');
    expect(t?.flags).toContain('RETRO');
    expect(t?.top?.binding?.version).toBe('2026.11.0');
    expect(t?.top?.counts.scripts).toEqual({ok: 1, total: 1});
    expect(w.sinks.alerts).toEqual([]);
  });

  it('proceed once across an event-page restart: exact recorded items still verify after the fact, no restart alert', async () => {
    // Status and Content-Type of recorded items are persisted, so a release that becomes known
    // after an idle stop does not turn every recorded item into unverifiable verifier-restarted
    // (PROTECTION_LOST with a sticky alert).
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [], session, local, timers});
    await proceedOnceUnbound(w1);
    await script(w1, MAIN);
    expect((await w1.tab(1))?.state).toBe('BUILD_UNVERIFIED');
    // The event page stops; the release becomes known in the next instance.
    const w2 = await createWorld({cores: [], session, local, timers});
    w2.registry.hint = w1.registry.hint;
    await w2.settle();
    w2.trust.cores.push(vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN}));
    await w2.engine.releaseKnown(w2.trust.cores.map(c => c.ref));
    await w2.settle();
    const t = await w2.tab(1);
    expect(t?.state).toBe('BUILD_UNVERIFIED');
    expect(t?.flags).toContain('RETRO');
    expect(t?.top?.counts.scripts).toEqual({ok: 1, total: 1});
    expect(await w2.engine.listAlerts()).toEqual([]);
    expect(w2.sinks.alerts).toEqual([]);
  });

  it('proceed once on an unpublished build: a recorded script that differs from the release is MISMATCH after the fact', async () => {
    const w = await createWorld({cores: []});
    await proceedOnceUnbound(w);
    await script(w, bytes('tampered()'));
    expect((await w.tab(1))?.state).toBe('BUILD_UNVERIFIED');
    w.trust.cores.push(vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN}));
    await w.engine.releaseKnown(w.trust.cores.map(c => c.ref));
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toContain('bytes');
    expect(w.sinks.alerts.at(-1)?.state).toBe('MISMATCH');
  });

  it('proceed once releases one load of that document hash in that tab', async () => {
    const w = await createWorld({cores: []});
    const once = async (): Promise<number> =>
      (await w.engine.listIncidents(50)).filter(i => i.kind === 'proceed-once').length;
    await proceedOnceUnbound(w);
    const n = await once();
    // Spent: the same document in the same tab is denied again, with no further proceed-once entry.
    expect((await navigate(w, INDEX)).filter.written).toHaveLength(0);
    expect(await once()).toBe(n);
    // Scoped: an allowance for INDEX releases neither another document nor INDEX in another tab.
    await w.engine.allowForTab(1, {k: 'proceed-once', sha256: await sha256Hex(INDEX)});
    expect((await navigate(w, bytes('<html>another build</html>'))).filter.written).toHaveLength(0);
    expect((await navigate(w, INDEX, {tab: 2})).filter.written).toHaveLength(0);
  });

  for (const order of ['tampered first', 'genuine first'] as const) {
    it(`proceed once: two bodies for one recorded path are both judged after the fact (${order})`, async () => {
      // The page fetches the path again (another query) for the genuine bytes: the body that ran
      // must not be replaced by it before the release becomes known.
      const w = await createWorld({cores: []});
      await proceedOnceUnbound(w);
      const bodies = [bytes('tampered()'), MAIN];
      if (order === 'genuine first') bodies.reverse();
      expect((await script(w, bodies[0]!, `${MAIN_PATH}?v=1`))?.output).toEqual(bodies[0]);
      expect((await script(w, bodies[1]!, `${MAIN_PATH}?v=2`))?.output).toEqual(bodies[1]);
      w.trust.cores.push(vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN}));
      await w.engine.releaseKnown(w.trust.cores.map(c => c.ref));
      await w.settle();
      const t = await w.tab(1);
      expect(t?.state).toBe('MISMATCH');
      expect(t?.reasons).toContain('bytes');
      await navigate(w, INDEX, {tab: 2});
      expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    });
  }

  it('proceed once: a page that verifies after the fact still taints its origin until it ends', async () => {
    const w = await createWorld({cores: []});
    await proceedOnceUnbound(w);
    await script(w, MAIN);
    w.trust.cores.push(vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN}));
    await w.engine.releaseKnown(w.trust.cores.map(c => c.ref));
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('BUILD_UNVERIFIED');
    expect(t?.flags).toContain('RETRO');
    // What ran before the build was known is not undone by the verdict on what was recorded.
    await navigate(w, INDEX, {tab: 2});
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    w.env.tabsOnRemoved.emit(1, {windowId: 1, isWindowClosing: false});
    await w.settle();
    await navigate(w, INDEX, {tab: 3});
    expect((await w.tab(3))?.state).toBe('VERIFIED');
  });

  it('unknown build: the built core contradicts the document → MISMATCH release-differs', async () => {
    const w = await createWorld({cores: []});
    w.registry.hint = {version: '2026.11.0', at: 0};
    await navigate(w, INDEX);
    w.trust.complete({app: 'vaultwarden-web', variant: 'release', version: '2026.11.0'}, [
      vwCore('2026.11.0', {'/index.html': bytes('<html>the real release</html>')}),
    ]);
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toEqual(['release-differs']);
  });

  it('unknown build: a release without a tarball is BUILD_UNVERIFIED image-only-release', async () => {
    const w = await createWorld({cores: []});
    w.registry.hint = {version: '2026.8.0', at: 0};
    await navigate(w, INDEX);
    w.trust.fail(
      {app: 'vaultwarden-web', variant: 'release', version: '2026.8.0'},
      'image-only-release',
    );
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('BUILD_UNVERIFIED');
    expect(t?.reasons).toEqual(['image-only-release']);
  });

  it('filterResponseData throws "Invalid request ID" (a service worker answers): PROTECTION_LOST sw-served, cancelled', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    w.env.filterError = () => new Error('Invalid request ID');
    const r = await w.env.webRequest.onBeforeRequest.fire(
      details({
        requestId: 'sw1',
        url: `${VW_ORIGIN}${MAIN_PATH}`,
        type: 'script',
        documentUrl: `${VW_ORIGIN}/`,
      }),
    );
    expect(r[0]).toEqual({cancel: true});
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('PROTECTION_LOST');
    expect(t?.reasons).toContain('sw-served');
  });

  // Hashing is the only thing that stops a same-origin script the floor (script-src 'self') allows,
  // for example one a DOM injection puts into a verified vault: on a server path it must be held
  // and denied, whatever its content type.
  for (const [path, type, ctype] of [
    ['/api/evil.js', 'script', 'application/json'],
    ['/api/evil.css', 'stylesheet', 'text/css'],
    ['/vw_static/evil.js', 'script', 'text/javascript'],
    ['/vw_static/evil.css', 'stylesheet', 'text/css'],
    ['/admin/evil.js', 'script', 'text/javascript'],
    ['/css/vaultwarden.css', 'script', 'text/css'],
    ['/css/vaultwarden.css', 'font', 'text/css'],
  ] as const) {
    it(`active content on a server path is held and denied: ${type} ${path}`, async () => {
      const w = await createWorld({cores: [core1()]});
      await navigate(w, INDEX);
      expect((await w.tab(1))?.state).toBe('VERIFIED');
      const req = String(seq++);
      const d = details({
        requestId: req,
        url: `${VW_ORIGIN}${path}`,
        type,
        tabId: 1,
        documentUrl: `${VW_ORIGIN}/`,
        originUrl: `${VW_ORIGIN}/`,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      const filter = w.env.filters.get(req);
      expect(filter, 'a filter holds the response').toBeDefined();
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 200,
        responseHeaders: [{name: 'Content-Type', value: ctype}],
      });
      filter!.respond(bytes('evil()'));
      await w.settle();
      expect(filter!.written).toHaveLength(0);
      const t = await w.tab(1);
      expect(t?.state).toBe('MISMATCH');
      expect(t?.reasons).toEqual(['unknown-path']);
    });
  }

  it('a server stylesheet the validator rejects is withheld unless the user allows it for the tab', async () => {
    // Data-dependent selectors can tell the server what the vault holds.
    const w = await createWorld({cores: [core1()]});
    const style = async (css: Uint8Array): Promise<FakeStreamFilter> => {
      const d = details({
        requestId: String(seq++),
        url: `${VW_ORIGIN}/css/vaultwarden.css`,
        type: 'stylesheet',
        tabId: 1,
        documentUrl: `${VW_ORIGIN}/`,
        originUrl: `${VW_ORIGIN}/`,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      const f = w.env.filters.get(d.requestId)!;
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'text/css'}],
      });
      f.respond(css);
      await w.settle();
      return f;
    };
    await navigate(w, INDEX);
    const stock = bytes('.vw-hide{display:none!important}');
    expect((await style(stock)).output).toEqual(stock);
    const custom = bytes('body{color:red}');
    const denied = await style(custom);
    expect(denied.closed).toBe(true);
    expect(denied.written).toHaveLength(0);
    const t = await w.tab(1);
    expect(t?.state).toBe('UNVERIFIED_STYLE');
    expect(t?.top?.serverStyle).toMatchObject({accepted: false, reason: 'custom-rules'});
    await w.engine.allowForTab(1, {k: 'server-style', path: '/css/vaultwarden.css'});
    await navigate(w, INDEX);
    expect((await style(custom)).output).toEqual(custom);
  });

  it('a subresource of a document still unjudged after the wait is unbound and denied', async () => {
    const w = await createWorld({cores: [core1()]});
    // The document's request and headers, but neither its commit nor its body.
    const doc = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(doc);
    await w.env.webRequest.onHeadersReceived.fire({...doc, statusCode: 200, responseHeaders: HTML});
    // documentUrl names the loading document, which takes the script.
    const js = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(js);
    const f = w.env.filters.get(js.requestId)!;
    await w.env.webRequest.onHeadersReceived.fire({...js, statusCode: 200, responseHeaders: JS});
    f.respond(bytes('evil()'));
    await w.settle();
    expect(f.written).toHaveLength(0);
    w.timers.advance(SESSION_LIMITS.unboundWaitMs);
    await w.settle();
    expect(f.closed).toBe(true);
    expect(f.written).toHaveLength(0);
    const item = (await w.engine.details(1))?.docs[0]?.items.find(i => i.path === MAIN_PATH);
    expect(item?.outcome).toEqual({r: 'unverifiable', reason: 'unbound'});
    expect((await w.tab(1))?.state).toBe('PROTECTION_LOST');
  });

  it('header guard: a Refresh header is cancelled (MISMATCH header)', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const d = details({
      requestId: 'r1',
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      documentUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const hr = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [...JS, {name: 'Refresh', value: '0; url=https://evil.example/'}],
    });
    expect(hr[0]).toEqual({cancel: true});
    await w.settle();
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    expect((await w.tab(1))?.reasons).toContain('header');
  });

  it('protected code is rewritten to Cache-Control: no-store and gets the CSP floor', async () => {
    const w = await createWorld({cores: [core1()]});
    const d = details({requestId: 'h1', url: `${VW_ORIGIN}/`, type: 'main_frame'});
    await w.env.webRequest.onBeforeRequest.fire(d);
    const hr = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [...HTML, {name: 'Cache-Control', value: 'public, max-age=600'}],
    });
    const headers = (hr[0]?.responseHeaders ?? []) as {name: string; value: string}[];
    expect(headers.filter(h => h.name === 'cache-control').map(h => h.value)).toEqual(['no-store']);
    expect(headers.some(h => h.name === 'content-security-policy')).toBe(true);
  });

  it('the vendor CSP is kept and the floor is added beside it', async () => {
    const w = await createWorld({cores: [core1()]});
    const vendor = "default-src 'self'; frame-src 'self'; connect-src 'self'";
    const d = details({requestId: 'h2', url: `${VW_ORIGIN}/`, type: 'main_frame'});
    await w.env.webRequest.onBeforeRequest.fire(d);
    const hr = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [...HTML, {name: 'Content-Security-Policy', value: vendor}],
    });
    const csp = ((hr[0]?.responseHeaders ?? []) as {name: string; value: string}[])
      .filter(h => h.name === 'content-security-policy')
      .map(h => h.value);
    expect(csp).toHaveLength(2);
    expect(csp[0]).toBe(vendor);
    expect(csp[1]).toContain("script-src 'self'");
  });

  it('an unfiltered data request to a dynamic path answered as code is MISMATCH header', async () => {
    // Only the header-time check sees it: data requests to dynamic paths get no filter.
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/api/x`,
      type: 'xmlhttprequest',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    expect(w.env.filters.has(d.requestId)).toBe(false);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toContain('header');
  });

  it('restart with an unclosed persisted filter: PROTECTION_LOST verifier-restarted and a sticky alert', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core1()], session, local, timers});
    await navigate(w1, INDEX);
    // A script filter is open when the event page dies.
    const d = details({
      requestId: 'open1',
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      documentUrl: `${VW_ORIGIN}/`,
    });
    await w1.env.webRequest.onBeforeRequest.fire(d);
    await w1.settle();
    expect([...session.data.keys()].some(k => k.startsWith('s:v1:ff:pending:'))).toBe(true);
    // A new background instance over the same storage.session.
    const w2 = await createWorld({cores: [core1()], session, local, timers});
    await w2.settle();
    const t = await w2.tab(1);
    expect(t?.state).toBe('PROTECTION_LOST');
    expect(t?.reasons).toContain('verifier-restarted');
    expect((await w2.engine.listAlerts())[0]).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: expect.arrayContaining(['verifier-restarted']),
    });
    expect([...session.data.keys()].some(k => k.startsWith('s:v1:ff:pending:'))).toBe(false);
  });

  it('a document redirected to another site leaves no persisted filter: no restart alert at the next start', async () => {
    // An auth-flow page redirects to its identity provider. That hop gets no filter, so nothing
    // reopens the entry the redirected hop's filter held.
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core1()], session, local, timers});
    const idp = 'https://idp.example/login';
    const d = details({
      requestId: 'sso1',
      url: `${VW_ORIGIN}/identity/connect/authorize`,
      type: 'main_frame',
      tabId: 1,
    });
    await w1.env.webRequest.onBeforeRequest.fire(d);
    await w1.settle();
    const pendingKeys = (): string[] =>
      [...session.data.keys()].filter(k => k.startsWith('s:v1:ff:pending:'));
    expect(pendingKeys()).toEqual(['s:v1:ff:pending:sso1']);
    const answer = await w1.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 302,
      responseHeaders: [{name: 'Location', value: idp}],
    });
    expect(answer[0]?.cancel).not.toBe(true);
    // Firefox follows the redirect and drops the redirected hop's filter.
    await w1.env.webRequest.onBeforeRedirect.fire({...d, statusCode: 302, redirectUrl: idp});
    w1.env.filters.get('sso1')!.onerror?.({});
    await w1.env.webRequest.onBeforeRequest.fire({...d, url: idp});
    await w1.settle();
    expect(pendingKeys()).toEqual([]);
    const w2 = await createWorld({cores: [core1()], session, local, timers});
    await w2.settle();
    expect(await w2.engine.listAlerts()).toEqual([]);
    await navigate(w2, INDEX);
    expect((await w2.tab(1))?.state).toBe('VERIFIED');
  });

  it('R4: a filter pending past its timeout is PROTECTION_LOST timeout, closed empty', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const d = details({
      requestId: 'slow',
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      documentUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const f = w.env.filters.get('slow')!;
    w.timers.advance(r4Ms('script') + 1_000);
    await w.settle();
    expect(f.closed).toBe(true);
    expect(f.written).toHaveLength(0);
    const t = await w.tab(1);
    expect(t?.state).toBe('PROTECTION_LOST');
    expect(t?.reasons).toContain('timeout');
  });

  it('origin taint: an unverifiable build run by "Proceed once" in another tab makes the vault CO_RESIDENT_UNVERIFIED', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX, {tab: 1});
    await script(w, MAIN, MAIN_PATH, 1);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const page = bytes('<html>unverified build</html>');
    await w.engine.allowForTab(2, {k: 'proceed-once', sha256: await sha256Hex(page)});
    const d = details({requestId: 'unv', url: `${VW_ORIGIN}/`, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
    w.env.filters.get('unv')!.respond(page);
    await w.settle();
    expect((await w.tab(2))?.state).toBe('BUILD_UNVERIFIED');
    const t = await w.tab(1);
    expect(t?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect(t?.top?.coResident).toEqual({class: 'unverifiable', sourcePath: '/'});
  });
});

/**
 * R1: every failure while a response is held denies it and shows PROTECTION_LOST internal-error;
 * none releases the bytes or publishes a better state.
 */
describe('fail closed on faults (R1)', () => {
  /** Starts a document load up to its headers; the test injects the fault, then the body comes. */
  async function held(w: World): Promise<{filter: FakeStreamFilter; d: WebRequestDetails}> {
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    return {filter: w.env.filters.get(d.requestId)!, d};
  }
  const body = async (w: World, h: {filter: FakeStreamFilter; d: WebRequestDetails}) => {
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: h.d.url, timeStamp: 0});
    h.filter.respond(INDEX);
    await w.settle();
  };

  it('the engine throws while it judges a document body', async () => {
    const w = await createWorld({cores: [core1()]});
    const h = await held(w);
    w.trust.candidates = () => Promise.reject(new Error('IndexedDB failed'));
    await body(w, h);
    expect(h.filter.written).toHaveLength(0);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
  });

  it('the body cannot be hashed', async () => {
    const w = await createWorld({cores: [core1()]});
    const h = await held(w);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('boom'));
    try {
      await body(w, h);
    } finally {
      spy.mockRestore();
    }
    expect(h.filter.written).toHaveLength(0);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
  });

  it('building the evaluation input throws: PROTECTION_LOST, never VERIFIED', async () => {
    const w = await createWorld({cores: [core1()]});
    const h = await held(w);
    w.trust.snapshot = () => {
      throw new Error('boom');
    };
    await body(w, h);
    expect(h.filter.written).toHaveLength(0);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
  });

  it('no StreamFilter API: the response is cancelled', async () => {
    const w = await createWorld({cores: [core1()]});
    (w.env.ext.webRequest as {filterResponseData?: unknown}).filterResponseData = undefined;
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    const r = await w.env.webRequest.onBeforeRequest.fire(d);
    expect(r[0]).toEqual({cancel: true});
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('PROTECTION_LOST');
    expect(t?.reasons).toContain('filter-failed');
  });
});

/**
 * Revocation is visible (docs/security.md): a registered server whose host permission is
 * missing gets no webRequest event and no content script, so only the commit (webNavigation needs
 * no host permission) says that one of its documents runs, unchecked.
 */
describe('a registered server whose host permission is missing', () => {
  const commit = (w: World, tab: number): void =>
    void w.env.onCommitted.emit({
      tabId: tab,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/`,
      timeStamp: 0,
    });

  it('a load is PROTECTION_LOST permission-revoked with a Grant button, not "not protected"', async () => {
    const w = await createWorld({cores: [core1()], origins: [vwOrigin(false)]});
    commit(w, 3);
    await w.settle();
    const t = await w.tab(3);
    expect(t).toMatchObject({state: 'PROTECTION_LOST', permissionMissing: true});
    expect(t?.reasons).toContain('permission-revoked');
    expect(popupView(t, '1.0.0').buttons.grant).not.toBeNull();
  });

  it('a reload after the permission was revoked stays red, and taints the origin once granted again', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX, {tab: 4});
    expect((await w.tab(4))?.state).toBe('VERIFIED');
    w.registry.origins = [vwOrigin(false)];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    commit(w, 4);
    await w.settle();
    const t = await w.tab(4);
    expect(t).toMatchObject({state: 'PROTECTION_LOST', permissionMissing: true});
    expect(t?.reasons).toContain('permission-revoked');
    w.registry.origins = [vwOrigin(true)];
    await w.engine.originsChanged(w.registry.protectedOrigins());
    await w.settle();
    await navigate(w, INDEX, {tab: 5});
    expect((await w.tab(5))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it("a frame's commit is reported too: nothing else tells of that document", async () => {
    const w = await createWorld({cores: [core1()], origins: [vwOrigin(false)]});
    w.env.onCommitted.emit({
      tabId: 3,
      frameId: 7,
      parentFrameId: 0,
      url: `${VW_ORIGIN}/`,
      timeStamp: 0,
    });
    await w.settle();
    const t = await w.tab(3);
    expect(t).toMatchObject({state: 'PROTECTION_LOST', permissionMissing: true});
    expect(t?.reasons).toContain('permission-revoked');
  });
});

/**
 * A commit of a protected address that no request preceded, the host permission granted. In the
 * top-level frame it is a page restored from the back/forward cache (a page loaded before
 * IntactWarden watched it is not no-store, so Firefox can keep it there). In another frame it is a
 * document some page frames: Firefox reports its request only if the extension may access the
 * framing page, and reports its commit even when it refuses to render it.
 */
describe('a protected document that commits without a request', () => {
  it('is PROTECTION_LOST untracked and taints its origin', async () => {
    const w = await createWorld({cores: [core1()]});
    const url = `${VW_ORIGIN}/`;
    const commit = async (to: string): Promise<void> => {
      w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: to, timeStamp: 0});
      await w.settle();
    };
    // The page announces itself (content-script hello): adopted, untracked (R2).
    expect(await w.engine.hello({tab: 1, frame: 0, url})).toMatchObject({protected: true});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    // The tab goes to another site, and "Back" restores the page.
    await commit('https://example.org/');
    expect(await w.tab(1)).toBeNull();
    await commit(url);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    // Nobody verified what it runs: a vault opened beside it is co-resident.
    await navigate(w, INDEX, {tab: 2});
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('in a frame it is not adopted: no session, no state, no alert, and a vault tab stays VERIFIED', async () => {
    const w = await createWorld({cores: [core1()]});
    const url = `${VW_ORIGIN}/`;
    const frame = {tab: 1, frame: 7, url};
    await navigate(w, INDEX, {tab: 2});
    expect((await w.tab(2))?.state).toBe('VERIFIED');
    // A page of another site in tab 1, and its frame commits the vault's address: the commit
    // alone does not say whether Firefox rendered the document (X-Frame-Options, frame-ancestors).
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://example.org/',
      timeStamp: 0,
    });
    w.env.onCommitted.emit({tabId: 1, frameId: 7, parentFrameId: 0, url, timeStamp: 0});
    await w.settle();
    expect(w.backend.docKeyFor(frame)).toBeNull();
    expect(await w.engine.details(1)).toBeNull();
    expect(await w.tab(1)).toBeNull();
    expect(w.sinks.alerts).toHaveLength(0);
    expect(await w.engine.listIncidents(10)).toEqual([]);
    expect(await w.tab(2)).toMatchObject({state: 'VERIFIED', reasons: []});
    // A framed document that runs announces itself (content-script hello): untracked (R2).
    expect(await w.engine.hello(frame)).toMatchObject({protected: true});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    expect(w.sinks.alerts).toHaveLength(1);
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a reported frame whose page is restored is not adopted again; its tab keeps the taint until it closes', async () => {
    const w = await createWorld({cores: [core1()]});
    const url = `${VW_ORIGIN}/`;
    const frame = {tab: 1, frame: 7, url};
    const commit = async (frameId: number, to: string): Promise<void> => {
      w.env.onCommitted.emit({
        tabId: 1,
        frameId,
        parentFrameId: frameId === 0 ? -1 : 0,
        url: to,
        timeStamp: 0,
      });
      await w.settle();
    };
    await commit(0, 'https://example.org/');
    await commit(7, url);
    expect(await w.engine.hello(frame)).toMatchObject({protected: true});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['untracked']});
    // The tab leaves the page and "Back" restores it from the back/forward cache: Firefox reports
    // the commit of the page and of its frame, and the frame's content script does not start again.
    await commit(0, 'https://example.org/away');
    await commit(0, 'https://example.org/');
    await commit(7, url);
    expect(w.backend.docKeyFor(frame)).toBeNull();
    expect(await w.tab(1)).toBeNull();
    // A framed taint source leaves its taint with its tab.
    await navigate(w, INDEX, {tab: 2});
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    w.env.tabsOnRemoved.emit(1, {});
    w.env.tabsOnRemoved.emit(2, {});
    await w.settle();
    await navigate(w, INDEX, {tab: 3});
    expect((await w.tab(3))?.state).toBe('VERIFIED');
  });
});

describe('whether Firefox confirms a document gone (webNavigation.getFrame)', () => {
  it('a removed frame, a discarded tab and a closed tab are gone; anything else is not', async () => {
    const w = await createWorld({cores: [core1()]});
    expect(await w.backend.documentGone(1, 0)).toBe(false);
    // Firefox rejects for a frame the tab does not have (a removed iframe).
    w.env.goneFrames.add('1:5');
    expect(await w.backend.documentGone(1, 5)).toBe(true);
    expect(await w.backend.documentGone(1, 0)).toBe(false);
    // It resolves null for a discarded tab.
    w.env.discardedTabs.add(2);
    expect(await w.backend.documentGone(2, 0)).toBe(true);
    // It rejects for a tab that does not exist, as tabs.get does.
    w.env.removedTabs.add(3);
    expect(await w.backend.documentGone(3, 0)).toBe(true);
    // Any other failure leaves the document unconfirmed.
    const nav = w.env.ext.webNavigation as unknown as {getFrame: () => Promise<never>};
    nav.getFrame = async () => {
      throw new Error('An unexpected error occurred');
    };
    expect(await w.backend.documentGone(1, 5)).toBe(false);
  });
});

/**
 * After an idle stop, the event that wakes the event page can be a navigation commit or a tab close
 * in any tab. Those listeners must not run on the empty frame map before it is restored, or they
 * persist it empty over the stored one: the vault's DocKey would be lost, its sensor reports
 * dropped while the tab stays VERIFIED, and its own navigation would end nothing.
 */
describe('event-page restart: navigation events wait for the restored frame map', () => {
  const URL0 = `${VW_ORIGIN}/`;
  const sender = {tab: 1, frame: 0, url: URL0};
  const commit = (tabId: number, url: string) => (env: World['env']) =>
    env.onCommitted.emit({tabId, frameId: 0, parentFrameId: -1, url, timeStamp: 0});

  async function restartWith(wake: (env: World['env']) => void): Promise<{w2: World; doc: string}> {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core1()], session, local, timers});
    await navigate(w1, INDEX);
    await script(w1, MAIN);
    expect((await w1.tab(1))?.state).toBe('VERIFIED');
    const doc = w1.backend.docKeyFor(sender)!;
    expect(doc).toMatch(/^1:0:\d+$/);
    const w2 = await createWorld({cores: [core1()], session, local, timers, duringStart: wake});
    await w2.settle();
    return {w2, doc};
  }

  for (const [what, wake] of [
    ['another tab commits a document', commit(2, 'https://example.org/')],
    ['another tab closes', (env: World['env']) => env.tabsOnRemoved.emit(2, {})],
  ] as const) {
    it(`${what} while the page wakes: the vault keeps its DocKey and its sensor reports count`, async () => {
      const {w2, doc} = await restartWith(wake);
      expect(w2.backend.docKeyFor(sender)).toBe(doc);
      await w2.engine.contentCspViolation(sender, {
        doc,
        directive: 'script-src-elem',
        blockedUrl: 'inline',
      });
      await w2.settle();
      expect((await w2.tab(1))?.state).toBe('MISMATCH');
    });
  }

  it('the vault tab itself navigates away while the page wakes: its document ends', async () => {
    const {w2} = await restartWith(commit(1, 'https://example.org/'));
    expect(await w2.tab(1)).toBeNull();
  });

  it('a reload that wakes the page and is aborted before the engine is ready ends there: the tab stays VERIFIED', async () => {
    // The request's end must wait for the gate as its start does, or it finds no request yet and
    // is lost: the load would stay pending (CHECKING, then PROTECTION_LOST timeout).
    const d = details({requestId: 'wake1', url: URL0, type: 'main_frame', tabId: 1});
    const {w2} = await restartWith(env => {
      void env.webRequest.onBeforeRequest.emit(d);
      void env.webRequest.onErrorOccurred.emit({...d, error: 'NS_BINDING_ABORTED'});
    });
    expect((await w2.tab(1))?.state).toBe('VERIFIED');
    w2.timers.advance(61_000);
    await w2.settle();
    expect(await w2.tab(1)).toMatchObject({state: 'VERIFIED', reasons: []});
  });
});

/**
 * A body whose request the engine has no record of (its session record was lost while the backend
 * still attributes the frame to it): the body and unverifiable observations carry the request's
 * URL, so the engine can still judge it by its origin.
 */
describe('a body the engine cannot attribute', () => {
  it('a tampered script of a document whose session record is gone is denied', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({
      cores: [core1()],
      session,
      local,
      timers,
    });
    await navigate(w1, INDEX);
    expect((await w1.tab(1))?.state).toBe('VERIFIED');
    // The session record is lost (the backend still knows the frame's document).
    for (const k of [...session.data.keys()]) if (k.startsWith('s:v1:doc:')) session.data.delete(k);
    const w2 = await createWorld({
      cores: [core1()],
      session,
      local,
      timers,
    });
    await w2.settle();
    const js = await script(w2, bytes('evil()'));
    expect(js?.written ?? []).toHaveLength(0);
  });

  it('the document of a server removed while it loads is still released', async () => {
    const w = await createWorld({cores: [core1()]});
    const req = String(seq++);
    const d = details({requestId: req, url: `${VW_ORIGIN}/`, type: 'main_frame', tabId: 1});
    w.env.webRequest.onBeforeRequest.emit(d);
    // Removed in Options before the engine handles the document: it has no request record, and
    // its origin is no longer protected, so there is nothing to deny.
    w.registry.origins = [];
    const f = w.env.filters.get(req)!;
    f.respond(INDEX);
    await w.settle();
    expect(f.output).toEqual(INDEX);
  });
});

/**
 * When the backend's own header handler throws (here a header value Firefox could not hand over as
 * text, malformed), the response is cancelled without the header guard, and the document (which
 * never got the CSP floor) must not end VERIFIED.
 */
describe('a document whose header stage failed is never VERIFIED', () => {
  it('cancelled without the guard, PROTECTION_LOST internal-error', async () => {
    const w = await createWorld({cores: [core1()]});
    const req = String(seq++);
    const d = details({requestId: req, url: `${VW_ORIGIN}/`, type: 'main_frame', tabId: 1});
    await w.env.webRequest.onBeforeRequest.fire(d);
    const hr = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [...HTML, {name: 'X-Bad', binaryValue: 5 as unknown as number[]}],
    });
    expect(hr[0]).toEqual({cancel: true});
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
    w.env.filters.get(req)!.respond(INDEX);
    await w.settle();
    expect(await w.tab(1)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: expect.arrayContaining(['internal-error']),
    });
  });
});

/**
 * The backend's blocking request handler itself throws (fault injection: a details object whose
 * `frameId` cannot be read). The engine must hear it, so the tab is never left VERIFIED after a
 * response it could not judge was denied.
 */
describe('a request handler that throws', () => {
  const broken = (d: WebRequestDetails): WebRequestDetails =>
    Object.defineProperty({...d}, 'frameId', {
      get(): number {
        throw new TypeError('injected');
      },
    }) as WebRequestDetails;

  it('a subresource whose handler throws is cancelled and leaves the tab PROTECTION_LOST internal-error', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    const [answer] = await w.env.webRequest.onBeforeRequest.fire(broken(d));
    expect(answer).toEqual({cancel: true});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: expect.arrayContaining(['internal-error']),
    });
  });

  it('the second hop of a redirect whose handler throws: the fault reaches the live documents of the origin', async () => {
    // The request id still names the first hop's record, whose document ended at the redirect; a
    // fault aimed at that document would be dropped.
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX, {tab: 2});
    const req = String(seq++);
    const hop1 = details({requestId: req, url: `${VW_ORIGIN}/index.html`, type: 'main_frame'});
    await w.env.webRequest.onBeforeRequest.fire(hop1);
    await w.env.webRequest.onHeadersReceived.fire({
      ...hop1,
      statusCode: 303,
      responseHeaders: [{name: 'Location', value: `${VW_ORIGIN}/`}],
    });
    w.env.webRequest.onBeforeRedirect.emit({
      ...hop1,
      statusCode: 303,
      redirectUrl: `${VW_ORIGIN}/`,
    });
    await w.settle();
    const hop2 = details({requestId: req, url: `${VW_ORIGIN}/`, type: 'main_frame'});
    await w.env.webRequest.onBeforeRequest.fire(broken(hop2));
    await w.settle();
    expect(await w.tab(2)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: expect.arrayContaining(['internal-error']),
    });
  });
});

/**
 * The worker-URL chain. Firefox reports a worker's own requests with
 * the worker script's URL as documentUrl and originUrl (measured on 153 ESR and 159), so the chain
 * is what attributes them. The chain is persisted, so after an event-page restart a worker's import
 * is still attributed and hashed.
 */
describe('worker-URL chain', () => {
  const WORKER_PATH = '/app/worker.0123456789abcdef0123.js';
  const CHUNK_PATH = '/app/chunk.0123456789abcdef0123.js';
  const WORKER = bytes('importScripts("chunk.0123456789abcdef0123.js")');
  const CHUNK = bytes('self.chunk = 1');
  const coreW = (): ReturnType<typeof vwCore> =>
    vwCore('2026.10.1', {'/index.html': INDEX, [WORKER_PATH]: WORKER, [CHUNK_PATH]: CHUNK});
  /** A request the worker makes (importScripts): documentUrl and originUrl are the worker's URL. */
  const fromWorker = (w: World, tabId: number): Promise<FakeStreamFilter | undefined> =>
    (async () => {
      const req = String(seq++);
      const d = details({
        requestId: req,
        url: `${VW_ORIGIN}${CHUNK_PATH}`,
        type: 'script',
        tabId,
        documentUrl: `${VW_ORIGIN}${WORKER_PATH}`,
        originUrl: `${VW_ORIGIN}${WORKER_PATH}`,
      });
      await w.env.webRequest.onBeforeRequest.fire(d);
      await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
      return w.env.filters.get(req);
    })();

  for (const when of [
    'same instance',
    'worker started before a restart',
    'worker started after a restart',
  ] as const) {
    for (const body of ['genuine', 'tampered'] as const) {
      it(`${when}: a ${body} import of the worker is hashed and judged`, async () => {
        const session = new FakeArea();
        const local = new FakeArea();
        const timers = new FakeTimers();
        let w = await createWorld({cores: [coreW()], session, local, timers});
        await navigate(w, INDEX);
        if (when !== 'worker started after a restart') await script(w, WORKER, WORKER_PATH);
        if (when !== 'same instance') {
          w = await createWorld({cores: [coreW()], session, local, timers});
          await w.settle();
        }
        if (when === 'worker started after a restart') await script(w, WORKER, WORKER_PATH);
        const f = await fromWorker(w, 1);
        expect(f).toBeDefined();
        f!.respond(body === 'genuine' ? CHUNK : bytes('self.chunk = "tampered"'));
        await w.settle();
        expect((await w.tab(1))?.state).toBe(body === 'genuine' ? 'VERIFIED' : 'MISMATCH');
      });
    }
  }

  it('worker started before a restart, tab-less shape (tabId -1): a tampered import is hashed and MISMATCH', async () => {
    // No tab, and documentUrl and originUrl are the worker's URL, so only the persisted chain can
    // attribute it after the restart.
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [coreW()], session, local, timers});
    await navigate(w1, INDEX);
    await script(w1, WORKER, WORKER_PATH);
    const w2 = await createWorld({cores: [coreW()], session, local, timers});
    await w2.settle();
    const f = await fromWorker(w2, -1);
    expect(f).toBeDefined();
    f!.respond(bytes('self.chunk = "tampered"'));
    await w2.settle();
    expect(f!.written).toHaveLength(0);
    expect((await w2.tab(1))?.state).toBe('MISMATCH');
  });

  it('a worker URL two live documents loaded is ambiguous: untracked (fail closed)', async () => {
    const w = await createWorld({cores: [coreW()]});
    await navigate(w, INDEX, {tab: 1});
    await script(w, WORKER, WORKER_PATH, 1);
    await navigate(w, INDEX, {tab: 2});
    await script(w, WORKER, WORKER_PATH, 2);
    const f = await fromWorker(w, -1);
    expect(f).toBeUndefined();
  });

  it('a worker of a document that ended no longer attributes', async () => {
    const w = await createWorld({cores: [coreW()]});
    await navigate(w, INDEX, {tab: 1});
    await script(w, WORKER, WORKER_PATH, 1);
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://example.org/',
      timeStamp: 0,
    });
    await w.settle();
    expect(await fromWorker(w, -1)).toBeUndefined();
  });
});

/**
 * A document load that never commits (cancelled at its headers, aborted, superseded by the next
 * navigation, answered as a download) must not leave a live session for the life of the tab: a
 * stale MISMATCH, CHECKING or even VERIFIED on whatever the tab shows next.
 */
describe('a document load that never commits ends its session', () => {
  /** A top-level document request on tab 1 that is not committed. */
  async function load(
    w: World,
    headers: {name: string; value: string}[] = HTML,
  ): Promise<{d: WebRequestDetails; answer: unknown}> {
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const hr = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: headers,
    });
    await w.settle();
    return {d, answer: hr[0]};
  }
  const commitOther = async (w: World): Promise<void> => {
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://example.org/',
      timeStamp: 0,
    });
    await w.settle();
  };

  it('a document cancelled at its headers (Refresh) ends; the next page shows no stale MISMATCH', async () => {
    const w = await createWorld({cores: [core1()]});
    const {d, answer} = await load(w, [
      ...HTML,
      {name: 'Refresh', value: '0; url=https://evil.example/'},
    ]);
    expect(answer).toEqual({cancel: true});
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    await w.env.webRequest.onErrorOccurred.fire({...d, error: 'NS_ERROR_ABORT'});
    await w.settle();
    await commitOther(w);
    expect(await w.tab(1)).toBeNull();
    // The incident (blocked page, origin alert) is kept.
    expect((await w.engine.listAlerts()).map(a => a.origin)).toEqual([VW_ORIGIN]);
  });

  it('an aborted reload of a verified page leaves it VERIFIED, not CHECKING', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {d} = await load(w);
    await w.env.webRequest.onErrorOccurred.fire({...d, error: 'NS_BINDING_ABORTED'});
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.flags).not.toContain('CHECKING');
  });

  it('a load superseded by the next navigation ends, even when its abort comes late', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const first = await load(w);
    await navigate(w, INDEX);
    await w.env.webRequest.onErrorOccurred.fire({...first.d, error: 'NS_BINDING_ABORTED'});
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.flags).not.toContain('CHECKING');
  });

  it('a document answered as a download, then another site in the tab: no record is left', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {d} = await load(w, [...HTML, {name: 'Content-Disposition', value: 'attachment'}]);
    w.env.filters.get(d.requestId)!.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
    await commitOther(w);
    expect(await w.tab(1)).toBeNull();
  });

  it('a vault document is shown, never saved: Content-Disposition is stripped from its headers', async () => {
    // As a download the tab would stay on the page that started the navigation (another site)
    // while the verified download's VERIFIED stood for that tab.
    const w = await createWorld({cores: [core1()]});
    const {answer} = await load(w, [...HTML, {name: 'Content-Disposition', value: 'attachment'}]);
    const names = ((answer as {responseHeaders?: {name: string}[]}).responseHeaders ?? []).map(h =>
      h.name.toLowerCase(),
    );
    expect(names).toContain('content-security-policy');
    expect(names).not.toContain('content-disposition');
  });

  it('a download (no commit, no error) superseded by the next navigation in the tab ends', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {d} = await load(w, [...HTML, {name: 'Content-Disposition', value: 'attachment'}]);
    w.env.filters.get(d.requestId)!.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
    await w.settle();
    const download = w.backend.docKeyFor({tab: 1, frame: 0, url: `${VW_ORIGIN}/`});
    await navigate(w, INDEX);
    const live = (await w.engine.details(1))?.docs ?? [];
    expect(live).toHaveLength(1);
    expect(w.backend.docKeyFor({tab: 1, frame: 0, url: `${VW_ORIGIN}/`})).not.toBe(download);
    expect((await w.tab(1))?.flags).not.toContain('CHECKING');
  });

  it('a load whose error arrives before its own commit renders after all: its session and taint come back', async () => {
    // Firefox can deliver the parent's error before the content process commits the page and
    // renders what the filter released. The page of a build nobody
    // can check is released because the user chose "Proceed once".
    const w = await createWorld({cores: [core1()]});
    const admin = bytes('<html>unverified build</html>');
    await w.engine.allowForTab(1, {k: 'proceed-once', sha256: await sha256Hex(admin)});
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    await w.settle();
    // No report of the request's end comes in time: the body is judged and released after the wait.
    w.env.filters.get(d.requestId)!.respond(admin, 7, false);
    await w.settle();
    w.timers.advance(5_000);
    await w.settle();
    expect(w.env.filters.get(d.requestId)!.written).not.toHaveLength(0);
    await w.env.webRequest.onErrorOccurred.fire({...d, error: 'NS_ERROR_NET_INTERRUPT'});
    await w.settle();
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
    await w.settle();
    expect((await w.tab(1))?.state).toBe('BUILD_UNVERIFIED');
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    await navigate(w, INDEX, {tab: 2});
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a released page whose own request errors after its commit keeps its session and taint', async () => {
    // The frame already shows the page and runs what the filter released; an error on its
    // request (a connection the server cuts after the last byte, window.stop()) ends nothing.
    const w = await createWorld({cores: [core1()]});
    const page = bytes('<html>unverified build</html>');
    await w.engine.allowForTab(1, {k: 'proceed-once', sha256: await sha256Hex(page)});
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
    w.env.filters.get(d.requestId)!.respond(page, 7, false);
    await w.settle();
    w.timers.advance(5_000);
    await w.settle();
    expect((await w.tab(1))?.state).toBe('BUILD_UNVERIFIED');
    await w.env.webRequest.onErrorOccurred.fire({...d, error: 'NS_BINDING_ABORTED'});
    await w.settle();
    expect((await w.tab(1))?.state).toBe('BUILD_UNVERIFIED');
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    await navigate(w, INDEX, {tab: 2});
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it("a subresource that comes before its document's commit: the late commit keeps the document", async () => {
    // A fresh tab: the request of a script attributes it by documentUrl and switches the frame to the
    // pending document early; the commit that follows must confirm it, not end the live document.
    const w = await createWorld({cores: [core1()]});
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.filters.get(d.requestId)!.respond(INDEX);
    await w.settle();
    const js = await script(w, MAIN);
    expect(js?.output).toEqual(MAIN);
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
    await w.settle();
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    // A later chunk is still attributed and judged.
    const evil = await script(w, bytes('evil()'));
    expect(evil).toBeDefined();
    expect((await w.tab(1))?.state).toBe('MISMATCH');
  });

  it('a response whose tab was closed while it loaded is not judged: no MISMATCH, nothing written', async () => {
    // Firefox ends the filter of a response cut off by closing its tab with the bytes that had
    // arrived, a prefix of the file (e2e vw-tab-closed-while-loading, permission-revoked).
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    w.env.removedTabs.add(1);
    const js = await script(w, MAIN.subarray(0, 5));
    await w.settle();
    expect(js?.output.length).toBe(0);
    expect(w.sinks.alerts).toHaveLength(0);
    expect((await w.engine.listAlerts()).length).toBe(0);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it("a commit older than the load (a new tab's about:blank, replayed late at a wake-up) leaves it alone", async () => {
    // The vault load wakes the stopped event page; Firefox delivers the tab's earlier about:blank
    // commit after the vault request, and the load must not be ended as one something else
    // committed over (e2e event-page-wake-block, event-page-idle).
    const w = await createWorld({cores: [core1()]});
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
      timeStamp: 2000,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: 'about:blank',
      timeStamp: 1000,
    });
    await w.settle();
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/`,
      timeStamp: 3000,
    });
    w.env.filters.get(d.requestId)!.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...d, statusCode: 200, timeStamp: 3000});
    await w.settle();
    expect(w.env.filters.get(d.requestId)!.output).toEqual(INDEX);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.top?.binding?.buildId).toBe('vaultwarden-web@2026.10.1+release');
  });
});

/**
 * A navigation cancels the loads of the document it replaces, and Firefox can still report one of
 * them completed although its filter stopped with a prefix (e2e vw-reload-cuts-response). The start of
 * the navigation (webNavigation.onBeforeNavigate) is what marks such a body: bytes that do not
 * match are then no evidence of different code. Everything else is judged as on any other page.
 */
describe('a response cut off while its document is being replaced', () => {
  const PREFIX = MAIN.subarray(0, 5);

  /** A request of tab 1's document, as far as its response headers. */
  async function requested(
    w: World,
    extra: Partial<WebRequestDetails> = {},
    headers = JS,
  ): Promise<{d: WebRequestDetails; filter: FakeStreamFilter}> {
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
      ...extra,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const filter = w.env.filters.get(d.requestId)!;
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: headers,
    });
    return {d, filter};
  }

  /** A frame starts a navigation, to a site the extension has no access to. */
  async function leaves(w: World, tabId = 1, frameId = 0): Promise<void> {
    w.env.onBeforeNavigate.emit({
      tabId,
      frameId,
      parentFrameId: frameId === 0 ? -1 : 0,
      url: 'https://elsewhere.example/',
      timeStamp: 0,
    });
    await w.settle();
  }

  async function expectQuiet(w: World, filter: FakeStreamFilter): Promise<void> {
    expect(filter.written).toHaveLength(0);
    expect(filter.closed).toBe(true);
    expect(w.sinks.alerts).toHaveLength(0);
    expect(await w.engine.listAlerts()).toEqual([]);
    expect(await w.engine.listIncidents(10)).toEqual([]);
    expect(w.env.tabsUpdated).toEqual([]);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.flags).not.toContain('CHECKING');
    expect(t?.top?.counts.scripts).toEqual({ok: 0, total: 0});
  }

  async function expectMismatch(w: World, filter: FakeStreamFilter): Promise<void> {
    expect(filter.written).toHaveLength(0);
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    expect((await w.tab(1))?.reasons).toContain('bytes');
    expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['MISMATCH']);
    expect((await w.engine.listIncidents(10)).map(i => i.kind)).toEqual(['mismatch']);
  }

  it('a prefix reported completed after its frame started a navigation is not judged: no MISMATCH, no alert, no incident, nothing written', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {filter} = await requested(w);
    await leaves(w);
    filter.respond(PREFIX);
    await w.settle();
    await expectQuiet(w, filter);
  });

  it('the same when the request is reported completed before the navigation starts and its filter stops after', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {d, filter} = await requested(w);
    await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
    await leaves(w);
    filter.respond(PREFIX, 7, false);
    await w.settle();
    await expectQuiet(w, filter);
  });

  it('the same when no end of the request is reported at all', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {filter} = await requested(w);
    await leaves(w);
    filter.respond(PREFIX, 7, false);
    await w.settle();
    expect(filter.closed).toBe(false);
    w.timers.advance(5_000);
    await w.settle();
    await expectQuiet(w, filter);
  });

  it("a navigation of a frame above the request's frame counts, one of another frame or tab does not", async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    // The vault frames one of its own pages (frame 5), which requests a script.
    const frame = {
      tabId: 1,
      frameId: 5,
      parentFrameId: 0,
      frameAncestors: [{url: `${VW_ORIGIN}/`, frameId: 0}],
    };
    const fd = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'sub_frame',
      ...frame,
    });
    await w.env.webRequest.onBeforeRequest.fire(fd);
    await w.env.webRequest.onHeadersReceived.fire({...fd, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({...frame, url: `${VW_ORIGIN}/`, timeStamp: 0});
    w.env.filters.get(fd.requestId)!.respond(INDEX);
    await w.settle();
    const inside = await requested(w, frame);
    await leaves(w, 1, 0);
    inside.filter.respond(PREFIX);
    await w.settle();
    await expectQuiet(w, inside.filter);

    const other = await createWorld({cores: [core1()]});
    await navigate(other, INDEX);
    const {filter} = await requested(other);
    await leaves(other, 2, 0);
    await leaves(other, 1, 5);
    filter.respond(PREFIX);
    await other.settle();
    await expectMismatch(other, filter);
  });

  it('a short body on a page that is not being replaced is MISMATCH, with its alert and incident', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {filter} = await requested(w);
    filter.respond(PREFIX);
    await w.settle();
    await expectMismatch(w, filter);
  });

  it('a request that began after the navigation started is judged: the page lives until the new one commits', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await leaves(w);
    const good = await requested(w);
    good.filter.respond(MAIN);
    await w.settle();
    expect(good.filter.output).toEqual(MAIN);
    expect((await w.tab(1))?.top?.counts.scripts).toEqual({ok: 1, total: 1});
    const bad = await requested(w);
    bad.filter.respond(PREFIX);
    await w.settle();
    await expectMismatch(w, bad.filter);
  });

  it('a whole body that matches is released and counted although the navigation started', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const {filter} = await requested(w);
    await leaves(w);
    filter.respond(MAIN);
    await w.settle();
    expect(filter.output).toEqual(MAIN);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.top?.counts.scripts).toEqual({ok: 1, total: 1});
  });

  it('a wrong header or an unlisted path stays MISMATCH, whatever the body', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const typed = await requested(w, {}, [{name: 'Content-Type', value: 'text/plain'}]);
    await leaves(w);
    typed.filter.respond(PREFIX);
    await w.settle();
    expect(typed.filter.written).toHaveLength(0);
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    expect((await w.tab(1))?.reasons).toEqual(['header']);

    const other = await createWorld({cores: [core1()]});
    await navigate(other, INDEX);
    const unlisted = await requested(other, {url: `${VW_ORIGIN}/app/other.js`});
    await leaves(other);
    unlisted.filter.respond(PREFIX);
    await other.settle();
    expect(unlisted.filter.written).toHaveLength(0);
    expect((await other.tab(1))?.state).toBe('MISMATCH');
    expect((await other.tab(1))?.reasons).toEqual(['unknown-path']);
    expect((await other.engine.listAlerts()).map(a => a.state)).toEqual(['MISMATCH']);
  });

  it('an empty body is handled as on any other page, under a bound document and under one proceeded with once', async () => {
    for (const bound of [true, false]) {
      const seen: unknown[] = [];
      for (const leaving of [false, true]) {
        const w = await createWorld({cores: bound ? [core1()] : []});
        if (bound) await navigate(w, INDEX);
        else await proceedOnceUnbound(w);
        const {filter} = await requested(w);
        if (leaving) await leaves(w);
        filter.respond(new Uint8Array(0));
        await w.settle();
        expect(filter.written.every(c => c.length === 0)).toBe(true);
        if (!bound) {
          // The release becomes known: the empty body that was kept is judged after the fact.
          const core = vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN});
          w.trust.cores.push(core);
          await w.engine.releaseKnown([core.ref]);
          await w.settle();
        }
        const t = await w.tab(1);
        seen.push([t?.state, t?.reasons, t?.top?.counts.scripts]);
      }
      expect(seen[0]).toEqual(['PROTECTION_LOST', ['unverifiable-active'], {ok: 0, total: 1}]);
      expect(seen[1]).toEqual(seen[0]);
    }
  });

  it('a document is never marked: one that differs is denied although its frame started a navigation after its request', async () => {
    // A load Firefox starts in its main process is announced after its request.
    const other = vwCore('2026.10.1', {'/index.html': bytes('<html>other</html>')});
    const w = await createWorld({cores: [other]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await leaves(w);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/`,
      timeStamp: 0,
    });
    w.env.filters.get(d.requestId)!.respond(INDEX);
    await w.settle();
    expect(w.env.filters.get(d.requestId)!.written).toHaveLength(0);
    expect(w.env.tabsUpdated.at(-1)?.url).toMatch(/\/ui\/blocked\.html#[0-9a-f]{16}$/);
    expect((await w.tab(1))?.state).toBe('MISMATCH');
  });

  it('under a document the user proceeded with once, a cut-off body is neither released nor kept for retro-verification', async () => {
    const w = await createWorld({cores: []});
    await proceedOnceUnbound(w);
    const {filter} = await requested(w);
    await leaves(w);
    filter.respond(PREFIX);
    await w.settle();
    expect(filter.written).toHaveLength(0);
    expect(filter.closed).toBe(true);
    // The release becomes known: nothing of the cut-off body is judged after the fact.
    const core = vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN});
    w.trust.cores.push(core);
    await w.engine.releaseKnown([core.ref]);
    await w.settle();
    const t = await w.tab(1);
    expect(t?.top?.binding?.version).toBe('2026.11.0');
    expect(t?.state).toBe('BUILD_UNVERIFIED');
    expect(t?.top?.counts.scripts).toEqual({ok: 0, total: 0});
    expect((await w.engine.listIncidents(50)).filter(i => i.kind === 'mismatch')).toEqual([]);
  });

  for (const start of [
    'before the body arrives',
    'after the whole body arrived, before the end of its request is reported',
  ] as const) {
    it(`a navigation that never replaces the page (it starts ${start}) hides nothing that runs: a changed file is withheld while marked and judged when the page asks again`, async () => {
      // The navigation is answered without a document (204, a download): nothing commits.
      const w = await createWorld({cores: [core1()]});
      await navigate(w, INDEX);
      const changed = bytes('changed();');
      const marked = await requested(w);
      if (start === 'before the body arrives') {
        await leaves(w);
        marked.filter.respond(changed);
      } else {
        marked.filter.respond(changed, 7, false);
        await w.settle();
        await leaves(w);
        await w.env.webRequest.onCompleted.fire({...marked.d, statusCode: 200});
      }
      await w.settle();
      await expectQuiet(w, marked.filter);
      const again = await requested(w);
      again.filter.respond(changed);
      await w.settle();
      await expectMismatch(w, again.filter);
    });
  }

  it('a framed document is never marked either: one that differs is denied although the top frame started a navigation after its request', async () => {
    const w = await createWorld({cores: [core1()]});
    w.registry.hint = {version: '2026.10.1', at: 0};
    await navigate(w, INDEX);
    const frame = {
      tabId: 1,
      frameId: 5,
      parentFrameId: 0,
      frameAncestors: [{url: `${VW_ORIGIN}/`, frameId: 0}],
    };
    const fd = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'sub_frame',
      ...frame,
    });
    await w.env.webRequest.onBeforeRequest.fire(fd);
    await leaves(w, 1, 0);
    await w.env.webRequest.onHeadersReceived.fire({...fd, statusCode: 200, responseHeaders: HTML});
    w.env.onCommitted.emit({...frame, url: `${VW_ORIGIN}/`, timeStamp: 0});
    const filter = w.env.filters.get(fd.requestId)!;
    filter.respond(bytes('<html>other</html>'));
    await w.settle();
    expect(filter.written).toHaveLength(0);
    expect((await w.tab(1))?.state).toBe('MISMATCH');
    expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['MISMATCH']);
  });

  it('a script a service worker answers is not excused by the mark: withheld and PROTECTION_LOST as on any page', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const filter = w.env.filters.get(d.requestId)!;
    // The worker takes the request: no response headers and no end are reported for its answer.
    w.env.webRequest.onBeforeRedirect.emit({...d, statusCode: 0, redirectUrl: d.url});
    await leaves(w);
    filter.respond(bytes('self.evil = true;'), 7, false);
    await w.settle();
    w.timers.advance(2_000);
    await w.settle();
    expect(filter.written).toHaveLength(0);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
  });

  it('a request that names no tab is never marked: a changed import of a worker is MISMATCH although the tab started a navigation', async () => {
    const WORKER_PATH = '/app/worker.0123456789abcdef0123.js';
    const CHUNK_PATH = '/app/chunk.0123456789abcdef0123.js';
    const WORKER = bytes('importScripts("chunk.0123456789abcdef0123.js")');
    const w = await createWorld({
      cores: [
        vwCore('2026.10.1', {
          '/index.html': INDEX,
          [WORKER_PATH]: WORKER,
          [CHUNK_PATH]: bytes('self.chunk = 1'),
        }),
      ],
    });
    await navigate(w, INDEX);
    await script(w, WORKER, WORKER_PATH);
    const imported = await requested(w, {
      url: `${VW_ORIGIN}${CHUNK_PATH}`,
      tabId: -1,
      frameId: -1,
      documentUrl: `${VW_ORIGIN}${WORKER_PATH}`,
      originUrl: `${VW_ORIGIN}${WORKER_PATH}`,
    });
    await leaves(w);
    imported.filter.respond(bytes('self.chunk = "changed"'));
    await w.settle();
    await expectMismatch(w, imported.filter);
  });

  it('under a document the user proceeded with once, a marked body does not hide one that ran: the body released before is MISMATCH after the fact', async () => {
    const w = await createWorld({cores: []});
    await proceedOnceUnbound(w);
    const ran = bytes('tampered()');
    expect((await script(w, ran))?.output).toEqual(ran);
    // The page asks for the path again; this time the body arrives while the frame leaves.
    const {filter} = await requested(w);
    await leaves(w);
    filter.respond(MAIN);
    await w.settle();
    expect(filter.written).toHaveLength(0);
    w.trust.cores.push(vwCore('2026.11.0', {'/index.html': INDEX, [MAIN_PATH]: MAIN}));
    await w.engine.releaseKnown(w.trust.cores.map(c => c.ref));
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toContain('bytes');
    expect(w.sinks.alerts.at(-1)?.state).toBe('MISMATCH');
  });
});

/**
 * A document's StreamFilter that fails (onerror) no longer holds the document, but its bytes reach
 * a page only if its load commits. A newer navigation of the frame (a double reload, a page script
 * calling location.assign twice) cancels the older load, and Firefox ends that load's filter with
 * onerror when its response had not started (e2e vw-double-reload): nothing of it commits or runs, so
 * it ends quietly. A failed load that commits, or that the frame already shows, is a filter failure on a
 * shown document: red, an origin alert and taint.
 */
describe('a document filter that fails is decided by whether its load commits', () => {
  /**
   * A top-level load of the vault started in tab 1 (`at`: its request's time). `responded`: its
   * response started (headers seen, the first bytes of the document held); a load the next
   * navigation cancels before that has none.
   */
  async function start(
    w: World,
    at = 0,
    responded = true,
  ): Promise<{d: WebRequestDetails; filter: FakeStreamFilter}> {
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
      timeStamp: at,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    const filter = w.env.filters.get(d.requestId)!;
    if (responded) {
      await w.env.webRequest.onHeadersReceived.fire({
        ...d,
        statusCode: 200,
        responseHeaders: HTML,
      });
      filter.ondata?.({data: INDEX.slice(0, 9).buffer});
    }
    await w.settle();
    return {d, filter};
  }
  const fail = async (w: World, f: FakeStreamFilter): Promise<void> => {
    f.onerror?.({});
    await w.settle();
  };
  const abort = async (w: World, d: WebRequestDetails): Promise<void> => {
    await w.env.webRequest.onErrorOccurred.fire({...d, error: 'NS_BINDING_ABORTED'});
    await w.settle();
  };
  const commit = async (w: World, at = 0): Promise<void> => {
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/`,
      timeStamp: at,
    });
    await w.settle();
  };
  /**
   * The load's filter fails, its request reports the abort and the frame commits, with no time
   * between the three events: the engine is still busy with the first when the last arrives.
   */
  const failAbortCommit = async (
    w: World,
    load: {d: WebRequestDetails; filter: FakeStreamFilter},
    at = 0,
  ): Promise<void> => {
    load.filter.onerror?.({});
    w.env.webRequest.onErrorOccurred.emit({...load.d, error: 'NS_BINDING_ABORTED'});
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/`,
      timeStamp: at,
    });
    await w.settle();
  };
  /** The second load runs to the end: committed, verified, completed. */
  const finish = async (
    w: World,
    second: {d: WebRequestDetails; filter: FakeStreamFilter},
    at = 0,
  ): Promise<void> => {
    await commit(w, at);
    // The rest of the document (start() sent its first bytes).
    second.filter.respond(INDEX.slice(9));
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...second.d, statusCode: 200});
    await w.settle();
    await script(w, MAIN);
  };
  const quiet = async (w: World): Promise<void> => {
    expect(await w.engine.listAlerts()).toEqual([]);
    expect(await w.engine.listIncidents(10)).toEqual([]);
    expect(w.sinks.alerts).toEqual([]);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
  };
  const red = async (w: World): Promise<void> => {
    expect((await w.engine.listAlerts()).map(a => [a.state, a.reasons])).toEqual([
      ['PROTECTION_LOST', ['filter-failed']],
    ]);
    expect((await w.engine.listIncidents(10)).map(i => i.kind)).toEqual(['protection-lost']);
    expect(w.sinks.alerts.map(a => a.state)).toEqual(['PROTECTION_LOST']);
  };

  it('a double reload: the load the second one cancels ends quietly, the second is VERIFIED', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    // The server has not answered the first load yet when the second one starts.
    const first = await start(w, 0, false);
    const second = await start(w);
    // Firefox cancels the first load: its filter fails, then its request reports the abort.
    await fail(w, first.filter);
    await abort(w, first.d);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await finish(w, second);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.flags).not.toContain('CHECKING');
    expect(second.filter.output).toEqual(INDEX);
    expect(first.filter.written).toHaveLength(0);
    await quiet(w);
  });

  it('a late commit is not taken for a newer load that was cancelled before its response started and reported failed', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    // The first load's response started; its commit arrives only after the second load, which
    // never got a response, was cancelled: nobody holds that one, but its request failed.
    const first = await start(w, 1000);
    const second = await start(w, 2000, false);
    await fail(w, second.filter);
    await abort(w, second.d);
    await finish(w, first, 2500);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.top?.doc).toBe('1:0:2');
    expect(first.filter.output).toEqual(INDEX);
    await quiet(w);
  });

  it('a double reload that cancels the first load mid-body: its filter stops with a prefix, which is never judged', async () => {
    // Firefox commits a document when its response starts, before the filter writes anything.
    // Cancelled while its body is held, the load's request reports the abort and its filter stops
    // with what had arrived: nothing was written, so nothing of it reached the page.
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    const first = await start(w);
    await commit(w);
    await abort(w, first.d);
    first.filter.onstop?.({});
    await w.settle();
    const second = await start(w);
    await finish(w, second);
    expect(first.filter.written).toHaveLength(0);
    expect(first.filter.closed).toBe(true);
    expect(w.env.tabsUpdated).toEqual([]);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.flags).not.toContain('CHECKING');
    await quiet(w);
  });

  it('a prefix whose abort is reported after the filter stopped waits for the outcome and is never judged', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    const first = await start(w);
    await commit(w);
    first.filter.onstop?.({});
    await w.settle();
    await abort(w, first.d);
    const second = await start(w);
    await finish(w, second);
    expect(first.filter.written).toHaveLength(0);
    expect(w.env.tabsUpdated).toEqual([]);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await quiet(w);
  });

  it('a whole response whose outcome is reported after the filter stopped is judged once it is', async () => {
    const w = await createWorld({cores: [core1()]});
    const first = await start(w);
    await commit(w);
    first.filter.respond(INDEX.slice(9), 7, false);
    await w.settle();
    expect(first.filter.written).toHaveLength(0);
    await w.env.webRequest.onCompleted.fire({...first.d, statusCode: 200});
    await w.settle();
    expect(first.filter.output).toEqual(INDEX);
    // With no outcome at all, the body is judged after a bounded wait.
    const again = await start(w);
    await commit(w);
    again.filter.respond(INDEX.slice(9), 7, false);
    await w.settle();
    expect(again.filter.written).toHaveLength(0);
    w.timers.advance(5_000);
    await w.settle();
    expect(again.filter.output).toEqual(INDEX);
  });

  it('the cancelled load reports its failure and abort before the next load starts: it ends quietly too', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    const first = await start(w, 0, false);
    await fail(w, first.filter);
    await abort(w, first.d);
    const second = await start(w);
    await finish(w, second);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await quiet(w);
  });

  // A reload the next reload cancels after its headers were seen and before its commit: Firefox
  // fails its filter and its request, and the load never commits. The one commit that follows is
  // the next load's, but nothing tells it from a commit of the cancelled load, whose response
  // nobody held.
  /** The first reload responded; the second one's request and response headers are in. */
  const cancelledAfterHeaders = async (
    w: World,
  ): Promise<Record<'first' | 'second', Awaited<ReturnType<typeof start>>>> => {
    await navigate(w, INDEX);
    await script(w, MAIN);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const first = await start(w, 1000);
    const second = await start(w, 2000, false);
    await w.env.webRequest.onHeadersReceived.fire({
      ...second.d,
      statusCode: 200,
      responseHeaders: HTML,
    });
    return {first, second};
  };
  /** The second reload's document is checked and released; answers its script's filter. */
  const released = async (
    w: World,
    load: Awaited<ReturnType<typeof start>>,
  ): Promise<FakeStreamFilter | undefined> => {
    load.filter.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...load.d, statusCode: 200});
    await w.settle();
    expect(load.filter.output).toEqual(INDEX);
    return script(w, MAIN);
  };

  it('a reload cancelled after its response started, whose filter fails before the next load commits, takes that commit: red, a false alarm one more reload ends', async () => {
    const w = await createWorld({cores: [core1()]});
    const {first, second} = await cancelledAfterHeaders(w);
    await fail(w, first.filter);
    await abort(w, first.d);
    await quiet(w);
    await commit(w, 2500);
    const js = await released(w, second);
    expect(first.filter.written).toHaveLength(0);
    // The page shows the second load's verified document, but the tab is the cancelled load's,
    // which is never judged: the page's script is withheld.
    expect(js?.written).toHaveLength(0);
    const t = await w.tab(1);
    expect(t).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed', 'unbound']});
    expect(t?.frames.map(f => f.state)).toEqual(['CO_RESIDENT_UNVERIFIED']);
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    // One more reload replaces it: the taint ends, and the alert withholds green until it is
    // acknowledged.
    const third = await start(w, 3000);
    await finish(w, third, 3500);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(false);
    expect(await w.tab(1)).toMatchObject({state: 'RECOVERING', reasons: [], frames: []});
    await w.engine.acknowledgeAlert(VW_ORIGIN);
    await w.settle();
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('a reload cancelled after its response started, whose failure and abort arrive together with the next commit, takes that commit too: the same false alarm', async () => {
    const w = await createWorld({cores: [core1()]});
    const {first, second} = await cancelledAfterHeaders(w);
    await w.settle();
    await failAbortCommit(w, first, 2500);
    const js = await released(w, second);
    expect(js?.written).toHaveLength(0);
    const t = await w.tab(1);
    expect(t).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed', 'unbound']});
    expect(t?.top?.counts.document).toEqual({ok: 0, total: 1});
    expect(t?.frames.map(f => f.state)).toEqual(['CO_RESIDENT_UNVERIFIED']);
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
  });

  it('a reload cancelled after its response started, whose filter fails after the next load committed, ends quietly; the next load is VERIFIED', async () => {
    const w = await createWorld({cores: [core1()]});
    const {first, second} = await cancelledAfterHeaders(w);
    await commit(w, 2500);
    await fail(w, first.filter);
    await abort(w, first.d);
    const js = await released(w, second);
    expect(first.filter.written).toHaveLength(0);
    expect(js?.output).toEqual(MAIN);
    const t = await w.tab(1);
    expect(t?.state).toBe('VERIFIED');
    expect(t?.flags).not.toContain('CHECKING');
    expect(t?.frames).toEqual([]);
    await quiet(w);
  });

  it('a failed load that commits after all (its response went to the page unfiltered) is red, with an alert and taint', async () => {
    const w = await createWorld({cores: [core1()]});
    const first = await start(w);
    await fail(w, first.filter);
    // Nothing has run yet: no alert before the commit.
    expect(await w.engine.listAlerts()).toEqual([]);
    await commit(w);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
  });

  it('a filter that fails on a document the frame already shows is red at once', async () => {
    const w = await createWorld({cores: [core1()]});
    const first = await start(w);
    await commit(w);
    await fail(w, first.filter);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
  });

  it('a document whose filter cannot be attached is cancelled: its blocked page, no alert, no incident, no taint', async () => {
    const w = await createWorld({cores: [core1()]});
    w.env.filterError = () => new Error('filter failed');
    const d = details({requestId: String(seq++), url: `${VW_ORIGIN}/`, type: 'main_frame'});
    const r = await w.env.webRequest.onBeforeRequest.fire(d);
    w.env.filterError = null;
    expect(r[0]).toEqual({cancel: true});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    const shown = w.env.tabsUpdated.find(u => u.tab === 1);
    const id = decodeURIComponent(shown!.url.slice(shown!.url.indexOf('#') + 1));
    expect(await w.engine.blockedView(id)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['filter-failed'],
    });
    await quiet(w);
  });

  it('a request of the failed document shows it committed before its commit event arrived: red', async () => {
    const w = await createWorld({cores: [core1()]});
    const first = await start(w);
    await fail(w, first.filter);
    expect(await w.engine.listAlerts()).toEqual([]);
    // The page's own script request names the loading document: it is shown and runs.
    await script(w, MAIN);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST'});
    expect((await w.tab(1))?.reasons).toContain('filter-failed');
    expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['PROTECTION_LOST']);
  });

  it('a failed load whose abort comes before its own commit is revived red when the commit arrives', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX, {tab: 2});
    const first = await start(w);
    await fail(w, first.filter);
    await abort(w, first.d);
    await quiet(w);
    await commit(w);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
  });

  it('a failed load whose abort and own commit arrive together is revived red too: the end queued behind its request does not end it', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX, {tab: 2});
    const first = await start(w);
    await failAbortCommit(w, first);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
  });

  it('a failed load whose commit is reported after the next load started is revived red, not taken for the next load', async () => {
    // The first load committed (its page shows unfiltered bytes) before the second request
    // started, but Firefox delivers that commit after the second request: the commit's time
    // tells it apart from the second load's own commit.
    const w = await createWorld({cores: [core1()]});
    const first = await start(w, 1000);
    await fail(w, first.filter);
    const second = await start(w, 2000);
    await commit(w, 1500);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    // The second load then commits over it and its bytes verify, but it is not green: it was
    // loading while the first document ran (its co-resident flag is sticky), and the
    // first load's alert stays open.
    await finish(w, second, 2500);
    expect(second.filter.output).toEqual(INDEX);
    expect((await w.tab(1))?.top?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect((await w.engine.listAlerts()).map(a => a.acknowledged)).toEqual([false]);
  });

  it("a failed load whose commit comes after the next load's request, before that load responded, is the one shown: red", async () => {
    // The next load cannot have committed yet (Firefox commits a document once its response
    // starts), so the commit is the failed load's, whatever its time.
    const w = await createWorld({cores: [core1()]});
    const first = await start(w, 1000);
    await fail(w, first.filter);
    const second = await start(w, 2000, false);
    await commit(w, 2500);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    // The second load then responds, commits over it and verifies, but it was loading while the
    // first document ran.
    await w.env.webRequest.onHeadersReceived.fire({
      ...second.d,
      statusCode: 200,
      responseHeaders: HTML,
    });
    await commit(w, 3000);
    second.filter.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...second.d, statusCode: 200});
    await w.settle();
    expect(second.filter.output).toEqual(INDEX);
    expect((await w.tab(1))?.top?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect((await w.engine.listAlerts()).map(a => a.acknowledged)).toEqual([false]);
  });

  it("a load the next request replaced, whose filter and request then fail, still takes a commit that comes before the next load's response: red", async () => {
    // The filter failure counts for a load the next request replaced too, and its reported
    // request failure takes nothing back. The next load has no response yet, so it cannot have
    // committed: the commit is the failed load's.
    const w = await createWorld({cores: [core1()]});
    const first = await start(w, 1000);
    const second = await start(w, 2000, false);
    await fail(w, first.filter);
    await abort(w, first.d);
    await quiet(w);
    await commit(w, 2500);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    // The second load then responds, commits over it and verifies, but it was loading while the
    // first document ran.
    await w.env.webRequest.onHeadersReceived.fire({
      ...second.d,
      statusCode: 200,
      responseHeaders: HTML,
    });
    await commit(w, 3000);
    second.filter.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...second.d, statusCode: 200});
    await w.settle();
    expect(second.filter.output).toEqual(INDEX);
    expect((await w.tab(1))?.top?.state).toBe('CO_RESIDENT_UNVERIFIED');
    expect((await w.engine.listAlerts()).map(a => a.acknowledged)).toEqual([false]);
  });

  it('a commit both a failed load and the next load could report is taken for the failed one: red', async () => {
    const w = await createWorld({cores: [core1()]});
    const first = await start(w, 1000);
    await fail(w, first.filter);
    const second = await start(w, 2000);
    await commit(w, 2500);
    await red(w);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
    await finish(w, second, 3000);
    expect((await w.tab(1))?.top?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a failed load another commit of the frame ended is revived red by its own late commit', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX, {tab: 2});
    const first = await start(w, 1000);
    await fail(w, first.filter);
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: 'about:blank',
      timeStamp: 1500,
    });
    await w.settle();
    await quiet(w);
    await commit(w, 1600);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    await red(w);
    expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
  });

  it('a failed load that neither commits nor ends is never green: R4 makes it PROTECTION_LOST timeout, and its commit still counts', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    const first = await start(w, 0, false);
    await fail(w, first.filter);
    expect((await w.tab(1))?.flags).toContain('CHECKING');
    w.timers.advance(31_000);
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['timeout']});
    await quiet(w);
    await commit(w);
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST'});
    expect((await w.tab(1))?.reasons).toContain('filter-failed');
    expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['PROTECTION_LOST']);
    expect(w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
  });

  for (const variant of [
    'before its response started',
    'after its response started, its content script already connected',
    'and R4 passed',
  ] as const) {
    it(`an event-page restart after the filter of a load failed ${variant}, before its commit: it counts as run`, async () => {
      // The new instance cannot tell whether that load committed: the frame map keeps no loading
      // document. Its commit reaches the new instance, which attributes it to nothing.
      const session = new FakeArea();
      const local = new FakeArea();
      const timers = new FakeTimers();
      const w1 = await createWorld({cores: [core1()], session, local, timers});
      await navigate(w1, INDEX);
      await script(w1, MAIN);
      await navigate(w1, INDEX, {tab: 2});
      const responded = variant !== 'before its response started' && variant !== 'and R4 passed';
      const first = await start(w1, 0, responded);
      await fail(w1, first.filter);
      if (responded) await w1.engine.hello({tab: 1, frame: 0, url: `${VW_ORIGIN}/`});
      if (variant === 'and R4 passed') {
        timers.advance(31_000);
        await w1.settle();
        expect(await w1.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['timeout']});
      }
      await quiet(w1);
      const w2 = await createWorld({cores: [core1()], session, local, timers});
      await w2.settle();
      if (!responded) {
        await w2.env.webRequest.onHeadersReceived.fire({
          ...first.d,
          statusCode: 200,
          responseHeaders: HTML,
        });
      }
      await commit(w2);
      const alerts = await w2.engine.listAlerts();
      expect(alerts.map(a => [a.state, a.acknowledged])).toEqual([['PROTECTION_LOST', false]]);
      expect(alerts[0]?.reasons).toContain('verifier-restarted');
      expect(session.data.has(`s:v1:taint:${VW_ORIGIN}`)).toBe(true);
      expect((await w2.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
      await navigate(w2, INDEX, {tab: 3});
      expect((await w2.tab(3))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    });
  }

  it('a double reload, then an event-page restart: the cancelled load is not taken for one that ran', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const w1 = await createWorld({cores: [core1()], session, local, timers});
    await navigate(w1, INDEX);
    await script(w1, MAIN);
    const first = await start(w1, 0, false);
    const second = await start(w1);
    await fail(w1, first.filter);
    await abort(w1, first.d);
    await finish(w1, second);
    const w2 = await createWorld({cores: [core1()], session, local, timers});
    await w2.settle();
    expect((await w2.tab(1))?.state).toBe('VERIFIED');
    await quiet(w2);
  });
});

/**
 * A subresource filter that fails stops holding the response. Firefox also fails a filter whose
 * request is already gone (its tab closed or reloaded before the filter attached): that request
 * is reported failed and nothing of it reaches a page.
 */
describe('a subresource filter that fails', () => {
  const failingScript = async (w: World): Promise<WebRequestDetails> => {
    const d = details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    return d;
  };
  const aborted = (d: WebRequestDetails): unknown => ({...d, error: 'NS_BINDING_ABORTED'});

  for (const order of ['filter error first', 'request failure first'] as const) {
    it(`a request Firefox reports failed is not counted as delivered (${order})`, async () => {
      const w = await createWorld({cores: [core1()]});
      await navigate(w, INDEX);
      const d = await failingScript(w);
      const f = w.env.filters.get(d.requestId)!;
      if (order === 'filter error first') f.onerror?.({});
      await w.env.webRequest.onErrorOccurred.fire(aborted(d));
      if (order === 'request failure first') f.onerror?.({});
      w.timers.advance(5_000);
      await w.settle();
      expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', reasons: []});
      expect(w.sinks.alerts).toEqual([]);
    });
  }

  it('a request that completes is PROTECTION_LOST filter-failed with an alert', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const d = await failingScript(w);
    w.env.filters.get(d.requestId)!.onerror?.({});
    await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    expect(w.sinks.alerts.map(a => a.state)).toEqual(['PROTECTION_LOST']);
  });

  it('a request whose end is not reported in time counts as delivered', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const d = await failingScript(w);
    w.env.filters.get(d.requestId)!.onerror?.({});
    await w.settle();
    expect((await w.tab(1))?.reasons).not.toContain('filter-failed');
    w.timers.advance(2_000);
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
  });
});

describe('a service worker that controls the page', () => {
  // Firefox reports a request such a worker takes as onBeforeRedirect with no status and the
  // request's own address, under the same request id (`taken`). It reports no response headers
  // and no end for what the worker answers; a request the worker leaves to the network is
  // reported again (onBeforeRequest, same id), and the first filter of that request fails.
  const documentRequest = (at = 0): WebRequestDetails =>
    details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
      tabId: 1,
      timeStamp: at,
    });
  const scriptRequest = (): WebRequestDetails =>
    details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${MAIN_PATH}`,
      type: 'script',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
  const request = async (w: World, d: WebRequestDetails): Promise<FakeStreamFilter> => {
    await w.env.webRequest.onBeforeRequest.fire(d);
    return w.env.filters.get(d.requestId)!;
  };
  const taken = (w: World, d: WebRequestDetails): void => {
    w.env.webRequest.onBeforeRedirect.emit({...d, statusCode: 0, redirectUrl: d.url});
  };
  const commit = (w: World, at = 0): void => {
    w.env.onCommitted.emit({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: `${VW_ORIGIN}/`,
      timeStamp: at,
    });
  };
  const tainted = (w: World): boolean => w.env.session.data.has(`s:v1:taint:${VW_ORIGIN}`);
  /** The network answers the document request `d` in full: headers, commit, body, end. */
  const answered = async (w: World, d: WebRequestDetails, f: FakeStreamFilter): Promise<void> => {
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    commit(w);
    f.respond(INDEX);
    await w.settle();
    await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
    await w.settle();
  };

  const ORDERS = [
    ['filter error', 'notice', 'commit'],
    ['filter error', 'commit', 'notice'],
    ['notice', 'filter error', 'commit'],
    ['notice', 'commit', 'filter error'],
    ['commit', 'filter error', 'notice'],
    ['commit', 'notice', 'filter error'],
  ] as const;
  for (const order of ORDERS) {
    it(`a document the worker answers is red, with an alert and taint (${order.join(', ')})`, async () => {
      const w = await createWorld({cores: [core1()]});
      const d = documentRequest();
      const f = await request(w, d);
      for (const event of order) {
        if (event === 'filter error') f.onerror?.({});
        if (event === 'notice') taken(w, d);
        if (event === 'commit') commit(w);
        if (order.indexOf(event) === 1) await w.settle();
      }
      await w.settle();
      expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
      expect((await w.engine.listAlerts()).map(a => [a.state, a.reasons])).toEqual([
        ['PROTECTION_LOST', ['filter-failed']],
      ]);
      expect(tainted(w)).toBe(true);
      expect(f.written).toHaveLength(0);
      // The page's content script finds its document, and what it reports counts.
      const url = `${VW_ORIGIN}/`;
      const hello = await w.engine.hello({tab: 1, frame: 0, url});
      expect(hello.protected).toBe(true);
      await w.engine.contentDom(
        {tab: 1, frame: 0, url},
        {doc: hello.doc, event: 'sw-register', detail: {count: 1}},
      );
      expect(await w.tab(1)).toMatchObject({state: 'MISMATCH', reasons: ['service-worker']});
      // The vault in another tab meanwhile is not green.
      await navigate(w, INDEX, {tab: 2});
      expect((await w.tab(2))?.state).toBe('CO_RESIDENT_UNVERIFIED');
    });
  }

  for (const late of [false, true]) {
    it(`a document the worker leaves to the network is judged on its own bytes (the first filter fails ${late ? 'after' : 'before'} the request is reported again)`, async () => {
      const w = await createWorld({cores: [core1()]});
      const d = documentRequest();
      const first = await request(w, d);
      // No time passes between these events: the engine is still busy with the document's start
      // when the same request id names the next hop.
      if (!late) first.onerror?.({});
      taken(w, d);
      const second = await request(w, d);
      expect(second).not.toBe(first);
      if (late) first.onerror?.({});
      await answered(w, d, second);
      expect(second.output).toEqual(INDEX);
      await script(w, MAIN);
      w.timers.advance(5_000);
      await w.settle();
      expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', reasons: []});
      expect(await w.engine.listAlerts()).toEqual([]);
      expect(await w.engine.listIncidents(10)).toEqual([]);
      expect(tainted(w)).toBe(false);
    });
  }

  it('a tampered document the worker leaves to the network is denied', async () => {
    const w = await createWorld({cores: [core1()]});
    const d = documentRequest();
    const first = await request(w, d);
    first.onerror?.({});
    taken(w, d);
    const second = await request(w, d);
    await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
    second.respond(bytes('<!doctype html><script src="/evil.js"></script>'));
    await w.settle();
    expect(second.written).toHaveLength(0);
    expect((await w.tab(1))?.state).not.toBe('VERIFIED');
    expect(tainted(w)).toBe(false);
  });

  for (const late of [false, true]) {
    it(`a script the worker leaves to the network is verified by its second filter (the first fails ${late ? 'after' : 'before'} the request is reported again)`, async () => {
      const w = await createWorld({cores: [core1()]});
      await navigate(w, INDEX);
      const d = scriptRequest();
      const first = await request(w, d);
      if (!late) first.onerror?.({});
      taken(w, d);
      const second = await request(w, d);
      if (late) first.onerror?.({});
      await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: JS});
      second.respond(MAIN);
      await w.settle();
      await w.env.webRequest.onCompleted.fire({...d, statusCode: 200});
      w.timers.advance(5_000);
      await w.settle();
      expect(second.output).toEqual(MAIN);
      expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', reasons: []});
      expect(w.sinks.alerts).toEqual([]);
    });
  }

  for (const [what, body] of [
    ['its own bytes', bytes('self.evil = true;')],
    ["the release's bytes", MAIN],
  ] as const) {
    it(`a script the worker answers with ${what} is withheld: no response headers were reported for it`, async () => {
      const w = await createWorld({cores: [core1()]});
      await navigate(w, INDEX);
      const d = scriptRequest();
      const f = await request(w, d);
      taken(w, d);
      // The filter receives what the worker answers; no headers and no end are reported.
      f.respond(body, 7, false);
      await w.settle();
      expect(f.closed).toBe(false);
      w.timers.advance(2_000);
      await w.settle();
      expect(f.written).toHaveLength(0);
      expect(f.closed).toBe(true);
      expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
    });
  }

  it('a script whose filter fails after the worker took the request counts as delivered', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    const d = scriptRequest();
    const f = await request(w, d);
    taken(w, d);
    f.onerror?.({});
    w.timers.advance(2_000);
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    expect(w.sinks.alerts.map(a => a.state)).toEqual(['PROTECTION_LOST']);
  });

  it('a load the worker answers takes its commit from an older load that only responded', async () => {
    // The older load's response started (its headers were seen) before the next request cut it
    // off; no headers are ever reported for the load the worker answers.
    const w = await createWorld({cores: [core1()]});
    const older = documentRequest(1000);
    const cut = await request(w, older);
    await w.env.webRequest.onHeadersReceived.fire({
      ...older,
      statusCode: 200,
      responseHeaders: HTML,
    });
    const d = documentRequest(2000);
    const f = await request(w, d);
    cut.onstop?.({});
    f.onerror?.({});
    await w.env.webRequest.onErrorOccurred.fire({...older, error: 'NS_BINDING_ABORTED'});
    taken(w, d);
    commit(w, 2500);
    await w.settle();
    const t = await w.tab(1);
    expect(t).toMatchObject({state: 'PROTECTION_LOST', reasons: ['filter-failed']});
    expect(t?.top?.doc).toBe(`1:0:2`);
    expect((await w.engine.listAlerts()).map(a => a.state)).toEqual(['PROTECTION_LOST']);
    expect(tainted(w)).toBe(true);
  });
});

describe('a redirect of a server-rendered page', () => {
  it('the admin portal sending a visitor to its login page is followed; the login page is denied quietly', async () => {
    const w = await createWorld({cores: [core1()]});
    await navigate(w, INDEX);
    await script(w, MAIN);
    const req = String(seq++);
    const hop1 = details({requestId: req, url: `${VW_ORIGIN}/admin`, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(hop1);
    const answer = await w.env.webRequest.onHeadersReceived.fire({
      ...hop1,
      statusCode: 302,
      responseHeaders: [{name: 'Location', value: '/admin/login'}],
    });
    expect(answer[0]?.cancel).not.toBe(true);
    w.env.filters.get(req)!.onerror?.({});
    await w.env.webRequest.onBeforeRedirect.fire({
      ...hop1,
      redirectUrl: `${VW_ORIGIN}/admin/login`,
    });
    await w.settle();
    const hop2 = details({
      requestId: req,
      url: `${VW_ORIGIN}/admin/login`,
      type: 'main_frame',
      tabId: 2,
    });
    await w.env.webRequest.onBeforeRequest.fire(hop2);
    await w.env.webRequest.onHeadersReceived.fire({
      ...hop2,
      statusCode: 200,
      responseHeaders: HTML,
    });
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url: hop2.url, timeStamp: 0});
    const login = w.env.filters.get(req)!;
    login.respond(bytes('<html><form method="post">token</form></html>'));
    await w.settle();
    expect(login.written).toHaveLength(0);
    expect(w.env.tabsUpdated.map(u => u.tab)).toEqual([2]);
    expect(await w.tab(2)).toMatchObject({state: 'NOT_COVERED', reasons: ['admin-portal']});
    expect(await w.engine.listAlerts()).toEqual([]);
    expect(w.sinks.alerts).toEqual([]);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });
});

/**
 * A revalidation: Firefox reports the server's 304 to onHeadersReceived (no Location), then the
 * cached response it merged the 304 into (status 200), then the cached body to the filter.
 */
describe('a revalidated response (304, then the cached one)', () => {
  const NOT_MODIFIED = [{name: 'ETag', value: '"abc"'}];
  const LOGO = bytes('\x89PNG logo');
  const LOGO_PATH = '/images/logo.png';
  const withLogo = (): ReturnType<typeof vwCore> => {
    const c = vwCore('2026.10.1', {'/index.html': INDEX, [MAIN_PATH]: MAIN, [LOGO_PATH]: LOGO});
    const files = c.core.files as Record<string, {class: string}>;
    files[LOGO_PATH] = {...files[LOGO_PATH]!, class: 'image'};
    return c;
  };
  const image = (): WebRequestDetails =>
    details({
      requestId: String(seq++),
      url: `${VW_ORIGIN}${LOGO_PATH}`,
      type: 'image',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });

  it('a 304 for an image of a VERIFIED page is not cancelled: no red state, no alert', async () => {
    const w = await createWorld({cores: [withLogo()]});
    await navigate(w, INDEX);
    const img = image();
    await w.env.webRequest.onBeforeRequest.fire(img);
    const answer = await w.env.webRequest.onHeadersReceived.fire({
      ...img,
      statusCode: 304,
      responseHeaders: NOT_MODIFIED,
    });
    await w.settle();
    expect(answer).not.toContainEqual({cancel: true});
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', reasons: []});
    expect(w.sinks.alerts).toEqual([]);
  });

  it('a revalidated document is hashed and released: VERIFIED, the CSP floor only on the cached response', async () => {
    const w = await createWorld({cores: [withLogo()]});
    const url = `${VW_ORIGIN}/`;
    const req = String(seq++);
    const d = details({requestId: req, url, type: 'main_frame', tabId: 1});
    await w.env.webRequest.onBeforeRequest.fire(d);
    const first = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 304,
      responseHeaders: NOT_MODIFIED,
    });
    const second = await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [...HTML, ...NOT_MODIFIED],
    });
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get(req)!.respond(INDEX);
    await w.settle();
    expect([...first, ...second]).not.toContainEqual({cancel: true});
    const names = (answer: unknown): string[] =>
      ((answer as {responseHeaders?: {name: string}[]}).responseHeaders ?? []).map(h => h.name);
    expect(names(first[0])).not.toContain('content-security-policy');
    expect(names(second[0])).toContain('content-security-policy');
    expect(w.env.filters.get(req)!.output).toEqual(INDEX);
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', reasons: []});
    expect(w.env.tabsUpdated).toEqual([]);
    expect(w.sinks.alerts).toEqual([]);
  });

  for (const [what, body] of [
    ['with its cached bytes', LOGO],
    ['with an empty filtered body (the image cache keeps the picture)', bytes('')],
  ] as const) {
    it(`a listed image revalidated ${what} leaves the page VERIFIED`, async () => {
      const w = await createWorld({cores: [withLogo()]});
      await navigate(w, INDEX);
      const img = image();
      await w.env.webRequest.onBeforeRequest.fire(img);
      const first = await w.env.webRequest.onHeadersReceived.fire({
        ...img,
        statusCode: 304,
        responseHeaders: NOT_MODIFIED,
      });
      const second = await w.env.webRequest.onHeadersReceived.fire({
        ...img,
        statusCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'image/png'}, ...NOT_MODIFIED],
      });
      w.env.filters.get(img.requestId)!.respond(body);
      await w.settle();
      expect([...first, ...second]).not.toContainEqual({cancel: true});
      expect(await w.tab(1)).toMatchObject({state: 'VERIFIED', reasons: []});
      expect(w.sinks.alerts).toEqual([]);
    });
  }

  it('a 304 nothing was cached for (an empty document) is never green', async () => {
    const w = await createWorld({cores: [withLogo()]});
    const url = `${VW_ORIGIN}/`;
    const req = String(seq++);
    const d = details({requestId: req, url, type: 'main_frame', tabId: 1});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 304,
      responseHeaders: NOT_MODIFIED,
    });
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get(req)!.respond(bytes(''));
    await w.settle();
    expect((await w.tab(1))?.state).not.toBe('VERIFIED');
    expect(w.env.filters.get(req)!.output.length).toBe(0);
  });
});

/**
 * A listed data file the page reads (a locale) must match, also when it is served tampered and
 * padded past the buffering budget. Every listed file is far below the budget, so such a response
 * is unverifiable data the page reads: denied, and the tab is not VERIFIED.
 */
describe('a listed file over the buffering budget', () => {
  const LOCALE = bytes('{"login":{"message":"Log in"}}');
  const coreL = (): ReturnType<typeof vwCore> =>
    vwCore('2026.10.1', {'/index.html': INDEX, '/locales/en/messages.json': LOCALE});
  const fetchData = async (w: World, path: string, body: Uint8Array): Promise<FakeStreamFilter> => {
    const req = String(seq++);
    const d = details({
      requestId: req,
      url: `${VW_ORIGIN}${path}`,
      type: 'xmlhttprequest',
      tabId: 1,
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'application/json'}],
    });
    const f = w.env.filters.get(req)!;
    f.respond(body, 1 << 20);
    await w.settle();
    return f;
  };
  // Just over the backend's real buffering budget (64 MiB).
  const padded = new Uint8Array(64 * 1024 * 1024 + 1).fill(0x20);
  padded.set(bytes('{"login":{"message":"Type your master password at evil.example"}}'));

  it('a tampered listed locale over the budget is denied and the tab is not VERIFIED', async () => {
    const w = await createWorld({cores: [coreL()]});
    await navigate(w, INDEX);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const f = await fetchData(w, '/locales/en/messages.json', padded);
    expect(f.output.length).toBe(0);
    expect(await w.tab(1)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['unverifiable-active'],
    });
  });

  it('an unlisted data path over the budget changes no state', async () => {
    const w = await createWorld({cores: [coreL()]});
    await navigate(w, INDEX);
    await fetchData(w, '/locales/xx/messages.json', padded);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });
});
