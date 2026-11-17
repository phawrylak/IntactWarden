/**
 * Origin-taint bookkeeping.
 *
 * The source rules are the policy kernel's (`taintSourceClass`). Here: live sources per origin in
 * storage.session (`s:v1:taint:<origin>`, kept across event-page restarts), the sticky
 * `coResident` flag on every other live session of the origin, and removal only on a confirmed end
 * of liveness.
 *
 * Holds: a window a taint source opened (`opened:<tab>`) keeps the source's taint
 * until that tab is removed, because the opener could script it (an `about:blank` popup no request
 * names) and it keeps a handle to whatever its opener's frame shows next. The tabs that opened a
 * held or tainting tab hold it too: a document can navigate its opener (and the opener's opener) to
 * `about:blank`, which takes the navigating document's origin, and script it. The opener of each
 * opened tab is kept in `s:v1:openers`.
 */

import {
  SESSION_KEYS,
  type DocKey,
  type Origin,
  type TaintClass,
  type TaintRecord,
} from '../contracts.ts';
import type {SessionStore} from '../platform/storage.ts';
import type {SessionRec} from './types.ts';

type Sources = Record<DocKey, {class: TaintClass; since: number; path: string; tab: number}>;

const HOLD = 'opened:';
const holdKey = (tab: number): string => `${HOLD}${tab}`;

export class TaintBook {
  readonly #store: SessionStore;
  readonly #byOrigin = new Map<Origin, Sources>();
  /** Opened tab → the tab that opened it (webNavigation.onCreatedNavigationTarget). */
  #openers: Record<string, number> = {};

  constructor(store: SessionStore) {
    this.#store = store;
  }

  async rehydrate(): Promise<void> {
    const openers = await this.#store.get<Record<string, number>>(SESSION_KEYS.openers);
    if (typeof openers === 'object' && openers !== null) {
      for (const [tab, opener] of Object.entries(openers)) {
        if (typeof opener === 'number') this.#openers[tab] = opener;
      }
    }
    const keys = await this.#store.keys('s:v1:taint:');
    const recs = await this.#store.getMany<TaintRecord>(keys);
    for (const k of keys) {
      const r = recs[k];
      if (r !== undefined && typeof r.origin === 'string' && typeof r.sources === 'object') {
        this.#byOrigin.set(r.origin, {...(r.sources as Sources)});
      }
    }
  }

  /** Live sources of an origin other than `except`. */
  sources(
    origin: Origin,
    except?: DocKey,
  ): {doc: DocKey; class: TaintClass; since: number; path: string}[] {
    const src = this.#byOrigin.get(origin);
    if (src === undefined) return [];
    return Object.entries(src)
      .filter(([doc]) => doc !== except)
      .map(([doc, v]) => ({doc, class: v.class, since: v.since, path: v.path}));
  }

  /** Registers a live source; returns true when it is new. */
  async add(s: SessionRec, cls: TaintClass, now: number): Promise<boolean> {
    const src = this.#byOrigin.get(s.origin) ?? {};
    if (src[s.doc] !== undefined) return false;
    src[s.doc] = {class: cls, since: now, path: s.path, tab: s.tab};
    this.#byOrigin.set(s.origin, src);
    await this.#persist(s.origin);
    return true;
  }

  /** Holds of a tab that taint sources opened (or that a held tab opened). */
  heldBy(tab: number): {origin: Origin; class: TaintClass; path: string}[] {
    const out: {origin: Origin; class: TaintClass; path: string}[] = [];
    for (const [origin, src] of this.#byOrigin) {
      const h = src[holdKey(tab)];
      if (h !== undefined) out.push({origin, class: h.class, path: h.path});
    }
    return out;
  }

  /** The tab `tab` was opened by a taint source of `origin`: it taints until the tab is removed. */
  async hold(
    origin: Origin,
    tab: number,
    cls: TaintClass,
    path: string,
    now: number,
  ): Promise<boolean> {
    const src = this.#byOrigin.get(origin) ?? {};
    if (src[holdKey(tab)] !== undefined) return false;
    src[holdKey(tab)] = {class: cls, since: now, path, tab};
    this.#byOrigin.set(origin, src);
    await this.#persist(origin);
    return true;
  }

  async noteOpener(tab: number, opener: number): Promise<void> {
    if (tab === opener || this.#openers[String(tab)] === opener) return;
    this.#openers = {...this.#openers, [String(tab)]: opener};
    await this.#store.set({[SESSION_KEYS.openers]: this.#openers});
  }

  /** The tabs that opened `tab`, its opener first, then that tab's opener, and so on. */
  openerChain(tab: number): number[] {
    const out: number[] = [];
    let at = this.#openers[String(tab)];
    while (at !== undefined && at !== tab && !out.includes(at) && out.length < 32) {
      out.push(at);
      at = this.#openers[String(at)];
    }
    return out;
  }

  /** The tab was removed: its holds end, and it opened nothing any more (`opener` is null). */
  async releaseTab(tab: number): Promise<void> {
    for (const [origin, src] of [...this.#byOrigin]) {
      if (src[holdKey(tab)] === undefined) continue;
      delete src[holdKey(tab)];
      await this.#persist(origin);
    }
    const kept = Object.entries(this.#openers).filter(([t, o]) => t !== String(tab) && o !== tab);
    if (kept.length === Object.keys(this.#openers).length) return;
    this.#openers = Object.fromEntries(kept);
    if (kept.length === 0) await this.#store.remove(SESSION_KEYS.openers);
    else await this.#store.set({[SESSION_KEYS.openers]: this.#openers});
  }

  /** Tabs that hold a taint (restart: holds of tabs closed meanwhile are released). */
  heldTabs(): number[] {
    const out = new Set<number>();
    for (const src of this.#byOrigin.values()) {
      for (const [k, v] of Object.entries(src)) if (k.startsWith(HOLD)) out.add(v.tab);
    }
    return [...out];
  }

  /** Ends a source (confirmed end of liveness only). */
  async remove(origin: Origin, doc: DocKey): Promise<void> {
    const src = this.#byOrigin.get(origin);
    if (src?.[doc] === undefined) return;
    delete src[doc];
    await this.#persist(origin);
  }

  /**
   * Flags a session co-resident with the first live source of its origin.
   * Returns true when the flag was newly set (it never clears).
   */
  flag(s: SessionRec, now: number, exclude: ReadonlySet<DocKey> = new Set()): boolean {
    if (s.coResident !== null) return false;
    const [first] = this.sources(s.origin, s.doc).filter(x => !exclude.has(x.doc));
    if (first === undefined) return false;
    s.coResident = {class: first.class, since: now, sourcePath: first.path};
    return true;
  }

  async #persist(origin: Origin): Promise<void> {
    const src = this.#byOrigin.get(origin) ?? {};
    if (Object.keys(src).length === 0) {
      this.#byOrigin.delete(origin);
      await this.#store.remove(SESSION_KEYS.taint(origin));
      return;
    }
    const rec: TaintRecord = {origin, sources: src};
    await this.#store.set({[SESSION_KEYS.taint(origin)]: rec});
  }
}
