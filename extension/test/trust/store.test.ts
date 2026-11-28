import {beforeAll, describe, expect, it} from 'vitest';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {
  LOCAL_KEYS,
  type CoreRef,
  type DeepVerifyJobView,
  type ReleaseKey,
} from '../../src/contracts.ts';
import {memoryExtensionDb, type MemoryDb} from '../helpers/memoryDb.ts';
import {createGitHubClient, type GitHubClient} from '../../src/trust/github.ts';
import {createTrustStore} from '../../src/trust/index.ts';
import {createFakeEnv} from '../engine/helpers/fakeExt.ts';
import {createInProcessJobHost, type JobHost} from '../../src/trust/jobHost.ts';
import type {JobLimits} from '../../src/trust/job.ts';
import {
  createLocalTrustStore,
  NOT_FOUND_TTL_MS,
  PERMISSION_RETRY_MS,
  RETRY_BASE_MS,
} from '../../src/trust/store.ts';
import {createFakeFetch, type FakeFetch} from './helpers/fakeFetch.ts';
import {createGitHubEmulator, type GitHubEmulator} from './helpers/githubEmulator.ts';
import {
  flip,
  getCore,
  manualClock,
  memoryKv,
  packageReader,
  type MemoryKv,
} from './helpers/memory.ts';
import {
  bundledPackage,
  idsFor,
  publishVw,
  sha256,
  vwAssets,
  VW_REPO,
  VW_REPO_ID,
  type BundledPackage,
} from './helpers/vaultwarden.ts';

const BUNDLED = '2026.10.1';
const NEW = '2026.11.0';
const key = (version: string): ReleaseKey => ({
  app: 'vaultwarden-web',
  variant: 'release',
  version,
});

let pkg: BundledPackage;
let pkg2: BundledPackage;
beforeAll(async () => {
  pkg = await bundledPackage([BUNDLED]);
  pkg2 = await bundledPackage([BUNDLED, '2026.9.0']);
});

interface Options {
  readonly kv?: MemoryKv;
  readonly db?: MemoryDb;
  readonly fake?: FakeFetch;
  readonly emu?: GitHubEmulator;
  readonly pkg?: BundledPackage;
  readonly limits?: Partial<JobLimits>;
  readonly clock?: ReturnType<typeof manualClock>;
  /** The builder fingerprint (an update that changes it drops the cores built before). */
  readonly fingerprint?: string;
  readonly jobHost?: JobHost;
  readonly github?: GitHubClient;
}

function setup(options: Options = {}) {
  const fake = options.fake ?? createFakeFetch();
  const emu = options.emu ?? createGitHubEmulator(fake);
  const clock = options.clock ?? manualClock();
  const kv = options.kv ?? memoryKv();
  const db = options.db ?? memoryExtensionDb();
  const builder = createCoreBuilder();
  const env = {
    permission: true,
    published: [] as DeepVerifyJobView[],
    known: [] as CoreRef[][],
    disputed: [] as [ReleaseKey, string][],
    logs: [] as string[],
  };
  const store = createLocalTrustStore({
    kv,
    db,
    builder,
    builderFingerprint: options.fingerprint ?? 'f1',
    now: clock.now,
    jobHost:
      options.jobHost ??
      createInProcessJobHost({
        fetch: fake.fetch,
        builder,
        ...(options.limits === undefined ? {} : {limits: options.limits}),
      }),
    github: options.github ?? createGitHubClient({fetch: fake.fetch, now: clock.now, kv}),
    readPackageFile: packageReader((options.pkg ?? pkg).files),
    hasGitHubPermission: async () => env.permission,
    publishJob: view => env.published.push(view),
    log: code => env.logs.push(code),
  });
  store.onReleaseKnown(refs => env.known.push([...refs]));
  store.onReleaseDisputed((k, reason) => env.disputed.push([k, reason]));
  return {fake, emu, clock, kv, db, store, env};
}

describe('trust store: bundled cores', () => {
  it('loads the bootstrap and answers candidates, states and lookups', async () => {
    const {store} = setup();
    const snap = await store.ready();
    expect(snap).toMatchObject({ready: true, loaded: true});
    const state = store.releaseState(key(BUNDLED));
    expect(state.k).toBe('known');
    if (state.k === 'known') {
      expect(state.refs[0]).toMatchObject({
        buildId: `vaultwarden-web@${BUNDLED}+release`,
        source: 'bundled',
        assurance: 'release-exact',
        sha256: pkg.cores[0]!.sha256,
        status: 'current',
      });
    }
    expect(store.releaseState(key(NEW))).toEqual({k: 'unknown'});
    const [c] = await store.candidates({app: 'vaultwarden-web', variant: 'release'});
    expect(c?.core.build_id).toBe(`vaultwarden-web@${BUNDLED}+release`);
    expect(c?.fileIndex.lookup('/index.html')).not.toBeNull();
    expect(
      await store.candidates({app: 'bitwarden-web', variant: 'selfhosted-commercial'}),
    ).toEqual([]);
    expect((await store.getCoreBySha256(pkg.cores[0]!.sha256))?.ref.version).toBe(BUNDLED);
    expect(await getCore(store, key(NEW))).toBeNull();
  });

  it('orders candidates by hint, then newest version', async () => {
    const {store} = setup({pkg: pkg2});
    const q = {app: 'vaultwarden-web', variant: 'release'} as const;
    expect((await store.candidates(q)).map(c => c.ref.version)).toEqual([BUNDLED, '2026.9.0']);
    expect(
      (await store.candidates({...q, hintVersion: '2026.9.0'})).map(c => c.ref.version),
    ).toEqual(['2026.9.0', BUNDLED]);
  });

  it('starts without bootstrap data (the shipping package): no core, no error, no log', async () => {
    const {store, emu, env} = setup({pkg: {files: new Map(), index: pkg.index, cores: []}});
    expect(await store.ready()).toEqual({ready: true, loaded: true, githubBackoffUntil: null});
    expect(await store.listCores()).toEqual([]);
    expect((await store.pins()).pins).toEqual([]);
    expect(store.releaseState(key(BUNDLED))).toEqual({k: 'unknown'});
    expect(env.logs).toEqual(['trust.store.ready']);
    // Deep verify learns the release, as for any release a package does not bundle.
    publishVw(emu, BUNDLED);
    const outcome = await store.ensureRelease({key: key(BUNDLED), trigger: 'unknown-build'});
    expect(outcome).toMatchObject({ok: true, refs: [{source: 'deep-verify'}]});
  });

  it('reports a trust store that failed to start (R5)', async () => {
    const kv = memoryKv();
    const github = createGitHubClient({fetch: createFakeFetch().fetch, now: () => 0, kv});
    const {store, env} = setup({
      kv,
      github: {...github, load: () => Promise.reject(new Error('broken'))},
    });
    expect(await store.ready()).toMatchObject({ready: true, loaded: false});
    expect(env.logs).toContain('trust.store.init-failed');
  });

  it('after a failed start (R5) a deep verify fails as transient and writes over no pin, release or job list', async () => {
    // Memory holds none of the stored pins, cores and disputes then: a job that ran would pin a
    // release again as if first seen and store a record without them.
    const kv = memoryKv();
    const db = memoryExtensionDb();
    const first = setup({kv, db});
    publishVw(first.emu, NEW);
    expect((await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
    const pins = kv.data.get(LOCAL_KEYS.pins);
    const releases = kv.data.get(LOCAL_KEYS.releases);
    const jobs = kv.data.get(LOCAL_KEYS.jobs);

    const fake = createFakeFetch();
    const github = createGitHubClient({fetch: fake.fetch, now: () => 0, kv});
    const second = setup({
      kv,
      db,
      fake,
      github: {...github, load: () => Promise.reject(new Error('broken'))},
    });
    publishVw(second.emu, '2026.11.1');
    const outcome = await second.store.ensureRelease({key: key('2026.11.1'), trigger: 'user'});
    expect(outcome).toEqual({
      ok: false,
      failure: 'network',
      transient: true,
      retryAt: second.clock.now() + RETRY_BASE_MS,
    });
    // A state, so the engine waits for the retry time.
    expect(second.store.releaseState(key('2026.11.1'))).toMatchObject({
      k: 'failed',
      failure: 'network',
      transient: true,
    });
    expect(fake.calls).toEqual([]);
    expect(kv.data.get(LOCAL_KEYS.pins)).toEqual(pins);
    expect(kv.data.get(LOCAL_KEYS.releases)).toEqual(releases);
    expect(await db.cores.keys()).toHaveLength(1);
    expect(kv.data.get(LOCAL_KEYS.jobs)).toEqual(jobs);
  });
});

describe('trust store: local deep verify', () => {
  it("stamps a done job's finishedAt after the release became known", async () => {
    // The blocked page takes a job finished before its incident for one that cannot have made the
    // build known. Writing the core and its refs takes time; finishedAt taken at the start of that
    // write would let a document denied meanwhile (NEW_BUILD) see a finished job "older" than
    // itself.
    const clock = manualClock();
    const inner = memoryKv();
    let knownAt: number | null = null;
    const kv: MemoryKv = {
      ...inner,
      set: async (k, v) => {
        if (k === LOCAL_KEYS.releases) {
          clock.advance(30);
          await inner.set(k, v);
          const ids = Object.keys((v as {cores?: Record<string, unknown>}).cores ?? {});
          if (knownAt === null && ids.some(id => id.includes(NEW))) knownAt = clock.now();
          return;
        }
        return inner.set(k, v);
      },
    };
    const s = setup({kv, clock});
    publishVw(s.emu, NEW);
    expect((await s.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(true);
    const done = (await s.store.listJobs()).find(j => j.phase === 'done');
    expect(knownAt).not.toBeNull();
    expect(done?.finishedAt).toBeGreaterThanOrEqual(knownAt!);
  });

  it('builds an unknown release from GitHub, stores it and announces it', async () => {
    const {emu, db, store, env} = setup();
    const a = publishVw(emu, NEW);
    const outcome = await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ref = outcome.refs[0]!;
    expect(ref).toMatchObject({
      buildId: `vaultwarden-web@${NEW}+release`,
      source: 'deep-verify',
      status: 'current',
    });
    expect(env.known).toEqual([[ref]]);
    expect(store.releaseState(key(NEW))).toEqual({k: 'known', refs: [ref]});
    expect((await db.cores.get(ref.sha256))?.buildId).toBe(ref.buildId);
    const loaded = await getCore(store, key(NEW));
    expect(loaded?.core.source).toMatchObject({
      commit: idsFor(NEW).commit,
      tag_object: idsFor(NEW).tagObject,
    });
    expect(
      (await store.candidates({app: 'vaultwarden-web', variant: 'release'}))[0]?.ref.version,
    ).toBe(NEW);

    // The TOFU pin of the tarball, recorded before the download.
    const local = (await store.pins()).pins.filter(p => p.source === 'local');
    expect(local.map(p => (p.kind === 'release-asset' ? [p.asset, p.sha256] : null))).toEqual([
      [a.asset, sha256(a.tarball)],
    ]);
    const jobs = await store.listJobs();
    expect(jobs[0]).toMatchObject({phase: 'done', trigger: 'unknown-build', variant: 'release'});
    const phases = env.published.map(v => v.phase).filter((p, i, all) => all[i - 1] !== p);
    expect(phases).toEqual([
      'queued',
      'resolving',
      'downloading',
      'verifying',
      'building',
      'storing',
      'done',
    ]);
  });

  it('shares one job between concurrent requests for the same asset', async () => {
    const {emu, store} = setup();
    publishVw(emu, NEW);
    const [x, y] = await Promise.all([
      store.ensureRelease({key: key(NEW), trigger: 'unknown-build'}),
      store.ensureRelease({key: key(NEW), trigger: 'unknown-build'}),
    ]);
    expect(x.ok && y.ok).toBe(true);
    expect(emu.counts.download).toBe(1); // the tarball, once
    expect((await store.listJobs()).filter(j => j.phase === 'done')).toHaveLength(1);
  });

  it('reports working while the job runs', async () => {
    const {emu, store} = setup();
    publishVw(emu, NEW);
    await store.ready();
    const pending = store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    for (let i = 0; i < 5 && store.releaseState(key(NEW)).k === 'unknown'; i++)
      await Promise.resolve();
    expect(store.releaseState(key(NEW))).toMatchObject({k: 'working', phase: 'queued'});
    await pending;
    expect(store.releaseState(key(NEW)).k).toBe('known');
  });

  it('reloads deep-verified cores after a restart, re-verifying their bytes', async () => {
    const first = setup();
    publishVw(first.emu, NEW);
    await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    const second = setup({kv: first.kv, db: first.db});
    await second.store.ready();
    expect(second.store.releaseState(key(NEW)).k).toBe('known');
    expect((await getCore(second.store, key(NEW)))?.ref.source).toBe('deep-verify');

    // Bytes changed at rest: the core is dropped and the release becomes unknown again.
    const ref = (await second.store.listCores()).find(r => r.version === NEW)!;
    const record = (await first.db.cores.get(ref.sha256))!;
    const bytes = record.bytes.slice();
    flip(bytes, 10, 1);
    await first.db.cores.put(ref.sha256, {...record, bytes});
    const third = setup({kv: first.kv, db: first.db});
    expect(await getCore(third.store, key(NEW))).toBeNull();
    expect(third.store.releaseState(key(NEW))).toEqual({k: 'unknown'});
  });

  it('keeps a core whose read from IndexedDB failed: the next start loads it', async () => {
    // A rejected read says nothing about the stored bytes. Forgetting the release would cost a
    // new download, GitHub requests and a deep-verify budget slot.
    const first = setup();
    publishVw(first.emu, NEW);
    await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    const stored = first.kv.data.get(LOCAL_KEYS.releases);
    const unreadable: MemoryDb = {
      cores: {...first.db.cores, get: () => Promise.reject(new Error('UnknownError'))},
    };
    const second = setup({kv: first.kv, db: unreadable});
    expect(await getCore(second.store, key(NEW))).toBeNull();
    expect(
      (await second.store.candidates({app: 'vaultwarden-web', variant: 'release'})).map(
        c => c.ref.version,
      ),
    ).toEqual([BUNDLED]);
    expect(second.env.logs).toContain('trust.cores.read-failed');
    expect(second.store.releaseState(key(NEW)).k).toBe('known');
    expect(first.kv.data.get(LOCAL_KEYS.releases)).toEqual(stored);

    const third = setup({kv: first.kv, db: first.db});
    expect((await getCore(third.store, key(NEW)))?.ref.source).toBe('deep-verify');
    expect(third.fake.calls).toEqual([]);
  });

  it('answers a user request for a known release at once, without GitHub', async () => {
    const {fake, store} = setup();
    const outcome = await store.ensureRelease({key: key(BUNDLED), trigger: 'user'});
    expect(outcome).toMatchObject({ok: true, refs: [{source: 'bundled'}]});
    expect(fake.calls).toEqual([]);
    expect(await store.listJobs()).toEqual([]);
  });

  it('refuses builder output with a wrong identity or content address and writes nothing', async () => {
    // The store's check is the only check of a built core (the job does not repeat it).
    const built = (await setup().store.listCores())[0]!;
    const bytes = pkg.files.get(`data/bootstrap/cores/${built.sha256}.json`)!;
    for (const core of [
      {sha256: 'e'.repeat(64), bytes}, // wrong content address
      {sha256: built.sha256, bytes}, // the bundled release's core, asked for another release
    ]) {
      const jobHost: JobHost = {run: async () => ({ok: true, core, configs: []})};
      const {emu, db, store, env} = setup({jobHost});
      publishVw(emu, NEW);
      expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toMatchObject({
        ok: false,
        failure: 'build-refused',
        detail: 'invalid-core',
      });
      expect(await db.cores.keys()).toEqual([]);
      expect(env.known).toEqual([]);
    }
  });
});

describe('trust store: cores built by other builder code', () => {
  it('keeps local cores across restarts and updates with the same builder fingerprint', async () => {
    const first = setup({fingerprint: 'f1'});
    publishVw(first.emu, NEW);
    const outcome = await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    expect(outcome.ok).toBe(true);
    const sha = outcome.ok ? outcome.refs[0]!.sha256 : '';
    expect(first.kv.data.get(LOCAL_KEYS.releases)).toMatchObject({builder: 'f1'});

    // The store never reads the extension version: an update that leaves the builder code alone
    // brings the same fingerprint.
    const updated = setup({kv: first.kv, db: first.db, fingerprint: 'f1'});
    await updated.store.ready();
    expect(updated.store.releaseState(key(NEW))).toMatchObject({
      k: 'known',
      refs: [{source: 'deep-verify', sha256: sha}],
    });
    expect((await getCore(updated.store, key(NEW)))?.ref.sha256).toBe(sha);
    expect(await first.db.cores.keys()).toEqual([sha]);
    expect(updated.fake.calls).toEqual([]);
  });

  it('keeps them over an extension update in the wiring of trust/index.ts', async () => {
    const fake = createFakeFetch();
    const emu = createGitHubEmulator(fake);
    const db = memoryExtensionDb();
    const local = createFakeEnv().local;
    const open = (version: string) => {
      const env = createFakeEnv({local});
      env.ext.runtime.getManifest = () => ({version, manifest_version: 3});
      return createTrustStore({
        ext: env.ext,
        db,
        builder: createCoreBuilder(),
        fetch: fake.fetch,
        now: () => Date.UTC(2026, 10, 15),
      });
    };
    const first = open('0.1.0');
    publishVw(emu, NEW);
    expect((await first.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(true);
    const updated = open('0.2.0');
    await updated.ready();
    expect(updated.releaseState(key(NEW))).toMatchObject({
      k: 'known',
      refs: [{source: 'deep-verify'}],
    });
  });

  it('drops local cores (not the pins) when the builder fingerprint changes', async () => {
    const first = setup({fingerprint: 'f1'});
    publishVw(first.emu, NEW);
    expect((await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
    const updated = setup({kv: first.kv, db: first.db, fingerprint: 'f2'});
    await updated.store.ready();
    expect(updated.store.releaseState(key(NEW))).toEqual({k: 'unknown'});
    expect(updated.store.releaseState(key(BUNDLED)).k).toBe('known');
    expect(await first.db.cores.keys()).toEqual([]);
    expect(first.kv.data.get(LOCAL_KEYS.releases)).toMatchObject({builder: 'f2'});
    // The local pins stay: a rebuild must still match what this browser saw first.
    expect((await updated.store.pins()).pins.filter(p => p.source === 'local')).toHaveLength(1);
    publishVw(updated.emu, NEW);
    expect((await updated.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
  });

  it('forgets stored failures (not disputes) when the builder fingerprint changes', async () => {
    // A refusal is the verdict of the builder code that gave it: other code must try again at
    // once, not after the refusal's day has passed.
    const kv = memoryKv();
    const db = memoryExtensionDb();
    const first = setup({kv, db, fingerprint: 'f1'});
    // A release the builder refuses: its archive is not a gzip stream.
    const broken = vwAssets(NEW);
    const junk = new Uint8Array(4096).fill(0x41);
    first.emu.addRelease({
      repoId: VW_REPO_ID,
      repo: VW_REPO,
      tag: broken.tag,
      assets: [{name: broken.asset, bytes: junk}],
    });
    first.emu.setTag(VW_REPO, VW_REPO_ID, broken.tag, idsFor(NEW));
    const refused = await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    expect(refused).toMatchObject({ok: false, failure: 'build-refused', transient: false});
    // And a disputed one: the tag of a pinned release moved (its first download was other bytes).
    const pinned = publishVw(first.emu, '2026.11.1');
    first.emu.serveInstead(VW_REPO, pinned.tag, pinned.asset, junk);
    expect(
      (await first.store.ensureRelease({key: key('2026.11.1'), trigger: 'unknown-build'})).ok,
    ).toBe(false);
    first.emu.setTag(VW_REPO, VW_REPO_ID, 'v2026.11.1', {commit: 'c'.repeat(40)});
    expect(await first.store.ensureRelease({key: key('2026.11.1'), trigger: 'user'})).toMatchObject(
      {failure: 'disputed'},
    );

    // The same builder code keeps the refusal and asks GitHub nothing.
    const {fake, emu} = first;
    const requests = fake.calls.length;
    const same = setup({kv, db, fake, emu, fingerprint: 'f1'});
    await same.store.ready();
    expect(same.store.releaseState(key(NEW))).toMatchObject({
      k: 'failed',
      failure: 'build-refused',
    });
    expect(await same.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toMatchObject(
      {ok: false, failure: 'build-refused'},
    );
    expect(fake.calls.length).toBe(requests);

    // Other builder code starts again; the dispute stays.
    const updated = setup({kv, db, fake, emu, fingerprint: 'f2'});
    await updated.store.ready();
    expect(updated.store.releaseState(key(NEW))).toEqual({k: 'unknown'});
    expect(updated.store.releaseState(key('2026.11.1'))).toMatchObject({k: 'disputed'});
    const states = (kv.data.get(LOCAL_KEYS.releases) as {states: Record<string, {k: string}>})
      .states;
    expect(Object.values(states).map(s => s.k)).toEqual(['disputed']);
    // The release is downloaded and built again (in this test by the same code, which refuses).
    const downloads = emu.counts.download;
    expect(
      await updated.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'}),
    ).toMatchObject({ok: false, failure: 'build-refused'});
    expect(emu.counts.download).toBe(downloads + 1);
  });

  it('drops local cores persisted without a builder fingerprint (by earlier code)', async () => {
    const first = setup();
    publishVw(first.emu, NEW);
    expect((await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
    // The earlier layout recorded the extension version instead.
    const earlier = {...(first.kv.data.get(LOCAL_KEYS.releases) as Record<string, unknown>)};
    delete earlier['builder'];
    earlier['version'] = '0.1.0';
    first.kv.data.set(LOCAL_KEYS.releases, earlier);
    const second = setup({kv: first.kv, db: first.db});
    await second.store.ready();
    expect(second.store.releaseState(key(NEW))).toEqual({k: 'unknown'});
    expect(await first.db.cores.keys()).toEqual([]);
    expect(first.kv.data.get(LOCAL_KEYS.releases)).toMatchObject({builder: 'f1'});
  });
});

describe('trust store: pins and disputes', () => {
  it('disputes a moved tag, keeps the dispute sticky and stops contacting GitHub', async () => {
    const {emu, fake, store, env} = setup();
    const a = publishVw(emu, NEW);
    // The first download is other bytes: the release is pinned, not known.
    emu.serveInstead(VW_REPO, a.tag, a.asset, new Uint8Array(a.tarball.length));
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(false);
    emu.setTag(VW_REPO, VW_REPO_ID, `v${NEW}`, {
      commit: 'c'.repeat(40),
      tagObject: idsFor(NEW).tagObject,
    });
    const outcome = await store.ensureRelease({key: key(NEW), trigger: 'user'});
    // The evidence (recorded tag commit, the one GitHub reports now) is kept for the details page.
    const evidence = {recorded: idsFor(NEW).commit, observed: 'c'.repeat(40)};
    expect(outcome).toEqual({
      ok: false,
      failure: 'disputed',
      transient: false,
      retryAt: null,
      dispute: 'tag-moved',
    });
    expect(env.disputed).toEqual([[key(NEW), 'tag-moved']]);
    expect(store.releaseState(key(NEW))).toMatchObject({
      k: 'disputed',
      reason: 'tag-moved',
      evidence,
    });
    const calls = fake.calls.length;
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(false);
    expect((await store.ensureRelease({key: key(NEW), trigger: 'user'})).ok).toBe(false);
    expect(fake.calls.length).toBe(calls);
  });

  it('shows the two tag objects when a tag was re-created on the same commit', async () => {
    // The two commits are equal then: shown as recorded and observed, they would say nothing.
    const {emu, store} = setup();
    const a = publishVw(emu, NEW);
    emu.serveInstead(VW_REPO, a.tag, a.asset, new Uint8Array(a.tarball.length));
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(false);
    const recreated = 'd'.repeat(40);
    emu.setTag(VW_REPO, VW_REPO_ID, `v${NEW}`, {commit: idsFor(NEW).commit, tagObject: recreated});
    expect(await store.ensureRelease({key: key(NEW), trigger: 'user'})).toMatchObject({
      ok: false,
      failure: 'disputed',
      dispute: 'tag-moved',
    });
    expect(store.releaseState(key(NEW))).toMatchObject({
      k: 'disputed',
      reason: 'tag-moved',
      evidence: {recorded: idsFor(NEW).tagObject, observed: recreated},
    });
  });

  it('disputes a re-uploaded asset (digest differs from the local pin)', async () => {
    const {emu, store} = setup();
    const a = publishVw(emu, NEW);
    emu.serveInstead(VW_REPO, a.tag, a.asset, new Uint8Array(a.tarball.length));
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(false);
    const other = vwAssets(NEW);
    const changed = other.tarball.slice();
    flip(changed, 20, 1); // inside the gzip header mtime: still a different digest
    emu.addRelease({
      repoId: VW_REPO_ID,
      repo: VW_REPO,
      tag: `v${NEW}`,
      assets: [{name: other.asset, bytes: changed}],
    });
    const outcome = await store.ensureRelease({key: key(NEW), trigger: 'user'});
    expect(outcome).toMatchObject({ok: false, failure: 'disputed', dispute: 'pin-changed'});
  });

  it('a rejected pin write does not lose the pin: the retry persists it and a re-upload is disputed', async () => {
    // One rejected write must not poison the pin write chain while the pin is already in memory;
    // the retry would then become known with no persisted first-sight pin.
    const inner = memoryKv();
    let failNext = true;
    const kv: MemoryKv = {
      ...inner,
      set: async (k, v) => {
        if (k === LOCAL_KEYS.pins && failNext) {
          failNext = false;
          throw new Error('QuotaExceededError');
        }
        return inner.set(k, v);
      },
    };
    const first = setup({kv});
    const a = publishVw(first.emu, NEW);
    let outcome = await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    for (let i = 0; i < 3 && !outcome.ok; i++) {
      first.clock.advance(60 * 60_000);
      outcome = await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    }
    expect(outcome.ok).toBe(true);
    const persisted = inner.data.get(LOCAL_KEYS.pins) as {pins: {asset?: string}[]};
    expect(persisted.pins.map(p => p.asset)).toEqual([a.asset]);

    // An update drops the local core; GitHub now lists other bytes for the same tag and asset.
    const second = setup({kv, db: first.db, fingerprint: 'f2'});
    const changed = a.tarball.slice();
    flip(changed, 20, 1);
    second.emu.addRelease({
      repoId: VW_REPO_ID,
      repo: VW_REPO,
      tag: a.tag,
      assets: [{name: a.asset, bytes: changed}],
    });
    second.emu.setTag(VW_REPO, VW_REPO_ID, a.tag, idsFor(NEW));
    expect(await second.store.ensureRelease({key: key(NEW), trigger: 'user'})).toMatchObject({
      ok: false,
      failure: 'disputed',
      dispute: 'pin-changed',
    });
  });

  it('a rejected read of the local pins at start-up neither erases them nor lets a pinned release look new', async () => {
    // A failed read leaves memory empty: a pin write then would store only the new pins, and after
    // an update a re-upload of the first release would be accepted, not disputed.
    const kv = memoryKv();
    const db = memoryExtensionDb();
    const first = setup({kv, db, fingerprint: 'f1'});
    const a = publishVw(first.emu, NEW);
    expect((await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
    // Two: start-up retries one failed read.
    let failReads = 2;
    const flaky: MemoryKv = {
      ...kv,
      get: async k => {
        if (k === LOCAL_KEYS.pins && failReads > 0) {
          failReads--;
          throw new Error('read failed');
        }
        return kv.get(k);
      },
    };
    const second = setup({kv: flaky, db, fingerprint: 'f1'});
    publishVw(second.emu, '2026.11.1');
    expect(
      (await second.store.ensureRelease({key: key('2026.11.1'), trigger: 'unknown-build'})).ok,
    ).toBe(true);
    const tags = (kv.data.get(LOCAL_KEYS.pins) as {pins: {tag: string}[]}).pins.map(p => p.tag);
    expect(tags).toEqual(expect.arrayContaining([a.tag, 'v2026.11.1']));
    // An update drops the local core; GitHub now lists other bytes for the first release.
    const third = setup({kv, db, fingerprint: 'f2'});
    await third.store.ready();
    const changed = a.tarball.slice();
    flip(changed, 20, 1);
    third.emu.addRelease({
      repoId: VW_REPO_ID,
      repo: VW_REPO,
      tag: a.tag,
      assets: [{name: a.asset, bytes: changed}],
    });
    third.emu.setTag(VW_REPO, VW_REPO_ID, a.tag, idsFor(NEW));
    expect(await third.store.ensureRelease({key: key(NEW), trigger: 'user'})).toMatchObject({
      ok: false,
      failure: 'disputed',
      dispute: 'pin-changed',
    });
  });

  it('while the local pins cannot be read, a deep verify fails as transient and writes no pin', async () => {
    const kv = memoryKv();
    const flaky: MemoryKv = {
      ...kv,
      get: async k => {
        if (k === LOCAL_KEYS.pins) throw new Error('read failed');
        return kv.get(k);
      },
    };
    const s = setup({kv: flaky});
    publishVw(s.emu, NEW);
    expect(await s.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toMatchObject({
      ok: false,
      transient: true,
    });
    expect(kv.data.has(LOCAL_KEYS.pins)).toBe(false);
  });

  it('a release record that cannot be read at start-up is never written over: a dispute survives', async () => {
    // A start-up write after a failed read would erase the stored disputes.
    const kv = memoryKv();
    const db = memoryExtensionDb();
    const first = setup({kv, db});
    const a = publishVw(first.emu, NEW);
    first.emu.serveInstead(VW_REPO, a.tag, a.asset, new Uint8Array(a.tarball.length));
    expect((await first.store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(
      false,
    );
    first.emu.setTag(VW_REPO, VW_REPO_ID, a.tag, {commit: 'c'.repeat(40)});
    expect(await first.store.ensureRelease({key: key(NEW), trigger: 'user'})).toMatchObject({
      failure: 'disputed',
      dispute: 'tag-moved',
    });
    const stored = kv.data.get(LOCAL_KEYS.releases);
    let failures = 2;
    const flaky: MemoryKv = {
      ...kv,
      get: async k => {
        if (k === LOCAL_KEYS.releases && failures-- > 0) throw new Error('read failed');
        return kv.get(k);
      },
    };
    const second = setup({kv: flaky, db});
    await second.store.ready();
    expect(second.env.logs).toContain('trust.store.releases-unread');
    expect(kv.data.get(LOCAL_KEYS.releases)).toEqual(stored);
    const third = setup({kv, db});
    await third.store.ready();
    expect(third.store.releaseState(key(NEW))).toMatchObject({k: 'disputed'});
  });

  it('records the pin before downloading, so a digest mismatch leaves GitHub’s digest pinned', async () => {
    const {emu, store, db} = setup();
    const a = publishVw(emu, NEW);
    const tampered = a.tarball.slice();
    flip(tampered, tampered.length - 20, 0xff);
    emu.serveInstead(VW_REPO, `v${NEW}`, a.asset, tampered);
    const outcome = await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    expect(outcome).toMatchObject({ok: false, failure: 'digest-mismatch', transient: false});
    expect(store.releaseState(key(NEW))).toMatchObject({k: 'failed', failure: 'digest-mismatch'});
    expect(await db.cores.keys()).toEqual([]);
    const pin = (await store.pins()).pins.find(
      p => p.kind === 'release-asset' && p.asset === a.asset,
    );
    expect(pin).toMatchObject({source: 'local', sha256: sha256(a.tarball)});
  });
});

describe('trust store: failures and back-off', () => {
  it('maps a missing release, an image-only release and a missing digest to permanent failures', async () => {
    const {emu, store} = setup();
    expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toEqual({
      ok: false,
      failure: 'release-not-found',
      transient: false,
      retryAt: null,
    });
    publishVw(emu, '2026.8.0', {tarball: false});
    expect(
      await store.ensureRelease({key: key('2026.8.0'), trigger: 'unknown-build'}),
    ).toMatchObject({
      ok: false,
      failure: 'image-only-release',
    });
    publishVw(emu, '2026.7.0', {digest: null});
    expect(
      await store.ensureRelease({key: key('2026.7.0'), trigger: 'unknown-build'}),
    ).toMatchObject({
      ok: false,
      failure: 'digest-unavailable',
    });
    expect(store.releaseState(key('2026.8.0'))).toMatchObject({
      k: 'failed',
      failure: 'image-only-release',
    });
  });

  it('caches a permanent failure, then forgets it after its TTL', async () => {
    const {emu, clock, store} = setup();
    await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    const api = emu.counts.api;
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(false);
    expect(emu.counts.api).toBe(api);
    clock.advance(NOT_FOUND_TTL_MS + 1);
    expect(store.releaseState(key(NEW))).toEqual({k: 'unknown'});
    publishVw(emu, NEW);
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(true);
  });

  it('a user-started deep verify ignores a cached permanent failure', async () => {
    const {emu, store} = setup();
    await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    publishVw(emu, NEW);
    expect((await store.ensureRelease({key: key(NEW), trigger: 'user'})).ok).toBe(true);
  });

  it('waits for the GitHub rate-limit reset and then retries', async () => {
    const {emu, clock, store} = setup();
    publishVw(emu, NEW);
    const reset = Math.floor(clock.now() / 1000) + 900;
    emu.rateLimit(reset);
    const first = await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    expect(first).toEqual({
      ok: false,
      failure: 'rate-limited',
      transient: true,
      retryAt: reset * 1000 + 1000,
    });
    expect(store.releaseState(key(NEW))).toMatchObject({
      k: 'failed',
      failure: 'rate-limited',
      transient: true,
    });
    expect(store.snapshot().githubBackoffUntil).toBe(reset * 1000 + 1000);
    const api = emu.counts.api;
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(false);
    expect((await store.ensureRelease({key: key(NEW), trigger: 'user'})).ok).toBe(false);
    expect(emu.counts.api).toBe(api);
    emu.rateLimit(null);
    clock.advance(901_000);
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(true);
  });

  it('does not download when the last API answer used up the rate limit', async () => {
    const fake = createFakeFetch();
    const clock = manualClock();
    const kv = memoryKv();
    const real = createGitHubClient({fetch: fake.fetch, now: clock.now, kv});
    const reset = clock.now() + 900_000;
    let exhausted = false;
    const github: GitHubClient = {
      ...real,
      getTagRef: async (...args) => {
        const r = await real.getTagRef(...args);
        exhausted = true;
        return r;
      },
      backoffUntil: () => (exhausted ? reset : real.backoffUntil()),
    };
    const {emu, store} = setup({fake, clock, kv, github});
    publishVw(emu, NEW);
    expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toEqual({
      ok: false,
      failure: 'rate-limited',
      transient: true,
      retryAt: reset,
    });
    expect(emu.counts.download).toBe(0);
  });

  it('backs off exponentially after network failures', async () => {
    const fake = createFakeFetch(); // no emulator: every request fails
    const {clock, store} = setup({fake, emu: {} as GitHubEmulator});
    const t0 = clock.now();
    expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toEqual({
      ok: false,
      failure: 'network',
      transient: true,
      retryAt: t0 + RETRY_BASE_MS,
    });
    const calls = fake.calls.length;
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(false);
    expect(fake.calls.length).toBe(calls);
    clock.advance(RETRY_BASE_MS);
    const second = await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    expect(second).toMatchObject({
      failure: 'network',
      retryAt: t0 + RETRY_BASE_MS + 2 * RETRY_BASE_MS,
    });
  });

  it('refuses an oversized asset as a builder refusal', async () => {
    const {emu, store} = setup({limits: {maxAssetBytes: 100}});
    publishVw(emu, NEW);
    expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toMatchObject({
      ok: false,
      failure: 'build-refused',
      detail: 'size-mismatch',
    });
    expect(emu.counts.download).toBe(0);
  });

  it('refuses a corrupt archive (correct digest) as a builder refusal', async () => {
    const {emu, store} = setup();
    const a = vwAssets(NEW);
    const corrupt = a.tarball.slice(0, a.tarball.length - 100);
    emu.addRelease({
      repoId: VW_REPO_ID,
      repo: VW_REPO,
      tag: a.tag,
      assets: [{name: a.asset, bytes: corrupt}],
    });
    emu.setTag(VW_REPO, VW_REPO_ID, a.tag, idsFor(NEW));
    expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toMatchObject({
      ok: false,
      failure: 'build-refused',
      detail: 'archive-invalid',
    });
  });

  it('refuses a release whose repository answers under another name', async () => {
    const {emu, store} = setup();
    const a = vwAssets(NEW);
    emu.addRelease({
      repoId: VW_REPO_ID,
      repo: VW_REPO,
      downloadRepo: 'someone/else',
      tag: a.tag,
      assets: [{name: a.asset, bytes: a.tarball}],
    });
    expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toMatchObject({
      ok: false,
      failure: 'release-not-found',
    });
    expect(emu.counts.download).toBe(0);
  });

  it('reports a missing GitHub permission until it is granted', async () => {
    const {emu, store, env, clock} = setup();
    publishVw(emu, NEW);
    env.permission = false;
    expect(await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).toMatchObject({
      ok: false,
      failure: 'permission-missing',
    });
    // Kept while it lasts (a page given up on keeps its "Proceed once"), retried after
    // PERMISSION_RETRY_MS (after a browser restart, a stale failure is tried again).
    clock.advance(PERMISSION_RETRY_MS + 1);
    expect(store.releaseState(key(NEW))).toEqual({
      k: 'failed',
      failure: 'permission-missing',
      transient: true,
      at: clock.now() - PERMISSION_RETRY_MS - 1,
      retryAt: clock.now() - 1,
    });
    env.permission = true;
    store.permissionsChanged();
    expect(store.releaseState(key(NEW))).toEqual({k: 'unknown'});
    expect((await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'})).ok).toBe(true);
  });

  it('refuses keys and plans the builder does not support', async () => {
    const {store} = setup();
    expect(
      await store.ensureRelease({
        key: {app: 'vaultwarden-web', variant: 'release', version: '1.2'},
        trigger: 'user',
      }),
    ).toMatchObject({ok: false, failure: 'build-refused', detail: 'unsupported'});
    expect(
      await store.ensureRelease({
        key: {app: 'vaultwarden-web', variant: 'cloud-us', version: NEW},
        trigger: 'user',
      }),
    ).toMatchObject({ok: false, failure: 'build-refused', detail: 'unsupported'});
  });
});

describe('trust store: persistence', () => {
  it('lists a job a restart cut off as failed and does not resume it', async () => {
    const fake = createFakeFetch();
    const emu = createGitHubEmulator(fake);
    publishVw(emu, NEW);
    const clock = manualClock();
    const kv = memoryKv({
      [LOCAL_KEYS.jobs]: [
        {
          jobId: 'aaaaaaaaaaaaaaaa',
          app: 'vaultwarden-web',
          version: NEW,
          assetName: `bw_web_v${NEW}.tar.gz`,
          variant: 'release',
          trigger: 'unknown-build',
          phase: 'downloading',
          startedAt: clock.now() - 1000,
        },
      ],
    });
    const {store, env} = setup({fake, emu, kv, clock});
    await store.ready();
    expect(await store.listJobs()).toEqual([
      expect.objectContaining({
        jobId: 'aaaaaaaaaaaaaaaa',
        phase: 'failed',
        failure: 'network',
        finishedAt: clock.now(),
      }),
    ]);
    expect((kv.data.get(LOCAL_KEYS.jobs) as DeepVerifyJobView[])[0]?.phase).toBe('failed');
    expect(fake.calls).toHaveLength(0); // start-up makes no request
    expect(env.known).toEqual([]);
    expect(store.releaseState(key(NEW))).toEqual({k: 'unknown'});
  });

  it('ignores malformed persisted state and lets the bundle win over a local build', async () => {
    const kv = memoryKv({
      [LOCAL_KEYS.releases]: {
        cores: {
          junk: {buildId: 'junk'},
          [`vaultwarden-web@${BUNDLED}+release`]: {
            buildId: `vaultwarden-web@${BUNDLED}+release`,
            app: 'vaultwarden-web',
            variant: 'release',
            version: BUNDLED,
            assurance: 'release-exact',
            sha256: 'b'.repeat(64),
            size: 10,
            source: 'deep-verify',
            addedAt: 1,
            status: 'current',
          },
        },
        states: {x: 'nope', [`vaultwarden-web@${NEW}+release`]: {k: 'failed', failure: 'bogus'}},
      },
      [LOCAL_KEYS.jobs]: [{jobId: 'zz'}],
      [LOCAL_KEYS.pins]: 'garbage',
      [LOCAL_KEYS.github]: {v: 1, backoffUntil: 'soon'},
    });
    const {store} = setup({kv});
    await store.ready();
    const state = store.releaseState(key(BUNDLED));
    expect(state.k === 'known' && state.refs[0]!.source).toBe('bundled');
    expect(store.releaseState(key(NEW))).toEqual({k: 'unknown'});
    expect(await store.listJobs()).toEqual([]);
    expect(store.snapshot().githubBackoffUntil).toBeNull();
  });

  it('persists failures and disputes but not working states', async () => {
    const {emu, kv, store} = setup();
    await store.ensureRelease({key: key(NEW), trigger: 'unknown-build'});
    const persisted = kv.data.get(LOCAL_KEYS.releases) as {states: Record<string, {k: string}>};
    expect(persisted.states[`vaultwarden-web@${NEW}+release`]).toMatchObject({k: 'failed'});
    publishVw(emu, '2026.12.0');
    const pending = store.ensureRelease({key: key('2026.12.0'), trigger: 'unknown-build'});
    const during = kv.data.get(LOCAL_KEYS.releases) as {states: Record<string, {k: string}>};
    expect(during.states[`vaultwarden-web@2026.12.0+release`]).toBeUndefined();
    await pending;
  });
});
