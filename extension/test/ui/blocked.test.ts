/**
 * The blocked page on NEW_BUILD: the real Firefox
 * backend, engine and policy on the fake Ext deny an unknown vault build and send the tab to
 * `ui/blocked.html#<incident>`; the real `engine.blockedView()` and `shouldReload()` then decide
 * what the page shows and whether it reloads. A deep-verify job that finished before the document
 * was denied is not the one the page waits for, so it must never trigger a reload (the page would
 * re-request the vault and write a new incident on every round).
 */

import {describe, expect, it} from 'vitest';
import {buildIdOf, type DeepVerifyJobView} from '../../src/contracts.ts';
import {shouldReload} from '../../src/ui/shared/blocking.ts';
import {details} from '../engine/helpers/fakeExt.ts';
import {bytes, createWorld, VW_ORIGIN, vwOrigin, type World} from '../engine/helpers/world.ts';

const HTML = [{name: 'Content-Type', value: 'text/html; charset=utf-8'}];
const INDEX = bytes(
  '<!doctype html><html><head><script src="/app/main.0123456789abcdef0123.js"></script></head></html>',
);

function job(partial: Partial<DeepVerifyJobView>): DeepVerifyJobView {
  return {
    jobId: 'j',
    app: 'vaultwarden-web',
    version: '2026.2.0',
    assetName: 'bw_web_v2026.2.0.tar.gz',
    variant: 'release',
    trigger: 'user',
    phase: 'done',
    startedAt: 1,
    ...partial,
  };
}

let seq = 0;

/** Loads the vault home in tab 1 and returns the URL the backend sent the tab to, if any. */
async function loadVault(w: World): Promise<string | null> {
  const id = `doc${++seq}`;
  const before = w.env.tabsUpdated.length;
  const d = details({requestId: id, url: `${VW_ORIGIN}/`, type: 'main_frame', tabId: 1});
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
  w.env.filters.get(id)!.respond(INDEX);
  await w.settle();
  return w.env.tabsUpdated.slice(before).at(-1)?.url ?? null;
}

function incidentOf(url: string | null): string {
  expect(url).toMatch(/^moz-extension:\/\/[^/]+\/ui\/blocked\.html#[0-9a-f]{16}$/);
  return decodeURIComponent(url!.slice(url!.indexOf('#') + 1));
}

/** No core for the release the server names; `jobs` is the stored job list. */
async function blockedWorld(jobs: DeepVerifyJobView[] = []) {
  const w = await createWorld({origins: [vwOrigin()]});
  w.trust.jobs = jobs;
  w.registry.hint = {version: '2026.2.0', at: 0};
  return {w, trust: w.trust};
}

describe('blocked page on NEW_BUILD', () => {
  it('does not reload for a deep verify that finished before the document was denied', async () => {
    // GitHub access revoked: no job is started for the hinted release, and the newest stored job
    // is an older, successful deep verify of another release.
    const stale = job({jobId: 'old', version: '2025.1.0', finishedAt: 2});
    const {w, trust} = await blockedWorld([stale]);
    const hinted = {app: 'vaultwarden-web', variant: 'release', version: '2026.2.0'} as const;
    trust.states.set(buildIdOf(hinted), {
      k: 'failed',
      failure: 'permission-missing',
      transient: true,
      at: w.timers.now,
      retryAt: w.timers.now + 10 * 60_000,
    });
    const ids = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const incidentId = incidentOf(await loadVault(w));
      ids.add(incidentId);
      const view = await w.engine.blockedView(incidentId);
      expect(view).toMatchObject({
        state: 'NEW_BUILD',
        retry: true,
        job: null,
      });
      expect(shouldReload(view)).toBe(false);
    }
    expect(trust.ensured).toEqual([]);
    expect(ids.size).toBe(3);
  });

  it('reloads once a job finishes at or after the incident, also one started before it', async () => {
    const {w, trust} = await blockedWorld();
    const incidentId = incidentOf(await loadVault(w));
    const deniedAt = w.timers.now;
    // A second tab hit the same release while its job was already running.
    trust.jobs = [job({startedAt: deniedAt - 60_000, phase: 'verifying'})];
    let view = await w.engine.blockedView(incidentId);
    expect(view?.job).toMatchObject({phase: 'verifying'});
    expect(shouldReload(view)).toBe(false);
    w.timers.advance(30_000);
    trust.jobs = [job({startedAt: deniedAt - 60_000, finishedAt: w.timers.now})];
    view = await w.engine.blockedView(incidentId);
    expect(view?.job).toMatchObject({phase: 'done'});
    expect(shouldReload(view)).toBe(true);
    // Finished in the same millisecond as the denial: still not older than the incident.
    trust.jobs = [job({finishedAt: deniedAt})];
    expect(shouldReload(await w.engine.blockedView(incidentId))).toBe(true);
  });

  it('starts deep verify of the release the server names by itself', async () => {
    const {w} = await blockedWorld();
    const view = await w.engine.blockedView(incidentOf(await loadVault(w)));
    expect(view).toMatchObject({state: 'NEW_BUILD', retry: true});
    expect(w.trust.ensured.map(k => k.version)).toEqual(['2026.2.0']);
  });
});

describe('blocked page on Build not verified', () => {
  const hinted = {app: 'vaultwarden-web', variant: 'release', version: '2026.2.0'} as const;

  it('names the release whose deep verify failed, so that Retry can ask GitHub for it again', async () => {
    const {w, trust} = await blockedWorld();
    // GitHub does not list the release (yet): the stored failure is not retried for 6 hours.
    trust.states.set(buildIdOf(hinted), {
      k: 'failed',
      failure: 'release-not-found',
      transient: false,
      at: w.timers.now,
      retryAt: null,
    });
    const view = await w.engine.blockedView(incidentOf(await loadVault(w)));
    expect(view).toMatchObject({state: 'BUILD_UNVERIFIED', retry: false, release: hinted});
    expect(trust.ensured).toEqual([]);
  });

  it('names no release while the page waits for deep verify (NEW_BUILD)', async () => {
    const {w} = await blockedWorld();
    const view = await w.engine.blockedView(incidentOf(await loadVault(w)));
    expect(view?.state).toBe('NEW_BUILD');
    expect(view).not.toHaveProperty('release');
  });
});
