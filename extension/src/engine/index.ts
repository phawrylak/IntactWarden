/**
 * The engine: document sessions
 * keyed by DocKey, persisted in
 * storage.session before the icon updates; document binding and subresource checks through the
 * policy modules; unknown-build orchestration (hint fetch, TrustStore.ensureRelease, timers,
 * retro-verification on releaseKnown); origin taint bookkeeping; origin alerts; tab state records;
 * incidents; per-tab allowances; R1–R14.
 *
 * The backend reports observations and applies the returned decisions; it never decides a state.
 * Every entry point is fail closed (R1): an exception marks the affected session PROTECTION_LOST
 * (internal-error) and denies.
 */

import {checkServerStyle} from '@intactwarden/core/style/serverStyle.ts';
import {join, rankOf, stateRow} from '@intactwarden/core/verdict/states.ts';
import {
  r4Ms,
  SESSION_KEYS,
  SESSION_LIMITS,
  type AlertSink,
  type AllowanceRequest,
  type BindResult,
  type BlockedView,
  type BodyEvidence,
  type BodyObs,
  type Contribution,
  type CoreRef,
  type Decision,
  type DetailsView,
  type DisputeReason,
  type DocKey,
  type DocStartObs,
  type Evaluation,
  type HeaderDecision,
  type HeaderPair,
  type HeadersObs,
  type HintResult,
  type IncidentKind,
  type IncidentRecord,
  type ItemRecord,
  type LoadedCore,
  type Observation,
  type Origin,
  type OriginAlert,
  type ProfileRegistry,
  type ProtectedOrigin,
  type ProtectedOrigins,
  type ReleaseKey,
  type RequestId,
  type RequestObs,
  type SensorConfig,
  type TabStateRecord,
  type TaintClass,
  type TabStateSink,
  type TrustStore,
  type UnverifiableObs,
} from '../contracts.ts';
import type {ObservingBackend, SenderDoc} from '../backends/types.ts';
import {errorName, logWarn} from '../platform/guard.ts';
import {broadcast} from '../platform/messaging.ts';
import {createSessionStore, type SessionStore} from '../platform/storage.ts';
import type {Ext} from '../platform/webext.ts';
import {bindDocument} from '../policy/bind.ts';
import {classifyServerPath} from '../policy/classify.ts';
import {decisionFor, evaluateSession, meetsAlert} from '../policy/evaluate.ts';
import {headerGuard} from '../policy/headerGuard.ts';
import {taintSourceClass} from '../policy/taint.ts';
import {decideUnknownBuild} from '../policy/unknownBuild.ts';
import {classOfType} from '../policy/util.ts';
import {listedEntryOf, thirdPartyOutcome, verifyItem} from '../policy/verifyItem.ts';
import type {AlertBook} from './alerts.ts';
import {Allowances} from './allowances.ts';
import {DeepVerifyBudget} from './budget.ts';
import {FAULT_DECISION, itemDecision} from './decide.ts';
import {RetainedBytes} from './retained.ts';
import {addPending, newSession, putItem, recordKey, SessionTable, worsened} from './sessions.ts';
import {buildTabState, summarize, tabTop} from './tabState.ts';
import {TaintBook} from './taint.ts';
import type {ContentPayloads, EngineRuntime, SessionRec} from './types.ts';
import {hintedKey, unknownBuildView, unknownInput, withDecision} from './unknownBuild.ts';
import {originOf, pathOf, randomHex, redact} from './urls.ts';

export interface EngineDeps {
  readonly ext: Ext;
  readonly backend: ObservingBackend;
  readonly registry: ProfileRegistry;
  readonly trust: TrustStore;
  readonly tabSink: TabStateSink;
  readonly alertSink: AlertSink;
  /** Origin alerts and the incident log, shared with the trust store (background/main.ts). */
  readonly alerts: AlertBook;
  readonly now: () => number;
  /** Defaults to platform/storage.ts over `ext`. */
  readonly session?: SessionStore;
  /** setTimeout replacement (tests). */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

type Tried = Extract<BindResult, {k: 'unbound'}>['tried'];

interface ReqInfo {
  obs: RequestObs;
  headers: HeadersObs | null;
  isDocument: boolean;
  status: number | null;
}

/** Per-document state that lives in memory only (lost on restart, recreated where possible). */
interface DocRuntime {
  docReq: RequestId | null;
  core: LoadedCore | null;
  tried: Tried | undefined;
  waiters: (() => void)[];
  timer: unknown;
  unknownTimer: unknown;
  /**
   * The document's own response is held and not decided yet: it has not run, so it is no taint
   * source (a document that is then denied never runs; one that is released becomes one then).
   */
  undecided: boolean;
  /** Headers of recorded bodies (retro-verification), by `recordKey`; lost on restart. */
  evidence: Map<string, {req: RequestId | null; headers: readonly HeaderPair[]; status: number}>;
  /** The frame showed this document (CommittedObs, RevivedObs): what reaches it runs. */
  committed: boolean;
}

const ENDED_PER_TAB = 8;

/**
 * The previous instance died while a filter of `s` was open (or its own had failed before its
 * commit was seen): what reached the page meanwhile was not verified and may have run (R7). A
 * document whose own bytes were never judged is then one nobody verified, not one that never ran.
 */
function restartedWithOpenFilter(s: SessionRec): void {
  s.engineFault = 'verifier-restarted';
  if (s.docClass === 'pending') s.docClass = 'manifest';
}

/** A request still pending this long after it started shows CHECKING. */
const CHECKING_AFTER_MS = 1_600;
/** How long an unknown document's decision waits for the server's version hint. */
const BLOCK_HINT_WAIT_MS = 5_000;
/**
 * How long unknown-build resolution waits for the server's version hint. A hint that does not come
 * counts as a failed fetch (no version), like a network error: amber, never red. Without a bound,
 * one stalled fetch would stall the document's resolution for good (it runs once per document at a
 * time).
 */
const HINT_WAIT_MS = 10_000;

export function createEngine(deps: EngineDeps): EngineRuntime {
  return new EngineImpl(deps);
}

class EngineImpl implements EngineRuntime {
  readonly #d: EngineDeps;
  readonly #session: SessionStore;
  readonly #sessions: SessionTable;
  readonly #alerts: AlertBook;
  readonly #taint: TaintBook;
  readonly #allow: Allowances;
  readonly #budget: DeepVerifyBudget;
  readonly #retained = new RetainedBytes();
  readonly #runtime = new Map<DocKey, DocRuntime>();
  readonly #requests = new Map<RequestId, ReqInfo>();
  readonly #cores = new Map<string, LoadedCore>();
  readonly #inflight = new Set<string>();
  /** The subset of #inflight started as a background retry (a final decision's `ensure`). */
  readonly #retrying = new Set<string>();
  /** Unknown-build resolutions running, one per document; `again` asks for one more run after it. */
  readonly #resolving = new Map<DocKey, {again: boolean; run: Promise<void>}>();
  readonly #publishing = new Map<number, Promise<void>>();
  /** Per-document observation queues: a document's observations are handled in arrival order. */
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #reqKey = new Map<RequestId, string>();
  readonly #waited = new Set<RequestId>();
  #readyResolve!: () => void;
  readonly #ready: Promise<void>;
  #restarted = false;
  /**
   * start() failed (a storage read or write rejected): every session is PROTECTION_LOST
   * internal-error until a start succeeds, so everything is denied (R1).
   */
  #startFailed = false;

  constructor(d: EngineDeps) {
    this.#d = d;
    this.#session = d.session ?? createSessionStore(d.ext);
    this.#sessions = new SessionTable(this.#session);
    this.#alerts = d.alerts;
    this.#taint = new TaintBook(this.#session);
    this.#allow = new Allowances(this.#session);
    this.#budget = new DeepVerifyBudget(this.#session);
    this.#ready = new Promise(r => (this.#readyResolve = r));
    // Listeners are added synchronously (MV3 wake-up); they wait for readiness inside.
    d.ext.tabs.onRemoved.addListener(tab => this.#track(this.#onTabRemoved(tab)));
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    try {
      await Promise.all([
        this.#d.registry.ready(),
        this.#d.trust.ready(),
        this.#alerts.load(),
        this.#budget.load(),
      ]);
      this.#restarted = (await this.#session.get(SESSION_KEYS.boot)) !== undefined;
      await this.#session.set({[SESSION_KEYS.boot]: true});
      if (this.#restarted) await this.#rehydrate();
    } catch (e) {
      // Fail closed (R1): never count a failed start as ready and healthy.
      logWarn('engine-start', {error: errorName(e)});
      this.#startFailed = true;
    } finally {
      this.#readyResolve();
    }
    if (this.#startFailed) await this.#failTabRecords();
    await this.#markOrphanTabs();
    if (this.#restarted) {
      await this.#pruneHolds();
      // Documents that went away while the event page was stopped (an iframe removed, a tab
      // discarded) end once Firefox confirms them gone.
      await this.#endGone(this.#sessions.live());
    }
    for (const s of this.#sessions.live()) await this.#evaluate(s);
  }

  /**
   * The private browsing session ended (no private tab left): its alerts and incidents go, and
   * the open documents of the origins it had alerts for are evaluated again, so that none stays
   * RECOVERING for an alert that is gone.
   */
  async #purgePrivateIfLast(): Promise<void> {
    let tabs: Awaited<ReturnType<Ext['tabs']['query']>>;
    try {
      tabs = await this.#d.ext.tabs.query({});
    } catch {
      return;
    }
    if (tabs.some(t => t.incognito === true)) return;
    for (const origin of await this.#alerts.purgePrivate()) {
      for (const s of this.#sessions.liveByOrigin(origin)) await this.#evaluate(s);
    }
  }

  /**
   * After a failed start no tab record may still claim a state better than PROTECTION_LOST
   * internal-error (a VERIFIED record of the previous instance, of a document the engine can no
   * longer judge); live sessions republish theirs when they are evaluated. The persisted session
   * records of live documents get the engine fault too: while this instance runs, nothing of theirs
   * is judged, so a later start that succeeds must not rehydrate one as VERIFIED (R6).
   */
  async #failTabRecords(): Promise<void> {
    try {
      for (const s of this.#sessions.all()) {
        if (s.engineFault !== null) continue;
        s.engineFault = 'internal-error';
        void this.#sessions.touch(s.doc);
      }
      const docs = await this.#session.getMany<SessionRec>(await this.#session.keys('s:v1:doc:'));
      const failed: Record<string, SessionRec> = {};
      for (const [k, rec] of Object.entries(docs)) {
        if (typeof rec !== 'object' || rec === null || rec.alive !== true) continue;
        if (rec.engineFault !== null || this.#sessions.get(rec.doc) !== undefined) continue;
        failed[k] = {...rec, engineFault: 'internal-error'};
      }
      if (Object.keys(failed).length > 0) await this.#session.set(failed);
    } catch (e) {
      logWarn('engine-start-docs', {error: errorName(e)});
    }
    try {
      const recs = await this.#session.getMany<TabStateRecord>(
        await this.#session.keys('s:v1:tab:'),
      );
      for (const rec of Object.values(recs)) {
        if (typeof rec?.tab !== 'number' || rankOf(rec.state) >= rankOf('PROTECTION_LOST'))
          continue;
        const failed: TabStateRecord = {
          ...rec,
          updatedAt: this.#now(),
          state: 'PROTECTION_LOST',
          reasons: ['internal-error'],
          flags: [],
        };
        await this.#session.set({[SESSION_KEYS.tab(rec.tab)]: failed});
        await this.#notifyTab(rec.tab);
      }
    } catch (e) {
      logWarn('engine-start-tabs', {error: errorName(e)});
    }
  }

  /** Taint holds of tabs closed while the event page was stopped end. */
  async #pruneHolds(): Promise<void> {
    for (const tab of this.#taint.heldTabs()) {
      try {
        await this.#d.ext.tabs.get(tab);
      } catch {
        await this.#taint.releaseTab(tab);
      }
    }
  }

  whenReady(): Promise<void> {
    return this.#ready;
  }

  #track(p: Promise<unknown>): void {
    void p.catch((e: unknown) => logWarn('engine-task', {error: errorName(e)}));
  }

  #now(): number {
    return this.#d.now();
  }

  #timer(fn: () => void, ms: number): unknown {
    return (this.#d.setTimer ?? ((f, t) => setTimeout(f, t)))(fn, Math.max(0, ms));
  }

  #clear(h: unknown): void {
    if (h === null || h === undefined) return;
    (this.#d.clearTimer ?? (x => clearTimeout(x as ReturnType<typeof setTimeout>)))(h);
  }

  #rt(doc: DocKey): DocRuntime {
    let r = this.#runtime.get(doc);
    if (r === undefined) {
      r = {
        docReq: null,
        core: null,
        tried: undefined,
        waiters: [],
        timer: null,
        unknownTimer: null,
        undecided: false,
        evidence: new Map(),
        committed: false,
      };
      this.#runtime.set(doc, r);
    }
    return r;
  }

  #origin(s: SessionRec): ProtectedOrigin | null {
    return this.#d.registry.lookup(s.origin);
  }

  async #rehydrate(): Promise<void> {
    const recs = await this.#sessions.rehydrate();
    await Promise.all([this.#taint.rehydrate(), this.#allow.rehydrate()]);
    for (const s of recs) {
      // A request still pending when the previous instance died had an open filter: its bytes may
      // have run unverified (R7). The backend reports the same filter (engine-fault); this covers
      // it once, without waiting for an R4 timeout of a request no listener holds any more. A live
      // document whose own filter failed before its commit was seen is the same: this instance can
      // no longer tell whether it committed (the frame's loading documents are not kept), so its
      // unfiltered bytes may have run.
      if (s.alive && (Object.keys(s.pending).length > 0 || s.uncommittedFailure !== null)) {
        s.pending = {};
        s.uncommittedFailure = null;
        restartedWithOpenFilter(s);
      }
      if (s.alive && s.binding === null && s.docClass === 'manifest' && s.unknownBuild !== null) {
        this.#track(this.#resolveUnknown(s));
      }
    }
  }

  /**
   * A protected tab without a live session shows a document the backend never saw: it loaded
   * before IntactWarden started (install, update, enable; R2), before its server was added (`why`,
   * from originsChanged), or while the event page was stopped and its frame map was lost (R7). Its
   * top frame is adopted (`#adoptDoc`): PROTECTION_LOST, and a taint source until it ends.
   * Otherwise a bare record is written: `permission-revoked` when the origin's host permission is
   * missing (the grant runs originsChanged, which adopts the tab then), `internal-error` after a
   * failed start, else (a load already pending in the frame) `untracked`, or `verifier-restarted`
   * after a restart.
   *
   * Discarded tabs show nothing. At a first start a loading tab is left to the load the backend
   * observes; when a server is added, a loading tab is marked too (its load began before the
   * backend watched the origin, and a load it does observe rewrites the record). When servers
   * change, a record left for a tab whose origin is no longer protected is rebuilt from the live
   * sessions of protected origins, which removes it.
   */
  async #markOrphanTabs(why: 'untracked' | null = null): Promise<void> {
    let tabs: Awaited<ReturnType<Ext['tabs']['query']>> = [];
    try {
      tabs = await this.#d.ext.tabs.query({});
    } catch {
      return;
    }
    for (const t of tabs) {
      if (t.id === undefined || t.url === undefined || t.discarded === true) continue;
      if (why === null && !this.#restarted && t.status === 'loading') continue;
      const origin = originOf(t.url);
      const po = origin === null ? null : this.#d.registry.lookup(origin);
      if (po === null) {
        if (why !== null && (await this.#session.get(SESSION_KEYS.tab(t.id))) !== undefined)
          await this.#publishTab(t.id);
        continue;
      }
      if (this.#sessions.byTab(t.id).some(s => s.alive)) continue;
      const fault = why ?? (this.#restarted ? 'verifier-restarted' : 'untracked');
      if (po.granted && !this.#startFailed) {
        const url = redact(t.url);
        const doc = this.#d.backend.adopt(t.id, 0, url);
        const adopted =
          doc === null
            ? undefined
            : await this.#adoptDoc(doc, t.id, 0, url, t.incognito === true, fault).catch(
                (e: unknown) => void logWarn('engine-adopt', {error: errorName(e)}),
              );
        if (adopted !== undefined) continue;
      }
      const reason = !po.granted
        ? 'permission-revoked'
        : this.#startFailed
          ? 'internal-error'
          : fault;
      const rec: TabStateRecord = {
        v: 1,
        tab: t.id,
        updatedAt: this.#now(),
        origin: po.origin,
        app: po.app,
        deploymentId: po.deployment.id,
        kind: po.kind,
        instance: null,
        state: 'PROTECTION_LOST',
        reasons: [reason],
        flags: [],
        top: null,
        frames: [],
        hint: null,
        unknownBuild: null,
        alert: this.#alerts.get(po.origin),
        allowances: this.#allow.get(t.id),
        permissionMissing: !po.granted,
      };
      await this.#session.set({[SESSION_KEYS.tab(t.id)]: rec});
      await this.#notifyTab(t.id);
    }
  }

  // -------------------------------------------------------------------------
  // ObservationSink

  async push(o: Observation): Promise<Decision> {
    await this.#ready;
    const key = this.#queueKey(o);
    if (o.k === 'request' && this.#registersNow(o)) {
      // A request of a known document only registers (pending, R4 timer): it never waits for the
      // document's queue, so R4 runs from the request's start even while the queue is busy.
      return this.#dispatchSafe(o) as Promise<Decision>;
    }
    const r = await this.#enqueue(key, () => this.#dispatchSafe(o));
    if (r instanceof Deferred) {
      await r.wait;
      const again = await this.#enqueue(key, () => this.#dispatchSafe(o));
      return again instanceof Deferred ? this.#fault(o) : again;
    }
    return r;
  }

  /** Whether `#onRequest` only registers this request (a live, protected session owns it). */
  #registersNow(o: RequestObs): boolean {
    return o.doc !== null && this.#sessions.get(o.doc)?.alive === true;
  }

  async #dispatchSafe(o: Observation): Promise<Decision | Deferred> {
    try {
      return await this.#dispatch(o);
    } catch (e) {
      logWarn('engine-push', {kind: o.k, error: errorName(e)});
      return this.#fault(o);
    }
  }

  #enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    return run;
  }

  #noteReq(req: RequestId, key: string): void {
    this.#reqKey.set(req, key);
    if (this.#reqKey.size > 20_000) {
      const first = this.#reqKey.keys().next().value;
      if (first !== undefined) this.#reqKey.delete(first);
    }
  }

  #queueKey(o: Observation): string {
    switch (o.k) {
      case 'doc-start':
        if (o.req !== null) this.#noteReq(o.req, o.doc);
        return o.doc;
      case 'request': {
        const k = o.doc ?? `tab:${o.tab}`;
        this.#noteReq(o.req, k);
        return k;
      }
      case 'redirect':
      case 'body':
      case 'completed':
      case 'unverifiable':
        return this.#reqKey.get(o.req) ?? this.#requests.get(o.req)?.obs.doc ?? 'global';
      case 'revived':
      case 'committed':
      case 'doc-end':
      case 'unwatched-doc':
        return o.doc;
      case 'opened':
      case 'blob-doc':
        return 'global';
      case 'engine-fault':
        return o.doc ?? 'global';
    }
  }

  async headers(h: HeadersObs, r: RequestObs): Promise<HeaderDecision> {
    await this.#ready;
    const key = this.#reqKey.get(h.req) ?? r.doc ?? 'global';
    return this.#enqueue(key, () => this.#headersSafe(h, r));
  }

  async #headersSafe(h: HeadersObs, r: RequestObs): Promise<HeaderDecision> {
    const s = this.#sessions.get(r.doc);
    try {
      return await this.#headers(h, r);
    } catch (e) {
      logWarn('engine-headers', {error: errorName(e)});
      if (s !== undefined) await this.#faulted(s);
      // Fail closed (R1).
      return {act: s === undefined ? 'allow' : 'cancel'};
    }
  }

  /**
   * A response whose session is gone or was never created (R1, fail closed): denied when it is for
   * a protected origin; nothing to deny otherwise.
   */
  #orphanDecision(url: string | undefined): Decision {
    const origin = url === undefined ? null : originOf(url);
    const po = origin === null ? null : this.#d.registry.lookup(origin);
    return po === null ? {act: 'allow'} : FAULT_DECISION;
  }

  async #fault(o: Observation): Promise<Decision> {
    const req = 'req' in o && typeof o.req === 'string' ? o.req : '';
    const doc = 'doc' in o && typeof o.doc === 'string' ? o.doc : this.#requests.get(req)?.obs.doc;
    const s = this.#sessions.get(doc ?? null);
    if (s === undefined) {
      const url =
        'url' in o && typeof o.url === 'string' ? o.url : this.#requests.get(req)?.obs.url;
      return this.#orphanDecision(url);
    }
    await this.#faulted(s);
    return FAULT_DECISION;
  }

  /**
   * An entry point threw for `s` (R1): the session is PROTECTION_LOST internal-error from now on.
   * When its evaluation throws as well (storage.session rejects a write, as when its quota is
   * full), nothing was published, so the tab's stored record must not go on claiming a better
   * state: it is replaced by a bare PROTECTION_LOST internal-error record, which is smaller than
   * the one it replaces and so fits a full quota, or removed when that write fails too. Never
   * throws.
   */
  async #faulted(s: SessionRec): Promise<void> {
    s.engineFault = 'internal-error';
    try {
      await this.#evaluate(s);
      return;
    } catch (e) {
      logWarn('engine-fault', {error: errorName(e)});
    }
    if (s.tab < 0) return;
    const key = SESSION_KEYS.tab(s.tab);
    try {
      const rec = await this.#session.get<TabStateRecord>(key);
      if (typeof rec?.tab !== 'number' || rankOf(rec.state) >= rankOf('PROTECTION_LOST')) return;
      const failed: TabStateRecord = {
        ...rec,
        updatedAt: this.#now(),
        state: 'PROTECTION_LOST',
        reasons: ['internal-error'],
        flags: [],
        top: null,
        frames: [],
        unknownBuild: null,
      };
      await this.#session.set({[key]: failed});
    } catch {
      await this.#session.remove(key).catch(() => undefined);
    }
    await this.#notifyTab(s.tab);
  }

  async #dispatch(o: Observation): Promise<Decision | Deferred> {
    switch (o.k) {
      case 'doc-start':
        await this.#onDocStart(o);
        return {act: 'allow'};
      case 'request':
        return this.#onRequest(o);
      case 'redirect': {
        const info = this.#requests.get(o.req);
        if (info !== undefined) {
          const s = this.#sessions.get(info.obs.doc);
          if (s !== undefined) delete s.pending[o.req];
        }
        return {act: 'allow'};
      }
      case 'body':
        return this.#onBody(o);
      case 'completed':
        await this.#onCompleted(o.req, o.status);
        return {act: 'allow'};
      case 'unverifiable':
        return this.#onUnverifiable(o);
      case 'revived': {
        const s = this.#sessions.get(o.doc);
        if (s !== undefined && !s.alive) await this.#revive(s);
        if (s !== undefined) await this.#onCommitted(s);
        return {act: 'allow'};
      }
      case 'committed': {
        const s = this.#sessions.get(o.doc);
        if (s !== undefined) await this.#onCommitted(s);
        return {act: 'allow'};
      }
      case 'doc-end':
        await this.#endDoc(o.doc);
        return {act: 'allow'};
      case 'opened':
        await this.#onOpened(o);
        return {act: 'allow'};
      case 'blob-doc':
        // An unverified document no request names: its tab holds the taint until it closes.
        await this.#holdTab(o.origin, o.tab, 'unverifiable', 'blob:');
        return {act: 'allow'};
      case 'unwatched-doc': {
        let incognito = false;
        try {
          incognito = (await this.#d.ext.tabs.get(o.tab)).incognito === true;
        } catch {
          // The tab is gone already; its removal ends the session.
        }
        await this.#adoptDoc(o.doc, o.tab, o.frame, o.url, incognito, 'untracked');
        return {act: 'allow'};
      }
      case 'engine-fault': {
        const targets =
          o.doc !== undefined
            ? [this.#sessions.get(o.doc)].filter((s): s is SessionRec => s !== undefined)
            : o.origin !== undefined
              ? this.#sessions.liveByOrigin(o.origin)
              : [];
        for (const s of targets) {
          if (o.fault === 'verifier-restarted') restartedWithOpenFilter(s);
          else s.engineFault = o.fault;
          await this.#evaluate(s);
        }
        return {act: 'allow'};
      }
    }
  }

  // -------------------------------------------------------------------------
  // Documents

  async #onDocStart(o: DocStartObs): Promise<void> {
    const origin = originOf(o.url);
    const po = origin === null ? null : this.#d.registry.lookup(origin);
    if (po === null) {
      if (o.type === 'main_frame') await this.#publishTab(o.tab);
      return;
    }
    if (this.#sessions.get(o.doc) !== undefined) {
      const rt = this.#rt(o.doc);
      if (rt.docReq === null && o.req !== null) this.#rememberDocRequest(o);
      return;
    }
    const s = newSession(o, po, this.#now());
    // The document this one replaces in the same frame cannot script it: not a co-resident.
    const replaced = new Set(
      this.#sessions
        .byTab(o.tab)
        .filter(x => x.alive && (x.frame === o.frame || (o.frame === 0 && x.doc !== o.doc)))
        .map(x => x.doc),
    );
    await this.#endGoneSources(s.origin);
    this.#taint.flag(s, this.#now(), replaced);
    await this.#pruneEnded(o.tab);
    await this.#sessions.add(s);
    // Once the session exists, so that the document's own request is pending like any other: never
    // green until it is decided, R4, and the restart rule (#rehydrate).
    if (o.req !== null) this.#rememberDocRequest(o);
    await this.#evaluate(s);
  }

  #rememberDocRequest(o: DocStartObs): void {
    if (o.req === null) return;
    const rt = this.#rt(o.doc);
    rt.docReq = o.req;
    rt.undecided = true;
    this.#requests.set(o.req, {
      obs: {
        k: 'request',
        at: o.at,
        req: o.req,
        doc: o.doc,
        tab: o.tab,
        frame: o.frame,
        url: o.url,
        type: o.type,
      },
      headers: null,
      isDocument: true,
      status: null,
    });
    const s = this.#sessions.get(o.doc);
    if (s !== undefined) {
      addPending(s, o.req, {path: s.path, type: o.type, since: o.at, url: o.url});
    }
  }

  async #pruneEnded(tab: number): Promise<void> {
    const ended = this.#sessions
      .byTab(tab)
      .filter(s => !s.alive)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const s of ended.slice(ENDED_PER_TAB)) await this.#forget(s.doc);
  }

  async #forget(doc: DocKey): Promise<void> {
    const rt = this.#runtime.get(doc);
    if (rt !== undefined) {
      this.#clear(rt.timer);
      this.#clear(rt.unknownTimer);
      for (const w of rt.waiters) w();
    }
    this.#runtime.delete(doc);
    this.#retained.dropDoc(doc);
    for (const [req, info] of this.#requests) {
      if (info.obs.doc !== doc) continue;
      this.#requests.delete(req);
      this.#reqKey.delete(req);
      this.#waited.delete(req);
    }
    await this.#sessions.remove(doc);
  }

  async #onDocumentBody(s: SessionRec, info: ReqInfo, o: BodyObs): Promise<Decision> {
    const po = this.#origin(s);
    if (po === null) return {act: 'allow'};
    const rt = this.#rt(s.doc);
    const status = info.status ?? info.headers?.status ?? 200;
    s.docSha256 = o.sha256;
    if (info.headers === null) {
      // The response headers were never observed (the backend's header stage failed): the header
      // guard did not run and the document got no CSP floor, so it is unverifiable (R1), as a
      // subresource is in #itemFor.
      if (s.docClass === 'pending') s.docClass = 'manifest';
      const reason = po.granted ? 'internal-error' : 'no-host-permission';
      putItem(s, this.#docItem(s, info, {r: 'unverifiable', reason}, o));
      for (const w of rt.waiters.splice(0)) w();
      return this.#documentDecision(s, await this.#evaluate(s));
    }
    const cls = classifyServerPath(po, info.obs.url, info.obs.type);
    switch (cls.k) {
      case 'server-rendered':
        s.docClass = 'server-rendered';
        s.docClassDetail = cls.class;
        break;
      case 'not-covered':
        s.docClass = 'not-covered';
        s.docClassDetail = cls.reason;
        break;
      case 'dynamic':
        s.docClass = 'dynamic-document';
        break;
      case 'build':
        break;
      default:
        s.docClass = 'unknown';
        s.docClassDetail = cls.k;
    }
    if (cls.k !== 'build') return this.#documentDecision(s, await this.#evaluate(s));
    // An empty document body under any content status (every 2xx, 304) is
    // unverifiable, never evidence of another release.
    if (o.size === 0 && ((status >= 200 && status < 300) || status === 304)) {
      s.docClass = 'manifest';
      putItem(s, this.#docItem(s, info, {r: 'unverifiable', reason: 'empty-body'}, o));
      return this.#documentDecision(s, await this.#evaluate(s));
    }
    const candidates = await this.#d.trust.candidates({
      app: po.app,
      variant: po.deployment.variant as ReleaseKey['variant'],
      hintVersion: s.unknownBuild?.hint?.version ?? null,
    });
    const body: BodyEvidence = {
      sha256: o.sha256,
      size: o.size,
      ...(o.bytes !== undefined ? {bytes: o.bytes} : {}),
    };
    const r = await bindDocument({
      origin: po,
      url: info.obs.url,
      status,
      body,
      candidates,
      now: this.#now(),
    });
    switch (r.k) {
      case 'bound':
        await this.#applyBinding(s, r.binding, r.core, false);
        break;
      case 'invalid':
        s.docClass = 'unknown';
        s.docClassDetail = 'invalid';
        break;
      case 'unbound':
        s.docClass = 'manifest';
        rt.tried = r.tried;
        if (o.bytes !== undefined) this.#retained.put(s.doc, s.path, o.bytes);
        s.unknownBuild ??= {
          since: this.#now(),
          sha256: o.sha256,
          size: o.size,
          hint: null,
          attempts: [],
          decision: null,
        };
        this.#decideUnknown(s, po);
        if (s.unknownBuild.decision?.k === 'fetch-hint') {
          // The response is held anyway: with the server's version hint first, a document that
          // contradicts a release already known is denied as MISMATCH (release-differs: blocked
          // page, red alert), not as NEW_BUILD on a blocked page that has nothing to wait for
          //.
          await this.#hintWithin(s, po, BLOCK_HINT_WAIT_MS);
          // The release may have become known meanwhile (another tab's deep verify): the
          // document, still held, binds against the candidates as they are now, like any load.
          if (await this.#tryBind(s, false)) break;
          this.#decideUnknown(s, po);
        }
        this.#track(this.#resolveUnknown(s));
        break;
    }
    const ev = await this.#evaluate(s);
    if (s.binding !== null && s.incognito !== true)
      this.#track(this.#alerts.noteSeen(s.origin, s.binding.buildId, s.binding.version));
    return this.#documentDecision(s, ev);
  }

  #docItem(s: SessionRec, info: ReqInfo, outcome: ItemRecord['outcome'], o?: BodyObs): ItemRecord {
    return {
      req: info.obs.req,
      path: s.path,
      url: info.obs.url,
      type: info.obs.type,
      cls: 'document',
      key: null,
      outcome,
      at: this.#now(),
      ...(o !== undefined ? {sha256: o.sha256, size: o.size} : {}),
    };
  }

  async #applyBinding(
    s: SessionRec,
    binding: NonNullable<SessionRec['binding']>,
    core: LoadedCore,
    retro: boolean,
  ): Promise<void> {
    const b = {...binding, retro};
    // The binding becomes visible together with the retro results, in one synchronous step: an
    // evaluation in between would see recorded items under a bound document (an engine fault that
    // R6 keeps for the document's life).
    const judged = retro ? await this.#retroItems(s, core, b) : null;
    s.binding = b;
    s.docVerified = true;
    s.docClass = 'manifest';
    for (const [path, item] of Object.entries(s.items)) {
      const r = judged?.get(item);
      if (r !== undefined) s.items[path] = r;
    }
    const rt = this.#rt(s.doc);
    rt.core = core;
    this.#cores.set(core.ref.sha256, core);
    for (const w of rt.waiters.splice(0)) w();
  }

  async #documentDecision(s: SessionRec, ev: Evaluation): Promise<Decision> {
    this.#rt(s.doc).undecided = false;
    const allowances = this.#allow.get(s.tab);
    let d: Decision;
    let fault = false;
    try {
      d = decisionFor(ev, allowances, s.docSha256);
    } catch {
      d = FAULT_DECISION;
      fault = true;
    }
    // A denied document that is released all the same is one the user chose to proceed with once.
    if (
      d.act === 'allow' &&
      ev.action === 'deny' &&
      s.docSha256 !== null &&
      allowances?.proceedOnce.includes(s.docSha256)
    ) {
      await this.#allow.consumeProceedOnce(s.tab, s.docSha256);
      await this.#incident(s, 'proceed-once', ev);
    }
    if (d.act !== 'block') {
      // Released: from now on it runs, and taints its origin if it is a source.
      await this.#taintUpdate(s);
      return d;
    }
    s.blocked = true;
    const denial = ev.denial ?? ev;
    const kind = this.#incidentKind(denial.state);
    // A document denied where nothing ran and nothing points to an attack (an unknown or
    // server-rendered page, one whose bytes could not be read) is no incident: its blocked page
    // reads a record that is never listed. Attack evidence and unverified builds are incidents.
    const quiet = ev.alert === null && kind === 'protection-lost';
    const incidentId = quiet
      ? await this.#denialRecord(s, denial)
      : await this.#incident(s, kind, denial);
    await this.#evaluate(s);
    // The incident id makes the backend replace a top-level document with the blocked page. Not
    // on a fault: the incident records the evaluation, not the fault, so the page would mislead.
    return s.topLevel && !fault
      ? {...d, incidentId}
      : {act: 'block', state: d.state, reason: d.reason};
  }

  #incidentKind(state: SessionRec['state']): IncidentKind {
    switch (state) {
      case 'MISMATCH':
        return 'mismatch';
      case 'DISPUTED':
        return 'release-disputed';
      case 'BUILD_UNVERIFIED':
      case 'NEW_BUILD':
        return 'build-unverified';
      default:
        return 'protection-lost';
    }
  }

  /** The record the blocked page of a denial without evidence reads (top-level documents only). */
  async #denialRecord(s: SessionRec, ev: Pick<Evaluation, 'state' | 'reasons'>): Promise<string> {
    if (!s.topLevel) return '';
    return this.#alerts.denial(
      {
        kind: 'protection-lost',
        origin: s.origin,
        path: s.path,
        state: ev.state,
        reasons: ev.reasons,
        buildId: s.binding?.buildId ?? null,
        expected: null,
        observed: s.docSha256,
      },
      s.incognito === true,
    );
  }

  async #incident(
    s: SessionRec,
    kind: IncidentKind,
    ev: Pick<Evaluation, 'state' | 'reasons'>,
  ): Promise<string> {
    const logged = s.incidentId ?? null;
    if (logged !== null && s.incidentState === `${kind}:${ev.state}`) return logged;
    // Claimed before the write: the denial of a document and its alert, evaluated concurrently (the
    // unknown-build resolution runs beside the document's queue), log one incident, not two.
    const id = randomHex(8);
    s.incidentId = id;
    s.incidentState = `${kind}:${ev.state}`;
    const bad = Object.values(s.items).find(i => i.outcome.r === 'mismatch');
    await this.#alerts.incident(
      {
        kind,
        origin: s.origin,
        path: bad?.path ?? s.path,
        state: ev.state,
        reasons: ev.reasons,
        buildId: s.binding?.buildId ?? null,
        expected:
          typeof bad?.expected === 'string' && bad.expected !== 'template' ? bad.expected : null,
        observed: bad?.sha256 ?? s.docSha256,
      },
      s.incognito === true,
      id,
    );
    this.#track(this.#sessions.touch(s.doc));
    return id;
  }

  // -------------------------------------------------------------------------
  // Requests, bodies, subresources

  async #onRequest(o: RequestObs): Promise<Decision> {
    const s = this.#sessions.get(o.doc);
    if (s === undefined) {
      const origin = originOf(o.url);
      const po = origin === null ? null : this.#d.registry.lookup(origin);
      if (po === null) return {act: 'allow'};
      // R2: a request to a protected origin that no known document owns.
      return this.#untracked(o, po);
    }
    const existing = this.#requests.get(o.req);
    this.#requests.set(o.req, {
      obs: o,
      headers: existing?.headers ?? null,
      isDocument: false,
      status: existing?.status ?? null,
    });
    const path = originOf(o.url) === s.origin ? (pathOf(o.url) ?? o.url) : o.url;
    addPending(s, o.req, {path, type: o.type, since: o.at, url: o.url});
    void this.#sessions.touch(s.doc);
    this.#schedule(s);
    return {act: 'allow'};
  }

  async #untracked(o: RequestObs, po: ProtectedOrigin): Promise<Decision> {
    // Only documents of the request's own tab. A request outside any tab (another extension's
    // background fetch, a shared or service worker) names no document: marking every live session
    // of the origin would let any extension turn every vault tab PROTECTION_LOST. It is still
    // denied below; a service worker is caught on its own (the failed filter or missing headers
    // of what it answers, the service-worker sensor).
    const targets =
      o.tab >= 0 ? this.#sessions.byTab(o.tab).filter(s => s.alive && s.origin === po.origin) : [];
    for (const s of targets) {
      s.untracked = true;
      await this.#evaluate(s);
    }
    // Only covered requests come here (the backend has cancelled them already). Every one is
    // denied: a locale or a `.wasm` read by fetch() is no less what the page runs on than a script
    // (R2).
    return {act: 'block', state: 'PROTECTION_LOST', reason: 'untracked'};
  }

  async #onBody(o: BodyObs): Promise<Decision | Deferred> {
    const info = this.#requests.get(o.req);
    // No request record: the request of a forgotten document or of a session the engine lost (fail
    // closed), or of a document whose server was removed while the request was in flight.
    if (info === undefined) return this.#orphanDecision(o.url);
    const s = this.#sessions.get(info.obs.doc);
    if (s === undefined) return this.#orphanDecision(info.obs.url);
    delete s.pending[o.req];
    if (info.isDocument && this.#rt(s.doc).docReq === o.req)
      return this.#onDocumentBody(s, info, o);
    return this.#onSubresourceBody(s, info, o);
  }

  async #waitForBinding(s: SessionRec): Promise<void> {
    if (s.docClass !== 'pending') return;
    const rt = this.#rt(s.doc);
    await new Promise<void>(resolve => {
      const h = this.#timer(resolve, SESSION_LIMITS.unboundWaitMs);
      rt.waiters.push(() => {
        this.#clear(h);
        resolve();
      });
    });
  }

  async #onSubresourceBody(s: SessionRec, info: ReqInfo, o: BodyObs): Promise<Decision | Deferred> {
    if (s.docClass === 'pending' && !this.#waited.has(o.req)) {
      // Wait (outside the document's queue) up to 5 s for the binding, then judge again.
      this.#waited.add(o.req);
      const path =
        originOf(info.obs.url) === s.origin ? (pathOf(info.obs.url) ?? info.obs.url) : info.obs.url;
      s.pending[o.req] = {path, type: info.obs.type, since: info.obs.at, url: info.obs.url};
      return new Deferred(this.#waitForBinding(s));
    }
    this.#waited.delete(o.req);
    const item = await this.#itemFor(s, info, o);
    if (cutOff(o, item.outcome)) {
      // Not judged and not released: the request ends as an aborted one does.
      await this.#evaluate(s);
      return {act: 'block', state: s.state, reason: null};
    }
    putItem(s, item);
    const ev = await this.#evaluate(s);
    return itemDecision(item, ev, this.#allow.get(s.tab));
  }

  /** The item record of a body (or of a header-only classification when `o` is null). */
  async #itemFor(s: SessionRec, info: ReqInfo, o: BodyObs | null): Promise<ItemRecord> {
    const po = this.#origin(s);
    const url = info.obs.url;
    const sameOrigin = originOf(url) === s.origin;
    const path = sameOrigin ? (pathOf(url) ?? url) : url;
    const base: ItemRecord = {
      req: info.obs.req,
      path,
      url,
      type: info.obs.type,
      cls: sameOrigin ? classOfType(info.obs.type, path) : 'third-party',
      key: null,
      outcome: {r: 'passive'},
      at: this.#now(),
      ...(o !== null ? {sha256: o.sha256, size: o.size} : {}),
    };
    if (s.docClass === 'pending') return {...base, outcome: {r: 'unverifiable', reason: 'unbound'}};
    if (po === null) return {...base, outcome: {r: 'unverifiable', reason: 'no-host-permission'}};
    if (o !== null && info.headers === null && !info.isDocument) {
      // The response headers were never observed: the host permission was revoked while the
      // request was in flight, so the backend stopped reporting it, or a service worker answered
      // the request (Firefox reports no response headers for its answer). The header checks
      // cannot run. That is not evidence of a header violation, so the item is unverifiable, not
      // a MISMATCH (red needs evidence).
      return {
        ...base,
        outcome: {r: 'unverifiable', reason: po.granted ? 'internal-error' : 'no-host-permission'},
      };
    }
    const status = info.status ?? info.headers?.status ?? 200;
    const headers = info.headers?.headers ?? [];
    if (s.binding !== null) {
      const core = await this.#coreFor(s);
      if (core === null) return {...base, outcome: {r: 'unverifiable', reason: 'internal-error'}};
      const item = await verifyItem({
        origin: po,
        core,
        binding: s.binding,
        request: info.obs,
        status,
        headers,
        body:
          o === null
            ? null
            : {
                sha256: o.sha256,
                size: o.size,
                ...(o.bytes !== undefined ? {bytes: o.bytes} : {}),
              },
        allowedThirdParty: s.allowedThirdParty?.id ?? null,
        now: this.#now(),
      });
      if (item.cls === 'server-style' && o !== null) this.#recordStyle(s, po, item, o);
      return item;
    }
    if (s.docClass === 'manifest') {
      // A document whose own bytes were never judged (adopted by hello, R2/R7, or its body was
      // empty or unverifiable) can never bind: nothing is kept for a retro-verification that never
      // comes, and the item is unverifiable, so it is denied.
      if (s.unknownBuild === null)
        return {...base, outcome: {r: 'unverifiable', reason: 'unbound'}};
      // Nothing is kept of a body that is not judged.
      if (o !== null && cutOff(o, {r: 'recorded'})) return {...base, outcome: {r: 'recorded'}};
      // Unbound document (unknown build): keep the evidence for retro-verification. Status and
      // Content-Type go into the persisted item too, so exact entries survive a restart.
      const rt = this.#rt(s.doc);
      const key = recordKey(path, o?.sha256);
      rt.evidence.set(key, {req: info.obs.req, headers, status});
      if (o?.bytes !== undefined && sameOrigin) this.#retained.put(s.doc, key, o.bytes);
      const ctype = headers.find(([n]) => n === 'content-type')?.[1];
      return {
        ...base,
        outcome: {r: 'recorded'},
        status,
        ...(ctype !== undefined ? {ctype: ctype.slice(0, 256)} : {}),
      };
    }
    // Subresources of declared non-manifest documents are not verifiable: counted only.
    return base;
  }

  #recordStyle(s: SessionRec, po: ProtectedOrigin, item: ItemRecord, o: BodyObs): void {
    const cls = classifyServerPath(po, item.url, item.type);
    if (cls.k !== 'server-style') return;
    if (o.bytes === undefined) return;
    const check = checkServerStyle(cls.style.validator, o.bytes);
    s.serverStyles[item.path] = check.ok
      ? {
          sha256: o.sha256,
          accepted: true,
          hidden: check.hidden.slice(0, SESSION_LIMITS.hiddenSelectors),
        }
      : {sha256: o.sha256, accepted: false, hidden: [], reason: check.reason};
  }

  async #coreFor(s: SessionRec): Promise<LoadedCore | null> {
    if (s.binding === null) return null;
    const rt = this.#rt(s.doc);
    if (rt.core !== null && rt.core.ref.sha256 === s.binding.coreSha256) return rt.core;
    const cached = this.#cores.get(s.binding.coreSha256);
    if (cached !== undefined) return (rt.core = cached);
    const core = await this.#d.trust.getCoreBySha256(s.binding.coreSha256);
    if (core !== null) {
      this.#cores.set(core.ref.sha256, core);
      rt.core = core;
    }
    return core;
  }

  async #onUnverifiable(o: UnverifiableObs): Promise<Decision> {
    const info = this.#requests.get(o.req);
    if (info === undefined) return this.#orphanDecision(o.url);
    const s = this.#sessions.get(info.obs.doc);
    if (s === undefined) return this.#orphanDecision(info.obs.url);
    const sameOrigin = originOf(info.obs.url) === s.origin;
    const path = info.isDocument
      ? s.path
      : sameOrigin
        ? (pathOf(info.obs.url) ?? info.obs.url)
        : info.obs.url;
    const isDoc = info.isDocument && this.#rt(s.doc).docReq === o.req;
    if (isDoc && o.delivered) {
      // The document's bytes are no longer held, but they reach a page only if its load commits.
      // Until it does nothing of it can run, so the decision waits for that evidence: the commit
      // (now, if the frame already shows it) makes this a filter failure on a shown document; a
      // load that never commits (a newer navigation of the frame cancelled it, its request was
      // aborted) ends quietly. Meanwhile its request stays pending (never green; R4 makes it
      // PROTECTION_LOST timeout, and a later commit still counts), and the failure is kept with the
      // session record, so an event-page restart before the decision counts it as run (#rehydrate).
      const rt = this.#rt(s.doc);
      s.uncommittedFailure = {
        req: o.req,
        path,
        url: info.obs.url,
        type: info.obs.type,
        cls: 'document',
        key: null,
        outcome: {r: 'unverifiable', reason: o.reason, delivered: true},
        at: this.#now(),
      };
      if (rt.committed) await this.#shownDocumentFailed(s);
      else await this.#sessions.touch(s.doc);
      // Nothing holds the response any more: no decision about it is applied.
      return {act: 'block', state: s.state, reason: null};
    }
    delete s.pending[o.req];
    if (isDoc && s.docClass === 'pending') s.docClass = 'manifest';
    // The listed file the response names counts even when passive, when the response was over
    // the buffering budget or reached the page unverified.
    const po = this.#origin(s);
    const core =
      (o.reason === 'too-large' || o.delivered) && !isDoc && sameOrigin
        ? await this.#coreFor(s)
        : null;
    const listed = core !== null && po !== null ? listedEntryOf(po, core, info.obs.url) : null;
    const item: ItemRecord = {
      req: o.req,
      path,
      url: info.obs.url,
      type: info.obs.type,
      cls: isDoc ? 'document' : sameOrigin ? classOfType(info.obs.type, path) : 'third-party',
      key: listed?.key ?? null,
      outcome: {r: 'unverifiable', reason: o.reason, ...(o.delivered ? {delivered: true} : {})},
      at: this.#now(),
    };
    putItem(s, item);
    for (const w of isDoc ? this.#rt(s.doc).waiters.splice(0) : []) w();
    const ev = await this.#evaluate(s);
    if (isDoc) return this.#documentDecision(s, ev);
    return itemDecision(item, ev, this.#allow.get(s.tab));
  }

  /** The frame shows `s` now; a filter failure of its own that waited for the commit counts. */
  async #onCommitted(s: SessionRec): Promise<void> {
    this.#rt(s.doc).committed = true;
    if (s.uncommittedFailure !== null) await this.#shownDocumentFailed(s);
  }

  /**
   * A document whose own filter failed is shown: its bytes reach the page whatever is or was
   * decided (a block decided while it failed is never applied), so it is no denied document that
   * never ran but a filter failure (red, an origin alert) and a taint source until it ends.
   */
  async #shownDocumentFailed(s: SessionRec): Promise<void> {
    const rt = this.#rt(s.doc);
    const item = s.uncommittedFailure;
    if (item === null) return;
    s.uncommittedFailure = null;
    if (item.req !== null) delete s.pending[item.req];
    if (s.docClass === 'pending') s.docClass = 'manifest';
    putItem(s, item);
    for (const w of rt.waiters.splice(0)) w();
    rt.undecided = false;
    s.blocked = false;
    await this.#evaluate(s);
  }

  async #onCompleted(req: RequestId, status: number): Promise<void> {
    const info = this.#requests.get(req);
    if (info === undefined) return;
    info.status = status;
    const s = this.#sessions.get(info.obs.doc);
    if (s === undefined) return;
    if (status === 0) {
      // Aborted: nothing was delivered to the page.
      delete s.pending[req];
      void this.#sessions.touch(s.doc);
    }
  }

  // -------------------------------------------------------------------------
  // Header guard

  async #headers(h: HeadersObs, r: RequestObs): Promise<HeaderDecision> {
    const info = this.#requests.get(h.req);
    if (info !== undefined) {
      info.headers = h;
      info.status = h.status;
    }
    const s = this.#sessions.get(r.doc);
    if (s === undefined || originOf(r.url) !== s.origin) return {act: 'allow'};
    const po = this.#origin(s);
    if (po === null) return {act: 'allow'};
    const isDocument =
      (r.type === 'main_frame' || r.type === 'sub_frame') && this.#rt(s.doc).docReq === r.req;
    const core = s.binding !== null ? await this.#coreFor(s) : null;
    const candidates =
      core !== null
        ? [core]
        : await this.#d.trust.candidates({
            app: po.app,
            variant: po.deployment.variant as ReleaseKey['variant'],
          });
    // A payment script granted for this tab's next page load goes to the top-level
    // document whose headers come now, the moment its CSP floor is fixed; a redirect is no page.
    if (isDocument && s.topLevel && (h.status < 300 || h.status >= 400)) {
      const id = await this.#allow.takeThirdParty(s.tab, s.origin, this.#now());
      if (id !== null) s.allowedThirdParty = {id, host: thirdPartyHost(po, id)};
    }
    const g = headerGuard({
      origin: po,
      request: r,
      response: h,
      isDocument,
      candidates,
      binding: s.binding,
      allowedThirdParty: s.allowedThirdParty?.id ?? null,
    });
    if (g.violation !== null) {
      const path = isDocument ? s.path : (pathOf(r.url) ?? r.url);
      putItem(s, {
        req: r.req,
        path,
        url: r.url,
        type: r.type,
        cls: isDocument ? 'document' : classOfType(r.type, path),
        key: null,
        outcome: {r: 'mismatch', reason: 'header'},
        at: this.#now(),
      });
    }
    const cancel = g.action === 'cancel';
    if (cancel) {
      delete s.pending[r.req];
      if (isDocument) s.blocked = true;
    }
    const ev = await this.#evaluate(s);
    if (cancel && isDocument && s.topLevel) {
      const incidentId = await this.#incident(s, 'mismatch', ev);
      this.#track(this.#d.backend.command({k: 'show-page', tab: s.tab, incidentId}));
    }
    if (g.action === 'cancel') return {act: 'cancel'};
    const strip = new Set(g.strip);
    const out: HeaderPair[] = [];
    for (const [n, v] of h.headers) {
      if (strip.has(n)) continue;
      if (g.noStore && (n === 'cache-control' || n === 'expires' || n === 'pragma')) continue;
      out.push([n, v]);
    }
    if (g.noStore) out.push(['cache-control', 'no-store']);
    out.push(...g.append);
    return {act: 'allow', responseHeaders: out};
  }

  // -------------------------------------------------------------------------
  // Sensors

  async #sensor(
    s: SessionRec,
    event: SessionRec['sensors'][number]['event'],
    count: number,
    at: number,
  ): Promise<void> {
    const prev = s.sensors.find(x => x.event === event);
    const n = Math.max(1, Math.min(count, 1_000_000));
    if (prev === undefined) {
      if (s.sensors.length >= SESSION_LIMITS.sensors) return;
      s.sensors = [...s.sensors, {event, count: n, at}];
    } else {
      s.sensors = s.sensors.map(x => (x.event === event ? {...x, count: x.count + n} : x));
    }
    await this.#evaluate(s);
  }

  // -------------------------------------------------------------------------
  // Unknown builds and retro-verification

  #decideUnknown(s: SessionRec, po: ProtectedOrigin): void {
    if (s.unknownBuild === null) return;
    const now = this.#now();
    const input = unknownInput(s, po, this.#d.trust, this.#rt(s.doc).tried, now, this.#budget, k =>
      this.#retrying.has(ensureId(k)),
    );
    const decision = decideUnknownBuild(input);
    s.unknownBuild = withDecision(s.unknownBuild, input, decision, this.#now());
  }

  /** The server's version hint, waiting at most HINT_WAIT_MS (then a failed fetch). */
  async #fetchHint(s: SessionRec, po: ProtectedOrigin): Promise<void> {
    const failed = (): HintResult => ({version: null, at: this.#now()});
    let timer: unknown = null;
    const hint = await Promise.race([
      this.#d.registry.fetchHint(po).catch(failed),
      new Promise<HintResult>(
        resolve => (timer = this.#timer(() => resolve(failed()), HINT_WAIT_MS)),
      ),
    ]);
    this.#clear(timer);
    if (s.unknownBuild !== null) s.unknownBuild = {...s.unknownBuild, hint};
  }

  /** #fetchHint, waiting at most `ms` (the fetch goes on; resolution picks it up later). */
  async #hintWithin(s: SessionRec, po: ProtectedOrigin, ms: number): Promise<void> {
    let timer: unknown = null;
    await Promise.race([
      this.#fetchHint(s, po),
      new Promise<void>(resolve => (timer = this.#timer(resolve, ms))),
    ]);
    this.#clear(timer);
  }

  /**
   * Unknown-build resolution of one document. It waits on the network (the hint, bounded), so it
   * never runs inside the document's observation queue, which the backend's header and body
   * decisions wait on. One run per document at a time: a request during a run (a release that
   * became known or disputed, a finished deep verify, a timer) makes it run once more afterwards.
   */
  #resolveUnknown(s: SessionRec): Promise<void> {
    const running = this.#resolving.get(s.doc);
    if (running !== undefined) {
      running.again = true;
      return running.run;
    }
    const entry = {again: false, run: Promise.resolve()};
    entry.run = (async () => {
      try {
        do {
          entry.again = false;
          await this.#resolveUnknownSteps(s);
        } while (entry.again);
      } finally {
        this.#resolving.delete(s.doc);
      }
    })();
    this.#resolving.set(s.doc, entry);
    return entry.run;
  }

  async #resolveUnknownSteps(s: SessionRec): Promise<void> {
    for (let step = 0; step < 6; step++) {
      // A denied document has ended (the tab shows the blocked page), but the release it named
      // must still be resolved: that page reloads once the build is known. For such a document only
      // the hint fetch and the deep verify run; it has no timer, the page's poll (blockedView) runs
      // this again.
      const denied = !s.alive && s.blocked;
      if (
        (!s.alive && !denied) ||
        s.binding !== null ||
        s.docClass !== 'manifest' ||
        s.unknownBuild === null
      )
        return;
      const po = this.#origin(s);
      if (po === null) return;
      this.#decideUnknown(s, po);
      const d = s.unknownBuild.decision;
      if (d === null) return;
      if (denied) {
        const key = d.k === 'ensure' ? d.key : d.k === 'final' ? d.ensure : undefined;
        if (key !== undefined) await this.#ensure(key, s.origin, d.k === 'final');
        if (d.k !== 'fetch-hint') return;
      }
      switch (d.k) {
        case 'fetch-hint': {
          await this.#fetchHint(s, po);
          continue;
        }
        case 'ensure': {
          await this.#ensure(d.key, s.origin);
          await this.#evaluate(s);
          // The store reports `working` now; re-decide once more to pick that up.
          this.#decideUnknown(s, po);
          await this.#evaluate(s);
          return;
        }
        case 'wait': {
          const rt = this.#rt(s.doc);
          this.#clear(rt.unknownTimer);
          rt.unknownTimer = null;
          if (d.retryAt !== null) {
            rt.unknownTimer = this.#timer(
              () => {
                rt.unknownTimer = null;
                this.#track(this.#resolveUnknown(s));
              },
              Math.min(d.retryAt - this.#now(), 10 * 60 * 1000),
            );
          }
          await this.#evaluate(s);
          return;
        }
        case 'final': {
          // Past the give-up time, a retry that is due runs in the background (#retrying: a
          // decision while it runs stays final, BUILD_UNVERIFIED, so "Proceed once" applies). A
          // success makes the release known (releaseKnown), so the next load verifies.
          if (d.ensure !== undefined) await this.#ensure(d.ensure, s.origin, true);
          const failed = s.unknownBuild.attempts.find(
            a => a.failure === 'digest-mismatch' || a.failure === 'build-refused',
          );
          const ev = await this.#evaluate(s);
          if (failed !== undefined) await this.#incident(s, 'deep-verify-failed', ev);
          return;
        }
      }
    }
  }

  /** Starts deep verify of `key`, once at a time; `background`: a retry past the give-up time. */
  async #ensure(key: ReleaseKey, origin: Origin, background = false): Promise<void> {
    await this.#budget.spend(origin, key, this.#now());
    const id = ensureId(key);
    if (this.#inflight.has(id)) return;
    this.#inflight.add(id);
    if (background) this.#retrying.add(id);
    const settled = (): void => {
      this.#inflight.delete(id);
      this.#retrying.delete(id);
    };
    // A deep verify takes minutes: nothing waits for it here; its outcome is handled when it
    // settles.
    void this.#d.trust.ensureRelease({key, trigger: 'unknown-build'}).then(
      outcome => {
        settled();
        this.#track(outcome.ok ? this.releaseKnown(outcome.refs) : this.#reconsider(key.app));
      },
      () => {
        settled();
        this.#track(this.#reconsider(key.app));
      },
    );
  }

  async #reconsider(app: ReleaseKey['app']): Promise<void> {
    for (const s of this.#sessions.live()) {
      if (s.app === app && s.binding === null && s.docClass === 'manifest')
        await this.#resolveUnknown(s);
    }
  }

  /**
   * Re-runs binding of an unbound document (retro-verification). Runs in the document's queue, so
   * only the
   * local bind attempt waits here; the resolution
   * that follows (network) runs outside it, as from the document body. Inside the queue it would
   * hold every header and body decision of the page behind a hint fetch, which Firefox may never
   * answer while one of those decisions is pending (its blocking webRequest replies are batched),
   * and the page would hang for good.
   */
  async #rebind(s: SessionRec): Promise<void> {
    if (s.binding !== null || (await this.#tryBind(s))) return;
    this.#track(this.#resolveUnknownOnce(s));
  }

  /**
   * Binds an unbound document against the current candidates; true when it bound. `retro`: the
   * document was released before (what it loaded meanwhile is judged, and it is flagged RETRO);
   * false while its own response is still held.
   */
  async #tryBind(s: SessionRec, retro = true): Promise<boolean> {
    const rt = this.#rt(s.doc);
    const po = this.#origin(s);
    const info = rt.docReq === null ? undefined : this.#requests.get(rt.docReq);
    if (po === null || s.docSha256 === null || s.unknownBuild === null) return false;
    const bytes = this.#retained.get(s.doc, s.path);
    const body: BodyEvidence = {
      sha256: s.docSha256,
      size: s.unknownBuild.size,
      ...(bytes !== undefined ? {bytes} : {}),
    };
    const candidates = await this.#d.trust.candidates({
      app: po.app,
      variant: po.deployment.variant as ReleaseKey['variant'],
      hintVersion: s.unknownBuild.hint?.version ?? null,
    });
    const r = await bindDocument({
      origin: po,
      url: info?.obs.url ?? s.origin + s.path,
      status: info?.status ?? 200,
      body,
      candidates,
      now: this.#now(),
    });
    if (r.k === 'bound') {
      await this.#applyBinding(s, r.binding, r.core, retro);
      await this.#evaluate(s);
      if (s.incognito !== true)
        this.#track(this.#alerts.noteSeen(s.origin, r.binding.buildId, r.binding.version));
      return true;
    }
    if (r.k === 'unbound') rt.tried = r.tried;
    return false;
  }

  async #resolveUnknownOnce(s: SessionRec): Promise<void> {
    const po = this.#origin(s);
    if (po === null) return;
    // A resolution is running: it re-decides once more when it ends.
    if (this.#resolving.has(s.doc)) return this.#resolveUnknown(s);
    this.#decideUnknown(s, po);
    if (s.unknownBuild?.decision !== undefined && s.unknownBuild.decision !== null) {
      await this.#resolveUnknown(s);
      return;
    }
    await this.#evaluate(s);
  }

  /**
   * Judges the recorded items of a document that is about to bind after the fact, against that
   * binding, without changing the session: the result maps each recorded item to its verdict. Items
   * recorded while it runs are judged too.
   */
  async #retroItems(
    s: SessionRec,
    core: LoadedCore,
    binding: NonNullable<SessionRec['binding']>,
  ): Promise<Map<ItemRecord, ItemRecord>> {
    const judged = new Map<ItemRecord, ItemRecord>();
    const po = this.#origin(s);
    if (po === null) return judged;
    const rt = this.#rt(s.doc);
    // Evidence that only lived in memory and is gone: lost to a restart, or evicted.
    const lost = this.#restarted ? 'verifier-restarted' : 'internal-error';
    for (;;) {
      const item = Object.values(s.items).find(i => i.outcome.r === 'recorded' && !judged.has(i));
      if (item === undefined) return judged;
      const key = recordKey(item.path, item.sha256);
      const ev =
        rt.evidence.get(key) ??
        (item.status !== undefined
          ? {
              req: item.req,
              status: item.status,
              headers: item.ctype !== undefined ? [['content-type', item.ctype] as const] : [],
            }
          : undefined);
      if (ev === undefined || item.sha256 === undefined || item.size === undefined) {
        judged.set(item, {...item, outcome: {r: 'unverifiable', reason: lost}});
        continue;
      }
      const bytes = this.#retained.get(s.doc, key);
      const verified = await verifyItem({
        origin: po,
        core,
        binding,
        request: {
          k: 'request',
          at: item.at,
          req: item.req ?? `retro:${item.path}`,
          doc: s.doc,
          tab: s.tab,
          frame: s.frame,
          url: item.url,
          type: item.type,
        },
        status: ev.status,
        headers: ev.headers,
        body: {sha256: item.sha256, size: item.size, ...(bytes !== undefined ? {bytes} : {})},
        allowedThirdParty: s.allowedThirdParty?.id ?? null,
        now: this.#now(),
      });
      // A template entry whose bytes are gone cannot be judged: unverifiable, never a mismatch.
      // Any other unverifiable result keeps its own reason.
      judged.set(
        item,
        bytes === undefined && verified.expected === 'template'
          ? {...verified, outcome: {r: 'unverifiable', reason: lost}}
          : verified,
      );
    }
  }

  async releaseKnown(refs: readonly CoreRef[]): Promise<void> {
    await this.#ready;
    const apps = new Set(refs.map(r => r.app));
    for (const s of this.#sessions.live()) {
      if (
        !apps.has(s.app) ||
        s.binding !== null ||
        s.docClass !== 'manifest' ||
        s.unknownBuild === null
      )
        continue;
      try {
        await this.#enqueue(s.doc, () => this.#rebind(s));
      } catch (e) {
        logWarn('engine-rebind', {error: errorName(e)});
        await this.#faulted(s);
      }
    }
  }

  async releaseDisputed(key: ReleaseKey, _reason: DisputeReason): Promise<void> {
    await this.#ready;
    for (const s of this.#sessions.live()) {
      if (s.app !== key.app) continue;
      if (s.binding !== null) {
        const core = await this.#coreFor(s);
        if (core !== null && core.ref.version === key.version) {
          // Reload the ref so buildStatus reflects the dispute.
          const fresh = await this.#d.trust.getCoreBySha256(core.ref.sha256);
          if (fresh !== null) {
            this.#cores.set(fresh.ref.sha256, fresh);
            this.#rt(s.doc).core = fresh;
          }
        }
        await this.#evaluate(s);
      } else if (s.docClass === 'manifest') {
        await this.#resolveUnknown(s);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Evaluation and publication

  async #evaluate(s: SessionRec): Promise<Evaluation> {
    const before = s.state;
    let alerted = true;
    try {
      alerted = meetsAlert(s.state, s.unverifiedCode);
    } catch {
      // A malformed record: raise nothing new from it.
    }
    const po = this.#origin(s);
    const core =
      s.binding !== null
        ? (this.#rt(s.doc).core ?? this.#cores.get(s.binding.coreSha256) ?? null)
        : null;
    let ev: Evaluation;
    try {
      ev = evaluateSession({
        session: s,
        trust: this.#d.trust.snapshot(),
        buildStatus: s.binding === null ? null : (core?.ref.status ?? 'current'),
        originAlert: this.#alerts.get(s.origin),
        engineHealthy: !this.#startFailed,
        permissionGranted: po?.granted ?? false,
        rollback: s.binding !== null && this.#alerts.isRollback(s.origin, s.binding.version),
      });
    } catch (e) {
      // Building the input threw (R1): this catch is what still publishes PROTECTION_LOST.
      logWarn('engine-evaluate', {error: errorName(e)});
      ev = {
        state: 'PROTECTION_LOST',
        reasons: ['internal-error'],
        flags: [],
        action: 'deny',
        denial: {state: 'PROTECTION_LOST', reasons: ['internal-error']},
        alert: null,
        unverifiedCode: s.unverifiedCode === 'ran' ? 'ran' : 'unchecked',
        newRed: s.state !== 'PROTECTION_LOST',
      };
    }
    s.state = ev.state;
    s.unverifiedCode = ev.unverifiedCode;
    s.reasons = ev.reasons.slice(0, SESSION_LIMITS.reasons);
    s.flags = ev.flags;
    s.peakState = join(s.peakState, ev.state);
    this.#schedule(s);
    await this.#taintUpdate(s);
    const write = this.#sessions.touch(s.doc);
    if (worsened(before, ev.state)) await write;
    await this.#sideEffects(s, ev, before, alerted);
    await this.#publishTab(s.tab);
    return ev;
  }

  /**
   * Re-evaluates when the next pending request reaches its R4 limit, and once 1.6 s after a request
   * started if it is still pending: a request is added without an evaluation (no flicker for a fast
   * response), so this is what withholds green (CHECKING) while a slow one is held.
   */
  #schedule(s: SessionRec): void {
    const rt = this.#rt(s.doc);
    this.#clear(rt.timer);
    rt.timer = null;
    const entries = Object.values(s.pending);
    if (entries.length === 0 || !s.alive) return;
    const now = this.#now();
    const next = Math.min(
      ...entries.map(p =>
        Math.min(
          p.since + r4Ms(p.type) + 1,
          p.since + CHECKING_AFTER_MS > now ? p.since + CHECKING_AFTER_MS : Infinity,
        ),
      ),
    );
    rt.timer = this.#timer(() => {
      rt.timer = null;
      this.#track(this.#timeoutPending(s));
    }, next - now);
  }

  /** R4: long-pending items become unverifiable (timeout); the evaluation does the rest. */
  async #timeoutPending(s: SessionRec): Promise<void> {
    if (!s.alive) return;
    const now = this.#now();
    for (const [req, p] of Object.entries(s.pending)) {
      if (now - p.since <= r4Ms(p.type)) continue;
      delete s.pending[req];
      const isDoc = this.#rt(s.doc).docReq === req;
      putItem(s, {
        req,
        path: p.path,
        url: p.url ?? p.path,
        type: p.type,
        cls: isDoc
          ? 'document'
          : originOf(p.url) === s.origin || p.url === undefined
            ? classOfType(p.type, p.path)
            : 'third-party',
        key: null,
        outcome: {r: 'unverifiable', reason: 'timeout'},
        at: now,
      });
      if (isDoc && s.docClass === 'pending') s.docClass = 'manifest';
    }
    await this.#evaluate(s);
  }

  async #taintUpdate(s: SessionRec): Promise<void> {
    let cls = null;
    try {
      cls = taintSourceClass(s);
    } catch {
      cls = 'unverifiable' as const;
    }
    const now = this.#now();
    if (cls !== null && s.alive && !this.#rt(s.doc).undecided) {
      if (await this.#taint.add(s, cls, now)) {
        for (const t of this.#sessions.liveByOrigin(s.origin)) {
          if (t.doc !== s.doc && this.#taint.flag(t, now)) this.#track(this.#evaluate(t));
        }
        // What the source can leave behind after it ends: an `about:blank` document of its origin
        // in a tab that opened its tab (window.opener, then the opener's opener), or, from a frame,
        // in a sibling frame of its own tab. Those tabs hold the taint until they close.
        if (s.frame !== 0) await this.#holdTab(s.origin, s.tab, cls, s.path);
        else
          for (const t of this.#taint.openerChain(s.tab))
            await this.#holdTab(s.origin, t, cls, s.path);
      }
    }
    // A source stays one until its document ends, even when it verifies after the fact:
    // what it ran before its build was known is not undone by the verdict on what was recorded.
  }

  /** `alerted`: the evaluation before this one already met the origin alert's condition. */
  async #sideEffects(
    s: SessionRec,
    ev: Evaluation,
    before: SessionRec['state'],
    alerted: boolean,
  ): Promise<void> {
    // A server the user removed: its sessions keep their state and taint, but nothing is reported.
    if (this.#origin(s) === null) return;
    let incidentId = s.incidentId ?? null;
    // Only when the document first meets the alert's condition (or enters another alerting state):
    // an alert the user closed while this document is still open (or that a restart rehydrated) is
    // not reopened by the same document. Meeting the condition is not only a change of state: a
    // document already PROTECTION_LOST without evidence that unverified code ran (an engine fault, a
    // revoked permission, a denied item) raises the alert when such evidence joins it.
    if (ev.alert !== null && (ev.state !== before || !alerted)) {
      incidentId = await this.#incident(s, this.#incidentKind(ev.state), ev);
      await this.#alerts.raise(
        s.origin,
        ev.alert.state,
        ev.alert.reasons,
        incidentId,
        s.incognito === true,
      );
    }
    // A red state without evidence on a document that never ran (its response is still held, or it
    // was denied) is no incident and notifies nothing: nothing of it ran, and a denied top-level
    // document shows its blocked page.
    const ran = !this.#rt(s.doc).undecided && !s.blocked;
    if (
      ev.newRed &&
      isRed(ev.state) &&
      rankOf(ev.state) > rankOf(before) &&
      (ev.alert !== null || ran)
    ) {
      incidentId ??= await this.#incident(s, this.#incidentKind(ev.state), ev);
      try {
        await this.#d.alertSink.redAlert({
          origin: s.origin,
          state: ev.state,
          reasons: ev.reasons,
          incidentId,
        });
      } catch (e) {
        logWarn('alert-sink', {error: errorName(e)});
      }
    }
  }

  async #publishTab(tab: number): Promise<void> {
    const running = this.#publishing.get(tab);
    if (running !== undefined) {
      await running;
    }
    const p = this.#writeTab(tab).finally(() => {
      if (this.#publishing.get(tab) === p) this.#publishing.delete(tab);
    });
    this.#publishing.set(tab, p);
    await p;
  }

  async #writeTab(tab: number): Promise<void> {
    if (tab < 0) return;
    // A removed server's documents show nothing (the default icon), like any unregistered site.
    const live = this.#sessions.byTab(tab).filter(s => s.alive && this.#origin(s) !== null);
    // Origin, alert and build view follow the document buildTabState shows on top.
    const top = tabTop(live);
    const po = top === undefined ? null : this.#origin(top);
    for (const s of live) await this.#coreFor(s);
    const rec = buildTabState({
      tab,
      now: this.#now(),
      sessions: live,
      origin: po,
      alert: top === undefined ? null : this.#alerts.get(top.origin),
      allowances: this.#allow.get(tab),
      permissionMissing: po !== null && !po.granted,
      cores: this.#cores,
      unknownBuild: top === undefined ? null : unknownBuildView(top, po, this.#d.trust),
    });
    if (rec === null) await this.#session.remove(SESSION_KEYS.tab(tab));
    else await this.#session.set({[SESSION_KEYS.tab(tab)]: rec});
    await this.#notifyTab(tab);
  }

  async #notifyTab(tab: number): Promise<void> {
    try {
      await this.#d.tabSink.tabStateChanged(tab);
    } catch (e) {
      logWarn('tab-sink', {error: errorName(e)});
    }
    broadcast(this.#d.ext, 'STATE_UPDATED', {tab});
  }

  // -------------------------------------------------------------------------
  // Liveness, navigation, tabs

  async #revive(s: SessionRec): Promise<void> {
    s.alive = true;
    s.endedAt = null;
    await this.#endGoneSources(s.origin);
    this.#taint.flag(s, this.#now());
    await this.#evaluate(s);
  }

  /**
   * Ends the documents of `sessions` that Firefox confirms gone: their frame no longer exists or
   * their tab is gone (backend.documentGone asks webNavigation.getFrame and tabs.get, never
   * anything a page controls). A navigation ends a document when it commits; this catches what no
   * event reports: a removed iframe, a discarded tab, a document that went away while the event
   * page was stopped. A taint source can therefore never end its own taint while it is displayed.
   */
  async #endGone(sessions: readonly SessionRec[]): Promise<void> {
    for (const s of sessions) {
      let gone = false;
      try {
        gone = await this.#d.backend.documentGone(s.tab, s.frame);
      } catch {
        gone = false;
      }
      if (gone) await this.#endDoc(s.doc);
    }
  }

  /**
   * Before another document of `origin` is flagged by the origin's taint sources (the only moment
   * another document's liveness changes a verdict), the sources that are gone end.
   */
  async #endGoneSources(origin: Origin): Promise<void> {
    const sources = this.#taint
      .sources(origin)
      .map(x => this.#sessions.get(x.doc))
      .filter((x): x is SessionRec => x?.alive === true);
    await this.#endGone(sources);
  }

  /**
   * A document opened a window. A taint source (or a window a taint source opened) keeps the taint
   * of its origin alive in the opened tab until that tab closes: the opener can script an
   * `about:blank` window no request names, and that window keeps a handle to whatever its opener's
   * frame shows next, a verified vault included.
   */
  async #onOpened(o: Extract<Observation, {k: 'opened'}>): Promise<void> {
    if (o.tab === o.sourceTab) return;
    await this.#taint.noteOpener(o.tab, o.sourceTab);
    const src = o.sourceDoc === null ? undefined : this.#sessions.get(o.sourceDoc);
    const origins = new Map<Origin, {class: TaintClass; path: string}>();
    if (src !== undefined && src.alive) {
      const own = this.#taint.sources(src.origin).find(x => x.doc === src.doc);
      if (own !== undefined) origins.set(src.origin, {class: own.class, path: own.path});
    }
    for (const h of this.#taint.heldBy(o.sourceTab)) {
      if (!origins.has(h.origin)) origins.set(h.origin, {class: h.class, path: h.path});
    }
    for (const [origin, h] of origins) await this.#holdTab(origin, o.tab, h.class, h.path);
  }

  /**
   * `tab` taints `origin` until it closes, and so does every tab that opened it (the held tab can
   * navigate its opener to `about:blank`, which takes its origin, and script it): every live
   * session of the origin is co-resident.
   */
  async #holdTab(origin: Origin, tab: number, cls: TaintClass, path: string): Promise<void> {
    const now = this.#now();
    let added = false;
    for (const t of [tab, ...this.#taint.openerChain(tab)]) {
      if (await this.#taint.hold(origin, t, cls, path, now)) added = true;
    }
    if (!added) return;
    for (const t of this.#sessions.liveByOrigin(origin)) {
      if (this.#taint.flag(t, now)) this.#track(this.#evaluate(t));
    }
  }

  async #endDoc(doc: DocKey): Promise<void> {
    await this.#ready;
    const s = this.#sessions.get(doc);
    if (s === undefined || !s.alive) return;
    s.alive = false;
    s.endedAt = this.#now();
    await this.#taint.remove(s.origin, s.doc);
    const rt = this.#runtime.get(doc);
    if (rt !== undefined) {
      this.#clear(rt.timer);
      this.#clear(rt.unknownTimer);
      rt.timer = rt.unknownTimer = null;
    }
    void this.#sessions.touch(doc);
    for (const child of this.#sessions.all()) {
      if (child.parentDoc === doc && child.alive) await this.#endDoc(child.doc);
    }
    await this.#publishTab(s.tab);
  }

  async #onTabRemoved(tab: number): Promise<void> {
    await this.#ready;
    for (const s of this.#sessions.byTab(tab)) {
      await this.#endDoc(s.doc);
      await this.#forget(s.doc);
    }
    await this.#taint.releaseTab(tab);
    await this.#allow.removeTab(tab);
    await this.#session.remove(SESSION_KEYS.tab(tab));
    // Whatever the tab showed: the last private tab need not be one of a protected page.
    await this.#purgePrivateIfLast();
  }

  // -------------------------------------------------------------------------
  // Engine interface (router, main.ts)

  async originsChanged(_origins: ProtectedOrigins): Promise<void> {
    await this.#ready;
    // A tab of a server added while it was open loaded unobserved (R2), as at start-up.
    await this.#markOrphanTabs('untracked');
    for (const s of this.#sessions.live()) await this.#evaluate(s);
  }

  async tabState(tab: number): Promise<TabStateRecord | null> {
    await this.#ready;
    return (await this.#session.get<TabStateRecord>(SESSION_KEYS.tab(tab))) ?? null;
  }

  async details(tab: number): Promise<DetailsView | null> {
    await this.#ready;
    const live = this.#sessions.byTab(tab).filter(s => s.alive);
    const top = live.find(s => s.topLevel) ?? live[0];
    if (top === undefined) return null;
    const docs = [];
    for (const s of live) {
      const core = await this.#coreFor(s);
      const b = s.binding;
      const release = b === null ? null : this.#d.trust.releaseState(b);
      docs.push({
        summary: summarize(s, core),
        items: Object.values(s.items).slice(0, SESSION_LIMITS.items),
        serverStyles: s.serverStyles,
        coreSha256: b?.coreSha256 ?? null,
        dispute: release?.k === 'disputed' ? release : null,
      });
    }
    return {tab, origin: top.origin, docs};
  }

  async blockedView(incidentId: string): Promise<BlockedView | null> {
    await this.#ready;
    const inc: IncidentRecord | null = await this.#alerts.getBlocked(incidentId);
    if (inc === null || inc.state === null) return null;
    let state = inc.state;
    let reasons = inc.reasons;
    let reload = false;
    let job = null;
    if (inc.state === 'NEW_BUILD') {
      const s = this.#sessions.all().find(x => x.incidentId === incidentId && x.blocked);
      const po = this.#d.registry.lookup(inc.origin);
      // The page of a NEW_BUILD denial shows BUILD_UNVERIFIED, with "Proceed once", once a reload
      // would get it (a failed deep verify, the give-up time).
      const now = this.#deniedNow(s, po);
      if (now === 'reload') reload = true;
      else if (now !== null) {
        state = now.state;
        reasons = now.reason === null ? [] : [now.reason];
      }
      // Only a job of the release the denied document named: another release's job would show
      // the wrong progress and reload the page for a build that is still unknown.
      const key = s === undefined || po === null ? null : hintedKey(s, po);
      const jobs =
        key === null
          ? []
          : (await this.#d.trust.listJobs().catch(() => [])).filter(
              j => j.app === key.app && j.variant === key.variant && j.version === key.version,
            );
      // A job that finished before the document was denied is not the one the page waits for
      // (had it made the build known, the document would not be NEW_BUILD): reloading on it loops.
      job =
        jobs.find(j => j.finishedAt === undefined) ??
        jobs.find(j => j.finishedAt !== undefined && j.finishedAt >= inc.at) ??
        null;
    }
    // Build not verified because deep verify of the release the document named failed, or is
    // still retried in the background: Retry on the page asks GitHub for it again at once (a user
    // deep verify ignores a stored failure and joins a running job) before it loads the page.
    let release: ReleaseKey | null = null;
    if (state === 'BUILD_UNVERIFIED') {
      const s = this.#sessions.all().find(x => x.incidentId === incidentId && x.blocked);
      const po = this.#d.registry.lookup(inc.origin);
      const key = s === undefined || po === null ? null : hintedKey(s, po);
      const k = key === null ? null : this.#d.trust.releaseState(key).k;
      if (k === 'failed' || k === 'working') release = key;
    }
    // A load of a disputed release is denied and its session ends, so this page is where the
    // dispute's evidence is seen.
    let dispute = null;
    if (inc.state === 'DISPUTED' && inc.buildId !== null) {
      const cores = await this.#d.trust.listCores().catch(() => []);
      const ref = cores.find(r => r.buildId === inc.buildId);
      const release = ref === undefined ? null : this.#d.trust.releaseState(ref);
      dispute = release?.k === 'disputed' ? (release.evidence ?? null) : null;
    }
    return {
      incidentId,
      origin: inc.origin,
      path: inc.path,
      state,
      reasons,
      expected: inc.expected,
      observed: inc.observed,
      canProceedOnce: stateRow(state).proceed_once === true,
      retry: state === 'NEW_BUILD',
      ...(reload ? {reload: true} : {}),
      ...(release !== null ? {release} : {}),
      dispute,
      job,
    };
  }

  /**
   * The unknown build of a denied NEW_BUILD document `s`, decided again: its blocked page polls,
   * and the document, ended by that page, has no timer. A retry that is due, or a fresh attempt,
   * starts here (past the give-up time, in the background of a final decision). Returns
   * - a final BUILD_UNVERIFIED contribution, which the page shows;
   * - `reload` when only a new load can tell more: the release is known or disputed by now (the
   *   load verifies, or is denied with that state's incident and evidence), or the denied document
   *   is gone (its tab closed, or the browser restarted and storage.session is empty). That load
   *   has a document of its own, and a known or disputed release is never NEW_BUILD again, so
   *   the page does not reload in a loop;
   * - null while the page waits, and for a server that is no longer registered.
   */
  #deniedNow(
    s: SessionRec | undefined,
    po: ProtectedOrigin | null,
  ): Contribution | 'reload' | null {
    if (po === null) return null;
    if (s === undefined) return 'reload';
    if (s.unknownBuild === null || s.binding !== null) return null;
    this.#decideUnknown(s, po);
    const d = s.unknownBuild.decision;
    if (d === null) return null;
    if (d.k !== 'final' || d.ensure !== undefined) this.#track(this.#resolveUnknown(s));
    if (d.k !== 'final') return null;
    const known = s.unknownBuild.attempts[0]?.state === 'known';
    return !known && d.contribution.state === 'BUILD_UNVERIFIED' ? d.contribution : 'reload';
  }

  async acknowledgeAlert(origin: Origin): Promise<OriginAlert | null> {
    await this.#ready;
    const a = await this.#alerts.acknowledge(origin);
    for (const s of this.#sessions.liveByOrigin(origin)) await this.#evaluate(s);
    return a;
  }

  async allowForTab(tab: number, allowance: AllowanceRequest): Promise<void> {
    await this.#ready;
    const top = this.#sessions.byTab(tab).find(s => s.alive && s.topLevel);
    if (allowance.k === 'third-party') {
      await this.#grantThirdParty(tab, top, allowance.id);
      return;
    }
    await this.#allow.add(tab, allowance);
    await this.#publishTab(tab);
  }

  /**
   * A payment script for one page load (docs/guide.md). The CSP floor is fixed when a
   * document's headers arrive, so the tab reloads and its next top-level document of the same
   * origin takes the grant (within SESSION_LIMITS.thirdPartyGrantMs); the allowance lives exactly
   * as long as that document. Only a payment script (`unpinnable-script`) the origin's profile
   * declares.
   */
  async #grantThirdParty(tab: number, top: SessionRec | undefined, id: string): Promise<void> {
    const po = top === undefined ? null : this.#origin(top);
    const tp = po?.profile.third_party.find(x => x.id === id);
    if (top === undefined || tp?.kind !== 'unpinnable-script') return;
    await this.#allow.grantThirdParty(
      tab,
      id,
      top.origin,
      this.#now() + SESSION_LIMITS.thirdPartyGrantMs,
    );
    await this.#d.ext.tabs.reload(tab);
  }

  async listAlerts(): Promise<readonly OriginAlert[]> {
    await this.#ready;
    return this.#alerts.list();
  }

  async listIncidents(limit: number): Promise<readonly IncidentRecord[]> {
    await this.#ready;
    return this.#alerts.listIncidents(limit);
  }

  // -------------------------------------------------------------------------
  // Content scripts

  #docFor(sender: SenderDoc, claimed: DocKey): SessionRec | undefined {
    const doc = this.#d.backend.docKeyFor(sender);
    if (doc === null || doc !== claimed) return undefined;
    return this.#sessions.get(doc);
  }

  async hello(sender: SenderDoc): Promise<SensorConfig> {
    await this.#ready;
    const off: SensorConfig = {doc: '', protected: false};
    const origin = originOf(sender.url);
    const po = origin === null ? null : this.#d.registry.lookup(origin);
    if (po === null) return off;
    const url = sender.url ?? po.origin + '/';
    // A protected document in a frame the backend never saw: R2, not "This site is not protected".
    const docKey =
      this.#d.backend.docKeyFor(sender) ??
      (po.granted ? this.#d.backend.adopt(sender.tab, sender.frame, url) : null);
    if (docKey === null) return off;
    const s = await this.#adoptDoc(
      docKey,
      sender.tab,
      sender.frame,
      url,
      sender.incognito === true,
      this.#restarted ? 'verifier-restarted' : 'untracked',
    );
    return s === undefined ? off : {doc: docKey, protected: true};
  }

  /**
   * The session of `doc`, made for a protected document the backend never saw when there is none:
   * it loaded before IntactWarden started (install, update, enable), before its server was added,
   * or while its host permission was missing. It ran unchecked, so it is PROTECTION_LOST (`fault`:
   * R2 `untracked`, or R7 `verifier-restarted` for one a restarted instance meets) and a taint
   * source until it ends, at its frame's next commit or its tab's removal.
   */
  async #adoptDoc(
    doc: DocKey,
    tab: number,
    frame: number,
    url: string,
    incognito: boolean,
    fault: 'untracked' | 'verifier-restarted',
  ): Promise<SessionRec | undefined> {
    if (this.#sessions.get(doc) !== undefined) return this.#sessions.get(doc);
    await this.#onDocStart({
      k: 'doc-start',
      at: this.#now(),
      doc,
      tab,
      frame,
      parentDoc: null,
      req: null,
      url,
      type: frame === 0 ? 'main_frame' : 'sub_frame',
      ...(incognito ? {incognito: true} : {}),
    });
    const s = this.#sessions.get(doc);
    if (s === undefined) return undefined;
    if (fault === 'verifier-restarted') s.engineFault = fault;
    else s.untracked = true;
    s.docClass = 'manifest';
    await this.#evaluate(s);
    return s;
  }

  async contentDom(sender: SenderDoc, p: ContentPayloads['dom']): Promise<void> {
    await this.#ready;
    const s = this.#docFor(sender, p.doc);
    if (s === undefined) return;
    if (p.event === 'third-party-script') {
      if (p.detail.url !== undefined) await this.#thirdPartyScript(s, p.detail.url);
      return;
    }
    await this.#sensor(s, p.event, p.detail.count, this.#now());
  }

  /**
   * A script of another origin in a protected document, seen by the content script (a
   * `<script src>` element, or a CSP report of the floor's `script-src`). webRequest never reports
   * third-party requests (no host permission for those hosts), so this is how a declared third
   * party becomes THIRD_PARTY_CODE (or a MISMATCH when the profile declares it `unexpected`). The
   * enforced `script-src` floor denies it; it re-adds a payment script only for the one document
   * the user allowed it for. Undeclared hosts are left to the vendor CSP and the floor, which block
   * them.
   */
  async #thirdPartyScript(s: SessionRec, url: string): Promise<boolean> {
    const po = this.#origin(s);
    const origin = originOf(url);
    if (po === null || origin === null || origin === s.origin) return false;
    const outcome = thirdPartyOutcome(po, url, s.allowedThirdParty?.id ?? null);
    if (outcome === null) return false;
    const path = redact(url);
    if (s.items[path] === undefined) {
      putItem(s, {
        req: null,
        path,
        url: path,
        type: 'script',
        cls: 'third-party',
        key: null,
        outcome,
        at: this.#now(),
      });
      await this.#evaluate(s);
    }
    return true;
  }

  async contentCspViolation(sender: SenderDoc, p: ContentPayloads['csp']): Promise<void> {
    await this.#ready;
    const s = this.#docFor(sender, p.doc);
    if (s === undefined) return;
    const d = p.directive.toLowerCase();
    // An inline script or handler blocked or reported by the floor is the inline-code sensor.
    if ((p.blockedUrl === 'inline' || p.blockedUrl === 'eval') && d.startsWith('script-src')) {
      await this.#sensor(
        s,
        d === 'script-src-attr' ? 'inline-handler' : 'inline-script',
        1,
        this.#now(),
      );
      return;
    }
    if (d === 'script-src' || d === 'script-src-elem')
      await this.#thirdPartyScript(s, p.blockedUrl);
  }
}

/**
 * Whether a subresource body is left unjudged because Firefox may have cut it off: its document
 * was being replaced when the response ended (`BodyObs.leaving`), it is not empty, and its bytes
 * are all that speaks against it (they match no listed file, or would be kept for a
 * retro-verification). A prefix of the genuine file looks exactly like that, so it is no evidence
 * of different code: no MISMATCH, no alert, no incident, now or after a retro-verification. Such a
 * body is never released. A header or path that is wrong stays MISMATCH, and an empty body is
 * handled like any other empty body.
 */
function cutOff(o: BodyObs, outcome: ItemRecord['outcome']): boolean {
  return (
    o.leaving === true &&
    o.size > 0 &&
    ((outcome.r === 'mismatch' && outcome.reason === 'bytes') || outcome.r === 'recorded')
  );
}

/** A body that must wait for its document's binding before it can be judged. */
class Deferred {
  readonly wait: Promise<void>;
  constructor(wait: Promise<void>) {
    this.wait = wait;
  }
}

function isRed(state: SessionRec['state']): boolean {
  return stateRow(state).colour === 'red';
}

/** The release of a deep verify the engine started (#inflight, #retrying). */
function ensureId(key: ReleaseKey): string {
  return `${key.app}@${key.version}+${key.variant}`;
}

/** The host a payment script's code comes from (its first CSP allowance), for the reason line. */
function thirdPartyHost(po: ProtectedOrigin, id: string): string {
  const tp = po.profile.third_party.find(x => x.id === id);
  const src = tp?.csp_allowance?.['script-src']?.[0];
  try {
    return src === undefined ? id : new URL(src).host;
  } catch {
    return id;
  }
}
