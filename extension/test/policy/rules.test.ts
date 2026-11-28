/**
 * The fail-closed rules R1–R14, one regression test per rule, named after it. A version hint or a
 * URL only selects candidate cores; only bytes decide, and no failure produces green.
 *
 * - R1. An exception gives PROTECTION_LOST `internal-error` and a denial.
 * - R2. An unknown tab, frame or document gives PROTECTION_LOST `untracked`.
 * - R3. A document whose bytes did not verify is PROTECTION_LOST, except an unknown build (R12)
 *   and the declared NOT_COVERED pages.
 * - R4. A request pending over 30 s (5 min for scripts and `xmlhttprequest`) is `timeout`.
 * - R5. A trust store that failed to start gives PROTECTION_LOST `internal-error`.
 * - R6. A document's state only rises, except that NEW_BUILD resolves and RECOVERING ends with its
 *   alert.
 * - R7. After a restart, protected tabs without a session give `verifier-restarted`.
 * - R8. No `RegExp` is built at run time, so no server data becomes a pattern.
 * - R9. Hashes are fixed-length lowercase hex, compared by exact equality.
 * - R10. The UI reads only stored state.
 * - R11. An unverifiable active item gives PROTECTION_LOST.
 * - R12. No red rests on absence: an unexplained build is BUILD_UNVERIFIED.
 * - R13. Taint is evaluated before green.
 * - R14. Nothing a server or GitHub sends lowers a red state.
 *
 * Rules that need the engine, a backend or the UI are exercised there as well:
 * R1 in test/backends/firefox.test.ts ("fail closed on faults"); R4 in test/backends/r4.test.ts and
 * test/backends/firefox.test.ts (the backend's timers) and test/engine/queueHold.test.ts (the
 * engine's own timer); R2 and R7 in test/engine/lifecycle.test.ts; R10 in test/ui/background.test.ts
 * and test/ui/popup.test.ts (the toolbar and popup read the persisted record); R13 in
 * test/engine/taint.test.ts.
 */

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {isSha256Hex} from '@intactwarden/core/hash/hex.ts';
import {stateRow} from '@intactwarden/core/verdict/states.ts';
import {
  r4Ms,
  type DocumentSessionRecord,
  type EvaluateInput,
  type ItemRecord,
  type TabStateRecord,
} from '../../src/contracts.ts';
import {itemContribution} from '../../src/policy/contribution.ts';
import {evaluateSession} from '../../src/policy/evaluate.ts';
import {decideUnknownBuild} from '../../src/policy/unknownBuild.ts';
import {newSession} from '../../src/engine/sessions.ts';
import {details} from '../engine/helpers/fakeExt.ts';
import {bytes, createWorld, VW_ORIGIN, vwCore, vwOrigin} from '../engine/helpers/world.ts';

const INDEX = bytes('<!doctype html><html></html>');
const core = vwCore('2026.10.1', {'/index.html': INDEX});
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

function session(over: Partial<DocumentSessionRecord> = {}): DocumentSessionRecord {
  const s = newSession(
    {
      k: 'doc-start',
      at: 0,
      doc: '1:0:1',
      tab: 1,
      frame: 0,
      parentDoc: null,
      req: 'r1',
      url: `${VW_ORIGIN}/`,
      type: 'main_frame',
    },
    vwOrigin(),
    0,
  );
  return {
    ...s,
    docClass: 'manifest',
    binding: bound,
    docVerified: true,
    ...over,
  } as DocumentSessionRecord;
}

function ev(over: Partial<EvaluateInput> = {}, s: Partial<DocumentSessionRecord> = {}) {
  return evaluateSession({
    session: session(s),
    trust: {ready: true, loaded: true, githubBackoffUntil: null},
    buildStatus: 'current',
    originAlert: null,
    engineHealthy: true,
    permissionGranted: true,
    rollback: false,
    ...over,
  });
}

const item = (over: Partial<ItemRecord>): ItemRecord => ({
  req: 'r',
  path: '/app/main.js',
  url: `${VW_ORIGIN}/app/main.js`,
  type: 'script',
  cls: 'script',
  key: null,
  outcome: {r: 'ok', how: 'exact'},
  at: 0,
  ...over,
});

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('fail-closed rules R1–R14', () => {
  it('R1 an evaluation that throws is PROTECTION_LOST internal-error and denies', () => {
    const broken = {...session(), items: null} as unknown as DocumentSessionRecord;
    const r = evaluateSession({...({} as EvaluateInput), session: broken});
    expect(r).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['internal-error'],
      action: 'deny',
    });
  });

  it('R2 an untracked session is PROTECTION_LOST untracked', () => {
    expect(ev({}, {untracked: true})).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['untracked'],
    });
  });

  it('R3 no verified document bytes is PROTECTION_LOST (unknown document)', () => {
    expect(ev({}, {binding: null, docVerified: false, docClass: 'unknown'})).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['unverifiable-active'],
    });
  });

  it('R4 limits; a pending item withholds green; an unverifiable timeout item is PROTECTION_LOST', () => {
    expect([r4Ms('script'), r4Ms('xmlhttprequest'), r4Ms('stylesheet')]).toEqual([
      300_000, 300_000, 30_000,
    ]);
    const pending = {r9: {path: '/app/main.js', type: 'script' as const, since: 0}};
    expect(ev({}, {pending})).toMatchObject({state: 'VERIFIED', flags: ['CHECKING']});
    const timedOut = {'/app/main.js': item({outcome: {r: 'unverifiable', reason: 'timeout'}})};
    expect(ev({}, {items: timedOut})).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['timeout'],
    });
  });

  it('R5 a trust store that failed to start is PROTECTION_LOST internal-error', () => {
    const t = {ready: true, loaded: false, githubBackoffUntil: null};
    expect(ev({trust: t})).toMatchObject({state: 'PROTECTION_LOST', reasons: ['internal-error']});
  });

  it('R6 severity only rises within a document', () => {
    expect(ev({}, {peakState: 'MISMATCH'}).state).toBe('MISMATCH');
    expect(ev({}, {peakState: 'PROTECTION_LOST'}).state).toBe('PROTECTION_LOST');
  });

  it('R7 a protected tab without a session after a restart is PROTECTION_LOST verifier-restarted', async () => {
    const w1 = await createWorld({cores: [core]});
    const w2 = await createWorld({cores: [core], session: w1.env.session, local: w1.env.local});
    w2.env.tabs.push({id: 4, url: `${VW_ORIGIN}/`, status: 'complete'});
    await w2.engine.start();
    await w2.settle();
    expect(await w2.tab(4)).toMatchObject({
      state: 'PROTECTION_LOST',
      reasons: ['verifier-restarted'],
    });
  });

  it('R8 no RegExp is ever built at run time (extension and core sources)', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    const files = [
      ...sources(join(root, 'extension', 'src')),
      ...sources(join(root, 'packages', 'core', 'src')),
      ...sources(join(root, 'packages', 'builders', 'src')),
    ];
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bRegExp\s*\(/);
  });

  it('R9 hashes are fixed-length lowercase hex; anything else is never accepted', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
  });

  it('R10 the UI reads only the persisted tab record', async () => {
    const w = await createWorld({cores: [core]});
    const url = `${VW_ORIGIN}/`;
    const d = details({requestId: 'r10', url, type: 'main_frame', tabId: 2});
    await w.env.webRequest.onBeforeRequest.fire(d);
    await w.env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/html'}],
    });
    w.env.onCommitted.emit({tabId: 2, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    w.env.filters.get('r10')!.respond(INDEX);
    await w.settle();
    const stored = (await w.env.session.get('s:v1:tab:2'))['s:v1:tab:2'] as TabStateRecord;
    expect(stored.state).toBe('VERIFIED');
    // What the UI asks for is the persisted record, not a verdict computed from the engine's memory:
    // a record planted for a tab the engine never saw is returned as it is.
    const planted: TabStateRecord = {...stored, tab: 9, state: 'MISMATCH', reasons: ['bytes']};
    await w.env.session.set({'s:v1:tab:9': planted});
    expect(await w.engine.tabState(9)).toEqual(planted);
  });

  it('R11 an unverifiable active item is PROTECTION_LOST; a passive one counts only as a listed file', () => {
    expect(
      itemContribution(item({outcome: {r: 'unverifiable', reason: 'too-large'}}), null),
    ).toMatchObject({state: 'PROTECTION_LOST', reason: 'unverifiable-active'});
    expect(
      itemContribution(
        item({type: 'image', cls: 'image', outcome: {r: 'unverifiable', reason: 'too-large'}}),
        null,
      ),
    ).toBeNull();
    // A listed file of a passive class that reached the page unverified (a service worker served
    // it, its filter failed) counts, with the evidence that it ran; one that was withheld, or an
    // unlisted one, does not.
    const data = (key: string | null, delivered: boolean) =>
      item({
        type: 'xmlhttprequest',
        cls: 'data',
        key,
        outcome: {r: 'unverifiable', reason: 'sw-served', ...(delivered ? {delivered} : {})},
      });
    expect(itemContribution(data('/locales/en/messages.json', true), null)).toEqual({
      state: 'PROTECTION_LOST',
      reason: 'sw-served',
      unverifiedCode: 'ran',
    });
    expect(itemContribution(data('/locales/en/messages.json', false), null)).toBeNull();
    expect(itemContribution(data(null, true), null)).toBeNull();
  });

  it('R12 missing data is never red: an unknown build nobody can explain stays amber', () => {
    const base = {
      differsAtManifestPath: false,
      waitingSince: 0,
      backgroundRetry: false,
      now: 1e12,
    };
    const key = {
      app: 'vaultwarden-web' as const,
      variant: 'release' as const,
      version: '2026.11.0',
    };
    const failed = (failure: 'release-not-found' | 'network', transient: boolean) => ({
      key,
      state: {k: 'failed' as const, failure, transient, at: 0, retryAt: null},
    });
    for (const deploymentKind of ['cloud', 'self-hosted'] as const) {
      for (const [hint, release] of [
        [null, null],
        [{version: null, at: 0}, null],
        [{version: '2026.11.0', at: 0}, failed('release-not-found', false)],
        [{version: '2026.11.0', at: 0}, failed('network', true)],
      ] as const) {
        const d = decideUnknownBuild({...base, deploymentKind, hint, release});
        expect(
          stateRow(d.contribution.state).colour,
          JSON.stringify({deploymentKind, hint}),
        ).not.toBe('red');
      }
    }
  });

  it('R13 taint is evaluated before green', () => {
    expect(ev({}, {coResident: {class: 'unverifiable', since: 0, sourcePath: '/'}}).state).toBe(
      'CO_RESIDENT_UNVERIFIED',
    );
  });

  it('R14 a build status (from GitHub) never lowers a red verdict', () => {
    const items = {'/app/main.js': item({outcome: {r: 'mismatch', reason: 'bytes'}})};
    expect(ev({buildStatus: 'disputed'}, {items}).state).toBe('MISMATCH');
    expect(ev({buildStatus: 'current'}, {items}).state).toBe('MISMATCH');
  });
});
