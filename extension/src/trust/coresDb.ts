/**
 * Core manifests at rest: IndexedDB `cores` holds the exact canonical bytes of every core built in
 * this browser, keyed by their sha256. A core is the extension's own data: the builder checked it
 * when it was built (finishCore), and cores built by other builder code are dropped (store.ts). A
 * load re-hashes the bytes, checks their canonical form and identity, and does not validate the
 * core again. Parsed cores are cached in memory per sha256 (immutable by address).
 */

import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {canonicalize} from '@intactwarden/core/jcs/canonicalize.ts';
import {fileIndexOf, type FileIndex} from '@intactwarden/core/routing/fileIndex.ts';
import type {CoreManifest} from '@intactwarden/core/schema/manifest.ts';
import type {CoreRef, ExtensionDb, LoadedCore, Sha256Hex} from '../contracts.ts';
import {isRecord, isSha256, type TrustLog, noLog} from './common.ts';

/** Upper bound for one core's bytes (real cores are about 50 KB). */
const MAX_CORE_BYTES = 16 * 1024 * 1024;

export interface CoreExpectation {
  readonly sha256: Sha256Hex;
  readonly size?: number;
  readonly app: string;
  readonly variant: string;
  readonly version: string;
}

export interface ParsedCore {
  readonly core: CoreManifest;
  readonly fileIndex: FileIndex;
}

export type CoreCheck =
  {readonly ok: true; readonly parsed: ParsedCore} | {readonly ok: false; readonly reason: string};

/** Re-hashes, parses and identity-checks a core's bytes. Never throws. */
export async function verifyCoreBytes(
  bytes: Uint8Array,
  expected: CoreExpectation,
): Promise<CoreCheck> {
  if (!isSha256(expected.sha256)) return {ok: false, reason: 'bad-expected-sha256'};
  if (bytes.length > MAX_CORE_BYTES) return {ok: false, reason: 'too-large'};
  if (expected.size !== undefined && bytes.length !== expected.size) {
    return {ok: false, reason: 'size'};
  }
  if ((await sha256Hex(bytes)) !== expected.sha256) return {ok: false, reason: 'sha256'};
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    value = JSON.parse(text);
    // The bytes are stored exactly as finishCore serialised them.
    if (canonicalize(value) !== text) throw new Error('not canonical');
  } catch {
    return {ok: false, reason: 'not-canonical'};
  }
  const core = value as CoreManifest;
  // buildIdOf() spelled out: the expectation's app and variant are plain strings here.
  const buildId = `${expected.app}@${expected.version}+${expected.variant}`;
  if (
    !isRecord(value) ||
    !isRecord(value['version']) ||
    core.build_id !== buildId ||
    core.app !== expected.app ||
    core.variant !== expected.variant ||
    core.version.label !== expected.version
  ) {
    return {ok: false, reason: 'identity'};
  }
  let fileIndex: FileIndex;
  try {
    fileIndex = fileIndexOf(core.files);
  } catch {
    return {ok: false, reason: 'file-index'};
  }
  return {ok: true, parsed: {core, fileIndex}};
}

export interface CoresDb {
  /** Stores the bytes of a core the store has checked, and caches its parse. */
  put(bytes: Uint8Array, parsed: ParsedCore, sha256: Sha256Hex, addedAt: number): Promise<void>;
  /**
   * Loads and verifies the core of `ref` from IndexedDB (or the memory cache); null if absent or
   * bad. Rejects when IndexedDB cannot be read.
   */
  load(ref: CoreRef): Promise<LoadedCore | null>;
  /** Adds an already verified core (bundled cores come from the package, not IndexedDB). */
  remember(sha256: Sha256Hex, parsed: ParsedCore): void;
  /** Deletes the blob and its cached parse. */
  remove(sha256: Sha256Hex): Promise<void>;
}

export function createCoresDb(db: ExtensionDb, log: TrustLog = noLog): CoresDb {
  const cache = new Map<Sha256Hex, ParsedCore>();
  const loading = new Map<Sha256Hex, Promise<ParsedCore | null>>();

  async function read(ref: CoreRef): Promise<ParsedCore | null> {
    let record;
    try {
      record = await db.cores.get(ref.sha256);
    } catch (e) {
      log('trust.cores.read-failed', {build: ref.buildId});
      throw e;
    }
    if (record === undefined || !(record.bytes instanceof Uint8Array)) {
      log('trust.cores.missing', {build: ref.buildId});
      return null;
    }
    const check = await verifyCoreBytes(record.bytes, {
      sha256: ref.sha256,
      size: ref.size,
      app: ref.app,
      variant: ref.variant,
      version: ref.version,
    });
    if (!check.ok) {
      log('trust.cores.rejected', {build: ref.buildId, reason: check.reason});
      return null;
    }
    return check.parsed;
  }

  return {
    async put(bytes, parsed, sha256, addedAt) {
      await db.cores.put(sha256, {sha256, bytes, buildId: parsed.core.build_id, addedAt});
      cache.set(sha256, parsed);
    },
    async load(ref) {
      let parsed = cache.get(ref.sha256);
      if (parsed === undefined) {
        let pending = loading.get(ref.sha256);
        if (pending === undefined) {
          pending = read(ref).finally(() => loading.delete(ref.sha256));
          loading.set(ref.sha256, pending);
        }
        const loaded = await pending;
        if (loaded === null) return null;
        // A cached core is reused only for the identity it was verified for.
        if (loaded.core.build_id !== ref.buildId) return null;
        cache.set(ref.sha256, loaded);
        parsed = loaded;
      }
      if (parsed.core.build_id !== ref.buildId) return null;
      return {ref, core: parsed.core, fileIndex: parsed.fileIndex};
    },
    remember(sha256, parsed) {
      cache.set(sha256, parsed);
    },
    async remove(sha256) {
      cache.delete(sha256);
      try {
        await db.cores.delete(sha256);
      } catch {
        log('trust.cores.delete-failed');
      }
    },
  };
}
