/**
 * The composition root (extension/src/background/main.ts) on the real Vaultwarden v2026.10.1
 * release (opt-in: INTACTWARDEN_CORPUS=1; uses the digest-addressed cache in
 * fixtures/corpora/.downloads/). The package carries the bootstrap data of a test build
 * (build/bootstrap.ts); the fake `browser` namespace serves it from `moz-extension://` URLs. A
 * self-hosted instance at loopback is added through UI_ADD_INSTANCE, and the Firefox backend sees
 * the release's own `index.html` and main script through webRequest and StreamFilters: VERIFIED
 * when the bytes are the release's, MISMATCH when one byte differs. No network: the add-server
 * request to `api/config` gets a Vaultwarden answer and every other fetch fails. This is the
 * closest the unit tests come to the Firefox end-to-end suite.
 */

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {iterateTarGzFiles} from '@intactwarden/core/archive/tar.ts';
import {
  CORPUS_ENABLED,
  fetchVaultwardenTarball,
  loadVaultwardenLock,
} from '../../../tools/corpus.ts';
import type {MessageType, TabStateRecord} from '../../src/contracts.ts';
import {buildBootstrap} from '../../build/bootstrap.ts';
import {createFakeEnv, details, type FakeEnv} from '../engine/helpers/fakeExt.ts';

const VW = loadVaultwardenLock('2026.10.1');
const ORIGIN = 'http://127.0.0.1:8080';
const BASE = 'moz-extension://test-extension-id/';
const PAGE = {id: 'test-extension-id', url: `${BASE}ui/popup.html`};
const HTML = [{name: 'content-type', value: 'text/html; charset=utf-8'}];
const JS = [{name: 'content-type', value: 'application/javascript; charset=utf-8'}];

const g = globalThis as {browser?: unknown; fetch: typeof fetch};

describe.runIf(CORPUS_ENABLED)('Firefox background on the real Vaultwarden release', () => {
  let env: FakeEnv;
  let realFetch: typeof fetch;
  const site = new Map<string, Uint8Array>();
  let seq = 0;

  // Real timer turns: WebCrypto digests (a 6.7 MB main among them) complete off the main thread.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 1));
  };

  async function ask(type: MessageType, payload: unknown): Promise<unknown> {
    const replies = (env.onMessage.emit({iw: 1, type, payload}, PAGE) as unknown[]).filter(
      r => r !== undefined,
    );
    expect(replies).toHaveLength(1);
    return replies[0];
  }

  async function tabState(tab: number): Promise<TabStateRecord | null> {
    const r = (await ask('UI_GET_STATE', {tab})) as {ok: true; value: TabStateRecord | null};
    expect(r.ok).toBe(true);
    return r.value;
  }

  /** One response through the Firefox backend: blocking listeners, then the StreamFilter. */
  async function load(
    tab: number,
    path: string,
    type: 'main_frame' | 'script',
    body: Uint8Array,
  ): Promise<Uint8Array> {
    const requestId = `q${seq++}`;
    const url = ORIGIN + path;
    const d = details({
      requestId,
      url,
      type,
      tabId: tab,
      ...(type === 'script' ? {originUrl: `${ORIGIN}/`, documentUrl: `${ORIGIN}/`} : {}),
    });
    await env.webRequest.onBeforeRequest.fire(d);
    await env.webRequest.onHeadersReceived.fire({
      ...d,
      statusCode: 200,
      responseHeaders: type === 'main_frame' ? HTML : JS,
    });
    if (type === 'main_frame') {
      env.onCommitted.emit({tabId: tab, frameId: 0, parentFrameId: -1, url, timeStamp: 0});
    }
    const filter = env.filters.get(requestId);
    expect(filter, `${path}: a StreamFilter`).toBeDefined();
    filter!.respond(body);
    await settle();
    await env.webRequest.onCompleted.fire({...d, statusCode: 200});
    await settle();
    return filter!.output;
  }

  beforeAll(async () => {
    const bootstrap = await buildBootstrap({apps: 'vaultwarden'});
    for await (const f of iterateTarGzFiles(await fetchVaultwardenTarball(VW), {
      stripPrefix: 'web-vault/',
    })) {
      site.set(f.path, new Uint8Array(f.bytes));
    }
    env = createFakeEnv();
    g.browser = env.ext;
    realFetch = g.fetch;
    g.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${ORIGIN}/api/config`) {
        const config = {
          object: 'config',
          server: {name: 'Vaultwarden'},
          environment: {vault: ORIGIN},
        };
        return new Response(JSON.stringify(config), {status: 200});
      }
      const bytes = url.startsWith(BASE) ? bootstrap.files.get(url.slice(BASE.length)) : undefined;
      if (bytes === undefined) throw new TypeError(`no network in this test: ${url}`);
      return new Response(bytes as unknown as BodyInit, {status: 200});
    }) as typeof fetch;
    await import('../../src/background/main.ts');
    await settle();
    const added = (await ask('UI_ADD_INSTANCE', {
      input: ORIGIN,
      lookalikeConfirmed: false,
    })) as {ok: boolean};
    expect(added).toMatchObject({ok: true, value: {ok: true}});
    await settle();
  }, 600_000);

  afterAll(() => {
    delete g.browser;
    if (realFetch !== undefined) g.fetch = realFetch;
  });

  function mainScript(): string {
    const html = new TextDecoder().decode(site.get('/index.html'));
    const m = /src="(app\/main\.[0-9a-f]+\.js)"/.exec(html);
    expect(m, 'index.html names app/main.<hash>.js').not.toBeNull();
    return `/${m![1]}`;
  }

  it('the bundled core is loaded from the package', async () => {
    const trust = (await ask('UI_GET_TRUST', {})) as {
      ok: true;
      value: {snapshot: {loaded: boolean}; cores: {buildId: string; source: string}[]};
    };
    expect(trust.value.snapshot.loaded).toBe(true);
    expect(trust.value.cores.map(c => [c.buildId, c.source])).toEqual([
      ['vaultwarden-web@2026.10.1+release', 'bundled'],
    ]);
  });

  it('VERIFIED: the release index.html and main script, released exactly as hashed', async () => {
    const index = site.get('/index.html')!;
    expect(await load(1, '/', 'main_frame', index)).toEqual(index);
    const path = mainScript();
    const js = site.get(path)!;
    expect(await load(1, path, 'script', js)).toEqual(js);
    const t = await tabState(1);
    expect(t).toMatchObject({
      origin: ORIGIN,
      app: 'vaultwarden-web',
      kind: 'instance',
      state: 'VERIFIED',
      top: {binding: {buildId: 'vaultwarden-web@2026.10.1+release', assurance: 'release-exact'}},
    });
    expect(t?.top?.counts.scripts).toEqual({ok: 1, total: 1});
  });

  it('MISMATCH: one changed byte in the main script is denied (nothing written) and alerts', async () => {
    await load(2, '/', 'main_frame', site.get('/index.html')!);
    const path = mainScript();
    const js = new Uint8Array(site.get(path)!);
    const at = js.length - 2;
    js[at] = js[at]! ^ 1;
    expect((await load(2, path, 'script', js)).length).toBe(0);
    const t = await tabState(2);
    expect(t).toMatchObject({state: 'MISMATCH', reasons: expect.arrayContaining(['bytes'])});
    expect(t?.alert).toMatchObject({origin: ORIGIN, acknowledged: false});
  });
});
