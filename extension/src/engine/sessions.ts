/**
 * Document sessions in storage.session.
 *
 * - One record per DocKey under `s:v1:doc:<docKey>`, bounded by SESSION_LIMITS.
 * - Writes are coalesced: every change marks the record dirty and returns the promise of the next
 *   flush (one storage.session.set for all dirty records). Callers await it for writes that worsen
 *   a state, before the icon updates; other writes are not awaited.
 * - Rehydration (R7) reads every record back after a background restart.
 * - Nothing here holds a full URL: paths and redacted URLs only.
 */

import {
  SESSION_KEYS,
  SESSION_LIMITS,
  type DocKey,
  type DocStartObs,
  type DocumentSessionRecord,
  type ItemRecord,
  type Origin,
  type ProtectedOrigin,
} from '../contracts.ts';
import type {SessionStore} from '../platform/storage.ts';
import {rankOf} from '@intactwarden/core/verdict/states.ts';
import type {SessionRec} from './types.ts';
import {pathOf} from './urls.ts';

const DOC_PREFIX = 's:v1:doc:';

export class SessionTable {
  readonly #store: SessionStore;
  readonly #map = new Map<DocKey, SessionRec>();
  readonly #dirty = new Set<DocKey>();
  readonly #removed = new Set<DocKey>();
  #pending: Promise<void> | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(store: SessionStore) {
    this.#store = store;
  }

  get(doc: DocKey | null | undefined): SessionRec | undefined {
    return doc === null || doc === undefined ? undefined : this.#map.get(doc);
  }

  all(): SessionRec[] {
    return [...this.#map.values()];
  }

  live(): SessionRec[] {
    return this.all().filter(s => s.alive);
  }

  byTab(tab: number): SessionRec[] {
    return this.all().filter(s => s.tab === tab);
  }

  liveByOrigin(origin: Origin): SessionRec[] {
    return this.all().filter(s => s.alive && s.origin === origin);
  }

  add(rec: SessionRec): Promise<void> {
    this.#map.set(rec.doc, rec);
    this.#removed.delete(rec.doc);
    return this.touch(rec.doc);
  }

  /** Marks a session dirty; resolves after the write that contains it. */
  touch(doc: DocKey): Promise<void> {
    if (!this.#map.has(doc)) return Promise.resolve();
    this.#dirty.add(doc);
    return this.#schedule();
  }

  remove(doc: DocKey): Promise<void> {
    this.#map.delete(doc);
    this.#dirty.delete(doc);
    this.#removed.add(doc);
    return this.#schedule();
  }

  /** Reads every persisted session back (R7). Malformed records are dropped. */
  async rehydrate(): Promise<SessionRec[]> {
    const keys = await this.#store.keys(DOC_PREFIX);
    const records = await this.#store.getMany<unknown>(keys);
    const out: SessionRec[] = [];
    for (const key of keys) {
      const rec = records[key];
      if (!isSessionRecord(rec)) continue;
      const s = rec as unknown as SessionRec;
      this.#map.set(s.doc, s);
      out.push(s);
    }
    return out;
  }

  #schedule(): Promise<void> {
    if (this.#pending !== null) return this.#pending;
    const run = this.#chain.then(() => {
      this.#pending = null;
      return this.#write();
    });
    this.#pending = run;
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #write(): Promise<void> {
    const items: Record<string, unknown> = {};
    for (const doc of this.#dirty) {
      const s = this.#map.get(doc);
      if (s !== undefined) items[SESSION_KEYS.doc(doc)] = s;
    }
    const removed = [...this.#removed].map(d => SESSION_KEYS.doc(d));
    this.#dirty.clear();
    this.#removed.clear();
    if (Object.keys(items).length > 0) await this.#store.set(items);
    if (removed.length > 0) await this.#store.remove(removed);
  }
}

function isSessionRecord(v: unknown): v is DocumentSessionRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<DocumentSessionRecord>;
  return (
    r.v === 1 &&
    typeof r.doc === 'string' &&
    typeof r.tab === 'number' &&
    typeof r.origin === 'string' &&
    typeof r.items === 'object' &&
    r.items !== null &&
    typeof r.pending === 'object' &&
    r.pending !== null
  );
}

export function newSession(obs: DocStartObs, origin: ProtectedOrigin, now: number): SessionRec {
  return {
    v: 1,
    doc: obs.doc,
    tab: obs.tab,
    frame: obs.frame,
    parentDoc: obs.parentDoc,
    topLevel: obs.type === 'main_frame',
    origin: origin.origin,
    path: pathOf(obs.url) ?? '/',
    app: origin.app,
    deploymentId: origin.deployment.id,
    ...(obs.incognito === true ? {incognito: true} : {}),
    startedAt: now,
    endedAt: null,
    alive: true,
    docClass: 'pending',
    docClassDetail: null,
    docSha256: null,
    docVerified: false,
    binding: null,
    unknownBuild: null,
    items: {},
    pending: {},
    overflow: false,
    serverStyles: {},
    sensors: [],
    engineFault: null,
    unverifiedCode: null,
    uncommittedFailure: null,
    untracked: false,
    coResident: null,
    blocked: false,
    allowedThirdParty: null,
    state: 'NOT_PROTECTED',
    reasons: [],
    flags: ['CHECKING'],
    peakState: 'NOT_PROTECTED',
    incidentId: null,
    incidentState: null,
  };
}

/** Outcomes ordered by how bad they are, so a later result never hides an earlier, worse one (R6). */
function outcomeWeight(item: ItemRecord): number {
  switch (item.outcome.r) {
    case 'mismatch':
      return 6;
    case 'unverifiable':
      return 5;
    case 'style-rejected':
      return 4;
    case 'third-party':
      return 3;
    case 'recorded':
      return 1;
    default:
      return 2;
  }
}

/**
 * The key a body recorded for retro-verification is kept under (its evidence and retained bytes
 * too): one per path and body, so every body that ran under an unbound document is judged.
 */
export function recordKey(path: string, sha256: string | undefined): string {
  return `${path}#${sha256 ?? ''}`;
}

/**
 * Stores an item result under its path. A recorded entry is replaced by any result, except that a
 * recorded body other than the one recorded under the path keeps its own entry (`recordKey`): a
 * page could otherwise fetch a path again for the genuine bytes and hide the body that ran from
 * retro-verification. Otherwise the worse outcome is kept. Returns false when the item limit is
 * reached (the session overflows).
 */
export function putItem(s: SessionRec, item: ItemRecord): boolean {
  const at = s.items[item.path];
  const key =
    item.outcome.r === 'recorded' && at?.outcome.r === 'recorded' && at.sha256 !== item.sha256
      ? recordKey(item.path, item.sha256)
      : item.path;
  const prev = s.items[key];
  if (prev === undefined && Object.keys(s.items).length >= SESSION_LIMITS.items) {
    s.overflow = true;
    return false;
  }
  if (
    prev !== undefined &&
    prev.outcome.r !== 'recorded' &&
    outcomeWeight(prev) > outcomeWeight(item)
  ) {
    return true;
  }
  s.items[key] = item;
  return true;
}

export function addPending(
  s: SessionRec,
  req: string,
  entry: {path: string; type: ItemRecord['type']; since: number; url: string},
): void {
  if (s.pending[req] !== undefined) return;
  if (Object.keys(s.pending).length >= SESSION_LIMITS.pending) {
    s.overflow = true;
    return;
  }
  s.pending[req] = entry;
}

export function worsened(
  before: DocumentSessionRecord['state'],
  after: DocumentSessionRecord['state'],
): boolean {
  return rankOf(after) > rankOf(before);
}
