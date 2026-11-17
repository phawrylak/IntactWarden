/**
 * The unknown-build give-up on a top-level page: a denied NEW_BUILD document is replaced by its
 * blocked page and ends, so the page's poll (UI_GET_BLOCKED, every minute and on JOB_UPDATED)
 * decides it again. GIVE_UP_MS after the first deep verify of the release (the deep-verify
 * budget's record, kept across reloads and event-page restarts), a release that cannot be fetched
 * is BUILD_UNVERIFIED, with "Proceed once". A transient failure is still retried, in the
 * background, whenever a load (or the page's poll) decides the document and the store's back-off
 * allows it; once a retry succeeds, the next load verifies.
 */

import {describe, expect, it} from 'vitest';
import {
  buildIdOf,
  type DeepVerifyJobView,
  type EnsureReleaseOutcome,
  type EnsureReleaseRequest,
  type ReleaseKey,
} from '../../src/contracts.ts';
import {GIVE_UP_MS} from '../../src/policy/unknownBuild.ts';
import {PERMISSION_RETRY_MS, RETRY_BASE_MS, RETRY_MAX_MS} from '../../src/trust/store.ts';
import {shouldReload} from '../../src/ui/shared/blocking.ts';
import {details, FakeArea, FakeTimers, type FakeStreamFilter} from './helpers/fakeExt.ts';
import {
  bytes,
  createWorld,
  FakeTrust,
  sha,
  VW_ORIGIN,
  vwCore,
  type World,
} from './helpers/world.ts';

const PAGE = bytes('<!doctype html><html>2026.11.0</html>');
const KEY: ReleaseKey = {app: 'vaultwarden-web', variant: 'release', version: '2026.11.0'};
const HTML = [{name: 'Content-Type', value: 'text/html'}];
const MINUTE = 60_000;

/**
 * A trust store whose deep verify fails at once, like the real one without access to GitHub
 * (`permission-missing`, retried after 10 minutes) or without a network (`network`, retried after
 * 30 s, doubling up to 15 minutes). With `slow`, it runs (`working`) until the test calls
 * `finishFailed`. With `failure` null, deep verify runs until the test completes it.
 */
class FailingTrust extends FakeTrust {
  failure: 'permission-missing' | 'network' | null;
  slow = false;
  readonly #now: () => number;
  #networkFailures = 0;
  #pending: (() => void) | null = null;
  constructor(now: () => number, failure: 'permission-missing' | 'network') {
    super([]);
    this.#now = now;
    this.failure = failure;
  }
  override ensureRelease(req: EnsureReleaseRequest): Promise<EnsureReleaseOutcome> {
    const failure = this.failure;
    const id = buildIdOf(req.key);
    const working = {
      k: 'working',
      jobId: 'job1',
      phase: 'downloading',
      since: this.#now(),
    } as const;
    if (failure === null) {
      const job = super.ensureRelease(req);
      this.states.set(id, working);
      return job;
    }
    this.ensured.push(req.key);
    const fail = (): EnsureReleaseOutcome => {
      const backOff =
        failure === 'network'
          ? Math.min(RETRY_BASE_MS * 2 ** this.#networkFailures++, RETRY_MAX_MS)
          : PERMISSION_RETRY_MS;
      const retryAt = this.#now() + backOff;
      this.states.set(id, {k: 'failed', failure, transient: true, at: this.#now(), retryAt});
      return {ok: false, failure, transient: true, retryAt};
    };
    if (!this.slow) return Promise.resolve(fail());
    this.states.set(id, working);
    return new Promise(resolve => (this.#pending = () => resolve(fail())));
  }
  /** The deep verify started in `slow` mode fails now. */
  finishFailed(): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.();
  }
  /** The store forgets the failure (LocalTrustStore.permissionsChanged: access granted again). */
  forget(key: ReleaseKey): void {
    this.states.delete(buildIdOf(key));
  }
}

let seq = 1;

/**
 * Loads the vault's home page in tab 1. A denied load is replaced by its blocked page, as Firefox
 * does: the page commits and the denied document ends. Returns the filter and the incident id.
 */
async function load(w: World): Promise<{filter: FakeStreamFilter; incident: string | null}> {
  const req = `gu${seq++}`;
  const url = `${VW_ORIGIN}/`;
  const d = details({requestId: req, url, type: 'main_frame', tabId: 1});
  await w.env.webRequest.onBeforeRequest.fire(d);
  await w.env.webRequest.onHeadersReceived.fire({...d, statusCode: 200, responseHeaders: HTML});
  w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
  const filter = w.env.filters.get(req)!;
  filter.respond(PAGE);
  await w.settle();
  const blocked = w.env.tabsUpdated.splice(0).at(-1)?.url ?? null;
  if (blocked === null) return {filter, incident: null};
  w.env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: blocked, timeStamp: 0});
  await w.settle();
  // The tab shows the blocked page: no document of the vault is live in it.
  expect(await w.tab(1)).toBeNull();
  return {filter, incident: decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1))};
}

async function world(trust: FakeTrust, timers = new FakeTimers()): Promise<World> {
  const w = await createWorld({trust, timers});
  w.registry.hint = {version: KEY.version, at: 0};
  return w;
}

const doneJob = (now: number): DeepVerifyJobView => ({
  jobId: 'job1',
  app: KEY.app,
  version: KEY.version,
  assetName: `bw_web_v${KEY.version}.tar.gz`,
  variant: KEY.variant,
  trigger: 'unknown-build',
  phase: 'done',
  startedAt: now,
  finishedAt: now,
});

const NEW_BUILD = {state: 'NEW_BUILD', retry: true, canProceedOnce: false};
const GAVE_UP = {
  state: 'BUILD_UNVERIFIED',
  reasons: ['selfhost-unpublished'],
  retry: false,
  canProceedOnce: true,
  observed: sha(PAGE),
};

describe('unknown-build give-up on the blocked page', () => {
  it('no access to GitHub: 10 minutes after the first attempt the open page offers "Proceed once", which lets the next load through, also clicked much later while the retries still fail', async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'permission-missing');
    const w = await world(trust, timers);
    const first = await load(w);
    expect(first.filter.written).toHaveLength(0);
    const id = first.incident!;
    expect(trust.ensured).toHaveLength(1);
    // The page polls every minute; a missing permission is not retried before the give-up time.
    for (let m = 1; m < 10; m++) {
      timers.advance(MINUTE);
      expect(await w.engine.blockedView(id)).toMatchObject(NEW_BUILD);
    }
    // Its retry is due at the give-up time: it starts in the background, and fails again.
    timers.advance(MINUTE + 1);
    const view = await w.engine.blockedView(id);
    expect(view).toMatchObject({...GAVE_UP, job: null});
    await w.settle();
    expect(trust.ensured).toHaveLength(2);
    // "Proceed once" clicked well after the failure's retry time: the next load is still let
    // through, and stays Build not verified while the retry it starts fails.
    timers.advance(2 * PERMISSION_RETRY_MS);
    await w.engine.allowForTab(1, {k: 'proceed-once', sha256: view!.observed!});
    const next = await load(w);
    expect(next.incident).toBeNull();
    expect(next.filter.output).toEqual(PAGE);
    expect(trust.ensured).toHaveLength(3);
    expect(await w.tab(1)).toMatchObject({state: 'BUILD_UNVERIFIED'});
  });

  it('a network failure, retried at each poll: the clock counts from the first attempt, not from a reload, and gives up even with a retry due (which then runs in the background)', async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'network');
    const w = await world(trust, timers);
    const first = await load(w);
    expect(trust.ensured).toHaveLength(1);
    timers.advance(MINUTE);
    expect(await w.engine.blockedView(first.incident!)).toMatchObject(NEW_BUILD);
    await w.settle();
    expect(trust.ensured).toHaveLength(2);
    // "Check now" after 5 minutes: a new document, denied again, with a retry.
    timers.advance(4 * MINUTE);
    const second = await load(w);
    expect(await w.engine.blockedView(second.incident!)).toMatchObject(NEW_BUILD);
    expect(trust.ensured).toHaveLength(3);
    // 10 minutes after the first attempt, the open page gives up; the retry due still starts.
    timers.advance(5 * MINUTE + 1);
    expect(await w.engine.blockedView(second.incident!)).toMatchObject(GAVE_UP);
    await w.settle();
    expect(trust.ensured).toHaveLength(4);
    // A reload after the give-up is Build not verified at once, not a new wait; that retry failed
    // just now, so the reload starts none.
    const third = await load(w);
    expect(await w.engine.blockedView(third.incident!)).toMatchObject(GAVE_UP);
    expect(trust.ensured).toHaveLength(4);
  });

  it('an event-page restart keeps the clock (budget and denied document in storage.session)', async () => {
    const shared = {session: new FakeArea(), local: new FakeArea(), timers: new FakeTimers()};
    const trust = new FailingTrust(shared.timers.clock, 'network');
    const w = await createWorld({...shared, trust});
    w.registry.hint = {version: KEY.version, at: 0};
    const {incident} = await load(w);
    shared.timers.advance(GIVE_UP_MS + 1);
    const again = await createWorld({...shared, trust});
    again.registry.hint = {version: KEY.version, at: 0};
    // The page gives up; its retry, due long ago, starts in the background (and fails).
    expect(await again.engine.blockedView(incident!)).toMatchObject(GAVE_UP);
    await again.settle();
    expect(trust.ensured).toHaveLength(2);
    const next = await load(again);
    expect(await again.engine.blockedView(next.incident!)).toMatchObject(GAVE_UP);
    expect(trust.ensured).toHaveLength(2);
  });

  it('a deep verify still running at the give-up time is waited for; when it succeeds the page reloads into Verified', async () => {
    const timers = new FakeTimers();
    const w = await world(new FakeTrust([]), timers);
    const {incident} = await load(w);
    timers.advance(GIVE_UP_MS + MINUTE);
    expect(await w.engine.blockedView(incident!)).toMatchObject(NEW_BUILD);
    expect(w.trust.ensured).toHaveLength(1);
    w.trust.complete(KEY, [vwCore(KEY.version, {'/index.html': PAGE})]);
    w.trust.jobs = [doneJob(timers.now)];
    await w.settle();
    const view = await w.engine.blockedView(incident!);
    expect(view).toMatchObject(NEW_BUILD);
    expect(shouldReload(view)).toBe(true);
    const next = await load(w);
    expect(next.incident).toBeNull();
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED'});
  });

  it('a deep verify that succeeds before the give-up time: the page keeps asking for its reload, never Build not verified', async () => {
    const timers = new FakeTimers();
    const w = await world(new FakeTrust([]), timers);
    const {incident} = await load(w);
    timers.advance(3 * MINUTE);
    w.trust.complete(KEY, [vwCore(KEY.version, {'/index.html': PAGE})]);
    w.trust.jobs = [doneJob(timers.now)];
    await w.settle();
    // Even a page polled long after (a sleeping laptop): the release is known, so it reloads.
    timers.advance(GIVE_UP_MS);
    const view = await w.engine.blockedView(incident!);
    expect(view).toMatchObject(NEW_BUILD);
    expect(shouldReload(view)).toBe(true);
    await load(w);
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED'});
  });

  it('access to GitHub granted again after the give-up: one fresh attempt, and the vault verifies', async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'permission-missing');
    const w = await world(trust, timers);
    const first = await load(w);
    timers.advance(GIVE_UP_MS + MINUTE);
    expect(await w.engine.blockedView(first.incident!)).toMatchObject(GAVE_UP);
    await w.settle();
    expect(trust.ensured).toHaveLength(2);
    // LocalTrustStore.permissionsChanged forgets the failure.
    trust.failure = null;
    trust.forget(KEY);
    const second = await load(w);
    expect(trust.ensured).toHaveLength(3);
    expect(await w.engine.blockedView(second.incident!)).toMatchObject(NEW_BUILD);
    trust.complete(KEY, [vwCore(KEY.version, {'/index.html': PAGE})]);
    await w.settle();
    const third = await load(w);
    expect(third.incident).toBeNull();
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED'});
  });

  it('no deep verify started in this session (a failure from before, retry not due): the clock counts from the document', async () => {
    const timers = new FakeTimers();
    const w = await world(new FakeTrust([]), timers);
    // GitHub's limit, hit before a browser restart; it resets in an hour.
    w.trust.states.set(buildIdOf(KEY), {
      k: 'failed',
      failure: 'rate-limited',
      transient: true,
      at: timers.now,
      retryAt: timers.now + 60 * MINUTE,
    });
    const {incident} = await load(w);
    timers.advance(GIVE_UP_MS - MINUTE);
    expect(await w.engine.blockedView(incident!)).toMatchObject(NEW_BUILD);
    timers.advance(MINUTE + 1);
    expect(await w.engine.blockedView(incident!)).toMatchObject(GAVE_UP);
    expect(w.trust.ensured).toHaveLength(0);
  });

  it('after a browser restart without access to GitHub: the stale failure gets one attempt, which starts the clock', async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'permission-missing');
    trust.states.set(buildIdOf(KEY), {
      k: 'failed',
      failure: 'permission-missing',
      transient: true,
      at: timers.now - 2 * 60 * MINUTE,
      retryAt: timers.now - 2 * 60 * MINUTE + PERMISSION_RETRY_MS,
    });
    const w = await world(trust, timers);
    const first = await load(w);
    expect(trust.ensured).toHaveLength(1);
    expect(await w.engine.blockedView(first.incident!)).toMatchObject(NEW_BUILD);
    // At the give-up time that attempt's retry (10 minutes) is due: it runs in the background.
    timers.advance(GIVE_UP_MS + 1);
    expect(await w.engine.blockedView(first.incident!)).toMatchObject(GAVE_UP);
    await w.settle();
    expect(trust.ensured).toHaveLength(2);
    const next = await load(w);
    expect(await w.engine.blockedView(next.incident!)).toMatchObject(GAVE_UP);
    expect(trust.ensured).toHaveLength(2);
  });

  it('a release that turns out disputed: the open page reloads, and that load shows Disputed', async () => {
    const w = await world(new FakeTrust([]));
    const first = await load(w);
    w.trust.states.set(buildIdOf(KEY), {k: 'disputed', reason: 'pin-changed', at: w.timers.now});
    const view = await w.engine.blockedView(first.incident!);
    expect(view).toMatchObject({...NEW_BUILD, reload: true});
    expect(shouldReload(view)).toBe(true);
    const next = await load(w);
    const disputed = await w.engine.blockedView(next.incident!);
    expect(disputed).toMatchObject({state: 'DISPUTED', retry: false, canProceedOnce: false});
    expect(shouldReload(disputed)).toBe(false);
  });

  it('a page whose denied document is gone (a browser restart emptied storage.session) reloads; the new load has a document of its own', async () => {
    const kept = {local: new FakeArea(), timers: new FakeTimers()};
    const trust = new FailingTrust(kept.timers.clock, 'network');
    const w = await createWorld({...kept, trust});
    w.registry.hint = {version: KEY.version, at: 0};
    const {incident} = await load(w);
    const waiting = await w.engine.blockedView(incident!);
    expect(waiting).toMatchObject(NEW_BUILD);
    expect(shouldReload(waiting)).toBe(false);
    // The incident log (storage.local) outlives the restart, and the restored tab asks again.
    const again = await createWorld({...kept, trust});
    again.registry.hint = {version: KEY.version, at: 0};
    const view = await again.engine.blockedView(incident!);
    expect(view).toMatchObject({...NEW_BUILD, reload: true, job: null});
    expect(shouldReload(view)).toBe(true);
    // The reload is denied again (GitHub still fails): its page waits for its own document.
    const next = await load(again);
    const nextView = await again.engine.blockedView(next.incident!);
    expect(nextView).toMatchObject(NEW_BUILD);
    expect(shouldReload(nextView)).toBe(false);
    // The same when the denied document's tab is gone.
    again.env.tabsOnRemoved.emit(1, {windowId: 1, isWindowClosing: false});
    await again.settle();
    expect(shouldReload(await again.engine.blockedView(next.incident!))).toBe(true);
  });

  it("a deep verify of another release is not the page's: it is not shown, and its end does not reload the page", async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'permission-missing');
    const w = await world(trust, timers);
    const {incident} = await load(w);
    timers.advance(MINUTE);
    // As the store lists them, newest first: another app's release still downloading, and another
    // version of this app that finished after the denial.
    const others: DeepVerifyJobView[] = [
      {
        jobId: 'job2',
        app: 'bitwarden-web',
        version: KEY.version,
        assetName: `web-${KEY.version}-selfhosted-COMMERCIAL.zip`,
        variant: 'selfhosted-commercial',
        trigger: 'unknown-build',
        phase: 'downloading',
        startedAt: timers.now,
      },
      {...doneJob(timers.now), jobId: 'job3', version: '2026.10.0'},
    ];
    w.trust.jobs = others;
    const view = await w.engine.blockedView(incident!);
    expect(view).toMatchObject({...NEW_BUILD, job: null});
    expect(shouldReload(view)).toBe(false);
    // The job of its own release is the one attached, wherever the list has it.
    w.trust.jobs = [...others, {...doneJob(timers.now), jobId: 'job4', phase: 'failed'}];
    expect((await w.engine.blockedView(incident!))?.job).toMatchObject({jobId: 'job4'});
  });

  it('a deep verify that finds no release: the open page shows Build not verified at once, with the failed job; a permanent failure is never retried', async () => {
    const w = await world(new FakeTrust([]));
    const {incident} = await load(w);
    w.trust.fail(KEY, 'release-not-found');
    w.trust.jobs = [{...doneJob(w.timers.now), phase: 'failed', failure: 'release-not-found'}];
    await w.settle();
    expect(await w.engine.blockedView(incident!)).toMatchObject({
      ...GAVE_UP,
      job: {phase: 'failed', failure: 'release-not-found'},
    });
    w.timers.advance(GIVE_UP_MS + MINUTE);
    const next = await load(w);
    expect(await w.engine.blockedView(next.incident!)).toMatchObject(GAVE_UP);
    await w.settle();
    expect(w.trust.ensured).toHaveLength(1);
  });

  it('after the give-up, a reload with a network retry due is Build not verified and retries in the background; once that succeeds, the next load is Verified', async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'network');
    const w = await world(trust, timers);
    await load(w);
    timers.advance(GIVE_UP_MS + 1);
    // GitHub answers again: the retry this load starts runs until the test completes it.
    trust.failure = null;
    const second = await load(w);
    expect(await w.engine.blockedView(second.incident!)).toMatchObject(GAVE_UP);
    expect(trust.ensured).toHaveLength(2);
    trust.complete(KEY, [vwCore(KEY.version, {'/index.html': PAGE})]);
    await w.settle();
    const third = await load(w);
    expect(third.incident).toBeNull();
    expect(third.filter.output).toEqual(PAGE);
    expect(await w.tab(1)).toMatchObject({state: 'VERIFIED'});
  });

  it('after the give-up, loads retry only when the back-off allows, and "Proceed once" still lets a load through while GitHub fails', async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'network');
    const w = await world(trust, timers);
    await load(w);
    expect(trust.ensured).toHaveLength(1);
    // The retry after 30 s is long due: the load is Build not verified and retries.
    timers.advance(GIVE_UP_MS + 1);
    const second = await load(w);
    expect(await w.engine.blockedView(second.incident!)).toMatchObject(GAVE_UP);
    expect(trust.ensured).toHaveLength(2);
    // That retry failed too: the next one waits 60 s, and a load before then starts none.
    timers.advance(2 * RETRY_BASE_MS - 1);
    const third = await load(w);
    expect(await w.engine.blockedView(third.incident!)).toMatchObject(GAVE_UP);
    expect(trust.ensured).toHaveLength(2);
    // "Proceed once" once the retry is due: the load is let through and retries in the
    // background; the retry fails, and the page stays Build not verified.
    timers.advance(1);
    await w.engine.allowForTab(1, {k: 'proceed-once', sha256: sha(PAGE)});
    const fourth = await load(w);
    expect(fourth.incident).toBeNull();
    expect(fourth.filter.output).toEqual(PAGE);
    expect(trust.ensured).toHaveLength(3);
    expect(await w.tab(1)).toMatchObject({state: 'BUILD_UNVERIFIED'});
  });

  it('after the give-up, loads while a background retry runs stay Build not verified (never New build), and "Proceed once" lets one through', async () => {
    const timers = new FakeTimers();
    const trust = new FailingTrust(timers.clock, 'network');
    const w = await world(trust, timers);
    await load(w);
    timers.advance(GIVE_UP_MS + 1);
    // GitHub is slow to fail: the retry this load starts keeps running.
    trust.slow = true;
    const second = await load(w);
    expect(await w.engine.blockedView(second.incident!)).toMatchObject(GAVE_UP);
    expect(trust.ensured).toHaveLength(2);
    expect(trust.releaseState(KEY).k).toBe('working');
    // Another load meanwhile: Build not verified at once, and no second retry.
    timers.advance(5_000);
    const third = await load(w);
    expect(await w.engine.blockedView(third.incident!)).toMatchObject(GAVE_UP);
    await w.engine.allowForTab(1, {k: 'proceed-once', sha256: sha(PAGE)});
    const fourth = await load(w);
    expect(fourth.incident).toBeNull();
    expect(fourth.filter.output).toEqual(PAGE);
    expect(await w.tab(1)).toMatchObject({state: 'BUILD_UNVERIFIED'});
    // The retry fails; the open page stays Build not verified and starts no new retry.
    trust.finishFailed();
    await w.settle();
    expect(await w.tab(1)).toMatchObject({state: 'BUILD_UNVERIFIED'});
    expect(trust.ensured).toHaveLength(2);
  });
});
