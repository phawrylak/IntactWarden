/** In-memory ExtensionDb for unit tests (Node has no IndexedDB); keys() lets a test look inside. */

import type {CoreBlobRecord, KeyValueStore} from '../../src/contracts.ts';

export interface MemoryStore<V> extends KeyValueStore<V> {
  keys(): Promise<string[]>;
}

function memoryStore<V>(): MemoryStore<V> {
  const m = new Map<string, V>();
  return {
    get: async key => m.get(key),
    put: async (key, value) => {
      m.set(key, structuredClone(value));
    },
    delete: async key => {
      m.delete(key);
    },
    keys: async () => [...m.keys()],
  };
}

export type MemoryDb = {readonly cores: MemoryStore<CoreBlobRecord>};

export function memoryExtensionDb(): MemoryDb {
  return {cores: memoryStore<CoreBlobRecord>()};
}
