/**
 * Test world for the engine and backend tests: synthetic cores, a protected Vaultwarden instance on
 * loopback, a controllable trust store and registry, recording UI sinks, and an engine wired to a
 * backend on the fake Ext.
 */

import {createHash} from 'node:crypto';
import {utf8} from '@intactwarden/core/hash/sha256.ts';
import {fileIndexOf} from '@intactwarden/core/routing/fileIndex.ts';
import type {CoreManifest, FileEntry} from '@intactwarden/core/schema/manifest.ts';
import {bitwardenWeb, vaultwardenWeb} from '@intactwarden/profiles';
import {createFirefoxBackend} from '../../../src/backends/firefox/index.ts';
import type {ObservingBackend} from '../../../src/backends/types.ts';
import {
  buildIdOf,
  type AlertSink,
  type CoreRef,
  type DeepVerifyJobView,
  type DisputeReason,
  type EnsureReleaseOutcome,
  type EnsureReleaseRequest,
  type HintResult,
  type InstanceRecord,
  type LoadedCore,
  type ProfileRegistry,
  type ProtectedOrigin,
  type ProtectedOrigins,
  type RedAlertEvent,
  type ReleaseKey,
  type ReleaseState,
  type TabStateRecord,
  type TabStateSink,
  type TrustSnapshot,
  type TrustStore,
} from '../../../src/contracts.ts';
import {AlertBook} from '../../../src/engine/alerts.ts';
import {createEngine} from '../../../src/engine/index.ts';
import type {EngineRuntime} from '../../../src/engine/types.ts';
import {createLocalStore, createSessionStore} from '../../../src/platform/storage.ts';
import {createFakeEnv, FakeTimers, type FakeArea, type FakeEnv} from './fakeExt.ts';

export const VW_ORIGIN = 'http://127.0.0.1:8080';

/** WebCrypto's digest, bound before any test replaces it with a spy (see `settle`). */
const REAL_DIGEST = crypto.subtle.digest.bind(crypto.subtle);

export const bytes = (s: string): Uint8Array => utf8(s);
export const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** A synthetic Vaultwarden (vaultwarden-rocket) release core. */
export function vwCore(
  version: string,
  files: Record<string, Uint8Array>,
  opts: {variant?: string} = {},
): LoadedCore {
  const variant = (opts.variant ?? 'release') as ReleaseKey['variant'];
  const entries: Record<string, FileEntry> = {};
  for (const [path, b] of Object.entries(files)) {
    const cls = path.endsWith('.html')
      ? 'document'
      : path.endsWith('.js')
        ? 'script'
        : path.endsWith('.css')
          ? 'style'
          : path.endsWith('.wasm')
            ? 'wasm'
            : 'data';
    entries[path] = {sha256: sha(b), size: b.length, class: cls};
  }
  const buildId = buildIdOf({app: 'vaultwarden-web', variant, version});
  const core: CoreManifest = {
    schema: 'intactwarden.manifest/1',
    build_id: buildId,
    app: 'vaultwarden-web',
    variant,
    version: {label: version},
    source: {
      repo: 'https://github.com/dani-garcia/bw_web_builds',
      repo_id: 1,
      tag: `v${version}`,
      commit: 'a'.repeat(40),
    },
    artifact: {
      kind: 'github-release-asset',
      name: `bw_web_v${version}.tar.gz`,
      sha256: 'b'.repeat(64),
    },
    routing: {hosting: 'vaultwarden-rocket', base_path: '/', index: '/index.html'},
    files: entries,
  };
  const ref: CoreRef = {
    buildId,
    app: 'vaultwarden-web',
    variant,
    version,
    assurance: 'release-exact',
    sha256: sha(utf8(JSON.stringify(core))),
    size: 1000,
    source: 'bundled',
    addedAt: 0,
    status: 'current',
  };
  return {ref, core, fileIndex: fileIndexOf(core.files)};
}

export const BW_ORIGIN = 'http://127.0.0.1:8081';

/** A file of a synthetic Bitwarden core. */
export interface BwFile {
  readonly bytes: Uint8Array;
}

/**
 * A synthetic Bitwarden self-hosted (bitwarden-selfhost) release core; a `/404.html` among the
 * files is the core's `not_found` document.
 */
export function bwSelfhostCore(version: string, files: Record<string, BwFile>): LoadedCore {
  const variant = 'selfhosted-commercial';
  const entries: Record<string, FileEntry> = {};
  for (const [path, f] of Object.entries(files)) {
    const cls = path.endsWith('.html')
      ? 'document'
      : path.endsWith('.js')
        ? 'script'
        : path.endsWith('.wasm')
          ? 'wasm'
          : 'data';
    entries[path] = {sha256: sha(f.bytes), size: f.bytes.length, class: cls};
  }
  const buildId = buildIdOf({app: 'bitwarden-web', variant, version});
  const core: CoreManifest = {
    schema: 'intactwarden.manifest/1',
    build_id: buildId,
    app: 'bitwarden-web',
    variant,
    version: {label: version},
    source: {
      repo: 'https://github.com/bitwarden/clients',
      repo_id: 2,
      tag: `web-v${version}`,
      commit: 'c'.repeat(40),
    },
    artifact: {
      kind: 'github-release-asset',
      name: `web-${version}-selfhosted-COMMERCIAL.zip`,
      sha256: 'd'.repeat(64),
    },
    routing: {
      hosting: 'bitwarden-selfhost',
      base_path: '/',
      index: '/index.html',
      ...('/404.html' in files ? {not_found: '/404.html'} : {}),
    },
    files: entries,
  };
  const ref: CoreRef = {
    buildId,
    app: 'bitwarden-web',
    variant,
    version,
    assurance: 'release-exact',
    sha256: sha(utf8(JSON.stringify(core))),
    size: 1000,
    source: 'bundled',
    addedAt: 0,
    status: 'current',
  };
  return {ref, core, fileIndex: fileIndexOf(core.files)};
}

/** A Bitwarden self-hosted instance on loopback (deployment `self-hosted`: the COMMERCIAL build). */
export function bwSelfhostOrigin(): ProtectedOrigin {
  const instance: InstanceRecord = {
    id: 'fedcba9876543210',
    app: 'bitwarden-web',
    origin: BW_ORIGIN,
    base_path: '/',
    added_at: 0,
  };
  const deployment = bitwardenWeb.deployments.find(d => d.kind === 'self-hosted')!;
  return {
    origin: BW_ORIGIN,
    app: 'bitwarden-web',
    profile: bitwardenWeb,
    deployment,
    basePath: '/',
    kind: 'instance',
    instance,
    granted: true,
  };
}

export function vwOrigin(granted = true): ProtectedOrigin {
  const instance: InstanceRecord = {
    id: '0123456789abcdef',
    app: 'vaultwarden-web',
    origin: VW_ORIGIN,
    base_path: '/',
    added_at: 0,
  };
  const deployment = vaultwardenWeb.deployments.find(d => d.kind === 'self-hosted')!;
  return {
    origin: VW_ORIGIN,
    app: 'vaultwarden-web',
    profile: vaultwardenWeb,
    deployment,
    basePath: '/',
    kind: 'instance',
    instance,
    granted,
  };
}

export function bwCloudOrigin(): ProtectedOrigin {
  const deployment = bitwardenWeb.deployments.find(d => d.id === 'cloud-us')!;
  return {
    origin: 'https://vault.bitwarden.com',
    app: 'bitwarden-web',
    profile: bitwardenWeb,
    deployment,
    basePath: '/',
    kind: 'official',
    instance: null,
    granted: true,
  };
}

export class FakeRegistry implements ProfileRegistry {
  origins: ProtectedOrigin[];
  hint: HintResult = {version: null, at: 0};
  hintCalls = 0;
  constructor(origins: ProtectedOrigin[]) {
    this.origins = origins;
  }
  async ready(): Promise<void> {}
  lookup(origin: string): ProtectedOrigin | null {
    return this.origins.find(o => o.origin === origin) ?? null;
  }
  protectedOrigins(): ProtectedOrigins {
    return {origins: this.origins};
  }
  instances(): readonly InstanceRecord[] {
    return this.origins.flatMap(o => (o.instance === null ? [] : [o.instance]));
  }
  async addInstance(): Promise<never> {
    throw new Error('not in tests');
  }
  async removeInstance(): Promise<void> {}
  async fetchHint(): Promise<HintResult> {
    this.hintCalls++;
    return this.hint;
  }
  async permissionStatus(): Promise<[]> {
    return [];
  }
  onChange(): () => void {
    return () => undefined;
  }
}

/** A trust store whose deep verify the test completes by hand. */
export class FakeTrust implements TrustStore {
  cores: LoadedCore[];
  readonly states = new Map<string, ReleaseState>();
  readonly ensured: ReleaseKey[] = [];
  readonly #waiters: {key: ReleaseKey; resolve: (o: EnsureReleaseOutcome) => void}[] = [];
  readonly #known = new Set<(refs: readonly CoreRef[]) => void>();
  constructor(cores: LoadedCore[]) {
    this.cores = cores;
  }
  async ready() {
    return this.snapshot();
  }
  snapshot(): TrustSnapshot {
    return {
      ready: true,
      loaded: true,
      githubBackoffUntil: null,
    };
  }
  async candidates(q: {app: string; variant: string}): Promise<readonly LoadedCore[]> {
    return this.cores.filter(c => c.ref.app === q.app && c.ref.variant === q.variant);
  }
  async getCoreBySha256(s: string) {
    return this.cores.find(c => c.ref.sha256 === s) ?? null;
  }
  releaseState(key: ReleaseKey): ReleaseState {
    const id = buildIdOf(key);
    const known = this.cores.filter(c => c.ref.buildId === id);
    if (known.length > 0) return {k: 'known', refs: known.map(c => c.ref)};
    return this.states.get(id) ?? {k: 'unknown'};
  }
  ensureRelease(req: EnsureReleaseRequest): Promise<EnsureReleaseOutcome> {
    this.ensured.push(req.key);
    this.states.set(buildIdOf(req.key), {
      k: 'working',
      jobId: 'job1',
      phase: 'downloading',
      since: 0,
    });
    return new Promise(resolve => this.#waiters.push({key: req.key, resolve}));
  }
  /** Completes the pending deep verify of `key` with these cores. */
  complete(key: ReleaseKey, cores: LoadedCore[]): void {
    this.cores.push(...cores);
    this.states.delete(buildIdOf(key));
    for (const w of this.#waiters.splice(0)) {
      if (buildIdOf(w.key) === buildIdOf(key)) w.resolve({ok: true, refs: cores.map(c => c.ref)});
      else this.#waiters.push(w);
    }
  }
  fail(
    key: ReleaseKey,
    failure: 'release-not-found' | 'image-only-release' | 'rate-limited',
  ): void {
    const transient = failure === 'rate-limited';
    this.states.set(buildIdOf(key), {k: 'failed', failure, transient, at: 0, retryAt: null});
    for (const w of this.#waiters.splice(0)) {
      w.resolve({ok: false, failure, transient, retryAt: null});
    }
  }
  onReleaseKnown(l: (refs: readonly CoreRef[]) => void) {
    this.#known.add(l);
    return () => this.#known.delete(l);
  }
  onReleaseDisputed(_l: (key: ReleaseKey, reason: DisputeReason) => void) {
    return () => undefined;
  }
  async listCores() {
    return this.cores.map(c => c.ref);
  }
  /** Deep-verify jobs as the store lists them (newest first); tests set them. */
  jobs: DeepVerifyJobView[] = [];
  async listJobs(): Promise<readonly DeepVerifyJobView[]> {
    return [...this.jobs];
  }
  async pins() {
    return {schema: 'intactwarden.localpins/1' as const, pins: []};
  }
}

export class Sinks implements TabStateSink, AlertSink {
  readonly changed: number[] = [];
  readonly alerts: RedAlertEvent[] = [];
  async tabStateChanged(tab: number): Promise<void> {
    this.changed.push(tab);
  }
  async redAlert(e: RedAlertEvent): Promise<void> {
    this.alerts.push(e);
  }
}

export interface World {
  readonly env: FakeEnv;
  readonly timers: FakeTimers;
  readonly registry: FakeRegistry;
  readonly trust: FakeTrust;
  readonly sinks: Sinks;
  readonly backend: ObservingBackend;
  readonly engine: EngineRuntime;
  /** The persisted tab record (what the popup and the icon read). */
  tab(tab: number): Promise<TabStateRecord | null>;
  settle(): Promise<void>;
}

export interface WorldOptions {
  readonly cores?: LoadedCore[];
  readonly origins?: ProtectedOrigin[];
  /** Reuse storage (restart tests). */
  readonly session?: FakeArea;
  readonly local?: FakeArea;
  readonly timers?: FakeTimers;
  readonly trust?: FakeTrust;
  /**
   * Runs right after backend.start() registered the listeners and before anything it started has
   * settled: an event that wakes the event page arrives here (restart tests).
   */
  readonly duringStart?: (env: FakeEnv) => void;
}

export async function createWorld(o: WorldOptions): Promise<World> {
  const env = createFakeEnv({
    ...(o.session !== undefined ? {session: o.session} : {}),
    ...(o.local !== undefined ? {local: o.local} : {}),
  });
  const timers = o.timers ?? new FakeTimers();
  const registry = new FakeRegistry(o.origins ?? [vwOrigin()]);
  const trust = o.trust ?? new FakeTrust(o.cores ?? []);
  const sinks = new Sinks();
  const session = createSessionStore(env.ext);
  const local = createLocalStore(env.ext);
  const holder: {engine?: EngineRuntime} = {};
  const whenReady = (): Promise<void> => holder.engine?.whenReady() ?? Promise.resolve();
  const backend = createFirefoxBackend({
    ext: env.ext,
    now: timers.clock,
    whenReady,
    lookup: origin => registry.lookup(origin),
    session,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const world: World = {
    env,
    timers,
    registry,
    trust,
    sinks,
    backend,
    engine: undefined as unknown as EngineRuntime,
    async tab(tab) {
      const r = await env.session.get(`s:v1:tab:${tab}`);
      return (r[`s:v1:tab:${tab}`] as TabStateRecord | undefined) ?? null;
    },
    async settle() {
      // WebCrypto digests complete off the main thread: a digest of its own in each round gives
      // those the code under test started the time to finish, on a busy machine too. The timer
      // turn then lets the engine's queued work and storage writes settle.
      for (let i = 0; i < 12; i++) {
        await REAL_DIGEST('SHA-256', new Uint8Array(1));
        await new Promise(r => setTimeout(r, 1));
      }
    },
  };
  const engine = createEngine({
    ext: env.ext,
    backend,
    registry,
    trust,
    tabSink: sinks,
    alertSink: sinks,
    alerts: new AlertBook(local, timers.clock, session),
    now: timers.clock,
    session,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  holder.engine = engine;
  (world as {engine: EngineRuntime}).engine = engine;
  const started = backend.start(engine);
  o.duringStart?.(env);
  await started;
  await engine.start();
  return world;
}
