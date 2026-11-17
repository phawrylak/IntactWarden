/**
 * Retained bytes for retro-verification: the
 * bytes of unbound documents and of their same-origin files, kept in memory only (never persisted
 * or messaged), at most 64 MB, least recently used first out. After a restart they are gone, and
 * such items become unverifiable (verifier-restarted).
 */

import type {DocKey} from '../contracts.ts';

export const RETAINED_BUDGET = 64 * 1024 * 1024;

export class RetainedBytes {
  readonly #budget: number;
  readonly #map = new Map<string, Uint8Array>();
  #size = 0;

  constructor(budget = RETAINED_BUDGET) {
    this.#budget = budget;
  }

  static key(doc: DocKey, path: string): string {
    return `${doc}\n${path}`;
  }

  put(doc: DocKey, path: string, bytes: Uint8Array): void {
    if (bytes.length > this.#budget) return;
    const k = RetainedBytes.key(doc, path);
    this.#drop(k);
    this.#map.set(k, bytes);
    this.#size += bytes.length;
    for (const [old, b] of this.#map) {
      if (this.#size <= this.#budget) break;
      this.#map.delete(old);
      this.#size -= b.length;
    }
  }

  get(doc: DocKey, path: string): Uint8Array | undefined {
    const k = RetainedBytes.key(doc, path);
    const b = this.#map.get(k);
    if (b !== undefined) {
      this.#map.delete(k);
      this.#map.set(k, b);
    }
    return b;
  }

  dropDoc(doc: DocKey): void {
    const prefix = `${doc}\n`;
    for (const k of [...this.#map.keys()]) if (k.startsWith(prefix)) this.#drop(k);
  }

  #drop(k: string): void {
    const b = this.#map.get(k);
    if (b === undefined) return;
    this.#map.delete(k);
    this.#size -= b.length;
  }
}
