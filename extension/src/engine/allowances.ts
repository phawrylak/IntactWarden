/**
 * Per-tab allowances (docs/guide.md): server stylesheets and "Proceed once", scoped to
 * one tab, and the pending grant of a payment script for the tab's next page load, persisted in
 * storage.session `s:v1:allow:<tab>`. Remote data can never add one; only UI_ALLOW_FOR_TAB from an
 * extension page does.
 */

import {
  SESSION_KEYS,
  type AllowanceRequest,
  type EpochMs,
  type Origin,
  type TabAllowances,
} from '../contracts.ts';
import type {SessionStore} from '../platform/storage.ts';

export class Allowances {
  readonly #store: SessionStore;
  readonly #byTab = new Map<number, TabAllowances>();

  constructor(store: SessionStore) {
    this.#store = store;
  }

  async rehydrate(): Promise<void> {
    const keys = await this.#store.keys('s:v1:allow:');
    const recs = await this.#store.getMany<TabAllowances>(keys);
    for (const k of keys) {
      const r = recs[k];
      if (r !== undefined && typeof r.tab === 'number') this.#byTab.set(r.tab, r);
    }
  }

  get(tab: number): TabAllowances | null {
    return this.#byTab.get(tab) ?? null;
  }

  #of(tab: number): TabAllowances {
    return (
      this.#byTab.get(tab) ?? {
        tab,
        thirdPartyGrant: null,
        serverStyles: [],
        proceedOnce: [],
      }
    );
  }

  async #save(next: TabAllowances): Promise<TabAllowances> {
    this.#byTab.set(next.tab, next);
    await this.#store.set({[SESSION_KEYS.allow(next.tab)]: next});
    return next;
  }

  async add(tab: number, a: Exclude<AllowanceRequest, {k: 'third-party'}>): Promise<TabAllowances> {
    const prev = this.#of(tab);
    const add = (list: readonly string[], v: string): string[] =>
      list.includes(v) ? [...list] : [...list, v].slice(-100);
    switch (a.k) {
      case 'server-style':
        return this.#save({...prev, serverStyles: add(prev.serverStyles, a.path)});
      case 'proceed-once':
        return this.#save({...prev, proceedOnce: add(prev.proceedOnce, a.sha256)});
    }
  }

  /** Grants payment script `id` to the next top-level document of `origin` in `tab`, until `until`. */
  async grantThirdParty(tab: number, id: string, origin: Origin, until: EpochMs): Promise<void> {
    await this.#save({...this.#of(tab), thirdPartyGrant: {id, origin, until}});
  }

  /**
   * The next top-level document of the tab takes the pending grant: it is gone afterwards, and it
   * applies (the id is returned) only when it is for `origin` and has not expired.
   */
  async takeThirdParty(tab: number, origin: Origin, now: EpochMs): Promise<string | null> {
    const prev = this.#byTab.get(tab);
    const grant = prev?.thirdPartyGrant ?? null;
    if (prev === undefined || grant === null) return null;
    await this.#save({...prev, thirdPartyGrant: null});
    return grant.origin === origin && now <= grant.until ? grant.id : null;
  }

  /** Consumes a "Proceed once" allowance for a document hash in a tab. */
  async consumeProceedOnce(tab: number, sha256: string): Promise<boolean> {
    const prev = this.#byTab.get(tab);
    if (prev === undefined || !prev.proceedOnce.includes(sha256)) return false;
    await this.#save({...prev, proceedOnce: prev.proceedOnce.filter(s => s !== sha256)});
    return true;
  }

  async removeTab(tab: number): Promise<void> {
    if (!this.#byTab.delete(tab)) return;
    await this.#store.remove(SESSION_KEYS.allow(tab));
  }
}
