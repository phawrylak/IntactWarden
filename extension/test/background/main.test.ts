/**
 * The composition root (extension/src/background/main.ts) booted against the fake `browser`
 * namespace: every listener is registered synchronously, every page and content-script message has
 * exactly one handler, and the extension pages get their state through messages (R10). No real
 * browser is involved (the Firefox end-to-end suite is extension/test/e2e), and no real network
 * either: `fetch` is stubbed before main.ts is imported, answers every request with 404 and records
 * it, and the test checks which hosts the background asked for. main.ts has no test hook.
 */

import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {
  DEFAULT_SETTINGS,
  MESSAGE_SENDERS,
  type MessageType,
  type OnboardingStatus,
  type Settings,
  type TrustPanelView,
} from '../../src/contracts.ts';
import {createFakeEnv, details, type FakeEnv} from '../engine/helpers/fakeExt.ts';
import {bytes} from '../engine/helpers/world.ts';

const BASE = 'moz-extension://test-extension-id/';
const PAGE = {id: 'test-extension-id', url: `${BASE}ui/popup.html`};
const CONTENT = {
  id: 'test-extension-id',
  url: 'https://vault.bitwarden.com/#/vault',
  tab: {id: 1},
  frameId: 0,
};

let env: FakeEnv;
const g = globalThis as {browser?: unknown};

/** The codes the background logged with logWarn. */
const warnings: string[] = [];

/** Every URL the background fetched; the stub answers 404 and never reaches the network. */
const fetched: string[] = [];
const offlineFetch = (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  fetched.push(url);
  return Promise.resolve(new Response('offline test', {status: 404}));
};

/**
 * Origins the background may contact at start-up: only its own package. Nothing runs on a timer
 * and no page asked for a release, so no GitHub request is expected either.
 */
const EXPECTED_ORIGINS = new Set(['moz-extension://test-extension-id']);

/** What the background answers to one message (undefined: no listener took it). */
async function ask(type: MessageType, payload: unknown, sender: object = PAGE): Promise<unknown> {
  const replies = env.onMessage.emit({iw: 1, type, payload}, sender) as unknown[];
  const taken = replies.filter(r => r !== undefined);
  expect(taken.length, `${type}: listeners that answered`).toBeLessThanOrEqual(1);
  return taken[0] === undefined ? undefined : await taken[0];
}

beforeAll(async () => {
  env = createFakeEnv();
  g.browser = env.ext;
  vi.stubGlobal('fetch', offlineFetch);
  vi.spyOn(console, 'warn').mockImplementation((_tag: unknown, code: unknown) => {
    warnings.push(String(code));
  });
  await import('../../src/background/main.ts');
  // Let main() reach engine.start() (registry, trust store and settings load from fakes). A
  // WebCrypto digest in each turn gives those main() started, which complete off the main
  // thread, the time to finish.
  for (let i = 0; i < 20; i++) {
    await crypto.subtle.digest('SHA-256', new Uint8Array(1));
    await new Promise(r => setImmediate(r));
  }
});

afterAll(() => {
  delete g.browser;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('background composition root', () => {
  it('fetches only through the stubbed fetch, and only its own package at start-up', () => {
    expect(fetched.length).toBeGreaterThan(0);
    // `${protocol}//${host}`: URL.origin is "null" for moz-extension: in Node.
    const origins = new Set(
      fetched.map(u => {
        const url = new URL(u);
        return `${url.protocol}//${url.host}`;
      }),
    );
    for (const origin of origins) expect(EXPECTED_ORIGINS, origin).toContain(origin);
    expect(origins).toContain('moz-extension://test-extension-id');
  });

  it('registers the Firefox backend listeners synchronously, blocking where it must', () => {
    const before = env.webRequest.onBeforeRequest.listeners;
    const headers = env.webRequest.onHeadersReceived.listeners;
    expect(before).toHaveLength(1);
    expect(before[0]!.extra).toEqual(['blocking']);
    expect(headers).toHaveLength(1);
    expect(headers[0]!.extra).toEqual(['blocking', 'responseHeaders']);
    expect(env.webRequest.onCompleted.listeners).toHaveLength(1);
    expect(env.onCommitted.listeners).toHaveLength(1);
    // The router; no port (nothing keeps the event page alive).
    expect(env.onMessage.listeners).toHaveLength(1);
  });

  it('answers every page and content-script message type with exactly one handler', async () => {
    // A content script in another tab: its hello adopts an unseen document there (R2).
    const content = {...CONTENT, tab: {id: 99}};
    for (const [type, kind] of Object.entries(MESSAGE_SENDERS) as [MessageType, string][]) {
      if (kind === 'background') continue;
      const reply = await ask(type, {}, kind === 'content' ? content : PAGE);
      // A malformed payload may be refused, but never left unanswered.
      expect(reply, type).toBeTypeOf('object');
      expect(reply, type).toHaveProperty('ok');
      expect(reply, type).not.toEqual({ok: false, error: 'bad-sender'});
    }
  });

  it('refuses a page message from a content script and foreign senders', async () => {
    expect(await ask('UI_GET_SETTINGS', {}, CONTENT)).toEqual({ok: false, error: 'bad-sender'});
    expect(await ask('UI_GET_SETTINGS', {}, {...PAGE, id: 'other'})).toEqual({
      ok: false,
      error: 'bad-sender',
    });
  });

  it('serves the pages their state through messages', async () => {
    const settings = (await ask('UI_GET_SETTINGS', {})) as {ok: true; value: Settings};
    expect(settings).toEqual({ok: true, value: DEFAULT_SETTINGS});
    expect(await ask('UI_GET_STATE', {tab: 1})).toEqual({ok: true, value: null});
    const trust = (await ask('UI_GET_TRUST', {})) as {ok: true; value: TrustPanelView};
    expect(trust.ok).toBe(true);
    expect(trust.value.snapshot.ready).toBe(true);
    const onboarding = (await ask('UI_GET_ONBOARDING', {})) as {
      ok: true;
      value: OnboardingStatus;
    };
    expect(onboarding.ok).toBe(true);
    expect(onboarding.value.permissions.length).toBeGreaterThan(0);
    expect(onboarding.value).not.toHaveProperty('browser');
    const patched = (await ask('UI_SET_SETTINGS', {patch: {notifications: false}})) as {
      ok: true;
      value: Settings;
    };
    expect(patched.value.notifications).toBe(false);
    expect(((await ask('UI_GET_SETTINGS', {})) as {value: Settings}).value.notifications).toBe(
      false,
    );
    await ask('UI_SET_SETTINGS', {patch: {notifications: true}});
  });

  it('a protected navigation reaches the popup through the persisted tab state', async () => {
    const url = 'https://vault.bitwarden.com/?secret=1#frag';
    const d = details({requestId: 'r1', url, type: 'main_frame', tabId: 1});
    await env.webRequest.onBeforeRequest.fire(d);
    await env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: [{name: 'content-type', value: 'text/html; charset=utf-8'}],
    });
    env.onCommitted.emit({tabId: 1, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    const page = bytes('<!doctype html><html><head></head><body>vault</body></html>');
    env.filters.get('r1')!.respond(page);
    type State = {ok: true; value: {state: string; reasons: string[]; origin: string} | null};
    // The body is hashed off the main thread and the hint is fetched: wait for the decision.
    const reply = await vi.waitFor(
      async () => {
        const r = (await ask('UI_GET_STATE', {tab: 1})) as State;
        expect(r.value?.state).toBe('BUILD_UNVERIFIED');
        return r;
      },
      {timeout: 4_000},
    );
    // Nothing to verify it against: denied, nothing written.
    expect(env.filters.get('r1')!.written).toHaveLength(0);
    expect(reply.ok).toBe(true);
    // No bundled core, as in the shipping package (the package reader finds no index): an unknown
    // build whose version hint is missing (the stub answers 404), not a failed start (R5).
    expect(reply.value).toMatchObject({
      origin: 'https://vault.bitwarden.com',
      state: 'BUILD_UNVERIFIED',
      reasons: ['not-derivable'],
    });
    expect(warnings).toContain('trust.store.ready');
    expect(warnings.filter(w => w.startsWith('trust.bootstrap'))).toEqual([]);
    expect(JSON.stringify(await env.session.get(null))).not.toMatch(/secret|frag/);
  });

  it('the content script of that document learns its sensor configuration', async () => {
    const reply = (await ask('CS_HELLO', {}, CONTENT)) as {
      ok: boolean;
      value?: {protected: boolean};
    };
    expect(reply.ok).toBe(true);
    expect(reply.value).toEqual({protected: true, doc: expect.stringMatching(/^1:0:\d+$/)});
  });
});
