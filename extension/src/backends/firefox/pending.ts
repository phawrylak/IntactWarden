/**
 * Persisted pending StreamFilters: every open filter is recorded
 * under `s:v1:ff:pending:<requestId>` with the generation of the background instance that opened
 * it. On start, an entry of another generation is a filter that instance never closed: its bytes
 * may have run unverified (PROTECTION_LOST verifier-restarted and an origin alert). Writes are
 * coalesced.
 */

import type {DocKey} from '../../contracts.ts';
import type {SessionStore} from '../../platform/storage.ts';

export const PENDING_PREFIX = 's:v1:ff:pending:';

export interface PendingFilter {
  /** The document the filtered response belongs to. */
  readonly doc: DocKey;
  readonly gen: string;
}

export class PendingFilters {
  readonly #store: SessionStore;
  readonly #gen: string;
  readonly #set = new Map<string, PendingFilter>();
  readonly #removed = new Set<string>();
  readonly #added = new Set<string>();
  #scheduled = false;
  #flush: Promise<void> = Promise.resolve();

  constructor(store: SessionStore, gen: string) {
    this.#store = store;
    this.#gen = gen;
  }

  open(req: string, doc: DocKey): void {
    this.#set.set(req, {doc, gen: this.#gen});
    this.#added.add(req);
    this.#removed.delete(req);
    this.#schedule();
  }

  close(req: string): void {
    this.#set.delete(req);
    // Opened and closed between two flushes: nothing to write.
    if (this.#added.delete(req)) return;
    this.#removed.add(req);
    this.#schedule();
  }

  /** Entries left by an earlier instance; they are removed from storage. */
  async takeStale(): Promise<PendingFilter[]> {
    const keys = await this.#store.keys(PENDING_PREFIX);
    const recs = await this.#store.getMany<PendingFilter>(keys);
    const stale: string[] = [];
    const out: PendingFilter[] = [];
    for (const k of keys) {
      const r = recs[k];
      if (r === undefined || r.gen === this.#gen) continue;
      stale.push(k);
      out.push(r);
    }
    if (stale.length > 0) await this.#store.remove(stale);
    return out;
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#flush = this.#flush.then(async () => {
      await Promise.resolve();
      this.#scheduled = false;
      const set: Record<string, unknown> = {};
      for (const req of this.#added) {
        const f = this.#set.get(req);
        if (f !== undefined) set[PENDING_PREFIX + req] = f;
      }
      this.#added.clear();
      const removed = [...this.#removed].map(r => PENDING_PREFIX + r);
      this.#removed.clear();
      try {
        if (Object.keys(set).length > 0) await this.#store.set(set);
        if (removed.length > 0) await this.#store.remove(removed);
      } catch {
        // storage.session full or gone: the in-memory set still drives decisions.
      }
    });
  }
}
