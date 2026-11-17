/**
 * In-memory stand-ins for the trust tests: a key-value view of storage.local,
 * a manual clock, a package-file reader, and a lookup of a registered core.
 */

import {
  buildIdOf,
  type LoadedCore,
  type ReleaseKey,
  type TrustStore,
} from '../../../src/contracts.ts';
import type {Kv} from '../../../src/trust/common.ts';

/** The loaded core of a release, if one is registered. */
export async function getCore(store: TrustStore, key: ReleaseKey): Promise<LoadedCore | null> {
  const ref = (await store.listCores()).find(r => r.buildId === buildIdOf(key));
  return ref === undefined ? null : store.getCoreBySha256(ref.sha256);
}

export interface MemoryKv extends Kv {
  readonly data: Map<string, unknown>;
  readonly writes: string[];
}

export function memoryKv(initial: Record<string, unknown> = {}): MemoryKv {
  const data = new Map<string, unknown>(Object.entries(initial));
  const writes: string[] = [];
  return {
    data,
    writes,
    get: async key => structuredClone(data.get(key)),
    set: async (key, value) => {
      writes.push(key);
      data.set(key, structuredClone(value));
    },
  };
}

export interface ManualClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function manualClock(start = Date.UTC(2026, 10, 6, 12, 0, 0)): ManualClock {
  let t = start;
  return {
    now: () => t,
    advance: ms => {
      t += ms;
    },
    set: ms => {
      t = ms;
    },
  };
}

export function packageReader(files: Map<string, Uint8Array>) {
  return async (path: string): Promise<Uint8Array | null> => files.get(path) ?? null;
}

/** XORs one byte in place (tests tamper with copies of real bytes). */
export function flip(bytes: Uint8Array, index: number, mask = 1): void {
  if (index < 0 || index >= bytes.length) throw new RangeError('flip: index out of range');
  bytes[index] = bytes[index]! ^ mask;
}
