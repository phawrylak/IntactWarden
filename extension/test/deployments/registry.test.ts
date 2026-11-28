/**
 * The profile registry (extension/src/deployments): input parsing, the look-alike check, official
 * origins, adding an instance (one GET of `{base}api/config`), and the rate-limited hint fetch.
 */

import {describe, expect, it, vi} from 'vitest';
import {createRegistry} from '../../src/deployments/index.ts';
import {isLookalikeHost, parseInstanceInput} from '../../src/deployments/serverAddress.ts';
import {createFakeEnv} from '../engine/helpers/fakeExt.ts';

describe('instance input', () => {
  it('https anywhere; http only on this computer', () => {
    expect(parseInstanceInput('vault.example.org/vw')).toEqual({
      ok: true,
      origin: 'https://vault.example.org',
      basePath: '/vw/',
    });
    for (const loopback of ['http://127.0.0.1:8080', 'http://localhost', 'http://[::1]/vw']) {
      expect(parseInstanceInput(loopback).ok, loopback).toBe(true);
    }
    for (const lan of [
      'http://192.168.1.10',
      'http://10.0.0.2',
      'http://nas.local',
      'http://[fd00::1]',
      'http://vault.example.org',
    ]) {
      expect(parseInstanceInput(lan), lan).toEqual({ok: false, code: 'http-not-loopback'});
    }
    expect(parseInstanceInput('https://user:pw@vault.example.org')).toEqual({
      ok: false,
      code: 'invalid-input',
    });
    expect(parseInstanceInput('https://vault.example.org/a//b')).toEqual({
      ok: false,
      code: 'invalid-input',
    });
  });

  it('refuses a host with `*`: its match pattern would cover more than one server', () => {
    for (const input of ['*', 'https://*', '*.example.org', 'http://*.localhost', 'a*b.example']) {
      expect(parseInstanceInput(input), input).toEqual({ok: false, code: 'invalid-input'});
    }
  });

  it('flags look-alikes on the raw host and on its skeleton, IDN hosts and vendor domains', () => {
    for (const host of [
      'vault.bitwarnem.com', // raw distance 2, skeleton distance 3
      'vault.bitwarn.com',
      'vvult.bitwarden.eu',
      'vau1t.b1twarden.c0m', // skeleton distance 0
      'vauit.bitvvarden.com',
      'login.bitwarden.com', // the vendor's own domain
      'bitwarden.eu',
      'vault.bitwarden.com.evil.org', // the vendor's domain as the start of another one
      'bitwarden.eu.example.net',
      'xn--vult-53d.bitwarden.com',
      'vault.xn--bitwrden-46g.com', // any internationalised label
      'xn--bcher-kva.example',
    ]) {
      expect(isLookalikeHost(host), host).toBe(true);
    }
    for (const host of [
      'vault.example.org',
      'vw.example',
      '127.0.0.1',
      'localhost',
      'bw.test',
      'bitwarden.mycompany.net', // the vendor's name alone is a common label of a self-hosted server
    ]) {
      expect(isLookalikeHost(host), host).toBe(false);
    }
  });
});

function fakeFetch(
  routes: Record<string, {status: number; json?: unknown} | 'network'>,
  seen: string[] = [],
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    seen.push(url);
    const r = routes[url];
    if (r === 'network') throw new TypeError('offline');
    if (r === undefined) return new Response('not found', {status: 404});
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), {status: r.status});
  }) as unknown as typeof fetch;
}

/** `/api/config` as both servers answer it (Bitwarden: `server: null`). */
const config = (server: unknown, vault: string) => ({
  status: 200,
  json: {version: '2026.10.0', server, environment: {vault}, featureStates: {}, object: 'config'},
});

describe('createRegistry', () => {
  it('lists the official origins and looks them up', async () => {
    const env = createFakeEnv();
    const reg = createRegistry({ext: env.ext, fetch: fakeFetch({}), now: () => 0});
    await reg.ready();
    const po = reg.lookup('https://vault.bitwarden.com');
    expect(po).toMatchObject({
      app: 'bitwarden-web',
      kind: 'official',
      basePath: '/',
      granted: true,
    });
    expect(po?.deployment.id).toBe('cloud-us');
    expect(reg.lookup('https://vault.bitwarden.eu')?.deployment.id).toBe('cloud-eu');
    expect(reg.lookup('https://example.org')).toBeNull();
  });

  it('adds a Vaultwarden server at the typed base path after one api/config request', async () => {
    const env = createFakeEnv();
    const o = 'https://vw.example.org';
    const seen: string[] = [];
    const reg = createRegistry({
      ext: env.ext,
      now: () => 7,
      fetch: fakeFetch(
        {
          // The server's DOMAIN setting does not decide the base path: the typed path does.
          [`${o}/vault/api/config`]: config({name: 'Vaultwarden'}, 'https://elsewhere.example'),
          [`${o}/vault/vw-version.json`]: {status: 200, json: {version: '2026.10.1'}},
        },
        seen,
      ),
    });
    const added = await reg.addInstance({input: 'vw.example.org/vault', lookalikeConfirmed: false});
    expect(added).toEqual({
      ok: true,
      instance: {
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        app: 'vaultwarden-web',
        origin: o,
        base_path: '/vault/',
        added_at: 7,
      },
    });
    expect(seen).toEqual([`${o}/vault/api/config`]);
    const po = reg.lookup(o)!;
    expect(po).toMatchObject({kind: 'instance', basePath: '/vault/', app: 'vaultwarden-web'});
    expect(await reg.fetchHint(po)).toEqual({version: '2026.10.1', at: 7});
    expect(await reg.addInstance({input: o, lookalikeConfirmed: false})).toEqual({
      ok: false,
      code: 'duplicate-instance',
    });
  });

  it('adds every other server that answers api/config as Bitwarden', async () => {
    const env = createFakeEnv();
    const o = 'https://bw.example.org';
    const reg = createRegistry({
      ext: env.ext,
      now: () => 0,
      fetch: fakeFetch({[`${o}/api/config`]: config(null, o)}),
    });
    const added = await reg.addInstance({input: o, lookalikeConfirmed: false});
    expect(added).toMatchObject({ok: true, instance: {app: 'bitwarden-web', base_path: '/'}});
  });

  it('refuses an address where no Bitwarden or Vaultwarden server answers', async () => {
    const env = createFakeEnv();
    const reg = createRegistry({
      ext: env.ext,
      now: () => 0,
      fetch: fakeFetch({
        'https://html.example/api/config': {status: 200, json: '<html>'},
        'https://shape.example/api/config': {status: 200, json: {server: {name: 'Vaultwarden'}}},
        'https://down.example/api/config': 'network',
      }),
    });
    for (const input of ['https://html.example', 'https://shape.example', 'https://none.example']) {
      expect(await reg.addInstance({input, lookalikeConfirmed: false}), input).toEqual({
        ok: false,
        code: 'no-server',
      });
    }
    expect(
      await reg.addInstance({input: 'https://down.example', lookalikeConfirmed: false}),
    ).toEqual({
      ok: false,
      code: 'unreachable',
    });
    expect(reg.instances()).toEqual([]);
  });

  it('refuses a look-alike host unless the user confirmed it, where the instance is stored', async () => {
    const env = createFakeEnv();
    const o = 'https://vault.bitwarnem.com';
    const reg = createRegistry({
      ext: env.ext,
      now: () => 0,
      fetch: fakeFetch({[`${o}/api/config`]: config(null, o)}),
    });
    expect(await reg.addInstance({input: o, lookalikeConfirmed: false})).toEqual({
      ok: false,
      code: 'lookalike-unconfirmed',
    });
    expect(reg.instances()).toEqual([]);
    expect((await reg.addInstance({input: o, lookalikeConfirmed: true})).ok).toBe(true);
  });

  it('refuses a server whose host permission is missing, before any request', async () => {
    const env = createFakeEnv();
    env.ext.permissions.contains = async ({origins}: {origins?: string[]}) =>
      !(origins ?? []).includes('https://vw.example/*');
    const seen: string[] = [];
    const reg = createRegistry({ext: env.ext, now: () => 0, fetch: fakeFetch({}, seen)});
    expect(await reg.addInstance({input: 'vw.example', lookalikeConfirmed: false})).toEqual({
      ok: false,
      code: 'permission-denied',
    });
    expect(seen).toEqual([]);
  });

  it('sees a host permission held through the "all websites" wildcard', async () => {
    // An exact string lookup in permissions.getAll() would miss an instance covered only by
    // https://*/*.
    const env = createFakeEnv();
    const held = new Set(['https://*/*']);
    env.ext.permissions.contains = async ({origins}: {origins?: string[]}) =>
      (origins ?? []).every(
        p => held.has(p) || (p.startsWith('https://') && held.has('https://*/*')),
      );
    const o = 'https://vw.example.org';
    const reg = createRegistry({
      ext: env.ext,
      now: () => 0,
      fetch: fakeFetch({[`${o}/api/config`]: config({name: 'Vaultwarden'}, o)}),
    });
    await reg.ready();
    expect(reg.lookup('https://vault.bitwarden.com')?.granted).toBe(true);
    expect((await reg.addInstance({input: o, lookalikeConfirmed: false})).ok).toBe(true);
    expect(reg.lookup(o)?.granted).toBe(true);
    const status = await reg.permissionStatus();
    expect(status.every(p => p.granted)).toBe(true);
    expect(status.filter(p => p.purpose === 'deep-verify').map(p => p.pattern)).toEqual([
      'https://api.github.com/*',
      'https://release-assets.githubusercontent.com/*',
    ]);
  });

  it('keeps the official origins granted when the instance list cannot be read', async () => {
    // A rejected l:v1:instances read must not leave every origin ungranted: the backend reads this
    // snapshot and would filter nothing until the next start.
    const env = createFakeEnv();
    const get = env.local.get.bind(env.local);
    env.local.get = async keys => {
      if (keys === 'l:v1:instances' || (Array.isArray(keys) && keys.includes('l:v1:instances')))
        throw new Error('storage');
      return get(keys);
    };
    const reg = createRegistry({ext: env.ext, now: () => 0, fetch: fakeFetch({})});
    await expect(reg.ready()).rejects.toThrow('storage');
    expect(reg.lookup('https://vault.bitwarden.com')?.granted).toBe(true);
  });

  it('reads the instance list again once when the first read fails', async () => {
    const env = createFakeEnv();
    await env.local.set({
      'l:v1:instances': [
        {
          id: '0123456789abcdef',
          app: 'vaultwarden-web',
          origin: 'https://vault.example.org',
          base_path: '/',
          added_at: 0,
        },
      ],
    });
    const get = env.local.get.bind(env.local);
    let failures = 1;
    env.local.get = async keys => {
      if (keys === 'l:v1:instances' && failures-- > 0) throw new Error('storage');
      return get(keys);
    };
    const reg = createRegistry({ext: env.ext, now: () => 0, fetch: fakeFetch({})});
    await reg.ready();
    expect(reg.lookup('https://vault.example.org')?.app).toBe('vaultwarden-web');
  });

  it('refuses official hosts on any port and the GitHub hosts as servers', async () => {
    // Their match pattern is a required host permission.
    const env = createFakeEnv();
    const reg = createRegistry({ext: env.ext, now: () => 0, fetch: fakeFetch({})});
    const add = (input: string) => reg.addInstance({input, lookalikeConfirmed: true});
    expect(await add('https://vault.bitwarden.com:8443')).toEqual({
      ok: false,
      code: 'refused-official-origin',
    });
    expect(await add('github.com')).toEqual({ok: false, code: 'invalid-input'});
    expect(await add('https://vault.bitwarden.eu:4443')).toEqual({
      ok: false,
      code: 'refused-official-origin',
    });
    expect(await add('https://raw.githubusercontent.com')).toEqual({
      ok: false,
      code: 'invalid-input',
    });
    expect(reg.instances()).toEqual([]);
  });

  it.each([
    '2026.06.1', // a leading zero: no release key carries it
    '2026.10.1234567', // more digits than the builders plan for
    '2026.10',
    '2026.10.1.2',
    'v2026.10.1',
    ' 2026.10.1',
  ])('reads the hint %j as no version', async version => {
    const env = createFakeEnv();
    const reg = createRegistry({
      ext: env.ext,
      now: () => 0,
      fetch: (async () =>
        new Response(JSON.stringify({version}), {status: 200})) as unknown as typeof fetch,
    });
    await reg.ready();
    const hint = await reg.fetchHint(reg.lookup('https://vault.bitwarden.com')!);
    expect(hint).toEqual({version: null, at: 0});
  });

  it('fetches the hint at most once a minute and accepts x.y.z only', async () => {
    const env = createFakeEnv();
    let now = 0;
    let calls = 0;
    const reg = createRegistry({
      ext: env.ext,
      now: () => now,
      fetch: (async () => {
        calls++;
        return new Response(
          JSON.stringify({version: calls === 1 ? '2026.11.0' : '2026.11.0-beta'}),
          {status: 200},
        );
      }) as unknown as typeof fetch,
    });
    await reg.ready();
    const po = reg.lookup('https://vault.bitwarden.com')!;
    expect((await reg.fetchHint(po)).version).toBe('2026.11.0');
    expect((await reg.fetchHint(po)).version).toBe('2026.11.0');
    expect(calls).toBe(1);
    now = 61_000;
    expect((await reg.fetchHint(po)).version).toBeNull();
  });

  it('stops reading an oversized hint body at the cap', async () => {
    // The body from the protected server must not be read whole before the size check.
    const env = createFakeEnv();
    const pulled = {bytes: 0};
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const reg = createRegistry({
      ext: env.ext,
      now: () => 0,
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (pulled.bytes >= 32 * 1024 * 1024) return c.close();
              pulled.bytes += chunk.length;
              c.enqueue(chunk);
            },
          }),
          {status: 200},
        )) as unknown as typeof fetch,
    });
    await reg.ready();
    const hint = await reg.fetchHint(reg.lookup('https://vault.bitwarden.com')!);
    expect(hint).toEqual({version: null, at: 0});
    expect(pulled.bytes).toBeLessThanOrEqual(4 * 64 * 1024);
  });

  it('a hint request that never answers fails at its deadline; concurrent callers share one request', async () => {
    // Without a deadline, an unknown-build resolution waiting for the hint would never end (a page
    // hang seen in the e2e tests). A failed hint has no version, never a verdict.
    const env = createFakeEnv();
    let calls = 0;
    const reg = createRegistry({
      ext: env.ext,
      now: () => 0,
      fetch: ((_url: string, init?: RequestInit) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as typeof fetch,
    });
    await reg.ready();
    const po = reg.lookup('https://vault.bitwarden.com')!;
    vi.useFakeTimers();
    try {
      const both = Promise.all([reg.fetchHint(po), reg.fetchHint(po)]);
      let settled = false;
      void both.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const [a, b] = await both;
      expect(calls).toBe(1);
      expect(a).toEqual({version: null, at: 0});
      expect(b).toBe(a);
    } finally {
      vi.useRealTimers();
    }
  });
});
