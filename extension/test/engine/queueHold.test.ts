/**
 * Unknown-build resolution never holds a document's observation queue on the network.
 *
 * Every observation of a document runs through one queue, and the Firefox backend's blocking
 * onHeadersReceived and StreamFilter body decisions wait on it. Firefox answers an extension's
 * blocking webRequest events in batches, so a hint fetch inside that queue could wait for a held
 * page event that waits for the queue: the page would never finish loading. The hint deadline and
 * R4 bound every hold, whatever the engine does.
 */

import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {describe, expect, it} from 'vitest';
import type {HintResult, LoadedCore} from '../../src/contracts.ts';
import {details, type FakeStreamFilter} from './helpers/fakeExt.ts';
import {
  bwCloudOrigin,
  bytes,
  createWorld,
  FakeTrust,
  VW_ORIGIN,
  vwOrigin,
  type World,
} from './helpers/world.ts';

const CLOUD = 'https://vault.bitwarden.com';
const HTML = [{name: 'Content-Type', value: 'text/html; charset=utf-8'}];
const JS = [{name: 'Content-Type', value: 'text/javascript'}];
const INDEX = bytes(
  '<!doctype html><html><head><script src="/app/main.0123456789abcdef0123.js"></script></head></html>',
);
const MAIN = bytes('console.log("vault");');

/**
 * Lets promise chains run without touching the fake clock. Real timer turns, so WebCrypto digests
 * (completed off the main thread) arrive in between.
 */
const flush = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
};

/** A trust store whose `candidates` can be made to hang (a local await that never settles). */
class StallingTrust extends FakeTrust {
  stall = false;
  override async candidates(q: {app: string; variant: string}) {
    if (this.stall) return new Promise<readonly LoadedCore[]>(() => undefined);
    return super.candidates(q);
  }
}

let docSeq = 0;

async function openDocument(w: World, origin: string, tab = 1): Promise<FakeStreamFilter> {
  const req = `doc${tab}-${docSeq++}`;
  const d = details({requestId: req, url: `${origin}/`, type: 'main_frame', tabId: tab});
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
  const f = w.env.filters.get(req)!;
  f.respond(INDEX);
  await flush();
  return f;
}

/**
 * A script request of the document. `sendHeaders()` fires its onHeadersReceived once and returns
 * what the blocking listener answered so far (read it after letting the promises run).
 */
async function startScript(
  w: World,
  origin: string,
  id: string,
  path = '/app/main.0123456789abcdef0123.js',
): Promise<{
  filter: FakeStreamFilter;
  sendHeaders: () => () => {answered: boolean; cancel: boolean};
}> {
  const d = details({
    requestId: id,
    url: `${origin}${path}`,
    type: 'script',
    tabId: 1,
    documentUrl: `${origin}/`,
    originUrl: `${origin}/`,
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  const filter = w.env.filters.get(id)!;
  return {
    filter,
    sendHeaders: () => {
      const seen = {answered: false, cancel: false};
      void Promise.resolve(
        w.env.webRequest.onHeadersReceived.emit({...d, statusCode: 200, responseHeaders: JS})[0],
      ).then((r: {cancel?: boolean} | undefined) => {
        seen.answered = true;
        seen.cancel = r?.cancel === true;
      });
      return () => ({...seen});
    },
  };
}

describe('unknown-build resolution and the document queue', () => {
  it('a hint fetch that never answers ends at its deadline as a failed fetch (amber BUILD_UNVERIFIED)', async () => {
    const w = await createWorld({origins: [bwCloudOrigin()]});
    w.registry.fetchHint = () => new Promise<HintResult>(() => undefined);
    const doc = await openDocument(w, CLOUD);
    // The decision waits at most 5 s for the hint: the document is denied as NEW_BUILD.
    w.timers.advance(5_000);
    await flush();
    expect(doc.written).toHaveLength(0);
    let t = await w.tab(1);
    expect(t?.state).toBe('NEW_BUILD');
    expect(t?.unknownBuild?.phase).toBe('hint');
    // The resolution's own fetch (started after the bounded wait) reaches its 10-s deadline.
    w.timers.advance(10_001);
    await flush();
    t = await w.tab(1);
    // No version from the server: the rule for a cloud build that cannot be derived.
    expect(t?.state).toBe('BUILD_UNVERIFIED');
    expect(t?.reasons).toContain('not-derivable');
    expect(t?.unknownBuild?.phase).toBe('final');
    expect(w.sinks.alerts).toHaveLength(0);
  });

  {
    it("R4 denies every held response and arms when a request starts, even while its document's queue is held", async () => {
      const trust = new StallingTrust([]);
      // An unknown self-hosted build (BUILD_UNVERIFIED selfhost-unpublished) runs only after the
      // user chose "Proceed once" for it.
      const w = await createWorld({trust, origins: [vwOrigin()]});
      w.registry.hint = {version: null, at: 0};
      const denied = await openDocument(w, VW_ORIGIN);
      await w.settle();
      expect(denied.written).toHaveLength(0);
      await w.engine.allowForTab(1, {k: 'proceed-once', sha256: await sha256Hex(INDEX)});
      const doc = await openDocument(w, VW_ORIGIN);
      await w.settle();
      expect(doc.output).toEqual(INDEX);
      expect((await w.tab(1))?.state).toBe('BUILD_UNVERIFIED');
      // Script A's header decision holds the document's queue (a local await that never settles).
      trust.stall = true;
      const a = await startScript(w, VW_ORIGIN, 'jsA');
      const ah = a.sendHeaders();
      await flush();
      expect(ah().answered).toBe(false);
      // Script B starts while the queue is held.
      const b = await startScript(w, VW_ORIGIN, 'jsB', '/app/polyfills.0123456789abcdef0123.js');
      w.timers.advance(59_999);
      await flush();
      expect(ah().answered).toBe(false);
      w.timers.advance(2);
      await flush();
      // R4 (60 s for scripts): A's header decision is answered without the engine (cancelled),
      // and the bodies are never released.
      const expected = {answered: true, cancel: true};
      expect(ah()).toEqual(expected);
      a.filter.respond(MAIN);
      // B's headers come after its R4 fired: denied at once.
      const bh = b.sendHeaders();
      await flush();
      expect(bh()).toEqual(expected);
      b.filter.respond(MAIN);
      await flush();
      for (const f of [a.filter, b.filter]) {
        expect(f.closed).toBe(true);
        expect(f.written).toHaveLength(0);
      }
      // Both items are unverifiable:timeout (PROTECTION_LOST), B included: its request registered
      // when it started, not when the held queue reached it.
      const persisted = (await w.env.session.get(null)) as Record<string, unknown>;
      // The released document's record (the first, denied one has no items).
      const docRec = Object.entries(persisted).find(
        ([k, v]) =>
          k.startsWith('s:v1:doc:') &&
          Object.keys((v as {items: object}).items).includes('/app/main.0123456789abcdef0123.js'),
      )?.[1] as {
        state: string;
        reasons: string[];
        items: Record<string, {outcome: {r: string; reason?: string}}>;
      };
      expect(docRec.state).toBe('PROTECTION_LOST');
      expect(docRec.reasons).toContain('timeout');
      for (const path of [
        '/app/main.0123456789abcdef0123.js',
        '/app/polyfills.0123456789abcdef0123.js',
      ]) {
        expect(docRec.items[path]?.outcome).toEqual({r: 'unverifiable', reason: 'timeout'});
      }
      // Amber, never red: the only notification is the PROTECTION_LOST one R4 always gives.
      expect(w.sinks.alerts.map(x => [x.state, x.reasons])).toEqual([
        ['PROTECTION_LOST', ['timeout']],
      ]);
      expect(Object.values(docRec.items).some(i => i.outcome.r === 'mismatch')).toBe(false);
    });
  }
});
