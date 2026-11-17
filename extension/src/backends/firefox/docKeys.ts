/**
 * Firefox DocKeys: "<tab>:<frame>:<navSeq>".
 *
 * - navSeq is one counter for the whole session (persisted, so a DocKey is never reused after an
 *   event-page restart); a document request allocates the next value as the frame's *pending*
 *   document.
 * - webNavigation.onCommitted switches the frame's *current* document to the pending one; in-flight
 *   requests are attributed by documentUrl, so a subresource that arrives before the commit is not
 *   misattributed (it switches the frame early, and the late commit then confirms that document
 *   instead of ending it).
 * - Workers: the worker-URL chain maps a script URL to the documents that loaded it; a request
 *   whose initiator is a worker script inherits that document if it is still a frame's current or
 *   pending document, and an ambiguous chain fails closed (null → R2 untracked). Firefox reports a
 *   worker's own requests with the worker's URL as documentUrl, so this chain is what attributes
 *   them. Persisted with the frame map, so it survives an event-page restart.
 */

import type {DocKey, RedactedUrl} from '../../contracts.ts';
import type {SessionStore} from '../../platform/storage.ts';

const SEQ_KEY = 's:v1:ff:seq';
const FRAMES_KEY = 's:v1:ff:frames';
const WORKERS_KEY = 's:v1:ff:workers';
/** Ended loads per frame a late commit can still revive. */
const ENDED_LOADS = 4;

interface FrameDoc {
  readonly doc: DocKey;
  readonly url: RedactedUrl;
  /**
   * Switched in by `forFrame` before its commit arrived; `prev` is the document the frame still
   * showed then. The late commit confirms it instead of ending it.
   */
  readonly early?: {readonly prev: DocKey | null};
}

/** A frame's loading document, with the time its request started. */
interface PendingDoc extends FrameDoc {
  readonly since: number;
  /** Its response started (its headers were seen). */
  responded?: boolean;
  /**
   * Its response is no longer held (its filter failed): what the frame shows if it commits was not
   * verified.
   */
  unfiltered?: boolean;
  /** Firefox reported that its request failed. */
  failed?: boolean;
}

/**
 * How well a load can explain a commit of its URL (see `DocKeys.commit`): one that can commit over
 * one that cannot; of two that can, one whose response started and that nobody holds. A load can
 * commit once its response started. One that nobody holds can commit without that: Firefox reports
 * no response headers, and no end of the request, for a document a service worker answers, and
 * that document commits all the same. Not so once its request is reported failed: that is a load
 * cancelled before its response started, which ranks below every load that can commit.
 */
const weight = (l: Pick<PendingDoc, 'responded' | 'unfiltered' | 'failed'>): number => {
  if (l.responded === true) return l.unfiltered === true ? 3 : 2;
  if (l.unfiltered !== true) return 0;
  return l.failed === true ? 1 : 2;
};

export class DocKeys {
  readonly #store: SessionStore;
  #seq = 0;
  readonly #current = new Map<string, FrameDoc>();
  readonly #pending = new Map<string, PendingDoc>();
  /**
   * A frame's loads that ended before their commit was seen, failed or superseded by a newer load,
   * oldest first (memory only; a late commit revives one). Cleared by the frame's next commit.
   */
  readonly #failed = new Map<string, PendingDoc[]>();
  readonly #workers = new Map<RedactedUrl, Set<DocKey>>();
  #dirty = false;

  constructor(store: SessionStore) {
    this.#store = store;
  }

  static frameKey(tab: number, frame: number): string {
    return `${tab}:${frame}`;
  }

  async restore(): Promise<void> {
    const seq = await this.#store.get<number>(SEQ_KEY);
    if (typeof seq === 'number' && Number.isSafeInteger(seq)) this.#seq = Math.max(this.#seq, seq);
    // Never reuse a navSeq of a persisted session.
    for (const k of await this.#store.keys('s:v1:doc:')) {
      const n = Number(k.split(':').at(-1));
      if (Number.isSafeInteger(n)) this.#seq = Math.max(this.#seq, n);
    }
    const frames = await this.#store.get<Record<string, FrameDoc>>(FRAMES_KEY);
    if (frames !== undefined && typeof frames === 'object' && frames !== null) {
      for (const [k, v] of Object.entries(frames)) {
        if (!this.#current.has(k) && typeof v?.doc === 'string') this.#current.set(k, v);
      }
    }
    const workers = await this.#store.get<Record<RedactedUrl, DocKey[]>>(WORKERS_KEY);
    if (workers !== undefined && typeof workers === 'object' && workers !== null) {
      for (const [url, docs] of Object.entries(workers)) {
        if (!Array.isArray(docs)) continue;
        const set = this.#workers.get(url) ?? new Set<DocKey>();
        for (const d of docs) if (typeof d === 'string') set.add(d);
        this.#workers.set(url, set);
      }
    }
  }

  /**
   * A document request (started at `since`, the request's timeStamp): allocate the frame's next
   * DocKey (pending until commit).
   */
  allocate(tab: number, frame: number, url: RedactedUrl, since = 0): DocKey {
    this.#seq++;
    const doc = `${tab}:${frame}:${this.#seq}`;
    const k = DocKeys.frameKey(tab, frame);
    // A load still pending is superseded; its commit may still be reported late (see `commit`).
    const superseded = this.#pending.get(k);
    if (superseded !== undefined) this.#ended(k, superseded);
    this.#pending.set(k, {doc, url, since});
    this.#persist();
    return doc;
  }

  /**
   * A document the frame shows that no request of this instance announced (adopted: R2, R7, or a
   * load without host permission): the frame's current document from now on.
   */
  adopt(tab: number, frame: number, url: RedactedUrl): DocKey {
    this.#seq++;
    const doc = `${tab}:${frame}:${this.#seq}`;
    const k = DocKeys.frameKey(tab, frame);
    this.#current.set(k, {doc, url});
    this.#failed.delete(k);
    this.#persist();
    return doc;
  }

  /** Remembers a load that ended before its commit was seen (the newest few per frame). */
  #ended(k: string, load: PendingDoc): void {
    const list = this.#failed.get(k) ?? [];
    list.push(load);
    if (list.length > ENDED_LOADS) list.shift();
    this.#failed.set(k, list);
  }

  /**
   * webNavigation.onCommitted (committed at `at`, its timeStamp): the frame now shows the load the
   * commit reports (or none). `dropped` is a pending document that something else committed over: it
   * never runs, unless its own commit still follows (it is kept as an ended load). A commit older than
   * the pending load's request is one delivered late (an event-page wake-up replays the new tab's
   * `about:blank` commit after the request that woke it): it ends the frame's current document but
   * leaves the pending load alone.
   *
   * A commit reports one of the frame's loads of its URL that started before it: the pending one,
   * one `forFrame` already switched in (a subresource came first; `previous` is then the document
   * shown before it), or one that ended before its commit arrived (`revived`): Firefox can deliver a
   * load's error first while the page still renders what was released, and a load's commit after
   * the request of the newer load that followed it. Only a load whose response started, or one
   * nobody holds and whose request has not failed (a service worker's answer has no reported
   * response), can commit, so such a load is preferred; of those, one whose response started and
   * that nobody held is: if the commit was its own, the frame runs bytes nobody verified, so an
   * ambiguous commit is taken for it. Remaining ties go to the pending load, then to one switched
   * in, then to the newest ended one, so a load a service worker answers does not lose its commit
   * to an older load that only responded.
   */
  commit(
    tab: number,
    frame: number,
    url: RedactedUrl,
    at = Number.POSITIVE_INFINITY,
  ): {
    previous: DocKey | null;
    current: DocKey | null;
    dropped: DocKey | null;
    revived: DocKey | null;
  } {
    const k = DocKeys.frameKey(tab, frame);
    const cur = this.#current.get(k);
    let previous = cur?.doc ?? null;
    const pending = this.#pending.get(k);
    const fits = (l: PendingDoc): boolean => l.url === url && l.since <= at;
    type Owner = {k: 'pending'; load: PendingDoc} | {k: 'early'} | {k: 'ended'; load: PendingDoc};
    const owners: {owner: Owner; weight: number}[] = [];
    if (pending !== undefined && fits(pending))
      owners.push({owner: {k: 'pending', load: pending}, weight: weight(pending)});
    // A document a request of it named has committed.
    if (cur?.early !== undefined && cur.url === url) owners.push({owner: {k: 'early'}, weight: 2});
    for (const load of (this.#failed.get(k) ?? []).filter(fits).reverse())
      owners.push({owner: {k: 'ended', load}, weight: weight(load)});
    const owner = owners.reduce<(typeof owners)[number] | undefined>(
      (best, o) => (best === undefined || o.weight > best.weight ? o : best),
      undefined,
    )?.owner;
    let dropped: PendingDoc | null = null;
    let revived: DocKey | null = null;
    if (owner?.k === 'pending') {
      this.#pending.delete(k);
      this.#current.set(k, {doc: owner.load.doc, url: owner.load.url});
    } else if (owner?.k === 'early' && cur !== undefined) {
      previous = cur.early?.prev ?? null;
      this.#current.set(k, {doc: cur.doc, url: cur.url});
    } else if (owner?.k === 'ended') {
      revived = owner.load.doc;
      this.#current.set(k, {doc: owner.load.doc, url: owner.load.url});
    } else {
      this.#current.delete(k);
      if (pending !== undefined && at >= pending.since) {
        this.#pending.delete(k);
        dropped = pending;
      }
    }
    this.#failed.delete(k);
    if (dropped !== null) this.#ended(k, dropped);
    this.#persist();
    return {
      previous,
      current: this.#current.get(k)?.doc ?? null,
      dropped: dropped?.doc ?? null,
      revived,
    };
  }

  /**
   * What the backend learnt of a load of the frame, loading or ended before its commit was seen:
   * its response started, its filter failed, or its request failed (see `commit`).
   */
  note(tab: number, frame: number, doc: DocKey, fact: 'responded' | 'unfiltered' | 'failed'): void {
    const k = DocKeys.frameKey(tab, frame);
    const pending = this.#pending.get(k);
    const load = pending?.doc === doc ? pending : this.#failed.get(k)?.find(l => l.doc === doc);
    if (load !== undefined) load[fact] = true;
  }

  /**
   * A pending document load failed before it committed: it is no longer the frame's pending one,
   * but its own commit may still arrive late (see `commit`).
   */
  unpend(tab: number, frame: number, doc: DocKey): void {
    const k = DocKeys.frameKey(tab, frame);
    const pending = this.#pending.get(k);
    if (pending?.doc !== doc) return;
    this.#pending.delete(k);
    this.#ended(k, pending);
    this.#persist();
  }

  current(tab: number, frame: number): DocKey | null {
    return this.#current.get(DocKeys.frameKey(tab, frame))?.doc ?? null;
  }

  /** The frame's document that is loading and not committed yet. */
  pending(tab: number, frame: number): DocKey | null {
    return this.#pending.get(DocKeys.frameKey(tab, frame))?.doc ?? null;
  }

  /**
   * The document a request (or a content script) belongs to: the frame's current document, or its
   * pending one when the documentUrl says the new document is already loading.
   */
  forFrame(tab: number, frame: number, documentUrl: RedactedUrl | null): DocKey | null {
    const k = DocKeys.frameKey(tab, frame);
    const cur = this.#current.get(k);
    const pend = this.#pending.get(k);
    if (
      documentUrl !== null &&
      pend !== undefined &&
      pend.url === documentUrl &&
      cur?.url !== documentUrl
    ) {
      // The commit event is late: switch now (the commit then confirms it).
      this.#pending.delete(k);
      this.#current.set(k, {doc: pend.doc, url: pend.url, early: {prev: cur?.doc ?? null}});
      this.#persist();
      return pend.doc;
    }
    if (cur === undefined) return null;
    if (documentUrl !== null && cur.url !== documentUrl) return null;
    return cur.doc;
  }

  /** Records that `doc` loaded script `url` (worker-URL chain). */
  noteScript(url: RedactedUrl, doc: DocKey): void {
    const set = this.#workers.get(url) ?? new Set<DocKey>();
    if (set.has(doc)) return;
    set.add(doc);
    this.#workers.set(url, set);
    if (this.#workers.size > 5000) {
      const first = this.#workers.keys().next().value;
      if (first !== undefined) this.#workers.delete(first);
    }
    this.#persist();
  }

  /**
   * The live document whose worker script initiated a request: exactly one of the documents that
   * loaded it that is still a frame's current or pending document, or null (fail closed).
   */
  byWorker(initiatorUrl: RedactedUrl | null): DocKey | null {
    if (initiatorUrl === null) return null;
    const set = this.#workers.get(initiatorUrl);
    if (set === undefined) return null;
    const live = new Set([...this.#current.values(), ...this.#pending.values()].map(f => f.doc));
    const alive = [...set].filter(d => live.has(d));
    return alive.length === 1 ? alive[0]! : null;
  }

  removeTab(tab: number): void {
    for (const k of [...this.#current.keys()]) if (k.startsWith(`${tab}:`)) this.#current.delete(k);
    for (const k of [...this.#pending.keys()]) if (k.startsWith(`${tab}:`)) this.#pending.delete(k);
    for (const k of [...this.#failed.keys()]) if (k.startsWith(`${tab}:`)) this.#failed.delete(k);
    // The tab's documents can never own a worker request again: the persisted chain stays small.
    for (const [url, docs] of [...this.#workers]) {
      for (const d of docs) if (d.startsWith(`${tab}:`)) docs.delete(d);
      if (docs.size === 0) this.#workers.delete(url);
    }
    this.#persist();
  }

  #persist(): void {
    if (this.#dirty) return;
    this.#dirty = true;
    queueMicrotask(() => {
      this.#dirty = false;
      const frames: Record<string, FrameDoc> = {};
      for (const [k, v] of this.#current) frames[k] = v;
      const workers: Record<RedactedUrl, DocKey[]> = {};
      for (const [url, docs] of this.#workers) workers[url] = [...docs];
      void this.#store
        .set({[SEQ_KEY]: this.#seq, [FRAMES_KEY]: frames, [WORKERS_KEY]: workers})
        .catch(() => undefined);
    });
  }
}
