/**
 * Bootstrap data generator, for test packages only (the end-to-end suite,
 * extension/test/e2e/run.ts): the shipping package bundles no cores and no pins.
 *
 * Reads the corpus locks in fixtures/corpora/ (`bitwarden-web-<x.y.z>.lock.json`,
 * `vaultwarden-web-<x.y.z>.lock.json`), checks every pinned coordinate against
 * the plan of `createCoreBuilder()` (repository, tag, asset name, download URL,
 * config paths at the tag commit), fetches the pinned assets and config files
 * through tools/corpus.ts (size and sha256 checked before use; cached in the
 * git-ignored fixtures/corpora/.downloads/), builds every variant of each
 * asset with the same CoreBuilder the extension's deep verify and the recompute
 * command line use, and writes into the test package:
 *
 *   <out>/data/bootstrap/index.json            BootstrapIndex (RFC 8785 bytes)
 *   <out>/data/bootstrap/cores/<sha256>.json   exact JCS bytes of each core
 *
 * The index also carries the bundled pins (`LocalPins`, `source: "bundled"`):
 * release assets (digest, size, tag → commit, tag object) and the config files
 * of the cloud derivation.
 *
 * Deterministic: the output is a pure function of the locks, the pinned bytes,
 * the builders and the bundled profiles (no clock, no environment). Vendor
 * bytes never leave the download cache; the package holds hashes and paths
 * only. Nothing generated is committed: the end-to-end suite runs this generator
 * for each test build and passes its output to build.ts (`bootstrapData`).
 * Behind an HTTPS proxy, run the build with NODE_USE_ENV_PROXY=1 (first download only).
 */

import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join, relative, resolve, sep} from 'node:path';
import type {
  BuilderVariant,
  BuildRequest,
  BuiltCore,
  CoreBuilder,
} from '@intactwarden/builders/api.ts';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {canonicalBytes} from '@intactwarden/core/jcs/canonicalize.ts';
import {fetchPinned as corpusFetchPinned, sha256} from '../../tools/corpus.ts';
import {
  BOOTSTRAP_INDEX_PATH,
  type AppId,
  type BootstrapIndex,
  type ConfigFilePin,
  type LocalPin,
  type ReleaseAssetPin,
} from '../src/contracts.ts';
import {REPO_ROOT} from './paths.ts';

/** Which apps get bundled cores. */
export type BootstrapSelection = 'all' | 'none' | 'bitwarden' | 'vaultwarden';

export const BOOTSTRAP_SELECTIONS: readonly BootstrapSelection[] = Object.freeze([
  'all',
  'none',
  'bitwarden',
  'vaultwarden',
]);

export function isBootstrapSelection(value: string): value is BootstrapSelection {
  return (BOOTSTRAP_SELECTIONS as readonly string[]).includes(value);
}

/** Fetches a pinned file; must check size and sha256 before returning (tools/corpus.ts fetchPinned). */
export type PinnedFetch = (url: string, sha256: string, size?: number) => Promise<Uint8Array>;

export interface BootstrapOptions {
  /** Default 'all'. */
  readonly apps?: BootstrapSelection;
  /** Directory of the corpus locks (default `<repo>/fixtures/corpora/`). */
  readonly locksDir?: string;
  /** Default: tools/corpus.ts fetchPinned (digest-checked, cached in fixtures/corpora/.downloads/). */
  readonly fetchPinned?: PinnedFetch;
  /** Progress lines (the CLI writes them to stderr). */
  readonly log?: (line: string) => void;
}

/** Generated bootstrap data, in memory. */
export interface BootstrapData {
  readonly index: BootstrapIndex;
  /** Exact RFC 8785 bytes of data/bootstrap/index.json. */
  readonly indexBytes: Uint8Array;
  readonly indexSha256: string;
  /** Every generated file by package path (index included), sorted by path. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** The package directory of the bootstrap data; `writeBootstrap` replaces it as a whole. */
export const BOOTSTRAP_DIR = 'data/bootstrap';
export const BOOTSTRAP_CORES_DIR = `${BOOTSTRAP_DIR}/cores`;

const DEFAULT_LOCKS_DIR = join(REPO_ROOT, 'fixtures', 'corpora');

const LOCK_NAME =
  /^(bitwarden-web|vaultwarden-web)-((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))\.lock\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^[0-9a-f]{40}$/;

const SELECTED: Readonly<Record<BootstrapSelection, readonly AppId[]>> = {
  all: ['bitwarden-web', 'vaultwarden-web'],
  none: [],
  bitwarden: ['bitwarden-web'],
  vaultwarden: ['vaultwarden-web'],
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

class LockError extends Error {
  override name = 'LockError';
}

// ---------------------------------------------------------------------------
// Strict reading of untrusted-shaped lock JSON

type Json = Record<string, unknown>;

function obj(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LockError(`${where} must be an object`);
  }
  return value as Json;
}

function str(o: Json, key: string, where: string, pattern?: RegExp): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '' || (pattern !== undefined && !pattern.test(v))) {
    throw new LockError(`${where}.${key} is missing or malformed`);
  }
  return v;
}

function int(o: Json, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new LockError(`${where}.${key} must be a non-negative integer`);
  }
  return v;
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new LockError(
      `${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

const releaseDownloadUrl = (repo: string, tag: string, asset: string): string =>
  `https://github.com/${repo}/releases/download/${tag}/${asset}`;

const rawUrl = (repo: string, commit: string, path: string): string =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;

// ---------------------------------------------------------------------------
// One lock → one build job

interface LockFile {
  readonly name: string;
  /** Repository-relative path with '/' separators. */
  readonly display: string;
  readonly app: AppId;
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

interface PinnedFile {
  readonly url: string;
  readonly sha256: string;
  readonly size?: number;
}

/** Build requests (one per variant) whose byte inputs are still to be fetched, and the pins they rest on. */
interface Job {
  readonly lock: LockFile;
  readonly asset: PinnedFile & {readonly name: string; readonly size: number};
  readonly configs: readonly (PinnedFile & {readonly path: string})[];
  readonly variants: readonly BuilderVariant[];
  readonly request: Omit<BuildRequest, 'asset' | 'configs' | 'variant'>;
  readonly pins: readonly LocalPin[];
}

function bitwardenJob(builder: CoreBuilder, lock: LockFile, raw: Json): Job {
  const where = lock.display;
  // The cloud plan names the three config files (base, cloud, euprd) both regions fetch.
  const plan = builder.plan('bitwarden-web', 'cloud-us', lock.version);
  const release = obj(raw['release'], `${where}.release`);
  const w = `${where}.release`;
  const repo = str(release, 'repo', w);
  const tag = str(release, 'tag', w);
  const commit = str(release, 'commit', w, OBJECT_ID);
  const asset = str(release, 'asset', w);
  const digest = str(release, 'sha256', w, SHA256);
  const size = int(release, 'size', w);
  expectEqual(repo, plan.repo, `${w}.repo`);
  expectEqual(tag, plan.tag, `${w}.tag`);
  expectEqual(asset, plan.assetName, `${w}.asset`);
  expectEqual(str(release, 'url', w), releaseDownloadUrl(repo, tag, asset), `${w}.url`);

  const config = obj(raw['config'], `${where}.config`);
  const names = ['base', 'cloud', 'euprd'];
  expectEqual(Object.keys(config).sort().join(), names.join(), `${where}.config keys`);
  const configs = names.map((name, i) => {
    const c = obj(config[name], `${where}.config.${name}`);
    const cw = `${where}.config.${name}`;
    const path = str(c, 'path', cw);
    const at = str(c, 'commit', cw, OBJECT_ID);
    expectEqual(path, plan.configPaths[i], `${cw}.path`);
    expectEqual(at, commit, `${cw}.commit (configs are pinned at the tag commit)`);
    expectEqual(str(c, 'url', cw), rawUrl(repo, commit, path), `${cw}.url`);
    return {path, url: rawUrl(repo, commit, path), sha256: str(c, 'sha256', cw, SHA256)};
  });
  expectEqual(configs.length, plan.configPaths.length, `${where}: number of config files`);

  const assetPin: ReleaseAssetPin = {
    kind: 'release-asset',
    repo,
    tag,
    tag_commit: commit,
    asset,
    sha256: digest,
    size,
    source: 'bundled',
  };
  const configPins: ConfigFilePin[] = configs.map(c => ({
    kind: 'config-file',
    repo,
    commit,
    path: c.path,
    sha256: c.sha256,
    source: 'bundled',
  }));
  return {
    lock,
    asset: {name: asset, url: releaseDownloadUrl(repo, tag, asset), sha256: digest, size},
    configs,
    variants: ['selfhosted-commercial', 'cloud-us', 'cloud-eu'],
    request: {app: 'bitwarden-web', version: lock.version, release: {tag, commit}},
    pins: [assetPin, ...configPins],
  };
}

function vaultwardenJob(builder: CoreBuilder, lock: LockFile, raw: Json): Job {
  const where = lock.display;
  const plan = builder.plan('vaultwarden-web', 'release', lock.version);
  const release = obj(raw['release'], `${where}.release`);
  const w = `${where}.release`;
  const repo = str(release, 'repo', w);
  const tag = str(release, 'tag', w);
  const commit = str(release, 'commit', w, OBJECT_ID);
  const tagObject = str(release, 'tag_object', w, OBJECT_ID);
  const asset = str(release, 'asset', w);
  const digest = str(release, 'sha256', w, SHA256);
  const size = int(release, 'size', w);
  expectEqual(repo, plan.repo, `${w}.repo`);
  expectEqual(int(release, 'repo_id', w), plan.repoId, `${w}.repo_id`);
  expectEqual(tag, plan.tag, `${w}.tag`);
  expectEqual(asset, plan.assetName, `${w}.asset`);
  expectEqual(str(release, 'url', w), releaseDownloadUrl(repo, tag, asset), `${w}.url`);

  const pin: ReleaseAssetPin = {
    kind: 'release-asset',
    repo,
    tag,
    tag_commit: commit,
    tag_object: tagObject,
    asset,
    sha256: digest,
    size,
    source: 'bundled',
  };
  return {
    lock,
    asset: {name: asset, url: releaseDownloadUrl(repo, tag, asset), sha256: digest, size},
    configs: [],
    variants: ['release'],
    request: {app: 'vaultwarden-web', version: lock.version, release: {tag, commit, tagObject}},
    pins: [pin],
  };
}

async function readLocks(dir: string, apps: readonly AppId[]): Promise<LockFile[]> {
  const out: LockFile[] = [];
  for (const name of (await readdir(dir)).sort(compare)) {
    if (!name.endsWith('.lock.json')) continue;
    const m = LOCK_NAME.exec(name);
    // Fail closed: a lock nobody taught the generator about is reviewed, not skipped.
    if (m === null) throw new LockError(`${name}: not a known corpus lock name`);
    const app = m[1] as AppId;
    if (!apps.includes(app)) continue;
    const file = join(dir, name);
    const bytes = new Uint8Array(await readFile(file));
    const rel = relative(REPO_ROOT, file);
    out.push({
      name,
      display: rel.startsWith('..') ? name : rel.split(sep).join('/'),
      app,
      version: m[2]!,
      bytes,
      sha256: sha256(bytes),
    });
  }
  return out;
}

function pinKey(pin: LocalPin): string {
  return pin.kind === 'release-asset'
    ? `release-asset\u0000${pin.repo}\u0000${pin.tag}\u0000${pin.asset}`
    : `config-file\u0000${pin.repo}\u0000${pin.commit}\u0000${pin.path}`;
}

/** A bundled core's artifact and source must equal the pin of its asset and tag. */
function checkAgainstPin(core: BuiltCore, pin: ReleaseAssetPin): void {
  const {artifact, source} = core.core;
  const where = `${core.buildId}`;
  if (artifact === null || artifact.kind !== 'github-release-asset') {
    throw new LockError(`${where}: artifact is not a GitHub release asset`);
  }
  expectEqual(artifact.name, pin.asset, `${where}: artifact.name`);
  expectEqual(artifact.sha256, pin.sha256, `${where}: artifact.sha256`);
  expectEqual(artifact.size, pin.size, `${where}: artifact.size`);
  expectEqual(source.commit, pin.tag_commit, `${where}: source.commit`);
  expectEqual(source.tag, pin.tag, `${where}: source.tag`);
  expectEqual(source.tag_object, pin.tag_object, `${where}: source.tag_object`);
}

// ---------------------------------------------------------------------------
// Public API

/** Builds the bootstrap data in memory (written into a test package by build.ts). */
export async function buildBootstrap(options: BootstrapOptions = {}): Promise<BootstrapData> {
  const selection = options.apps ?? 'all';
  if (!isBootstrapSelection(selection)) {
    throw new TypeError(`apps must be one of ${BOOTSTRAP_SELECTIONS.join(', ')}`);
  }
  const fetchPinned = options.fetchPinned ?? corpusFetchPinned;
  const log = options.log ?? (() => {});
  const builder = createCoreBuilder();
  const locks = await readLocks(options.locksDir ?? DEFAULT_LOCKS_DIR, SELECTED[selection]);

  const cores: BuiltCore[] = [];
  const pins = new Map<string, LocalPin>();
  for (const lock of locks) {
    let raw: Json;
    try {
      raw = obj(
        JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(lock.bytes)),
        lock.display,
      );
    } catch (e) {
      throw e instanceof LockError ? e : new LockError(`${lock.display}: not UTF-8 JSON`);
    }
    const job =
      lock.app === 'bitwarden-web'
        ? bitwardenJob(builder, lock, raw)
        : vaultwardenJob(builder, lock, raw);
    for (const pin of job.pins) {
      const key = pinKey(pin);
      const prev = pins.get(key);
      if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(pin)) {
        throw new LockError(
          `${lock.display}: conflicting pins for ${key.replaceAll('\u0000', ' ')}`,
        );
      }
      pins.set(key, pin);
    }

    log(`${lock.display}: fetching ${job.asset.name}`);
    const bytes = await fetchPinned(job.asset.url, job.asset.sha256, job.asset.size);
    const configs: Record<string, Uint8Array> = {};
    for (const c of job.configs) configs[c.path] = await fetchPinned(c.url, c.sha256);
    log(`${lock.display}: building ${job.request.app} ${job.request.version}`);
    const assetPin = job.pins[0] as ReleaseAssetPin;
    for (const variant of job.variants) {
      const core = await builder.build({
        ...job.request,
        variant,
        asset: {name: job.asset.name, sha256: job.asset.sha256, size: job.asset.size, bytes},
        ...(job.configs.length === 0 ? {} : {configs}),
      });
      checkAgainstPin(core, assetPin);
      for (const input of core.configInputs ?? []) {
        const pin = pins.get(
          `config-file\u0000${assetPin.repo}\u0000${input.commit}\u0000${input.path}`,
        );
        expectEqual(pin?.sha256, input.sha256, `${core.buildId}: config ${input.path}`);
      }
      log(`${core.sha256}  ${core.buildId}`);
      cores.push(core);
    }
  }

  const ids = new Set<string>();
  for (const c of cores) {
    if (ids.has(c.buildId)) throw new LockError(`two locks build ${c.buildId}`);
    ids.add(c.buildId);
  }
  cores.sort((a, b) => compare(a.buildId, b.buildId));
  const index: BootstrapIndex = {
    schema: 'intactwarden.bootstrap/1',
    generated_from: locks.map(l => ({lock: l.display, sha256: l.sha256})),
    cores: cores.map(c => ({
      app: c.app,
      variant: c.variant,
      version: c.version,
      build_id: c.buildId,
      assurance: c.assurance,
      sha256: c.sha256,
      size: c.bytes.length,
      path: `${BOOTSTRAP_CORES_DIR}/${c.sha256}.json`,
    })),
    pins: {
      schema: 'intactwarden.localpins/1',
      pins: [...pins.entries()].sort(([a], [b]) => compare(a, b)).map(([, p]) => p),
    },
  };
  const indexBytes = canonicalBytes(index);
  const files = new Map<string, Uint8Array>();
  for (const c of cores) files.set(`${BOOTSTRAP_CORES_DIR}/${c.sha256}.json`, c.bytes);
  files.set(BOOTSTRAP_INDEX_PATH, indexBytes);
  const sorted = new Map([...files.entries()].sort(([a], [b]) => compare(a, b)));
  return {index, indexBytes, indexSha256: sha256(indexBytes), files: sorted};
}

/** Writes the data under `<outDir>/data/bootstrap/`, replacing whatever was there. */
export async function writeBootstrap(outDir: string, data: BootstrapData): Promise<void> {
  const root = resolve(outDir);
  await rm(join(root, ...BOOTSTRAP_DIR.split('/')), {recursive: true, force: true});
  for (const [path, bytes] of data.files) {
    const file = join(root, ...path.split('/'));
    await mkdir(join(file, '..'), {recursive: true});
    await writeFile(file, bytes);
  }
}
