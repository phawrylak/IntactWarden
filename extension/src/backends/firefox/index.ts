/**
 * The Firefox backend: blocking onBeforeRequest creates the
 * StreamFilter for covered types and buffers to onstop (never writes before), hashes, awaits the engine's
 * Decision and writes exactly the hashed bytes or closes empty; blocking onHeadersReceived runs the
 * header guard (CSP floor appended, Link and Speculation-Rules removed, no-store rewrite); DocKey
 * tab:frame:navSeq with webNavigation.onCommitted; the worker-URL chain for importScripts; pending
 * filters persisted (s:v1:ff:pending:*) for restart detection;
 * webNavigation.onCreatedNavigationTarget (windows a document opens, for origin taint),
 * webNavigation.onBeforeNavigate (a frame leaves its document, whose responses Firefox then cuts
 * off: `leaving`) and webNavigation.getFrame (the end of a document no navigation event reported,
 * such as a removed iframe).
 *
 * Listeners are registered synchronously in start() with an `<all_urls>` filter (events only fire
 * for hosts the extension may access) and decide per origin from the registry, read at request
 * time, after the engine is ready.
 *
 * R4 bounds every hold, whatever the engine does: a header decision, a StreamFilter decision and an
 * R2 decision that have not come by the request's R4 deadline are answered without the engine
 * (cancelled or closed empty), and the engine is told `unverifiable:timeout` on a path that does
 * not wait for that request's own pending decisions. Firefox answers an extension's blocking
 * webRequest events in batches (all listeners of a batch settle before any reply), so a held page
 * event can also hold the extension's own fetches.
 */

import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {
  PAGES,
  r4Ms,
  type BackendCommand,
  type Decision,
  type DocKey,
  type HeaderPair,
  type Observation,
  type ObservationSink,
  type Origin,
  type ProtectedOrigin,
  type RedactedUrl,
  type RequestObs,
  type ResType,
} from '../../contracts.ts';
import {redact, originOf, randomHex} from '../../engine/urls.ts';
import {errorName, logWarn} from '../../platform/guard.ts';
import {createSessionStore, type SessionStore} from '../../platform/storage.ts';
import type {
  BlockingResponse,
  Ext,
  HttpHeader,
  WebRequestDetails,
  WebRequestErrorDetails,
  WebRequestRedirectDetails,
  WebRequestResponseDetails,
} from '../../platform/webext.ts';
import {classifyServerPath} from '../../policy/classify.ts';
import {isActiveType} from '../../policy/util.ts';
import type {ObservingBackend, SenderDoc, WhenReady} from '../types.ts';
import {DocKeys} from './docKeys.ts';
import {PendingFilters} from './pending.ts';
import {attachFilter} from './streamFilter.ts';

export interface FirefoxBackendDeps {
  readonly ext: Ext;
  readonly now: () => number;
  /** The registry's protected origin, read at request time (never a copy). */
  readonly lookup: (origin: Origin) => ProtectedOrigin | null;
  /** Resolves when the engine is ready (the listeners wait on it). */
  readonly whenReady?: WhenReady;
  readonly session?: SessionStore;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'media',
  'websocket',
  'other',
  'csp_report',
  'beacon',
  'imageset',
  'web_manifest',
  'speculative',
  'xslt',
  'xml_dtd',
  'object_subrequest',
  'webtransport',
]);

interface Rec {
  readonly obs: RequestObs;
  readonly isDocument: boolean;
  readonly filtered: boolean;
  /** When the request was first reported, on the clock that orders navigation starts (`ticks`). */
  readonly began: number;
  /** The request's frame and the frames above it: a navigation of any of them cuts it off. */
  readonly frames: readonly number[];
  /** Pushes for one request run in order (doc-start/request before body). */
  chain: Promise<unknown>;
  finished: boolean;
  /**
   * The response is a redirect. Firefox drops a request's StreamFilter when it follows a
   * redirect (the filter reports an error; e2e vw-index-redirect) and fires onBeforeRequest
   * again with the same request id, so the next hop gets its own record, DocKey and filter, and
   * this filter's error is expected, not a failure.
   */
  redirected: boolean;
  /**
   * The request went on to a next hop, which reuses this request id (Firefox followed the
   * redirect, or a service worker left the request to the network: `beforeRequest`), so nothing
   * more may be reported under the id for this hop. A redirect held at its header stage and then
   * cancelled (R4 without the guard) is `redirected` but never `followed`.
   */
  followed: boolean;
  /** Its request (or doc-start) observation went to the engine. */
  announced: boolean;
  /** R4 fired: no body decision of this request is waited for any more. */
  timedOut: boolean;
  /** Answers a header decision this request is held at without the engine (R4). */
  wake: (() => void) | null;
  /** How Firefox reported the request's end (onCompleted, onErrorOccurred), once it has. */
  outcome: 'completed' | 'failed' | null;
  /** Called once `outcome` is set. */
  settled: (() => void)[];
}

export type FirefoxBackend = ObservingBackend;

/** Buffering budget per response (Bitwarden's largest file is 17.7 MB). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Statuses Firefox follows when the response carries a Location header. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The answer for a response no page receives (its tab is gone, or its request was cut off):
 * nothing is written.
 */
const CLOSED_TAB: Decision = {act: 'block', state: 'PROTECTION_LOST', reason: null};

/**
 * How long a stopped filter waits for Firefox's report of its request's end. Firefox sends the
 * reports of several requests together, when it is idle or at most 250 ms later, so one can come
 * after the filter stopped. A request reported failed is not judged; with any other report, or
 * none in time, the body is judged (a subresource's with its `leaving` mark).
 */
const OUTCOME_WAIT_MS = 2_000;

/**
 * A request the extension itself makes (the background's `api/config` and hint fetches, its pages'
 * fetches), which is never a protected page load. Decided by the requesting document
 * (`documentUrl`); `originUrl` is only the triggering principal, and for a navigation it names
 * whoever started it: a top-level document opened by `tabs.create`/`tabs.update` from an
 * extension page (the blocked page's reload, a link in the popup or options page) carries the
 * extension page as `originUrl` and must still be verified (e2e scenario bw-genuine).
 */
export function isOwnRequest(
  d: Pick<WebRequestDetails, 'type' | 'originUrl' | 'documentUrl'>,
  ownBase: string,
): boolean {
  if (d.type === 'main_frame') return false;
  if (d.documentUrl !== undefined) return d.documentUrl.startsWith(ownBase);
  return d.type !== 'sub_frame' && (d.originUrl ?? '').startsWith(ownBase);
}

export function createFirefoxBackend(deps: FirefoxBackendDeps): FirefoxBackend {
  const {ext, now, lookup} = deps;
  const whenReady = deps.whenReady ?? (() => Promise.resolve());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
  const session = deps.session ?? createSessionStore(ext);
  const docs = new DocKeys(session);
  const pending = new PendingFilters(session, randomHex(8));
  const requests = new Map<string, Rec>();
  /**
   * One clock for requests and navigation starts, in the order Firefox reported them: a request
   * takes its tick when it is first reported, a frame when it starts a navigation (`starts`, by tab
   * and frame).
   */
  let ticks = 0;
  const starts = new Map<number, Map<number, number>>();
  let sink: ObservationSink | null = null;
  /**
   * Listeners act once the engine is ready and the frame map is restored (`gate`, set in start()):
   * an event that wakes the event page must not act on, and persist, an empty frame map.
   */
  let ready = false;
  let gate: Promise<void> = Promise.resolve();
  const ownBase = ((): string => {
    try {
      return ext.runtime.getURL('');
    } catch {
      return 'moz-extension://';
    }
  })();

  const isOwn = (d: WebRequestDetails): boolean => isOwnRequest(d, ownBase);

  const protectedFor = (url: string): ProtectedOrigin | null => {
    const o = originOf(url);
    const po = o === null ? null : lookup(o);
    return po === null || !po.granted ? null : po;
  };

  const resType = (t: string): ResType => (KNOWN_TYPES.has(t) ? (t as ResType) : 'other');

  /** The frame of a request and every frame above it, the tab's top frame included. */
  const framesOf = (d: WebRequestDetails): number[] =>
    [d.frameId, d.parentFrameId, 0, ...(d.frameAncestors ?? []).map(a => a.frameId)].filter(
      f => f >= 0,
    );

  /**
   * Whether the request's frame, or a frame above it, started a navigation after the request was
   * first reported: its document is being replaced.
   *
   * What Firefox does (e2e vw-reload-cuts-response): a navigation first cancels every load of the
   * frame's document and of the frames inside it, then announces its start, in one step of the
   * page's process. The network half of a request lives in the main process, and the response
   * reaches the page's process, where the StreamFilter sits, a moment later. A request whose
   * network half had just finished is therefore reported completed (`onCompleted`, status 200),
   * while the page's process drops whatever of the body it had not handled yet: the filter stops
   * with a prefix, as it does at the end of a whole response, and nothing tells the two apart.
   * The start of the navigation is the only trace (`webNavigation.onBeforeNavigate`, reported for
   * a navigation to any address, with or without host permission).
   */
  const leaving = (rec: Rec): boolean => {
    const byFrame = starts.get(rec.obs.tab);
    return byFrame !== undefined && rec.frames.some(f => (byFrame.get(f) ?? 0) > rec.began);
  };

  /**
   * Sends `o` after the request's earlier observations. `o` may be computed (a function): its
   * place on the chain is taken now, so a later observation cannot overtake it.
   */
  const push = (
    rec: Rec | null,
    o: Observation | (() => Promise<Observation>),
  ): Promise<Decision> => {
    if (sink === null) return Promise.resolve({act: 'allow'} as const);
    const s = sink;
    const run = (rec?.chain ?? Promise.resolve()).then(async () =>
      s.push(typeof o === 'function' ? await o() : o),
    );
    if (rec !== null) rec.chain = run.catch(() => undefined);
    return run;
  };

  /** A document ended: replaced by a navigation, or its load was superseded. */
  const endDoc = (doc: DocKey): void => {
    void push(null, {k: 'doc-end', doc});
  };

  /** Sends the request's own observation (request or doc-start): the first one of `rec`. */
  const announce = (rec: Rec, o: Parameters<ObservationSink['push']>[0]): void => {
    void push(rec, o);
    rec.announced = true;
  };

  /** R4 fired for `rec`: true the first time. A header decision it is held at is answered now. */
  const expire = (rec: Rec): boolean => {
    if (rec.timedOut) return false;
    rec.timedOut = true;
    const wake = rec.wake;
    rec.wake = null;
    wake?.();
    return true;
  };

  /**
   * Tells the engine `unverifiable:timeout` (PROTECTION_LOST), not behind a header or body
   * decision of the request still pending (`rec.chain`). The request's own observation was
   * handed to the engine long before (R4 is ≥ 30 s), so the engine still sees it first.
   *
   * A redirect hop is reported too as long as Firefox has not followed it: until then the request
   * id is still this hop's, the engine attributes the timeout to the hop's request (and document
   * session), and the hop's answer is unchanged (a 3xx answered without the guard is cancelled).
   * After onBeforeRedirect the id belongs to the next hop, which records its own outcome.
   */
  const reportTimeout = (rec: Rec): void => {
    const s = sink;
    if (s === null || rec.followed || requests.get(rec.obs.req) !== rec) return;
    const o = {
      k: 'unverifiable' as const,
      req: rec.obs.req,
      url: rec.obs.url,
      reason: 'timeout' as const,
      delivered: false,
    };
    if (!rec.announced) {
      // A request held only at its header stage (no filter): the engine learns of it now.
      if (rec.obs.doc === null) return;
      rec.announced = true;
      void s.push(rec.obs).catch(() => undefined);
    }
    void s.push(o).catch(() => undefined);
  };

  /** `p`, or a cancel when it has not settled within `ms` (R4) or failed. */
  const within = (p: Promise<BlockingResponse>, ms: number): Promise<BlockingResponse> =>
    new Promise(resolve => {
      const timer = setTimer(() => resolve({cancel: true}), ms);
      void p.then(
        r => {
          clearTimer(timer);
          resolve(r);
        },
        () => {
          clearTimer(timer);
          resolve({cancel: true});
        },
      );
    });

  const covered = (po: ProtectedOrigin, url: string, type: ResType): boolean => {
    let cls;
    try {
      cls = classifyServerPath(po, url, type);
    } catch {
      cls = {k: 'build' as const};
    }
    switch (cls.k) {
      case 'cross-origin':
      case 'dynamic':
      case 'not-covered':
      case 'server-rendered':
      case 'outside-base':
        // Not hashed; the header guard still runs. Active types outside the build are judged by the engine.
        return isActiveType(type) && cls.k !== 'cross-origin';
      case 'server-style':
        // The stylesheet is validated; anything else active on that path is denied, as above.
        return isActiveType(type);
      case 'build':
        return (
          isActiveType(type) || type === 'xmlhttprequest' || type === 'image' || type === 'media'
        );
    }
  };

  /**
   * The document of a frame a request or content script names (DocKeys.forFrame). One that names
   * the frame's loading document shows that it committed before its commit event arrived: the
   * engine learns of it now.
   */
  const frameDoc = (tab: number, frame: number, documentUrl: RedactedUrl | null): DocKey | null => {
    const before = docs.current(tab, frame);
    const doc = docs.forFrame(tab, frame, documentUrl);
    if (doc !== null && doc !== before) void push(null, {k: 'committed', doc});
    return doc;
  };

  const attribute = (d: WebRequestDetails): DocKey | null => {
    const documentUrl = d.documentUrl !== undefined ? redact(d.documentUrl) : null;
    if (d.tabId >= 0) {
      const byFrame = frameDoc(d.tabId, d.frameId, documentUrl);
      if (byFrame !== null) return byFrame;
    }
    // A worker's own requests name the worker script as documentUrl and originUrl (Firefox 153
    // and 159; tabId −1 for shared and service workers): the worker-URL chain.
    const initiator = d.originUrl !== undefined ? redact(d.originUrl) : null;
    return docs.byWorker(initiator);
  };

  /** Records how the request ended and wakes a body waiting for it. */
  const settle = (rec: Rec, outcome: 'completed' | 'failed'): void => {
    rec.outcome ??= outcome;
    for (const f of rec.settled.splice(0)) f();
  };

  /**
   * The request id of `prior` is reported again (onBeforeRequest): Firefox restarted the request
   * on a new channel. It does so when it follows a redirect and when a service worker that
   * controls the page does not answer the request and leaves it to the network. The earlier hop
   * delivers nothing: its filter is dropped (it errors), which is no failure. The observations of
   * the next hop (`next`) follow the earlier hop's: the engine keys a request's facts by its id,
   * so they must not overtake them.
   */
  const supersede = (prior: Rec, next: Rec): void => {
    prior.followed = true;
    next.chain = prior.chain;
  };

  /** The request's reported end, waiting at most OUTCOME_WAIT_MS for it (null: none came). */
  const outcomeOf = (rec: Rec): Promise<Rec['outcome']> => {
    if (rec.outcome !== null) return Promise.resolve(rec.outcome);
    return new Promise(resolve => {
      const timer = setTimer(() => resolve(rec.outcome), OUTCOME_WAIT_MS);
      rec.settled.push(() => {
        clearTimer(timer);
        resolve(rec.outcome);
      });
    });
  };

  const tabExists = (tab: number): Promise<boolean> =>
    ext.tabs.get(tab).then(
      () => true,
      () => false,
    );

  const pageUrl = (incidentId: string): string =>
    `${ext.runtime.getURL(PAGES.blocked)}#${encodeURIComponent(incidentId)}`;

  /** A denied top-level document is replaced by the blocked page of its incident. */
  const showBlocked = (rec: Rec, decision: Decision): void => {
    if (rec.obs.type !== 'main_frame' || decision.act !== 'block') return;
    if (decision.incidentId === undefined) return;
    void ext.tabs.update(rec.obs.tab, {url: pageUrl(decision.incidentId)}).catch(() => undefined);
  };

  const startFilter = (rec: Rec): BlockingResponse => {
    const {req, url} = rec.obs;
    const filterApi = ext.webRequest.filterResponseData;
    /**
     * No filter could be attached: the request is cancelled. Nothing of it reaches the page
     * (withheld), unless the call failed with "Invalid request ID" (`sw-served`): a service worker
     * answers such a request, and Firefox delivers its answer whatever this listener returns.
     */
    const cancelled = (reason: 'filter-failed' | 'sw-served', delivered: boolean) => {
      if (delivered && rec.isDocument && rec.obs.doc !== null)
        docs.note(rec.obs.tab, rec.obs.frame, rec.obs.doc, 'unfiltered');
      void push(rec, {k: 'unverifiable', req, url, reason, delivered}).then(d => {
        if (!delivered) showBlocked(rec, d);
      });
      return {cancel: true};
    };
    if (filterApi === undefined) return cancelled('filter-failed', false);
    let f;
    try {
      f = filterApi.call(ext.webRequest, req);
    } catch (e) {
      // "Invalid request ID" is Firefox's error for a request a service worker answers (bug
      // 1817450). Firefox reports it as the filter's error event (`filter-failed`, delivered); an
      // exception with that message means the same and counts as delivered too.
      const swServed = e instanceof Error && e.message.includes('Invalid request ID');
      return swServed ? cancelled('sw-served', true) : cancelled('filter-failed', false);
    }
    if (rec.obs.doc !== null) pending.open(req, rec.obs.doc);
    attachFilter(f, {
      req,
      timeoutMs: r4Ms(rec.obs.type),
      maxBytes: MAX_BODY_BYTES,
      body: async bytes => {
        // A filter stops at the end of the response or with what had arrived when the request was
        // cut off (a newer navigation of the frame, a stop, a dropped connection), and the filter
        // itself does not tell which. A request Firefox reports failed delivers nothing to the
        // page, which never receives these bytes either: they are not judged (no false MISMATCH
        // or alert for a load the next one cancelled), and nothing is written. Its failure has
        // reached the engine already, as an aborted request (status 0). A request reported
        // completed can still have been cut off, when its document was being replaced (`leaving`).
        if ((await outcomeOf(rec)) === 'failed') return CLOSED_TAB;
        const prepared = (async (): Promise<{
          o: Observation;
          outcome: 'body' | 'closed-tab' | 'hash-failed';
        }> => {
          // The tab was closed while the response loaded: Firefox ends the filter with what had
          // arrived (a prefix, or nothing). No page can run it, so there is nothing to judge; the
          // item ends as an aborted request does (no false MISMATCH or alert for a closed tab).
          if (rec.obs.tab >= 0 && !(await tabExists(rec.obs.tab))) {
            return {o: {k: 'completed', req, status: 0}, outcome: 'closed-tab'};
          }
          try {
            const sha256 = await sha256Hex(bytes);
            // Read last, after `tabs.get` above was answered. The navigation that cut a response
            // off was announced to Firefox's main process before the filter stopped, and that
            // process reports it at once, so the report precedes the answer on the same channel.
            // Not for a document: its own navigation can be announced after its request.
            const cut = !rec.isDocument && leaving(rec);
            return {
              o: {
                k: 'body',
                req,
                url,
                sha256,
                size: bytes.length,
                bytes,
                ...(cut ? {leaving: true} : {}),
              },
              outcome: 'body',
            };
          } catch {
            return {
              o: {k: 'unverifiable', req, url, reason: 'internal-error', delivered: false},
              outcome: 'hash-failed',
            };
          }
        })();
        // The body takes its place on the request's chain now, so the request's 'completed'
        // cannot overtake it while it is hashed.
        const d = await push(rec, async () => (await prepared).o);
        const {outcome} = await prepared;
        if (outcome === 'closed-tab') return CLOSED_TAB;
        // Recorded as unverifiable: the filter fails closed.
        if (outcome === 'hash-failed') throw new Error('body hash failed');
        return d;
      },
      unverifiable: (reason, delivered) => {
        if (reason === 'timeout') {
          if (expire(rec)) reportTimeout(rec);
          return;
        }
        // The filter of a request that went on to a next hop is dropped by Firefox: nothing of
        // this hop reached the page.
        if (rec.redirected || rec.followed) return;
        // A document the frame already shows (its commit was seen, or a request of it named it)
        // runs what reaches it: the engine learns that first. One not shown yet does if its load
        // commits, which its commit is then told by (DocKeys.commit).
        const {doc, tab, frame} = rec.obs;
        if (delivered && rec.isDocument && doc !== null) {
          docs.note(tab, frame, doc, 'unfiltered');
          if (docs.current(tab, frame) === doc) void push(rec, {k: 'committed', doc});
        }
        // A subresource whose request Firefox reports failed (its tab closed or reloaded before
        // the filter attached) delivered nothing to the page: as for a body, only the report of
        // the request's end tells, and a failed one is not reported. Nor is one that went on to
        // a next hop meanwhile: a service worker that leaves a request to the network makes its
        // filter fail ("ServiceWorker fallback redirection") before the request is reported again.
        if (delivered && !rec.isDocument) {
          void outcomeOf(rec).then(o => {
            if (o !== 'failed' && !rec.followed)
              void push(rec, {k: 'unverifiable', req, url, reason, delivered});
          });
          return;
        }
        void push(rec, {k: 'unverifiable', req, url, reason, delivered});
      },
      done: () => {
        rec.finished = true;
        // The persisted entry goes, unless a next hop of a redirect owns the request id by now
        // (its filter has persisted its own entry under it). A hop that starts later reopens the
        // entry; one that gets no filter (another site) leaves none behind.
        const owner = requests.get(req);
        if (owner === undefined || owner === rec) pending.close(req);
      },
      blocked: decision => showBlocked(rec, decision),
      setTimer,
      clearTimer,
    });
    return {};
  };

  const beforeRequest = (d: WebRequestDetails): BlockingResponse | Promise<BlockingResponse> => {
    if (isOwn(d)) return {};
    const po = protectedFor(d.url);
    if (po === null) return {};
    const type = resType(d.type);
    const url = redact(d.url);
    const at = now();
    const prior = requests.get(d.requestId);
    if (type === 'main_frame' || type === 'sub_frame') {
      // A load still pending in the frame is superseded: it never commits.
      const superseded = docs.pending(d.tabId, d.frameId);
      if (superseded !== null) endDoc(superseded);
      const doc = docs.allocate(d.tabId, d.frameId, url, d.timeStamp);
      const parentDoc = type === 'sub_frame' ? docs.current(d.tabId, d.parentFrameId) : null;
      const rec: Rec = {
        obs: {
          k: 'request',
          at,
          req: d.requestId,
          doc,
          tab: d.tabId,
          frame: d.frameId,
          url,
          type,
        },
        isDocument: true,
        filtered: true,
        began: ++ticks,
        frames: framesOf(d),
        chain: Promise.resolve(),
        finished: false,
        redirected: false,
        followed: false,
        announced: false,
        timedOut: false,
        wake: null,
        outcome: null,
        settled: [],
      };
      if (prior !== undefined) supersede(prior, rec);
      requests.set(d.requestId, rec);
      announce(rec, {
        k: 'doc-start',
        at,
        doc,
        tab: d.tabId,
        frame: d.frameId,
        parentDoc,
        req: d.requestId,
        url,
        type,
        ...(d.incognito === true ? {incognito: true} : {}),
      });
      return startFilter(rec);
    }
    const doc = attribute(d);
    const obs: RequestObs = {
      k: 'request',
      at,
      req: d.requestId,
      doc,
      tab: d.tabId,
      frame: d.frameId,
      url,
      type,
    };
    const isCovered = covered(po, d.url, type);
    const rec: Rec = {
      obs,
      isDocument: false,
      filtered: isCovered,
      began: ++ticks,
      frames: framesOf(d),
      chain: Promise.resolve(),
      finished: false,
      redirected: false,
      followed: false,
      announced: false,
      timedOut: false,
      wake: null,
      outcome: null,
      settled: [],
    };
    if (prior !== undefined) supersede(prior, rec);
    requests.set(d.requestId, rec);
    if (type === 'script' && doc !== null) docs.noteScript(url, doc);
    if (!isCovered) return {};
    if (doc === null) {
      // A request another site's document makes (`documentUrl` is Firefox's loading principal,
      // not the page's word): denied, and no document of the protected origin is marked for it.
      if (d.documentUrl !== undefined && originOf(d.documentUrl) !== po.origin) {
        return {cancel: true};
      }
      // R2: an active request no known document owns (held at most R4 for the engine's answer).
      const decided = push(rec, obs).then(r => (r.act === 'block' ? {cancel: true} : {}));
      rec.announced = true;
      return within(decided, r4Ms(type));
    }
    announce(rec, obs);
    return startFilter(rec);
  };

  const headerPairs = (hs: readonly HttpHeader[] | undefined): HeaderPair[] =>
    (hs ?? []).map(h => [
      h.name.toLowerCase(),
      h.value ?? (h.binaryValue !== undefined ? String.fromCharCode(...h.binaryValue) : ''),
    ]);

  const headersReceived = (
    d: WebRequestResponseDetails,
  ): BlockingResponse | Promise<BlockingResponse> => {
    if (isOwn(d) || sink === null) return {};
    let rec = requests.get(d.requestId);
    const po = protectedFor(d.url);
    if (po === null) return {};
    if (rec === undefined) {
      const doc = attribute(d);
      if (doc === null) return {};
      rec = {
        obs: {
          k: 'request',
          at: now(),
          req: d.requestId,
          doc,
          tab: d.tabId,
          frame: d.frameId,
          url: redact(d.url),
          type: resType(d.type),
        },
        isDocument: false,
        filtered: false,
        began: ++ticks,
        frames: framesOf(d),
        chain: Promise.resolve(),
        finished: false,
        redirected: false,
        followed: false,
        announced: false,
        timedOut: false,
        wake: null,
        outcome: null,
        settled: [],
      };
      requests.set(d.requestId, rec);
    }
    const r = rec;
    const s = sink;
    if (
      REDIRECT_STATUSES.has(d.statusCode) &&
      (d.responseHeaders ?? []).some(x => x.name.toLowerCase() === 'location')
    ) {
      r.redirected = true;
    } else if (r.isDocument && r.obs.doc !== null) {
      // The document's response started: its load can commit (DocKeys.commit).
      docs.note(r.obs.tab, r.obs.frame, r.obs.doc, 'responded');
    }
    const h = {
      req: d.requestId,
      status: d.statusCode,
      headers: headerPairs(d.responseHeaders),
    };
    const run = r.chain.then(() => s.headers(h, r.obs));
    r.chain = run.catch(() => undefined);
    const decided = run.then(
      (hd): BlockingResponse => {
        if (hd.act === 'cancel') return {cancel: true};
        if (hd.responseHeaders === undefined) return {};
        return {responseHeaders: hd.responseHeaders.map(([name, value]) => ({name, value}))};
      },
      (e: unknown): BlockingResponse => {
        logWarn('ff-headers', {error: errorName(e)});
        return {cancel: true};
      },
    );
    // R4 already fired before the headers came (a server slower than R4): the filter was closed
    // empty, so the response is denied now.
    if (r.timedOut) return {cancel: true};
    return new Promise<BlockingResponse>(resolve => {
      let timer: unknown = null;
      const settle = (b: BlockingResponse): void => {
        clearTimer(timer);
        if (r.wake === wake) r.wake = null;
        resolve(b);
      };
      // A header decision answered without the guard (R4, an engine failure) is a cancel.
      const wake = (): void => settle({cancel: true});
      // The request's R4 timer (its filter's) ends this wait, since the filter is closed empty
      // then; without a filter (or after it finished), at most R4 from the headers' arrival.
      r.wake = wake;
      timer = setTimer(() => {
        if (expire(r)) reportTimeout(r);
        wake();
      }, r4Ms(r.obs.type));
      void decided.then(settle);
    });
  };

  const guarded =
    <A extends unknown[]>(
      name: string,
      fn: (...a: A) => BlockingResponse | Promise<BlockingResponse>,
      fail: (...a: A) => BlockingResponse,
    ) =>
    (...a: A): BlockingResponse | Promise<BlockingResponse> => {
      const run = (): BlockingResponse | Promise<BlockingResponse> => {
        try {
          const r = fn(...a);
          return r instanceof Promise
            ? r.catch((e: unknown) => {
                logWarn(name, {error: errorName(e)});
                return fail(...a);
              })
            : r;
        } catch (e) {
          logWarn(name, {error: errorName(e)});
          return fail(...a);
        }
      };
      return ready ? run() : gate.then(run);
    };

  /** A non-blocking listener, run after the gate as the blocking ones are (arrival order kept). */
  const gated =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      if (ready) fn(...a);
      else void gate.then(() => fn(...a));
    };

  /**
   * A blocking handler itself failed (R1): the engine is told, so the request's document (else
   * every live document of its origin) is PROTECTION_LOST internal-error, and the request is
   * cancelled without the engine. The document is the request's only when its record is this hop's
   * and was announced: a record not announced yet, or one of an earlier redirect hop (whose
   * document already ended), would aim the fault at a document the engine drops it for.
   */
  const failFor = (d: WebRequestDetails): BlockingResponse => {
    const po = protectedFor(d.url);
    if (po === null) return {};
    const rec = requests.get(d.requestId) ?? null;
    let current = false;
    try {
      current = rec !== null && rec.announced && !rec.followed && rec.obs.url === redact(d.url);
    } catch {
      current = false;
    }
    const doc = current ? (rec?.obs.doc ?? null) : null;
    void push(rec, {
      k: 'engine-fault',
      fault: 'internal-error',
      ...(doc !== null ? {doc} : {origin: po.origin}),
    }).catch(() => undefined);
    return {cancel: true};
  };

  const onBeforeRequest = guarded('ff-before-request', beforeRequest, failFor);
  const onHeadersReceived = guarded('ff-headers-received', headersReceived, failFor);

  const onBeforeRedirect = gated((d: WebRequestRedirectDetails): void => {
    const rec = requests.get(d.requestId);
    if (rec === undefined) return;
    // No response status and the request's own address: no redirect a server sent, but a service
    // worker that controls the page taking the request. Firefox moves such a request to a channel
    // of its own for the worker (an internal redirect; the request id stays) and reports that
    // here, sometimes only after the document has committed. A document's filter fails at that
    // move ("Invalid request ID"), so nobody holds what the worker serves. A subresource's filter
    // still receives the worker's bytes, unless the worker answers with a response it fetched
    // from another address: Firefox then drops that filter too ("Channel redirected"). For what
    // the worker answers, no response headers and no end of the request are ever reported. If
    // the worker does not answer, Firefox moves the request to a network channel and reports it
    // again under the same id (onBeforeRequest: `supersede`). The request and its document go on
    // in every case: this notice ends nothing, and the filter's fate and a second onBeforeRequest
    // tell which case it is.
    if (d.statusCode === 0 && d.redirectUrl === d.url) return;
    rec.redirected = true;
    rec.followed = true;
    void push(rec, {k: 'redirect', req: d.requestId});
    if (rec.isDocument && rec.obs.doc !== null) {
      // The redirect response never becomes a document: its session ends here, and the next hop
      // (same request id, onBeforeRequest again) starts a new one.
      void push(rec, {k: 'doc-end', doc: rec.obs.doc});
    }
  });
  const onCompleted = gated((d: WebRequestResponseDetails): void => {
    const rec = requests.get(d.requestId);
    if (rec === undefined) return;
    requests.delete(d.requestId);
    settle(rec, 'completed');
    void push(rec, {k: 'completed', req: d.requestId, status: d.statusCode});
  });
  const onErrorOccurred = gated((d: WebRequestErrorDetails): void => {
    const rec = requests.get(d.requestId);
    if (rec === undefined) return;
    requests.delete(d.requestId);
    settle(rec, 'failed');
    if (rec.filtered && !rec.finished) pending.close(d.requestId);
    // The request is gone: a header decision it waits for no longer holds anything (no timeout).
    expire(rec);
    // Nothing was delivered to the page: the item simply ends.
    void push(rec, {k: 'completed', req: d.requestId, status: 0});
    // A document load that failed before it committed (cancelled at its headers, aborted) never
    // runs: its session ends. One the frame already shows keeps running, and one whose own commit
    // arrives after the error is revived then (docs.commit).
    const {doc, tab, frame} = rec.obs;
    if (rec.isDocument && doc !== null && docs.current(tab, frame) !== doc) {
      docs.note(tab, frame, doc, 'failed');
      docs.unpend(tab, frame, doc);
      // The end waits for the request's earlier observations. If the load's commit arrives
      // meanwhile, the engine learns of the revival first, and the end must not follow it: the
      // engine is told what the frame shows then.
      void push(rec, async () =>
        docs.current(tab, frame) === doc ? {k: 'committed', doc} : {k: 'doc-end', doc},
      );
    }
  });
  const onCommitted = gated(
    (d: {tabId: number; frameId: number; url: string; timeStamp: number}): void => {
      const {previous, current, dropped, revived} = docs.commit(
        d.tabId,
        d.frameId,
        redact(d.url),
        d.timeStamp,
      );
      if (previous !== null && previous !== current) endDoc(previous);
      // A pending load something else committed over (a download, the blocked page) never runs.
      if (dropped !== null) endDoc(dropped);
      // A load reported failed or superseded before its commit arrived renders after all: its
      // session (and its taint) comes back.
      if (revived !== null) void push(null, {k: 'revived', doc: revived});
      else if (current !== null) void push(null, {k: 'committed', doc: current});
      // A blob: document has the origin of the document that created it and can script that
      // origin's windows, but no request or content script names it.
      const blob = d.url.startsWith('blob:') ? protectedFor(d.url.slice('blob:'.length)) : null;
      if (blob !== null && d.tabId >= 0) {
        void push(null, {k: 'blob-doc', tab: d.tabId, origin: blob.origin});
      }
      // A document of a registered origin that commits without a load this backend saw: its
      // host permission is missing (webRequest never reported the load: no filter, no header
      // guard; this event needs no host permission), or no request preceded the commit of a
      // top-level document (a page restored from the back/forward cache). With the permission, a
      // frame's commit without a request is not adopted: Firefox reports a framed document's
      // request only if the extension may access the framing page, and reports the commit even
      // for a document it refuses to render (X-Frame-Options, frame-ancestors). A framed
      // document that runs is reported by its content script (CS_HELLO: `adopt` below).
      const o = originOf(d.url);
      const po = o === null ? null : lookup(o);
      if (
        current === null &&
        d.tabId >= 0 &&
        po !== null &&
        (!po.granted || (d.frameId === 0 && docs.pending(d.tabId, d.frameId) === null))
      ) {
        const url = redact(d.url);
        const doc = docs.adopt(d.tabId, d.frameId, url);
        void push(null, {k: 'unwatched-doc', doc, tab: d.tabId, frame: d.frameId, url});
      }
    },
  );
  const onBeforeNavigate = gated((d: {tabId: number; frameId: number}): void => {
    if (d.tabId < 0) return;
    let byFrame = starts.get(d.tabId);
    if (byFrame === undefined) starts.set(d.tabId, (byFrame = new Map()));
    // A navigation of the top frame counts for every frame of the tab: older starts add nothing.
    if (d.frameId === 0) byFrame.clear();
    byFrame.set(d.frameId, ++ticks);
  });
  const onTabRemoved = gated((tab: number): void => {
    docs.removeTab(tab);
    starts.delete(tab);
  });
  const onCreatedNavigationTarget = gated(
    (d: {sourceTabId: number; sourceFrameId: number; tabId: number}): void => {
      if (d.sourceTabId < 0 || d.tabId < 0) return;
      void push(null, {
        k: 'opened',
        sourceTab: d.sourceTabId,
        sourceDoc: docs.current(d.sourceTabId, d.sourceFrameId),
        tab: d.tabId,
      });
    },
  );

  const filter = {urls: ['<all_urls>']};
  const backend: FirefoxBackend = {
    async start(s) {
      sink = s;
      const restored = docs
        .restore()
        .catch((e: unknown) => logWarn('ff-restore', {error: errorName(e)}));
      gate = Promise.all([whenReady(), restored]).then(() => {
        ready = true;
      });
      // Synchronously, before any await (MV3 event-page wake-up).
      ext.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter, ['blocking']);
      ext.webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, [
        'blocking',
        'responseHeaders',
      ]);
      ext.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, filter);
      ext.webRequest.onCompleted.addListener(onCompleted, filter);
      ext.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);
      ext.webNavigation?.onCommitted.addListener(onCommitted);
      ext.webNavigation?.onBeforeNavigate?.addListener(onBeforeNavigate);
      ext.webNavigation?.onCreatedNavigationTarget?.addListener(onCreatedNavigationTarget);
      ext.tabs.onRemoved.addListener(onTabRemoved);
      try {
        await restored;
        for (const stale of await pending.takeStale()) {
          // A filter the previous instance never closed: its bytes may have run unverified.
          void push(null, {k: 'engine-fault', fault: 'verifier-restarted', doc: stale.doc});
        }
      } catch (e) {
        logWarn('ff-restore', {error: errorName(e)});
      }
    },

    async command(c: BackendCommand) {
      await ext.tabs.update(c.tab, {url: pageUrl(c.incidentId)}).catch(() => undefined);
    },

    docKeyFor(sender: SenderDoc): DocKey | null {
      return frameDoc(sender.tab, sender.frame, sender.url);
    },

    adopt(tab: number, frame: number, url: string): DocKey | null {
      if (docs.current(tab, frame) !== null || docs.pending(tab, frame) !== null) return null;
      return docs.adopt(tab, frame, url);
    },

    async documentGone(tab: number, frame: number): Promise<boolean> {
      // Only Firefox answers, never the backend's own frame bookkeeping, which a request or a
      // content-script message of the page can move (DocKeys.forFrame): a taint source must not
      // be able to end itself while it is displayed. A navigation ends a document through its
      // commit (onCommitted), not here.
      const getFrame = ext.webNavigation?.getFrame;
      if (getFrame === undefined) return false;
      try {
        const f = await getFrame.call(ext.webNavigation, {tabId: tab, frameId: frame});
        // A discarded tab: the document is gone.
        return f === null || f === undefined;
      } catch (e) {
        // getFrame rejects for a frame the tab does not have (an iframe was removed) and for a
        // tab that does not exist; anything else stays unconfirmed.
        if (e instanceof Error && e.message.startsWith('No frame found')) return true;
        try {
          await ext.tabs.get(tab);
          return false;
        } catch {
          return true;
        }
      }
    },
  };
  return backend;
}
