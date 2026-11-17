/**
 * IndexedDB access: database IDB.name, store `cores` (../contracts.ts §10), opened by the background
 * event page only. The upgrade only adds a missing store, so an existing database keeps its cores.
 * When the database cannot be opened every call fails: a deep verify then fails as transient.
 */

import {IDB, type CoreBlobRecord, type ExtensionDb, type KeyValueStore} from '../contracts.ts';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function storeOver<V>(db: IDBDatabase, name: string): KeyValueStore<V> {
  const tx = (mode: 'readonly' | 'readwrite'): IDBObjectStore =>
    db.transaction(name, mode).objectStore(name);
  return {
    async get(key) {
      return (await req(tx('readonly').get(key))) as V | undefined;
    },
    async put(_key, value) {
      // In-line keys (keyPath sha256).
      await req(tx('readwrite').put(value));
    },
    async delete(key) {
      await req(tx('readwrite').delete(key));
    },
  };
}

export async function openExtensionDb(): Promise<ExtensionDb> {
  const open = indexedDB.open(IDB.name, IDB.version);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(IDB.stores.cores)) {
      db.createObjectStore(IDB.stores.cores, {keyPath: 'sha256'});
    }
  };
  const db = await req(open);
  return {cores: storeOver<CoreBlobRecord>(db, IDB.stores.cores)};
}

/**
 * An ExtensionDb usable before the database opened (the background must construct everything
 * synchronously at wake-up): every call waits for it.
 */
export function deferredExtensionDb(db: Promise<ExtensionDb>): ExtensionDb {
  // A database that cannot be opened rejects each call, not the event page.
  db.catch(() => undefined);
  const lazy = <V>(pick: (d: ExtensionDb) => KeyValueStore<V>): KeyValueStore<V> => ({
    get: async key => pick(await db).get(key),
    put: async (key, value) => pick(await db).put(key, value),
    delete: async key => pick(await db).delete(key),
  });
  return {cores: lazy(d => d.cores)};
}
