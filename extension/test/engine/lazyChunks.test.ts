/**
 * Lazily loaded chunks in the engine: Secrets Manager is part of
 * the same web vault, so its chunks are ordinary files of the bound core. A genuine chunk verifies,
 * a swapped one is MISMATCH (bytes), a redirected or Refresh-carrying one is cancelled as MISMATCH
 * (header), and a chunk outside the core (Secrets Manager on Vaultwarden) is MISMATCH unknown-path.
 * The engine denies the response and never replaces the document.
 */

import {describe, expect, it} from 'vitest';
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

const HTML = [{name: 'Content-Type', value: 'text/html'}];
const JS = [{name: 'Content-Type', value: 'text/javascript'}];
const SM = '/541.f38c2a08966cd91bbade.js';
let seq = 1;

async function open(w: World, tab: number, origin: string, body: Uint8Array): Promise<void> {
  const req = `a${seq++}`;
  const url = `${origin}/`;
  const d = details({requestId: req, url, type: 'main_frame', tabId: tab});
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
  w.env.filters.get(req)!.respond(body);
  await w.settle();
}

/** A lazy chunk the page requests (webpack's `<script src>`); returns its StreamFilter. */
async function chunk(w: World, tab: number, path: string, body: Uint8Array, origin = BW_ORIGIN) {
  const req = `c${seq++}`;
  const s = details({
    requestId: req,
    url: `${origin}${path}`,
    type: 'script',
    tabId: tab,
    documentUrl: `${origin}/`,
  });
  await w.env.webRequest.onBeforeRequest.fire(s);
  await w.env.webRequest.onHeadersReceived.fire({...s, statusCode: 200, responseHeaders: JS});
  const filter = w.env.filters.get(req)!;
  filter.respond(body);
  await w.env.webRequest.onCompleted.fire({...s, statusCode: 200});
  await w.settle();
  return filter;
}

async function items(w: World, tab: number) {
  return (await w.engine.details(tab))?.docs[0]?.items ?? [];
}

describe('a Secrets Manager chunk on Vaultwarden', () => {
  const INDEX = bytes('<!doctype html><html></html>');

  it('is not in its core: MISMATCH unknown-path, denied (nothing written)', async () => {
    const w = await createWorld({cores: [vwCore('2026.10.1', {'/index.html': INDEX})]});
    await open(w, 1, VW_ORIGIN, INDEX);
    const filter = await chunk(w, 1, SM, bytes('sm()'), VW_ORIGIN);
    const t = await w.tab(1);
    expect(t).toMatchObject({state: 'MISMATCH', reasons: ['unknown-path']});
    const item = (await items(w, 1)).find(i => i.path === SM);
    expect(item?.outcome).toEqual({r: 'mismatch', reason: 'unknown-path'});
    expect(filter.written).toHaveLength(0);
    expect(w.sinks.alerts.map(a => a.state)).toEqual(['MISMATCH']);
    // A denied subresource never replaces the document: no blocked page.
    expect(w.env.tabsUpdated).toEqual([]);
  });
});

describe('Secrets Manager chunks on a Bitwarden self-hosted COMMERCIAL instance', () => {
  const INDEX = bytes('<!doctype html><script src="app/main.0123456789abcdef0123.js"></script>');
  const SHARED = '/195.d4ed0c5d550e92c646e9.js';
  const SM_JS = bytes('sm()');
  const SHARED_JS = bytes('shared()');
  const core = () =>
    bwSelfhostCore('2026.10.1', {
      '/index.html': {bytes: INDEX},
      [SM]: {bytes: SM_JS},
      [SHARED]: {bytes: SHARED_JS},
    });

  it('the genuine lazy chunks verify as ordinary files; the tab stays VERIFIED', async () => {
    const w = await createWorld({cores: [core()], origins: [bwSelfhostOrigin()]});
    await open(w, 1, BW_ORIGIN, INDEX);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await chunk(w, 1, SHARED, SHARED_JS);
    const sm = await chunk(w, 1, SM, SM_JS);
    expect(sm.written.length).toBeGreaterThan(0);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const list = await items(w, 1);
    expect(list.find(i => i.path === SM)?.outcome).toEqual({r: 'ok', how: 'exact'});
    expect(list.find(i => i.path === SHARED)?.outcome).toEqual({r: 'ok', how: 'exact'});
  });

  it('a swapped chunk 541 is MISMATCH (bytes) after the lazy load and denied (nothing written)', async () => {
    const w = await createWorld({cores: [core()], origins: [bwSelfhostOrigin()]});
    await open(w, 1, BW_ORIGIN, INDEX);
    const filter = await chunk(w, 1, SM, bytes('sm();self.__iwSmTampered = true;'));
    expect(await w.tab(1)).toMatchObject({state: 'MISMATCH', reasons: ['bytes']});
    expect(filter.written).toHaveLength(0);
    // A denied subresource never replaces the document: no blocked page.
    expect(w.env.tabsUpdated).toEqual([]);
  });

  it('a redirected or Refresh-carrying chunk 541 is cancelled as MISMATCH (header)', async () => {
    const headers = {
      redirect: [{name: 'Location', value: '/evil.js'}],
      refresh: [...JS, {name: 'Refresh', value: '0; url=https://evil.example/'}],
    };
    {
      for (const [kind, responseHeaders] of Object.entries(headers)) {
        const label = kind;
        const w = await createWorld({cores: [core()], origins: [bwSelfhostOrigin()]});
        await open(w, 1, BW_ORIGIN, INDEX);
        const d = details({
          requestId: `h${seq++}`,
          url: `${BW_ORIGIN}${SM}`,
          type: 'script',
          tabId: 1,
          documentUrl: `${BW_ORIGIN}/`,
        });
        await w.env.webRequest.onBeforeRequest.fire(d);
        const hr = await w.env.webRequest.onHeadersReceived.fire({
          ...d,
          statusCode: kind === 'redirect' ? 302 : 200,
          responseHeaders,
        });
        expect(hr[0], label).toEqual({cancel: true});
        await w.settle();
        expect(await w.tab(1), label).toMatchObject({state: 'MISMATCH', reasons: ['header']});
        expect((await items(w, 1)).find(i => i.path === SM)?.outcome, label).toEqual({
          r: 'mismatch',
          reason: 'header',
        });
      }
    }
  });
});
