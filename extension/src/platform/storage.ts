/**
 * Typed storage access (layout in ../contracts.ts §10).
 *
 * - storage.local values are shape-checked on read (unknown or malformed values are treated as
 *   absent), so bad data cannot break the engine; a well-formed value is trusted. Content scripts
 *   can reach storage.local; a content process taken over by an exploit counts as a compromised
 *   browser (docs/security.md). Firefox does not expose storage.session to content scripts.
 * - Every write that worsens a state is awaited by the caller before the icon updates; the engine
 *   coalesces session writes (engine/sessions.ts).
 */

import {LOCAL_KEYS, type LocalStorageSchema} from '../contracts.ts';
import type {Ext, StorageArea} from './webext.ts';

export interface LocalStore {
  get<K extends keyof LocalStorageSchema>(key: K): Promise<LocalStorageSchema[K] | undefined>;
  set<K extends keyof LocalStorageSchema>(key: K, value: LocalStorageSchema[K]): Promise<void>;
}

export interface SessionStore {
  get<T>(key: string): Promise<T | undefined>;
  getMany<T>(keys: readonly string[]): Promise<Record<string, T>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  /** Keys that start with `prefix` (s:v1:doc:, s:v1:ff:, …). */
  keys(prefix: string): Promise<string[]>;
}

const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shallow shape checks per local key; anything else reads as absent. */
const LOCAL_SHAPE: Readonly<Record<keyof LocalStorageSchema, (v: unknown) => boolean>> = {
  'l:v1:settings': isObject,
  'l:v1:instances': Array.isArray,
  'l:v1:originAlerts': isObject,
  'l:v1:lastSeen': isObject,
  'l:v1:pins': isObject,
  'l:v1:releases': isObject,
  'l:v1:jobs': Array.isArray,
  'l:v1:github': () => true,
  'l:v1:incidents': Array.isArray,
};

const KNOWN_LOCAL = new Set<string>(Object.values(LOCAL_KEYS));

export function createLocalStore(ext: Ext): LocalStore {
  const area = ext.storage.local;
  return {
    async get(key) {
      if (!KNOWN_LOCAL.has(key)) return undefined;
      const r = await area.get(key);
      const v = r[key];
      if (v === undefined || !LOCAL_SHAPE[key](v)) return undefined;
      return v as LocalStorageSchema[typeof key];
    },
    async set(key, value) {
      if (!KNOWN_LOCAL.has(key)) throw new Error('unknown storage.local key');
      await area.set({[key]: value});
    },
  };
}

export function createSessionStore(ext: Ext): SessionStore {
  const area: StorageArea = ext.storage.session;
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const r = await area.get(key);
      return r[key] as T | undefined;
    },
    async getMany<T>(keys: readonly string[]): Promise<Record<string, T>> {
      if (keys.length === 0) return {};
      return (await area.get(keys)) as Record<string, T>;
    },
    async set(items) {
      await area.set({...items});
    },
    async remove(keys) {
      await area.remove(keys);
    },
    async keys(prefix: string): Promise<string[]> {
      const all = await area.get(null);
      return Object.keys(all).filter(k => k.startsWith(prefix));
    },
  };
}
