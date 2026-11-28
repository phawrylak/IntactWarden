/**
 * The R4 bound in the Firefox backend: every response
 * the backend holds, at the header stage or in a StreamFilter, is denied by its R4 deadline,
 * whatever the engine does (it hangs, rejects or answers late); no byte is released without the
 * engine's 'allow'. The engine still hears `unverifiable:timeout` (PROTECTION_LOST) on a path that
 * does not wait for the request's own pending decisions.
 */

import {describe, expect, it} from 'vitest';
import {createFirefoxBackend} from '../../src/backends/firefox/index.ts';
import {attachFilter, type FilterHooks} from '../../src/backends/firefox/streamFilter.ts';
import {
  type Decision,
  type HeaderDecision,
  type Observation,
  type ObservationSink,
  type UnverifiableReason,
  r4Ms,
} from '../../src/contracts.ts';
import type {BlockingResponse} from '../../src/platform/webext.ts';
import {
  createFakeEnv,
  details,
  FakeStreamFilter,
  FakeTimers,
  type FakeEnv,
} from '../engine/helpers/fakeExt.ts';
import {bytes, VW_ORIGIN, vwOrigin} from '../engine/helpers/world.ts';

const flush = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};

const BODY = bytes('console.log("app");');
const R4 = r4Ms('script');

function filterHooks(
  timers: FakeTimers,
  body: FilterHooks['body'],
): {hooks: FilterHooks; reasons: UnverifiableReason[]; bodies: Uint8Array[]; done: () => boolean} {
  const reasons: UnverifiableReason[] = [];
  const bodies: Uint8Array[] = [];
  let finished = false;
  return {
    reasons,
    bodies,
    done: () => finished,
    hooks: {
      req: 'r1',
      timeoutMs: R4,
      maxBytes: 1 << 20,
      body: b => {
        bodies.push(b);
        return body(b);
      },
      unverifiable: r => reasons.push(r),
      done: () => (finished = true),
      blocked: () => undefined,
      setTimer: timers.set,
      clearTimer: timers.clear,
    },
  };
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('StreamFilter R4 (attachFilter)', () => {
  it('R4 closes the filter empty whether the decision is pending or onstop never came', async () => {
    for (const stopFirst of [true, false]) {
      const f = new FakeStreamFilter();
      const timers = new FakeTimers();
      let decide!: (d: Decision) => void;
      const h = filterHooks(timers, () => new Promise<Decision>(r => (decide = r)));
      attachFilter(f, h.hooks);
      if (stopFirst) f.respond(BODY);
      timers.advance(R4 + 1);
      await flush();
      expect(h.reasons).toEqual(['timeout']);
      expect(f.closed).toBe(true);
      expect(f.written).toHaveLength(0);
      if (!stopFirst) f.respond(BODY);
      else decide({act: 'allow'});
      await flush();
      expect(f.written).toHaveLength(0);
    }
  });
});

/** A backend on the fake Ext with a scripted engine. */
async function backendWith(
  sink: Partial<ObservationSink>,
): Promise<{env: FakeEnv; timers: FakeTimers; pushed: Observation[]}> {
  const env = createFakeEnv();
  const timers = new FakeTimers();
  const pushed: Observation[] = [];
  const vw = vwOrigin();
  const backend = createFirefoxBackend({
    ext: env.ext,
    now: timers.clock,
    lookup: origin => (origin === vw.origin ? vw : null),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const full: ObservationSink = {
    push: o => {
      pushed.push(o);
      return sink.push?.(o) ?? never<Decision>();
    },
    headers: (h, r) => sink.headers?.(h, r) ?? never<HeaderDecision>(),
  };
  await backend.start(full);
  // The document (its own decisions are not under test here) and its commit.
  const d = details({requestId: 'doc', url: `${VW_ORIGIN}/`, type: 'main_frame'});
  env.webRequest.onBeforeRequest.emit(d);
  env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url: d.url, timeStamp: 0});
  return {env, timers, pushed};
}

function headersOf(env: FakeEnv, d: ReturnType<typeof details>): () => BlockingResponse | null {
  let out: BlockingResponse | null = null;
  void Promise.resolve(
    env.webRequest.onHeadersReceived.emit({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}],
    })[0] as BlockingResponse | Promise<BlockingResponse>,
  ).then(r => (out = r));
  return () => out;
}

const SCRIPT = details({
  requestId: 's1',
  url: `${VW_ORIGIN}/app/main.0123456789abcdef0123.js`,
  type: 'script',
  documentUrl: `${VW_ORIGIN}/`,
  originUrl: `${VW_ORIGIN}/`,
});

describe('Firefox backend: nothing is held past R4, whatever the engine does', () => {
  it("a header decision the engine never gives is answered by the request's R4: cancelled", async () => {
    const {env, timers, pushed} = await backendWith({});
    env.webRequest.onBeforeRequest.emit(SCRIPT);
    const f = env.filters.get('s1')!;
    timers.advance(10_000);
    const answer = headersOf(env, SCRIPT);
    await flush();
    timers.advance(R4 - 10_001);
    await flush();
    expect(answer()).toBeNull();
    timers.advance(2);
    await flush();
    // The engine hears the timeout at the request's R4 although its header decision is pending.
    expect(pushed).toContainEqual(
      expect.objectContaining({k: 'unverifiable', req: 's1', reason: 'timeout'}),
    );
    expect(answer()).toEqual({cancel: true});
    f.respond(BODY);
    await flush();
    expect(f.written).toHaveLength(0);
    expect(f.closed).toBe(true);
  });

  it('headers that arrive after R4 fired are denied at once, whatever the engine would answer', async () => {
    // A server slower than R4. The engine answers the header decision (CSP floor appended)
    // when `answers` is set, never otherwise.
    for (const answers of [true, false]) {
      const floor = {act: 'allow' as const, responseHeaders: [['x-floor', '1'] as const]};
      const {env, timers} = await backendWith({
        ...(answers
          ? {
              headers: () => Promise.resolve(floor),
              push: () => Promise.resolve({act: 'allow' as const}),
            }
          : {}),
      });
      env.webRequest.onBeforeRequest.emit(SCRIPT);
      timers.advance(R4 + 1);
      await flush();
      const answer = headersOf(env, SCRIPT);
      await flush();
      expect(answer(), `answers: ${answers}`).toEqual({cancel: true});
    }
  });

  it('a request without a filter is held at its header stage at most the R4 limit', async () => {
    // /api/** is dynamic: no StreamFilter, the header guard only. A slow server is not a hold:
    // the bound runs from the headers' arrival.
    const {env, timers, pushed} = await backendWith({});
    const xhr = details({
      requestId: 'x1',
      url: `${VW_ORIGIN}/api/sync`,
      type: 'xmlhttprequest',
      documentUrl: `${VW_ORIGIN}/`,
      originUrl: `${VW_ORIGIN}/`,
    });
    env.webRequest.onBeforeRequest.emit(xhr);
    expect(env.filters.has('x1')).toBe(false);
    timers.advance(R4 + 30_000);
    const answer = headersOf(env, xhr);
    await flush();
    timers.advance(R4 - 1);
    await flush();
    expect(answer()).toBeNull();
    timers.advance(2);
    await flush();
    expect(answer()).toEqual({cancel: true});
    // The engine is told about the request and its timeout (PROTECTION_LOST).
    expect(pushed).toContainEqual(expect.objectContaining({k: 'request', req: 'x1'}));
    expect(pushed).toContainEqual(
      expect.objectContaining({k: 'unverifiable', req: 'x1', reason: 'timeout'}),
    );
  });

  it('an engine that rejects or answers late never makes the backend release', async () => {
    const {env, timers} = await backendWith({
      headers: () => Promise.reject(new Error('engine failed')),
      push: o =>
        o.k === 'body'
          ? new Promise<Decision>(r => timers.set(() => r({act: 'allow'}), 2 * R4))
          : Promise.resolve({act: 'allow'}),
    });
    env.webRequest.onBeforeRequest.emit(SCRIPT);
    const f = env.filters.get('s1')!;
    const answer = headersOf(env, SCRIPT);
    await flush();
    expect(answer()).toEqual({cancel: true});
    f.respond(BODY);
    await flush();
    timers.advance(R4 + 1);
    await flush();
    expect(f.written).toHaveLength(0);
    expect(f.closed).toBe(true);
    // The late 'allow' (at twice R4) changes nothing.
    timers.advance(2 * R4);
    await flush();
    expect(f.written).toHaveLength(0);
  });
});

/** Emits `d`'s headers with `status` and `headers`; the returned getter reads the listener's answer. */
function respond(
  env: FakeEnv,
  d: ReturnType<typeof details>,
  status: number,
  headers: [string, string][],
): () => BlockingResponse | null {
  let out: BlockingResponse | null = null;
  void Promise.resolve(
    env.webRequest.onHeadersReceived.emit({
      ...d,
      statusCode: status,
      responseHeaders: headers.map(([name, value]) => ({name, value})),
    })[0] as BlockingResponse | Promise<BlockingResponse>,
  ).then(r => (out = r));
  return () => out;
}

const DOC = details({requestId: 'doc', url: `${VW_ORIGIN}/`, type: 'main_frame'});
const EVIL: [string, string][] = [['Location', 'https://evil.example/x#frag']];

/**
 * The header guard: an undeclared Location and a Refresh are
 * cancelled, also when the backend answers a header decision without the engine (R4, an engine that rejects, a
 * handler that throws): every such answer is a cancel, so no undeclared redirect is followed (with
 * the URL fragment, where Bitwarden Send keys live).
 */
describe('Firefox backend: no undeclared redirect is followed when a header decision is answered without the engine', () => {
  const ORDINARY: [string, number, [string, string][]] = [
    'ordinary',
    200,
    [['Content-Type', 'text/javascript']],
  ];
  const cancelled: [string, number, [string, string][]][] = [
    ['cross-origin redirect', 302, EVIL],
    ['same-origin redirect', 301, [['Location', '/elsewhere']]],
    ['3xx without Location', 300, []],
    [
      'Refresh',
      200,
      [
        ['Content-Type', 'text/javascript'],
        ['Refresh', '0; url=https://evil.example/'],
      ],
    ],
    [
      'Link',
      200,
      [
        ['Content-Type', 'text/javascript'],
        ['Link', '<https://evil.example/x.css>; rel=preload'],
      ],
    ],
  ];

  it('an engine that rejects the header decision: every response is cancelled', async () => {
    for (const [what, status, headers] of [...cancelled, ORDINARY]) {
      const {env} = await backendWith({
        headers: () => Promise.reject(new Error('engine failed')),
        push: () => Promise.resolve({act: 'allow'}),
      });
      env.webRequest.onBeforeRequest.emit(SCRIPT);
      const answer = respond(env, SCRIPT, status, [...headers]);
      await flush();
      expect(answer(), what).toEqual({cancel: true});
    }
  });

  it('every header decision answered at the bound without the engine is a cancel', async () => {
    for (const [what, status, headers] of [...cancelled, ORDINARY]) {
      const {env, timers} = await backendWith({});
      env.webRequest.onBeforeRequest.emit(SCRIPT);
      timers.advance(1_000);
      const answer = respond(env, SCRIPT, status, [...headers]);
      await flush();
      timers.advance(R4 - 999);
      await flush();
      expect(answer(), what).toEqual({cancel: true});
    }
  });

  it('a header handler that throws cancels the response and tells the engine (R1)', async () => {
    // A header value Firefox could not hand over as text, malformed here (`binaryValue` not a list),
    // makes the backend's own handler throw before the engine is asked.
    const bad = {name: 'X-Bad', binaryValue: 5 as unknown as number[]};
    for (const [status, extra, expected] of [
      [302, [{name: 'Location', value: 'https://evil.example/x'}], {cancel: true}],
      [200, [{name: 'Refresh', value: '0; url=https://evil.example/'}], {cancel: true}],
      [200, [{name: 'Content-Type', value: 'text/javascript'}], {cancel: true}],
    ] as const) {
      const {env, pushed} = await backendWith({
        push: () => Promise.resolve({act: 'allow'}),
      });
      env.webRequest.onBeforeRequest.emit(SCRIPT);
      let out: BlockingResponse | null = null;
      void Promise.resolve(
        env.webRequest.onHeadersReceived.emit({
          ...SCRIPT,
          statusCode: status,
          responseHeaders: [...extra, bad],
        })[0] as BlockingResponse | Promise<BlockingResponse>,
      ).then(r => (out = r));
      await flush();
      expect(out, `${status}`).toEqual(expected);
      // R1: the engine is told, so the document is PROTECTION_LOST, not green.
      expect(pushed, `${status}`).toContainEqual(
        expect.objectContaining({k: 'engine-fault', fault: 'internal-error', doc: '1:0:1'}),
      );
    }
  });

  it('a request handler that throws cancels the request and tells the engine (R1)', async () => {
    // No input Firefox delivers is known to make the handler throw; a details object whose
    // `frameId` cannot be read stands in for an unforeseen internal error.
    const {env, pushed} = await backendWith({push: () => Promise.resolve({act: 'allow'})});
    const broken = {
      ...SCRIPT,
      get frameId(): number {
        throw new TypeError('unreadable');
      },
    };
    const out = await Promise.resolve(env.webRequest.onBeforeRequest.emit(broken)[0]);
    await flush();
    expect(out).toEqual({cancel: true});
    expect(env.filters.has('s1')).toBe(false);
    expect(pushed).toContainEqual(
      expect.objectContaining({k: 'engine-fault', fault: 'internal-error', origin: VW_ORIGIN}),
    );
  });
});

/**
 * A redirect hop whose header decision the engine never gives leaves a `timeout` record for the
 * hop, as any other held request does, without changing its answer (cancelled at the bound); a
 * hop Firefox has already followed reports nothing under the request id the next hop
 * now owns.
 */
describe('Firefox backend: a timed-out redirect hop is recorded', () => {
  it('an unanswered redirect hop reports unverifiable:timeout and is cancelled', async () => {
    for (const [d, r4] of [
      [DOC, r4Ms('main_frame')],
      [SCRIPT, R4],
    ] as const) {
      const {env, timers, pushed} = await backendWith({
        headers: () => never<HeaderDecision>(),
        push: () => Promise.resolve({act: 'allow'}),
      });
      if (d !== DOC) env.webRequest.onBeforeRequest.emit(d);
      const answer = respond(env, d, 302, [['Location', `${VW_ORIGIN}/elsewhere`]]);
      await flush();
      timers.advance(r4 + 1);
      await flush();
      expect(pushed, `${d.type}`).toContainEqual(
        expect.objectContaining({k: 'unverifiable', req: d.requestId, reason: 'timeout'}),
      );
      expect(answer(), `${d.type}`).toEqual({cancel: true});
    }
  });

  it('a followed redirect reports nothing under the reused request id when its old filter times out', async () => {
    const {env, timers, pushed} = await backendWith({
      headers: () => Promise.resolve({act: 'allow'}),
      push: () => never<Decision>(),
    });
    env.webRequest.onBeforeRequest.emit(SCRIPT);
    respond(env, SCRIPT, 302, [['Location', `${VW_ORIGIN}/app/main.1123456789abcdef0123.js`]]);
    await flush();
    env.webRequest.onBeforeRedirect.emit({
      ...SCRIPT,
      statusCode: 302,
      redirectUrl: `${VW_ORIGIN}/app/main.1123456789abcdef0123.js`,
    });
    await flush();
    // The old hop's filter is dropped by Firefox; its R4 timer still fires.
    timers.advance(R4 + 1);
    await flush();
    expect(pushed.filter(o => o.k === 'unverifiable' && o.req === 's1')).toEqual([]);
  });
});
