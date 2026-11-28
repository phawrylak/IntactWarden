/**
 * The local trust store:
 *
 * - the **registry** of cores: cores built in this browser (`source: 'deep-verify'`, IndexedDB
 *   `cores`), which are dropped when the builder fingerprint changes (the code that builds or
 *   reads them changed) together with the stored failures, and the bundled cores of a test
 *   package;
 * - **candidates** for binding, ordered by hint match, then newest version;
 * - **release states**; failed and disputed ones persist in `l:v1:releases`. Disputes are sticky;
 *   permanent failures are forgotten after their TTL, so a later page load tries again; a
 *   user-started deep verify ignores cached failures (not disputes);
 * - **ensureRelease**: one job per release, concurrent requests for one release share it, and one
 *   job runs at a time. A job a restart cut off is listed as failed (network) and not resumed;
 * - **listeners** for releases that became known or disputed (the engine retro-verifies or turns
 *   documents red).
 */

import {BuildError, type AssetPlan, type CoreBuilder} from '@intactwarden/builders/api.ts';
import type {
  BuildId,
  CandidateQuery,
  CoreRef,
  DeepVerifyJobView,
  DisputeEvidence,
  DisputeReason,
  EnsureReleaseOutcome,
  EnsureReleaseRequest,
  ExtensionDb,
  JobPhase,
  LoadedCore,
  ReleaseDetail,
  ReleaseFailure,
  ReleaseKey,
  ReleaseState,
  ReleasesState,
  Sha256Hex,
  TrustSnapshot,
  TrustStore,
  Unsubscribe,
  VariantId,
} from '../contracts.ts';
import {buildIdOf, LOCAL_KEYS} from '../contracts.ts';
import {profileByApp} from '@intactwarden/profiles';
import {loadBootstrap, profileAssurance, type PackageReader} from './bootstrap.ts';
import {
  compareVersions,
  isRecord,
  isReleaseKey,
  isSafeCount,
  isSha256,
  randomId,
  type Kv,
  type TrustLog,
  noLog,
  errorName,
} from './common.ts';
import {createCoresDb, verifyCoreBytes, type CoresDb} from './coresDb.ts';
import type {GitHubClient} from './github.ts';
import type {JobHost} from './jobHost.ts';
import type {JobProgress} from './job.ts';
import {createPinStore, type PinStore} from './pins.ts';
import {resolveRelease} from './resolve.ts';

export const MAX_JOBS = 50;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 15 * 60_000;
export const NOT_FOUND_TTL_MS = 6 * 60 * 60_000;
export const REFUSED_TTL_MS = 24 * 60 * 60_000;
/** A missing GitHub permission is tried again after this, or at once when access is granted. */
export const PERMISSION_RETRY_MS = 10 * 60_000;

export interface StoreDeps {
  readonly kv: Kv;
  readonly db: ExtensionDb;
  readonly builder: CoreBuilder;
  /** Builder fingerprint (fingerprint.ts): local cores built by other code are dropped. */
  readonly builderFingerprint: string;
  readonly now: () => number;
  readonly jobHost: JobHost;
  readonly github: GitHubClient;
  readonly readPackageFile: PackageReader;
  readonly hasGitHubPermission: () => Promise<boolean>;
  readonly publishJob?: (job: DeepVerifyJobView) => void;
  readonly log?: TrustLog;
}

export interface LocalTrustStore extends TrustStore {
  /** A host permission was granted: forget `permission-missing` failures. */
  permissionsChanged(): void;
}

type JobFailure = Extract<EnsureReleaseOutcome, {ok: false}>;
type JobOutcome = {readonly ok: true} | JobFailure;

const FAILURES: readonly ReleaseFailure[] = [
  'release-not-found',
  'asset-not-found',
  'image-only-release',
  'digest-unavailable',
  'digest-mismatch',
  'build-refused',
  'disputed',
  'network',
  'rate-limited',
  'permission-missing',
];
const DISPUTES: readonly DisputeReason[] = ['pin-changed', 'tag-moved'];
const PHASES: readonly JobPhase[] = [
  'queued',
  'resolving',
  'downloading',
  'verifying',
  'building',
  'storing',
  'done',
  'failed',
];
const TERMINAL: readonly JobPhase[] = ['done', 'failed'];

// Validation of persisted values (shape checks: a malformed value is dropped, never acted on).

function validRef(raw: unknown): CoreRef | null {
  if (!isRecord(raw) || !isReleaseKey(raw)) return null;
  const r = raw as Record<string, unknown> & ReleaseKey;
  const assurance = profileAssurance(r.app, r.variant);
  const ok =
    r['buildId'] === buildIdOf(r) &&
    assurance !== null &&
    r['assurance'] === assurance &&
    isSha256(r['sha256']) &&
    isSafeCount(r['size']) &&
    (r['source'] === 'bundled' || r['source'] === 'deep-verify') &&
    isSafeCount(r['addedAt']) &&
    (r['status'] === 'current' || r['status'] === 'disputed');
  if (!ok) return null;
  return {
    buildId: r['buildId'] as string,
    app: r.app,
    variant: r.variant,
    version: r.version,
    assurance,
    sha256: r['sha256'] as string,
    size: r['size'] as number,
    source: r['source'] as CoreRef['source'],
    addedAt: r['addedAt'] as number,
    status: r['status'] as CoreRef['status'],
  };
}

function validState(raw: unknown): ReleaseState | null {
  if (!isRecord(raw)) return null;
  if (raw['k'] === 'disputed') {
    const ev = raw['evidence'];
    const evidence =
      isRecord(ev) && typeof ev['recorded'] === 'string' && typeof ev['observed'] === 'string'
        ? {evidence: {recorded: ev['recorded'], observed: ev['observed']}}
        : {};
    return typeof raw['reason'] === 'string' &&
      (DISPUTES as readonly string[]).includes(raw['reason']) &&
      isSafeCount(raw['at'])
      ? {k: 'disputed', reason: raw['reason'] as DisputeReason, at: raw['at'], ...evidence}
      : null;
  }
  if (raw['k'] === 'failed') {
    const {failure, transient, at, retryAt, detail} = raw;
    if (
      typeof failure !== 'string' ||
      !(FAILURES as readonly string[]).includes(failure) ||
      failure === 'disputed' ||
      typeof transient !== 'boolean' ||
      !isSafeCount(at) ||
      !(retryAt === null || isSafeCount(retryAt)) ||
      !(detail === undefined || typeof detail === 'string')
    ) {
      return null;
    }
    return {
      k: 'failed',
      failure: failure as ReleaseFailure,
      transient,
      at,
      retryAt,
      ...(detail === undefined ? {} : {detail: detail as NonNullable<JobFailure['detail']>}),
    };
  }
  return null;
}

function validJob(raw: unknown): DeepVerifyJobView | null {
  if (!isRecord(raw)) return null;
  const ok =
    typeof raw['jobId'] === 'string' &&
    /^[0-9a-f]{16}$/.test(raw['jobId']) &&
    typeof raw['assetName'] === 'string' &&
    isReleaseKey({app: raw['app'], variant: raw['variant'], version: raw['version']}) &&
    (raw['trigger'] === 'unknown-build' || raw['trigger'] === 'user') &&
    typeof raw['phase'] === 'string' &&
    (PHASES as readonly string[]).includes(raw['phase']) &&
    isSafeCount(raw['startedAt']);
  return ok ? (raw as unknown as DeepVerifyJobView) : null;
}

function failureTtl(failure: ReleaseFailure): number | null {
  switch (failure) {
    case 'release-not-found':
    case 'asset-not-found':
    case 'image-only-release':
    case 'digest-unavailable':
      return NOT_FOUND_TTL_MS;
    case 'digest-mismatch':
    case 'build-refused':
      return REFUSED_TTL_MS;
    default:
      return null;
  }
}

function failureOf(state: Extract<ReleaseState, {k: 'failed'}>): JobFailure {
  return {
    ok: false,
    failure: state.failure,
    transient: state.transient,
    retryAt: state.retryAt,
    ...(state.detail === undefined ? {} : {detail: state.detail}),
  };
}

const disputedOutcome = (reason: DisputeReason): JobFailure => ({
  ok: false,
  failure: 'disputed',
  transient: false,
  retryAt: null,
  dispute: reason,
});

/** Selection order of candidates: hint match, then newest version. */
function rankCandidates(
  loaded: readonly LoadedCore[],
  query: CandidateQuery,
): readonly LoadedCore[] {
  const hinted = (c: LoadedCore): number =>
    typeof query.hintVersion === 'string' && c.ref.version === query.hintVersion ? 1 : 0;
  return [...loaded].sort(
    (a, b) => hinted(b) - hinted(a) || compareVersions(b.ref.version, a.ref.version),
  );
}

export function createLocalTrustStore(deps: StoreDeps): LocalTrustStore {
  const log = deps.log ?? noLog;
  const coresDb: CoresDb = createCoresDb(deps.db, log);
  const pins: PinStore = createPinStore({kv: deps.kv, log});

  const refs = new Map<BuildId, CoreRef>();
  const bundledSha = new Map<BuildId, Sha256Hex>();
  const states = new Map<BuildId, ReleaseState>();
  let jobs: DeepVerifyJobView[] = [];
  const inflight = new Map<string, Promise<JobOutcome>>();
  const attempts = new Map<string, number>();
  const knownListeners = new Set<(refs: readonly CoreRef[]) => void>();
  const disputedListeners = new Set<(key: ReleaseKey, reason: DisputeReason) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let writes: Promise<void> = Promise.resolve();
  let isReady = false;
  let initFailed = false;
  /**
   * The stored release record could not be read at start-up, or start-up failed: memory may lack
   * its disputes, failures and local cores, so it is never written over (a write would erase a
   * dispute; it would then come back VERIFIED at the next start). The next start reads it again.
   */
  let releasesUnread = false;

  // ----- persistence

  const persistReleases = (): Promise<void> => {
    if (releasesUnread) {
      log('trust.store.releases-unread');
      return writes;
    }
    const cores: Record<BuildId, CoreRef> = {};
    for (const [id, ref] of refs) cores[id] = ref;
    const persisted: Record<BuildId, ReleaseState> = {};
    for (const [id, st] of states) if (st.k === 'failed' || st.k === 'disputed') persisted[id] = st;
    const value: ReleasesState = {builder: deps.builderFingerprint, cores, states: persisted};
    writes = writes
      .then(() => deps.kv.set(LOCAL_KEYS.releases, value))
      .catch(() => log('trust.store.persist-failed', {key: 'releases'}));
    return writes;
  };

  const persistJobs = (): Promise<void> => {
    // After a failed start the stored list was never read: do not write over it.
    if (initFailed) return writes;
    const value = jobs.slice(0, MAX_JOBS);
    writes = writes
      .then(() => deps.kv.set(LOCAL_KEYS.jobs, value))
      .catch(() => log('trust.store.persist-failed', {key: 'jobs'}));
    return writes;
  };

  const publish = (view: DeepVerifyJobView): void => {
    try {
      deps.publishJob?.(view);
    } catch {
      log('trust.store.publish-failed');
    }
  };

  const upsertJob = (view: DeepVerifyJobView, persist: boolean): Promise<void> => {
    jobs = [view, ...jobs.filter(j => j.jobId !== view.jobId)].slice(0, MAX_JOBS);
    publish(view);
    return persist ? persistJobs() : Promise.resolve();
  };

  // ----- listeners

  const emitKnown = (newRefs: readonly CoreRef[]): void => {
    for (const l of [...knownListeners]) {
      try {
        l(newRefs);
      } catch {
        log('trust.store.listener-failed');
      }
    }
  };
  const emitDisputed = (key: ReleaseKey, reason: DisputeReason): void => {
    for (const l of [...disputedListeners]) {
      try {
        l(key, reason);
      } catch {
        log('trust.store.listener-failed');
      }
    }
  };

  // ----- start-up

  async function init(): Promise<void> {
    const [releasesRaw, jobsRaw] = await Promise.all([
      deps.kv
        .get(LOCAL_KEYS.releases)
        .catch(() => deps.kv.get(LOCAL_KEYS.releases))
        .catch(() => {
          releasesUnread = true;
          return undefined;
        }),
      deps.kv.get(LOCAL_KEYS.jobs).catch(() => undefined),
    ]);
    await deps.github.load();
    const boot = await loadBootstrap(deps.readPackageFile, log);
    await pins.load();

    const persistedCores =
      isRecord(releasesRaw) && isRecord(releasesRaw['cores']) ? releasesRaw['cores'] : {};
    const persistedStates =
      isRecord(releasesRaw) && isRecord(releasesRaw['states']) ? releasesRaw['states'] : {};
    const previous = new Map<BuildId, CoreRef>();
    for (const [id, raw] of Object.entries(persistedCores)) {
      const ref = validRef(raw);
      if (ref !== null && ref.buildId === id) previous.set(id, ref);
      else log('trust.store.dropped-ref');
    }

    // Cores built in this browser by other builder code (another fingerprint, or none) are
    // rebuilt on demand, and what that code failed at is tried again. An update that leaves that
    // code unchanged keeps both. The local pins and the disputes stay.
    const sameBuilder = isRecord(releasesRaw) && releasesRaw['builder'] === deps.builderFingerprint;
    let dirty = !sameBuilder;
    const now = deps.now();
    for (const {entry, parsed} of boot.cores) {
      coresDb.remember(entry.sha256, parsed);
      bundledSha.set(entry.build_id, entry.sha256);
      const found = previous.get(entry.build_id);
      const prev =
        found !== undefined && found.source === 'bundled' && found.sha256 === entry.sha256
          ? found
          : null;
      if (prev === null) dirty = true;
      refs.set(entry.build_id, {
        buildId: entry.build_id,
        app: entry.app,
        variant: entry.variant,
        version: entry.version,
        assurance: entry.assurance,
        sha256: entry.sha256,
        size: entry.size,
        source: 'bundled',
        addedAt: prev?.addedAt ?? now,
        status: 'current',
      });
    }
    for (const [id, ref] of previous) {
      if (ref.source !== 'deep-verify') {
        if (!bundledSha.has(id)) dirty = true; // a bundled core of an older package
        continue;
      }
      if (bundledSha.has(id) || !sameBuilder) {
        // The reviewed bundle wins over a local build of the same release.
        // Not awaited: start-up does not wait on IndexedDB, and its transactions keep their order.
        if (bundledSha.get(id) !== ref.sha256)
          void coresDb.remove(ref.sha256).catch(() => undefined);
        if (!bundledSha.has(id)) log('trust.store.dropped-local-core', {build: id});
        dirty = true;
        continue;
      }
      refs.set(id, {...ref, status: 'current'});
    }
    for (const [id, raw] of Object.entries(persistedStates)) {
      const st = validState(raw);
      if (st === null) {
        dirty = true;
        continue;
      }
      if (st.k === 'failed' && (refs.has(id) || !sameBuilder)) {
        dirty = true;
        continue;
      }
      states.set(id, st);
      if (st.k === 'disputed') {
        const ref = refs.get(id);
        if (ref !== undefined) refs.set(id, {...ref, status: 'disputed'});
      }
    }
    if (await deps.hasGitHubPermission().catch(() => false)) {
      for (const [id, st] of states) {
        if (st.k === 'failed' && st.failure === 'permission-missing') {
          states.delete(id);
          dirty = true;
        }
      }
    }
    // A job a restart cut off is not resumed; list it as failed (network).
    let cutOff = false;
    jobs = (Array.isArray(jobsRaw) ? jobsRaw : [])
      .map(validJob)
      .filter((j): j is DeepVerifyJobView => j !== null)
      .slice(0, MAX_JOBS)
      .map(j => {
        if (TERMINAL.includes(j.phase)) return j;
        cutOff = true;
        return {...j, phase: 'failed' as const, failure: 'network' as const, finishedAt: now};
      });
    if (cutOff) await persistJobs();
    if (dirty) await persistReleases();
    isReady = true;
    log('trust.store.ready', {
      cores: refs.size,
      bundled: bundledSha.size,
      skipped: boot.skipped.length,
    });
  }

  const readyPromise: Promise<void> = init().catch(e => {
    log('trust.store.init-failed', {error: errorName(e)});
    initFailed = true;
    // Memory may lack stored cores, failures and disputes: never write over the stored record.
    releasesUnread = true;
    isReady = true;
  });

  // ----- registry helpers

  async function loadRef(ref: CoreRef): Promise<LoadedCore | null> {
    let loaded: LoadedCore | null;
    try {
      loaded = await coresDb.load(ref);
    } catch {
      // IndexedDB could not be read: the core may be intact, so its ref stays.
      return null;
    }
    if (loaded !== null) return loaded;
    if (ref.source === 'deep-verify' && refs.get(ref.buildId)?.sha256 === ref.sha256) {
      // Missing or corrupt in IndexedDB: forget it, so the release can be rebuilt.
      refs.delete(ref.buildId);
      await persistReleases();
    }
    return null;
  }

  function releaseState(key: ReleaseKey): ReleaseState {
    const id = buildIdOf(key);
    const st = states.get(id);
    if (st?.k === 'disputed') return st;
    const ref = refs.get(id);
    if (ref !== undefined) return {k: 'known', refs: [ref]};
    if (st === undefined) return {k: 'unknown'};
    if (st.k === 'failed' && !st.transient) {
      const ttl = failureTtl(st.failure);
      if (ttl !== null && deps.now() - st.at >= ttl) {
        states.delete(id);
        void persistReleases();
        return {k: 'unknown'};
      }
    }
    return st;
  }

  const snapshot = (): TrustSnapshot => ({
    ready: isReady,
    loaded: isReady && !initFailed,
    githubBackoffUntil: deps.github.backoffUntil(),
  });

  // ----- jobs

  /** Sets the state of the plan's release (a dispute stays; a known core needs no state). */
  function setState(plan: AssetPlan, state: ReleaseState | null): void {
    const id = buildIdOf(plan);
    const current = states.get(id);
    if (current?.k === 'disputed') return;
    if (state === null || (refs.has(id) && state.k !== 'disputed')) {
      if (current?.k === 'working' || current?.k === 'failed') states.delete(id);
      return;
    }
    states.set(id, state);
  }

  /**
   * The dispute of the plan's release, if any. A job queued before a sibling variant's job found
   * the dispute must not register a core afterwards, even when GitHub's answer has flipped back.
   */
  function disputeOf(plan: AssetPlan): DisputeReason | null {
    const st = states.get(buildIdOf(plan));
    return st?.k === 'disputed' ? st.reason : null;
  }

  function retryDelay(id: BuildId): number {
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    return Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS);
  }

  async function failJob(
    view: DeepVerifyJobView,
    plan: AssetPlan,
    f: JobFailure,
  ): Promise<JobOutcome> {
    const now = deps.now();
    const id = buildIdOf(plan);
    let outcome = f;
    if (f.transient && f.failure !== 'disputed') {
      outcome = {...f, retryAt: f.retryAt ?? now + retryDelay(id)};
    } else {
      attempts.delete(id);
    }
    if (outcome.failure !== 'disputed') {
      setState(plan, {
        k: 'failed',
        failure: outcome.failure,
        transient: outcome.transient,
        at: now,
        retryAt: outcome.retryAt,
        ...(outcome.detail === undefined ? {} : {detail: outcome.detail}),
      });
    }
    await persistReleases();
    await upsertJob(
      {
        ...view,
        phase: 'failed',
        finishedAt: now,
        failure: outcome.failure,
        ...(outcome.detail === undefined ? {} : {detail: outcome.detail}),
      },
      true,
    );
    log('trust.job.failed', {failure: outcome.failure, detail: outcome.detail ?? ''});
    return outcome;
  }

  /**
   * The asset or tag of a release contradicts its pin: every variant of the app at that version is
   * built from that asset, so the dispute covers them all.
   */
  async function markDisputed(
    plan: AssetPlan,
    reason: DisputeReason,
    evidence: DisputeEvidence | undefined,
  ): Promise<void> {
    const now = deps.now();
    const keys: ReleaseKey[] = [];
    for (const variant of Object.keys(profileByApp(plan.app)?.variants ?? {}) as VariantId[]) {
      const key = {app: plan.app, variant, version: plan.version};
      const id = buildIdOf(key);
      states.set(id, {k: 'disputed', reason, at: now, ...(evidence ? {evidence} : {})});
      const ref = refs.get(id);
      if (ref !== undefined) refs.set(id, {...ref, status: 'disputed'});
      keys.push(key);
    }
    await persistReleases();
    log('trust.release.disputed', {reason});
    for (const key of keys) emitDisputed(key, reason);
  }

  /** Checks the core a job built, then writes it to IndexedDB and announces it. */
  async function finishJob(
    view: DeepVerifyJobView,
    plan: AssetPlan,
    result: Awaited<ReturnType<JobHost['run']>>,
  ): Promise<JobOutcome> {
    if (!result.ok) {
      return failJob(view, plan, {
        ok: false,
        failure: result.failure,
        transient: result.failure === 'network' || result.failure === 'rate-limited',
        retryAt: null,
        ...(result.detail === undefined ? {} : {detail: result.detail}),
      });
    }
    const {core: built} = result;
    const buildId = buildIdOf(plan);
    const refused = (detail: ReleaseDetail): Promise<JobOutcome> =>
      failJob(view, plan, {
        ok: false,
        failure: 'build-refused',
        transient: false,
        retryAt: null,
        detail,
      });
    const assurance = profileAssurance(plan.app, plan.variant);
    const check = await verifyCoreBytes(built.bytes, {
      sha256: built.sha256,
      app: plan.app,
      variant: plan.variant,
      version: plan.version,
    });
    if (assurance === null || !check.ok) return refused('invalid-core');
    // Config inputs the core was derived from must be the files the job fetched.
    const inputs = check.parsed.core.derivation?.inputs ?? [];
    for (const input of inputs) {
      const reported = result.configs.find(c => c.path === input.path);
      if (reported !== undefined && reported.sha256 !== input.sha256)
        return refused('invalid-core');
    }
    const dispute = disputeOf(plan);
    if (dispute !== null) return failJob(view, plan, disputedOutcome(dispute));
    // They become local pins (by commit), then the core is stored and registered.
    for (const input of inputs) {
      await pins.recordConfig(plan.repo, input.commit, input.path, input.sha256);
    }
    try {
      await coresDb.put(built.bytes, check.parsed, built.sha256, deps.now());
    } catch {
      log('trust.cores.write-failed', {build: buildId});
      return failJob(view, plan, {ok: false, failure: 'network', transient: true, retryAt: null});
    }
    refs.set(buildId, {
      buildId,
      app: plan.app,
      variant: plan.variant,
      version: plan.version,
      assurance,
      sha256: built.sha256,
      size: built.bytes.length,
      source: 'deep-verify',
      addedAt: deps.now(),
      status: 'current',
    });
    setState(plan, null);
    attempts.delete(buildId);
    await persistReleases();
    await upsertJob(
      {
        ...view,
        phase: 'done',
        // Stamped now, after the ref is written: "finished before" then implies "known before"
        // (the blocked page relies on it).
        finishedAt: deps.now(),
      },
      true,
    );
    log('trust.job.done');
    emitKnown([refs.get(buildId)!]);
    return {ok: true};
  }

  function progressHandler(
    viewRef: {current: DeepVerifyJobView},
    plan: AssetPlan,
  ): (p: JobProgress) => void {
    let lastPhase: JobPhase = viewRef.current.phase;
    return p => {
      // finishJob / failJob write the terminal view; late progress never overwrites it.
      if (TERMINAL.includes(p.phase)) return;
      const stored = jobs.find(j => j.jobId === viewRef.current.jobId);
      if (stored !== undefined && TERMINAL.includes(stored.phase)) return;
      const changed = p.phase !== lastPhase;
      lastPhase = p.phase;
      viewRef.current = {
        ...viewRef.current,
        phase: p.phase,
        ...(p.bytes === undefined ? {} : {bytes: p.bytes}),
        ...(p.total === undefined ? {} : {total: p.total}),
      };
      if (changed) {
        setState(plan, {
          k: 'working',
          jobId: viewRef.current.jobId,
          phase: p.phase,
          since: viewRef.current.startedAt,
        });
      }
      void upsertJob(viewRef.current, changed);
    };
  }

  function startJob(
    plan: AssetPlan,
    trigger: EnsureReleaseRequest['trigger'],
  ): Promise<JobOutcome> {
    const id = buildIdOf(plan);
    const existing = inflight.get(id);
    if (existing !== undefined) return existing;
    const jobId = randomId();
    const startedAt = deps.now();
    const viewRef = {
      current: {
        jobId,
        app: plan.app,
        version: plan.version,
        assetName: plan.assetName,
        variant: plan.variant,
        trigger,
        phase: 'queued',
        startedAt,
      } as DeepVerifyJobView,
    };
    setState(plan, {k: 'working', jobId, phase: 'queued', since: startedAt});
    void upsertJob(viewRef.current, true);
    const onProgress = progressHandler(viewRef, plan);

    const run = async (): Promise<JobOutcome> => {
      try {
        // After a failed start (R5) no pin is checked or recorded and nothing is downloaded: the
        // job fails as transient.
        if (initFailed) throw new Error('trust store failed to start');
        onProgress({phase: 'resolving'});
        if (!(await deps.hasGitHubPermission())) {
          return await failJob(viewRef.current, plan, {
            ok: false,
            failure: 'permission-missing',
            transient: true,
            retryAt: deps.now() + PERMISSION_RETRY_MS,
          });
        }
        // The local pins must be in memory before one is checked or recorded (a failed read at
        // start-up is retried here; while it fails, the job fails as transient).
        await pins.reload();
        const dispute = disputeOf(plan);
        if (dispute !== null) return await failJob(viewRef.current, plan, disputedOutcome(dispute));
        const resolved = await resolveRelease(plan, {github: deps.github, pins});
        if (!resolved.ok) {
          if (resolved.failure === 'disputed' && resolved.dispute !== undefined) {
            await markDisputed(plan, resolved.dispute, resolved.evidence);
          }
          return await failJob(viewRef.current, plan, resolved);
        }
        // TOFU: pin what GitHub lists now, before downloading.
        if (resolved.observed !== null) await pins.recordAsset(resolved.observed);
        const result = await deps.jobHost.run({...resolved.spec, jobId}, onProgress);
        return await finishJob(viewRef.current, plan, result);
      } catch (e) {
        log('trust.job.crashed', {error: errorName(e)});
        return failJob(viewRef.current, plan, {
          ok: false,
          failure: 'network',
          transient: true,
          retryAt: null,
        });
      }
    };
    const promise = queue.then(run, run).finally(() => inflight.delete(id));
    queue = promise.catch(() => undefined);
    inflight.set(id, promise);
    return promise;
  }

  // ----- the public API

  async function ensureRelease(request: EnsureReleaseRequest): Promise<EnsureReleaseOutcome> {
    await readyPromise;
    const {key, trigger} = request;
    if (!isReleaseKey(key)) {
      return {
        ok: false,
        failure: 'build-refused',
        transient: false,
        retryAt: null,
        detail: 'unsupported',
      };
    }
    const user = trigger === 'user';
    const id = buildIdOf(key);
    const before = releaseState(key);
    if (before.k === 'disputed') return disputedOutcome(before.reason);
    if (before.k === 'known') return {ok: true, refs: before.refs};
    if (!user && before.k === 'failed') {
      const due = before.transient && (before.retryAt === null || before.retryAt <= deps.now());
      if (!due) return failureOf(before);
    }

    let plan: AssetPlan;
    try {
      plan = deps.builder.plan(key.app, key.variant, key.version);
    } catch (e) {
      const detail = e instanceof BuildError ? e.code : 'unsupported';
      return {ok: false, failure: 'build-refused', transient: false, retryAt: null, detail};
    }
    const back = deps.github.backoffUntil();
    if (back !== null && !inflight.has(id)) {
      setState(plan, {
        k: 'failed',
        failure: 'rate-limited',
        transient: true,
        at: deps.now(),
        retryAt: back,
      });
      await persistReleases();
      return {ok: false, failure: 'rate-limited', transient: true, retryAt: back};
    }

    const job = await startJob(plan, trigger);
    const after = releaseState(key);
    if (after.k === 'disputed') return disputedOutcome(after.reason);
    if (!job.ok) return job;
    if (after.k === 'known') return {ok: true, refs: after.refs};
    if (after.k === 'failed') return failureOf(after);
    log('trust.store.unexpected-state', {state: after.k, build: id});
    return {ok: false, failure: 'network', transient: true, retryAt: deps.now() + RETRY_BASE_MS};
  }

  return {
    async ready() {
      await readyPromise;
      return snapshot();
    },
    snapshot,
    async candidates(query: CandidateQuery) {
      await readyPromise;
      const picked = [...refs.values()].filter(
        r => r.app === query.app && r.variant === query.variant,
      );
      const loaded = (await Promise.all(picked.map(loadRef))).filter(
        (c): c is LoadedCore => c !== null,
      );
      return rankCandidates(loaded, query);
    },
    async getCoreBySha256(sha256) {
      await readyPromise;
      if (!isSha256(sha256)) return null;
      const ref = [...refs.values()].find(r => r.sha256 === sha256);
      return ref === undefined ? null : loadRef(ref);
    },
    releaseState: key => (isReleaseKey(key) ? releaseState(key) : {k: 'unknown'}),
    ensureRelease,
    onReleaseKnown(listener): Unsubscribe {
      knownListeners.add(listener);
      return () => knownListeners.delete(listener);
    },
    onReleaseDisputed(listener): Unsubscribe {
      disputedListeners.add(listener);
      return () => disputedListeners.delete(listener);
    },
    async listCores() {
      await readyPromise;
      return [...refs.values()];
    },
    async listJobs() {
      await readyPromise;
      return [...jobs];
    },
    async pins() {
      await readyPromise;
      return pins.all();
    },
    permissionsChanged() {
      let changed = false;
      for (const [id, st] of states) {
        if (st.k === 'failed' && st.failure === 'permission-missing') {
          states.delete(id);
          changed = true;
        }
      }
      if (changed) void persistReleases();
    },
  };
}
