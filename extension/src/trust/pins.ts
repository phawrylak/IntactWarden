/**
 * Upstream pins:
 *
 * - **bundled** pins come from a test package's bootstrap index and win (the shipping package
 *   has none);
 * - **local** pins are recorded the first time this browser resolves a release (TOFU, before the
 *   download starts) and are never replaced;
 * - a later observation that differs from the pin of the same `(repo, tag, asset)` is a
 *   **dispute**: another digest or size (`pin-changed`), another tag commit or tag object
 *   (`tag-moved`). The lattice shows both as DISPUTED `pin-changed`.
 *
 * Config files are pinned by `(repo, commit, path)`; content at a commit cannot change, so a
 * different digest there is refused by the job (`digest-mismatch`), not disputed.
 */

import type {
  ConfigFilePin,
  DisputeEvidence,
  DisputeReason,
  LocalPin,
  LocalPins,
  ReleaseAssetPin,
} from '../contracts.ts';
import {LOCAL_KEYS} from '../contracts.ts';
import {
  ASSET_NAME,
  GIT_SHA1,
  isRecord,
  isSafeCount,
  REPO_NAME,
  REPO_PATH,
  SHA256_HEX,
  TAG_NAME,
  type Kv,
  type TrustLog,
  noLog,
} from './common.ts';

export const LOCAL_PINS_SCHEMA = 'intactwarden.localpins/1';

/** What GitHub reported for a release asset just now. */
export interface ObservedAsset {
  readonly repo: string;
  readonly tag: string;
  readonly commit: string;
  readonly tagObject?: string;
  readonly asset: string;
  readonly sha256: string;
  readonly size: number;
}

export type AssetPinCheck =
  | {readonly k: 'new'}
  | {readonly k: 'match'; readonly pin: ReleaseAssetPin}
  | {readonly k: 'dispute'; readonly reason: DisputeReason; readonly pin: ReleaseAssetPin};

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The two values a dispute shows: the pinned one and the one that contradicts it. The asset
 * digests for `pin-changed`; for `tag-moved` the tag commits, or with the same commit the objects
 * the tags point to.
 */
export function disputeEvidence(
  reason: DisputeReason,
  pin: ReleaseAssetPin,
  observed: {readonly sha256: string; readonly commit: string; readonly tagObject?: string},
): DisputeEvidence {
  if (reason === 'pin-changed') return {recorded: pin.sha256, observed: observed.sha256};
  if (pin.tag_commit !== observed.commit) {
    return {recorded: pin.tag_commit, observed: observed.commit};
  }
  return {
    recorded: pin.tag_object ?? pin.tag_commit,
    observed: observed.tagObject ?? observed.commit,
  };
}

/** Validates one pin; `source` must be the expected one ('bundled' in the index, 'local' in storage). */
export function validatePin(raw: unknown, source: 'bundled' | 'local'): LocalPin | null {
  if (!isRecord(raw) || raw['source'] !== source) return null;
  const repoOk = typeof raw['repo'] === 'string' && REPO_NAME.test(raw['repo']);
  const sha = typeof raw['sha256'] === 'string' && SHA256_HEX.test(raw['sha256']);
  if (!repoOk || !sha) return null;
  if (raw['kind'] === 'release-asset') {
    const keys = new Set([
      'kind',
      'repo',
      'tag',
      'tag_commit',
      'tag_object',
      'asset',
      'sha256',
      'size',
      'source',
    ]);
    if (Object.keys(raw).some(k => !keys.has(k))) return null;
    const ok =
      typeof raw['tag'] === 'string' &&
      TAG_NAME.test(raw['tag']) &&
      typeof raw['tag_commit'] === 'string' &&
      GIT_SHA1.test(raw['tag_commit']) &&
      (raw['tag_object'] === undefined ||
        (typeof raw['tag_object'] === 'string' && GIT_SHA1.test(raw['tag_object']))) &&
      typeof raw['asset'] === 'string' &&
      ASSET_NAME.test(raw['asset']) &&
      isSafeCount(raw['size']);
    return ok ? (raw as unknown as ReleaseAssetPin) : null;
  }
  if (raw['kind'] === 'config-file') {
    const keys = new Set(['kind', 'repo', 'commit', 'path', 'sha256', 'source']);
    if (Object.keys(raw).some(k => !keys.has(k))) return null;
    const ok =
      typeof raw['commit'] === 'string' &&
      GIT_SHA1.test(raw['commit']) &&
      typeof raw['path'] === 'string' &&
      REPO_PATH.test(raw['path']);
    return ok ? (raw as unknown as ConfigFilePin) : null;
  }
  return null;
}

/** Validates a pin list; malformed entries are dropped and counted. */
export function validatePins(
  raw: unknown,
  source: 'bundled' | 'local',
): {readonly pins: LocalPin[]; readonly dropped: number} {
  if (!isRecord(raw) || raw['schema'] !== LOCAL_PINS_SCHEMA || !Array.isArray(raw['pins'])) {
    return {pins: [], dropped: raw === undefined ? 0 : 1};
  }
  const pins: LocalPin[] = [];
  let dropped = 0;
  for (const p of raw['pins']) {
    const v = validatePin(p, source);
    if (v === null) dropped++;
    else pins.push(v);
  }
  return {pins, dropped};
}

export interface PinStore {
  /** Loads local pins from storage and sets the bundled ones. */
  load(bundled: readonly LocalPin[]): Promise<void>;
  /**
   * Reads the local pins again if the last read failed; rejects while they cannot be read, and
   * resolves true when it read them now. A job calls it before it checks or records a pin.
   */
  reload(): Promise<boolean>;
  /** Bundled pins first, then local ones. */
  all(): LocalPins;
  findAsset(repo: string, tag: string, asset: string): ReleaseAssetPin | null;
  /** The pin this browser recorded itself, even where a bundled pin is in force. */
  findLocalAsset(repo: string, tag: string, asset: string): ReleaseAssetPin | null;
  findConfig(repo: string, commit: string, path: string): ConfigFilePin | null;
  checkAsset(observed: ObservedAsset): AssetPinCheck;
  /** Records a local pin unless one exists (bundled or local); returns the pin in force. */
  recordAsset(observed: ObservedAsset): Promise<ReleaseAssetPin>;
  recordConfig(repo: string, commit: string, path: string, sha256: string): Promise<ConfigFilePin>;
}

export function createPinStore(deps: {readonly kv: Kv; readonly log?: TrustLog}): PinStore {
  const log = deps.log ?? noLog;
  let bundled: readonly LocalPin[] = [];
  let local: LocalPin[] = [];
  let writing: Promise<void> = Promise.resolve();
  /**
   * The stored local pins could not be read: memory holds none of them, so nothing may be checked
   * against them or written over them (a write would erase every pin stored before, and a release
   * pinned earlier would look new) until a read succeeds.
   */
  let unread = false;

  const read = async (): Promise<void> => {
    const raw = await deps.kv.get(LOCAL_KEYS.pins);
    const {pins, dropped} = validatePins(raw, 'local');
    if (dropped > 0) log('trust.pins.dropped', {count: dropped});
    local = pins;
    unread = false;
  };

  /**
   * Persists a new local pin, then adds it to memory: a rejected write leaves no pin in force that
   * storage does not hold, and does not block later writes.
   */
  const add = (pin: LocalPin): Promise<void> => {
    const write = writing
      .catch(() => undefined)
      .then(() => {
        if (unread) throw new Error('local pins unread');
        return deps.kv.set(LOCAL_KEYS.pins, {schema: LOCAL_PINS_SCHEMA, pins: [...local, pin]});
      })
      .then(() => void local.push(pin));
    writing = write;
    return write;
  };

  const assetPins = (pins: readonly LocalPin[]): ReleaseAssetPin[] =>
    pins.filter((p): p is ReleaseAssetPin => p.kind === 'release-asset');

  const findIn = (pins: readonly LocalPin[], repo: string, tag: string, asset: string) =>
    assetPins(pins).find(p => sameRepo(p.repo, repo) && p.tag === tag && p.asset === asset) ?? null;

  const findAsset = (repo: string, tag: string, asset: string): ReleaseAssetPin | null =>
    findIn([...bundled, ...local], repo, tag, asset);

  const findConfig = (repo: string, commit: string, path: string): ConfigFilePin | null =>
    [...bundled, ...local].find(
      (p): p is ConfigFilePin =>
        p.kind === 'config-file' &&
        sameRepo(p.repo, repo) &&
        p.commit === commit &&
        p.path === path,
    ) ?? null;

  const checkAsset = (o: ObservedAsset): AssetPinCheck => {
    const pin = findAsset(o.repo, o.tag, o.asset);
    if (pin === null) return {k: 'new'};
    if (pin.sha256 !== o.sha256 || pin.size !== o.size)
      return {k: 'dispute', reason: 'pin-changed', pin};
    if (pin.tag_commit !== o.commit || (pin.tag_object ?? null) !== (o.tagObject ?? null)) {
      return {k: 'dispute', reason: 'tag-moved', pin};
    }
    return {k: 'match', pin};
  };

  return {
    async load(bundledPins) {
      bundled = Object.freeze([...bundledPins]);
      try {
        // One retry: a transient failure here would hide a dispute (bundled pins win)
        // until a job reads them again.
        await read().catch(read);
      } catch {
        local = [];
        unread = true;
        log('trust.pins.unread', {});
      }
    },
    async reload() {
      if (!unread) return false;
      await read();
      return true;
    },
    all: () => ({schema: LOCAL_PINS_SCHEMA, pins: [...bundled, ...local]}),
    findAsset,
    findLocalAsset: (repo, tag, asset) => findIn(local, repo, tag, asset),
    findConfig,
    checkAsset,
    async recordAsset(o) {
      const existing = findAsset(o.repo, o.tag, o.asset);
      if (existing !== null) return existing;
      const pin: ReleaseAssetPin = {
        kind: 'release-asset',
        repo: o.repo,
        tag: o.tag,
        tag_commit: o.commit,
        ...(o.tagObject === undefined ? {} : {tag_object: o.tagObject}),
        asset: o.asset,
        sha256: o.sha256,
        size: o.size,
        source: 'local',
      };
      await add(pin);
      return pin;
    },
    async recordConfig(repo, commit, path, sha256) {
      const existing = findConfig(repo, commit, path);
      if (existing !== null) return existing;
      const pin: ConfigFilePin = {kind: 'config-file', repo, commit, path, sha256, source: 'local'};
      await add(pin);
      return pin;
    },
  };
}
