/**
 * Deep-verify budget. The release a deep verify downloads is named by the server's version hint,
 * so a server could make the extension download, build and store one release after another,
 * spending the user's bandwidth and IndexedDB space and the anonymous GitHub limit of 60 requests
 * per hour; each request also tells GitHub which version the server claims. A rolling 24-hour
 * window caps the distinct releases deep verify may start, per origin and for all origins
 * together. A release already known needs no download and is never capped; a version an origin
 * already started counts once. Persisted in storage.session, so an event-page restart does not
 * reset it. The first spend of a release also starts its unknown-build give-up time.
 */

import {SESSION_KEYS, type Origin, type ReleaseKey} from '../contracts.ts';
import type {SessionStore} from '../platform/storage.ts';

export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Distinct release versions one origin may have deep verified per window. */
export const BUDGET_PER_ORIGIN = 3;
/** Distinct release versions all origins together may have deep verified per window. */
export const BUDGET_TOTAL = 12;

type Entries = Record<Origin, {version: string; app: string; at: number}[]>;

export class DeepVerifyBudget {
  readonly #store: SessionStore;
  #entries: Entries = {};

  constructor(store: SessionStore) {
    this.#store = store;
  }

  async load(): Promise<void> {
    const v = await this.#store.get<Entries>(SESSION_KEYS.deepVerifyBudget);
    if (v !== undefined && typeof v === 'object' && v !== null) this.#entries = {...v};
  }

  #live(now: number): Entries {
    const out: Entries = {};
    for (const [origin, list] of Object.entries(this.#entries)) {
      const kept = (Array.isArray(list) ? list : []).filter(
        e => typeof e?.at === 'number' && now - e.at < BUDGET_WINDOW_MS,
      );
      if (kept.length > 0) out[origin] = kept;
    }
    return out;
  }

  /** Whether starting a deep verify of `key` for `origin` would exceed the budget. */
  exhausted(origin: Origin, key: ReleaseKey, now: number): boolean {
    const live = this.#live(now);
    const id = `${key.app}@${key.version}`;
    const mine = new Set((live[origin] ?? []).map(e => `${e.app}@${e.version}`));
    if (mine.has(id)) return false;
    if (mine.size >= BUDGET_PER_ORIGIN) return true;
    const all = new Set(Object.values(live).flatMap(l => l.map(e => `${e.app}@${e.version}`)));
    return !all.has(id) && all.size >= BUDGET_TOTAL;
  }

  /** When deep verify of `key` first started for `origin` in the window; null if it has not. */
  startedAt(origin: Origin, key: ReleaseKey, now: number): number | null {
    const e = this.#live(now)[origin]?.find(x => x.app === key.app && x.version === key.version);
    return e?.at ?? null;
  }

  /** Records that deep verify of `key` started for `origin`. */
  async spend(origin: Origin, key: ReleaseKey, now: number): Promise<void> {
    const live = this.#live(now);
    const list = live[origin] ?? [];
    if (!list.some(e => e.app === key.app && e.version === key.version)) {
      list.push({version: key.version, app: key.app, at: now});
    }
    live[origin] = list;
    this.#entries = live;
    try {
      await this.#store.set({[SESSION_KEYS.deepVerifyBudget]: live});
    } catch {
      // In memory only: the budget still holds until the next restart.
    }
  }
}
