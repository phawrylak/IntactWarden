/**
 * The incident log: a document's incident id lives on its persisted session record, so an
 * event-page restart neither logs the same document again nor loses the id the tab record and the
 * blocked page point to; and the log (one storage.local array) is bounded without letting a flood
 * of later incidents evict the evidence an open origin alert points to.
 */

import {describe, expect, it} from 'vitest';
import {
  buildIdOf,
  type EnsureReleaseOutcome,
  type EnsureReleaseRequest,
  type IncidentRecord,
  type NewIncident,
} from '../../src/contracts.ts';
import {AlertBook, DENIAL_CAP, INCIDENT_CAP} from '../../src/engine/alerts.ts';
import {createLocalStore, createSessionStore} from '../../src/platform/storage.ts';
import {createFakeEnv, details, FakeArea, FakeTimers} from './helpers/fakeExt.ts';
import {bytes, createWorld, FakeTrust, VW_ORIGIN, vwCore, type World} from './helpers/world.ts';

const MAIN_PATH = '/app/main.0123456789abcdef0123.js';
const INDEX = bytes(
  '<!doctype html><html><head><script src="app/main.0123456789abcdef0123.js"></script></head></html>',
);
const MAIN = bytes('console.log("vault");');
let seq = 1;

async function load(w: World, type: 'main_frame' | 'script', path: string, body: Uint8Array) {
  const d = details({
    requestId: `i${seq++}`,
    url: `${VW_ORIGIN}${path}`,
    type,
    tabId: 1,
    ...(type === 'script' ? {documentUrl: `${VW_ORIGIN}/`, originUrl: `${VW_ORIGIN}/`} : {}),
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({
    ...d,
    statusCode: 200,
    responseHeaders: [
      {name: 'Content-Type', value: type === 'script' ? 'text/javascript' : 'text/html'},
    ],
  });
  if (type === 'main_frame')
    w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
  w.env.filters.get(d.requestId)?.respond(body);
  await w.settle();
}

/** Ids in the stored log (storage.local `l:v1:incidents`). */
const stored = (area: FakeArea): string[] =>
  ((area.data.get('l:v1:incidents') as IncidentRecord[] | undefined) ?? []).map(r => r.id);

const incident = (n: number, origin = 'https://other.example'): NewIncident => ({
  kind: 'mismatch',
  origin,
  path: `/p${n}`,
  state: 'MISMATCH',
  reasons: ['bytes'],
  buildId: null,
  expected: null,
  observed: null,
});

describe('incident log', () => {
  it('an event-page restart does not log an open red document again, and keeps its incident id', async () => {
    const session = new FakeArea();
    const local = new FakeArea();
    const timers = new FakeTimers();
    const cores = [vwCore('2026.10.1', {'/index.html': INDEX, [MAIN_PATH]: MAIN})];
    const w = await createWorld({cores, session, local, timers});
    await load(w, 'main_frame', '/', INDEX);
    await load(w, 'script', MAIN_PATH, bytes('evil()'));
    const before = await w.tab(1);
    expect(before?.state).toBe('MISMATCH');
    expect(before?.alert?.incident_id).toBeDefined();
    expect(stored(local)).toHaveLength(1);
    for (let restart = 0; restart < 3; restart++) {
      const again = await createWorld({cores, session, local, timers});
      await again.settle();
      // Activity on the still-open red document after the restart.
      await load(again, 'script', '/app/other.js', bytes('more()'));
      expect((await again.tab(1))?.alert?.incident_id).toBe(before?.alert?.incident_id);
      expect(stored(local)).toHaveLength(1);
    }
  });

  it('keeps at most INCIDENT_CAP records, never evicting the one an open alert points to', async () => {
    let now = 1_000;
    const env = createFakeEnv();
    const book = new AlertBook(createLocalStore(env.ext), () => now, createSessionStore(env.ext));
    await book.load();
    const first = await book.incident(incident(0, VW_ORIGIN));
    await book.raise(VW_ORIGIN, 'MISMATCH', ['bytes'], first);
    for (let i = 1; i <= INCIDENT_CAP + 50; i++) {
      now += 1;
      await book.incident(incident(i));
    }
    const keys = stored(env.local);
    expect(keys.length).toBe(INCIDENT_CAP + 1);
    expect(keys).toContain(first);
    // Once the alert is acknowledged, its record ages out like any other.
    await book.acknowledge(VW_ORIGIN);
    now += 1;
    await book.incident(incident(10_000));
    expect(stored(env.local)).toHaveLength(INCIDENT_CAP);
    expect(stored(env.local)).not.toContain(first);
    // The incidents page reads what is kept, newest first.
    const listed: IncidentRecord[] = await book.listIncidents(500);
    expect(listed).toHaveLength(INCIDENT_CAP);
    expect(listed[0]?.path).toBe('/p10000');
  });

  it('skips malformed records and keeps the log when a write cannot read it', async () => {
    // storage.local is reachable from content scripts: a planted entry must not break the page.
    const env = createFakeEnv();
    const book = new AlertBook(createLocalStore(env.ext), () => 1_000, createSessionStore(env.ext));
    await book.load();
    await book.incident(incident(1));
    env.local.data.set('l:v1:incidents', [
      ...(env.local.data.get('l:v1:incidents') as unknown[]),
      'junk',
      {id: 7},
    ]);
    await book.incident(incident(2));
    expect((await book.listIncidents(500)).map(r => r.path)).toEqual(['/p2', '/p1']);
    expect(stored(env.local)).toHaveLength(2);
  });

  it('keeps the record of an open stored alert that a newer private-window alert of the origin hides', async () => {
    let now = 1_000;
    const env = createFakeEnv();
    const book = new AlertBook(createLocalStore(env.ext), () => now, createSessionStore(env.ext));
    await book.load();
    const kept = await book.incident(incident(0, VW_ORIGIN));
    await book.raise(VW_ORIGIN, 'DISPUTED', ['pin-changed'], kept);
    now += 1;
    const priv = await book.incident(incident(1, VW_ORIGIN), true);
    await book.raise(VW_ORIGIN, 'MISMATCH', ['bytes'], priv, true);
    for (let i = 2; i < INCIDENT_CAP + 10; i++) {
      now += 1;
      await book.incident(incident(i));
    }
    expect(stored(env.local)).toContain(kept);
    // The private incident never reached storage.local.
    expect(stored(env.local)).not.toContain(priv);
    expect(await book.getIncident(priv)).not.toBeNull();
    // The last private tab closes: the stored alert shows again and its record is there.
    await book.purgePrivate();
    expect(book.get(VW_ORIGIN)?.incident_id).toBe(kept);
    expect(await book.getIncident(kept)).not.toBeNull();
    expect(await book.getIncident(priv)).toBeNull();
  });

  it('a denial without evidence backs its blocked page but is no incident; it stays in memory, bounded', async () => {
    let now = 1_000;
    const env = createFakeEnv();
    const book = new AlertBook(createLocalStore(env.ext), () => now, createSessionStore(env.ext));
    await book.load();
    const denied = {...incident(0, VW_ORIGIN), kind: 'protection-lost' as const};
    const first = await book.denial({...denied, state: 'PROTECTION_LOST'});
    const priv = await book.denial({...denied, state: 'NOT_COVERED'}, true);
    expect(await book.getBlocked(first)).toMatchObject({path: '/p0', state: 'PROTECTION_LOST'});
    expect(await book.getBlocked(priv)).toMatchObject({state: 'NOT_COVERED'});
    expect(await book.listIncidents(10)).toEqual([]);
    expect(await book.getIncident(first)).toBeNull();
    expect(stored(env.local)).toEqual([]);
    // An incident is found too; a denial of the newest DENIAL_CAP only.
    const logged = await book.incident(incident(1));
    expect(await book.getBlocked(logged)).toMatchObject({kind: 'mismatch'});
    for (let i = 0; i < DENIAL_CAP; i++) {
      now += 1;
      await book.denial({...denied, path: `/d${i}`});
    }
    expect(await book.getBlocked(first)).toBeNull();
    // The last private tab closes: what private windows left goes.
    await book.purgePrivate();
    expect(await book.getBlocked(priv)).toBeNull();
  });

  it('never deletes the record it has just written, even after the clock moved back', async () => {
    let now = Date.UTC(2030, 0, 1);
    const env = createFakeEnv();
    const book = new AlertBook(createLocalStore(env.ext), () => now, createSessionStore(env.ext));
    await book.load();
    for (let i = 0; i < INCIDENT_CAP; i++) {
      now += 1;
      await book.incident(incident(i));
    }
    now = Date.UTC(2026, 10, 10);
    const id = await book.incident(incident(10_000, VW_ORIGIN));
    await book.raise(VW_ORIGIN, 'MISMATCH', ['bytes'], id);
    expect(await book.getIncident(id)).not.toBeNull();
    // The cap holds otherwise: the newest-dated records are what the log keeps.
    expect(stored(env.local)).toHaveLength(INCIDENT_CAP + 1);
  });

  it('an event-page restart does not log a failed deep verify of an open document again', async () => {
    // On a restart #rehydrate resolves the open unknown build again, and a final failure logs
    // deep-verify-failed through another path than the evaluation's side effects.
    class FailingTrust extends FakeTrust {
      override ensureRelease(req: EnsureReleaseRequest): Promise<EnsureReleaseOutcome> {
        this.ensured.push(req.key);
        this.states.set(buildIdOf(req.key), {
          k: 'failed',
          failure: 'digest-mismatch',
          transient: false,
          at: 0,
          retryAt: null,
        });
        return Promise.resolve({
          ok: false,
          failure: 'digest-mismatch',
          transient: false,
          retryAt: null,
        });
      }
    }
    const shared = {
      session: new FakeArea(),
      local: new FakeArea(),
      timers: new FakeTimers(),
    };
    const start = async (): Promise<World> => {
      const w = await createWorld({...shared, cores: [], trust: new FailingTrust([])});
      w.registry.hint = {version: '2026.11.0', at: 0};
      await w.settle();
      return w;
    };
    const w = await start();
    await load(w, 'main_frame', '/', INDEX);
    const logged = (await w.engine.listIncidents(500)).map(r => r.kind);
    expect(logged).toContain('deep-verify-failed');
    const count = logged.length;
    for (let restart = 0; restart < 3; restart++) {
      const again = await start();
      expect(await again.engine.listIncidents(500)).toHaveLength(count);
    }
  });

  it('never lists an expired record, and drops it with the next write', async () => {
    let now = 0;
    const env = createFakeEnv();
    const book = new AlertBook(createLocalStore(env.ext), () => now, createSessionStore(env.ext));
    await book.load();
    const old = await book.incident(incident(1));
    now = 91 * 24 * 60 * 60 * 1000;
    expect(await book.listIncidents(500)).toEqual([]);
    expect(stored(env.local)).toEqual([old]);
    const fresh = await book.incident(incident(2));
    expect(stored(env.local)).toEqual([fresh]);
  });
});
