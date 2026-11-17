import {describe, expect, it} from 'vitest';
import {
  createGitHubClient,
  MAX_BACKOFF_MS,
  reduceRelease,
  SECONDARY_BACKOFF_MS,
} from '../../src/trust/github.ts';
import {createFakeFetch, jsonResponse} from './helpers/fakeFetch.ts';
import {createGitHubEmulator} from './helpers/githubEmulator.ts';
import {manualClock, memoryKv} from './helpers/memory.ts';
import {publishVw, sha256, VW_REPO_ID} from './helpers/vaultwarden.ts';

const API = 'https://api.github.com';
const RELEASE_URL = `${API}/repositories/${VW_REPO_ID}/releases/tags/v2026.11.0`;

function setup() {
  const fake = createFakeFetch();
  const emu = createGitHubEmulator(fake);
  const clock = manualClock();
  const kv = memoryKv();
  const client = createGitHubClient({fetch: fake.fetch, now: clock.now, kv});
  return {fake, emu, clock, kv, client};
}

describe('GitHub REST client', () => {
  it('reads a release by repository id and keeps only the needed fields', async () => {
    const {fake, emu, client} = setup();
    const a = publishVw(emu, '2026.11.0');
    const r = await client.getRelease(VW_REPO_ID, 'v2026.11.0');
    expect(r.k).toBe('ok');
    if (r.k !== 'ok') return;
    expect(r.value.tag).toBe('v2026.11.0');
    expect(r.value.assets.find(x => x.name === a.asset)).toEqual({
      name: a.asset,
      size: a.tarball.length,
      sha256: sha256(a.tarball),
      downloadUrl: `https://github.com/dani-garcia/bw_web_builds/releases/download/v2026.11.0/${a.asset}`,
      uploaded: true,
    });
    const call = fake.calls[0]!;
    expect(call.url).toBe(RELEASE_URL);
    expect(call.init.credentials).toBe('omit');
    expect(call.init.cache).toBe('no-store');
    expect(call.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call.headers.get('if-none-match')).toBeNull();
  });

  it('backs off on an exhausted rate limit until the reset, without further requests', async () => {
    const {fake, emu, clock, kv, client} = setup();
    publishVw(emu, '2026.11.0');
    const reset = Math.floor(clock.now() / 1000) + 600;
    emu.rateLimit(reset);
    const r = await client.getRelease(VW_REPO_ID, 'v2026.11.0');
    expect(r).toEqual({k: 'rate-limited', retryAt: reset * 1000 + 1000});
    expect(client.backoffUntil()).toBe(reset * 1000 + 1000);
    const before = fake.calls.length;
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('rate-limited');
    expect(fake.calls.length).toBe(before);

    // A restarted event page keeps waiting.
    const restarted = createGitHubClient({fetch: fake.fetch, now: clock.now, kv});
    expect((await restarted.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('rate-limited');
    expect(fake.calls.length).toBe(before);

    emu.rateLimit(null);
    clock.advance(601_000);
    expect(client.backoffUntil()).toBeNull();
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('ok');
  });

  it('honours retry-after, backs off a minute on a bare secondary limit and caps the back-off', async () => {
    const fake = createFakeFetch();
    const clock = manualClock();
    const client = createGitHubClient({fetch: fake.fetch, now: clock.now, kv: memoryKv()});
    fake.route('GET', RELEASE_URL, () =>
      jsonResponse({message: 'secondary'}, {status: 429, headers: {'retry-after': '120'}}),
    );
    expect(await client.getRelease(VW_REPO_ID, 'v2026.11.0')).toEqual({
      k: 'rate-limited',
      retryAt: clock.now() + 120_000,
    });
    clock.advance(121_000);
    fake.route('GET', RELEASE_URL, () => jsonResponse({message: 'forbidden'}, {status: 403}));
    expect(await client.getRelease(VW_REPO_ID, 'v2026.11.0')).toEqual({
      k: 'rate-limited',
      retryAt: clock.now() + SECONDARY_BACKOFF_MS,
    });
    clock.advance(SECONDARY_BACKOFF_MS + 1);
    fake.route('GET', RELEASE_URL, () =>
      jsonResponse(
        {message: 'x'},
        {status: 403, headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999'}},
      ),
    );
    const capped = await client.getRelease(VW_REPO_ID, 'v2026.11.0');
    expect(capped).toEqual({k: 'rate-limited', retryAt: clock.now() + MAX_BACKOFF_MS});
  });

  it('backs off a minute when the reset is already past by this clock', async () => {
    // The computer's clock is ahead of GitHub's: without a floor every request would be sent,
    // rate-limited and retried a second later.
    const {fake, emu, clock, client} = setup();
    publishVw(emu, '2026.11.0');
    emu.rateLimit(Math.floor(clock.now() / 1000) - 600);
    expect(await client.getRelease(VW_REPO_ID, 'v2026.11.0')).toEqual({
      k: 'rate-limited',
      retryAt: clock.now() + SECONDARY_BACKOFF_MS,
    });
    const before = fake.calls.length;
    clock.advance(SECONDARY_BACKOFF_MS - 1);
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('rate-limited');
    expect(fake.calls.length).toBe(before);
    clock.advance(1);
    expect(client.backoffUntil()).toBeNull();
  });

  it('ignores a stored back-off further away than the cap', async () => {
    // Recorded while the clock was wrong: it must not block requests for longer than the cap.
    const {fake, emu, clock, kv} = setup();
    publishVw(emu, '2026.11.0');
    const stale = clock.now() + MAX_BACKOFF_MS + 1;
    await kv.set('l:v1:github', {v: 1, backoffUntil: stale, strikes: 0});
    const client = createGitHubClient({fetch: fake.fetch, now: clock.now, kv});
    await client.load();
    expect(client.backoffUntil()).toBeNull();
    // A new limit replaces it; the stale value is not what the caller waits for.
    const reset = Math.floor(clock.now() / 1000) + 600;
    emu.rateLimit(reset);
    expect(await client.getRelease(VW_REPO_ID, 'v2026.11.0')).toEqual({
      k: 'rate-limited',
      retryAt: reset * 1000 + 1000,
    });
    expect(kv.data.get('l:v1:github')).toMatchObject({backoffUntil: reset * 1000 + 1000});
    emu.rateLimit(null);
    clock.advance(601_000);
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('ok');

    // A stored back-off within the cap still holds.
    await kv.set('l:v1:github', {v: 1, backoffUntil: clock.now() + MAX_BACKOFF_MS, strikes: 0});
    const waiting = createGitHubClient({fetch: fake.fetch, now: clock.now, kv});
    await waiting.load();
    expect(waiting.backoffUntil()).toBe(clock.now() + MAX_BACKOFF_MS);
  });

  it('remembers an exhausted window from a successful response', async () => {
    const {fake, clock, client} = setup();
    const reset = Math.floor(clock.now() / 1000) + 300;
    fake.route('GET', RELEASE_URL, () =>
      jsonResponse(
        {tag_name: 'v2026.11.0', assets: []},
        {headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset)}},
      ),
    );
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('ok');
    expect(client.backoffUntil()).toBe(reset * 1000 + 1000);
  });

  it('maps 404 to not-found, 5xx to network and junk to bad-response', async () => {
    const fake = createFakeFetch();
    const client = createGitHubClient({fetch: fake.fetch, now: () => 0, kv: memoryKv()});
    fake.route('GET', RELEASE_URL, () => jsonResponse({message: 'Not Found'}, {status: 404}));
    expect(await client.getRelease(VW_REPO_ID, 'v2026.11.0')).toEqual({k: 'not-found'});
    fake.route('GET', RELEASE_URL, () => new Response('x', {status: 502}));
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('network');
    fake.route('GET', RELEASE_URL, () => new Response('{not json', {status: 200}));
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('bad-response');
    fake.route('GET', RELEASE_URL, () => jsonResponse([1, 2], {status: 200}));
    expect((await client.getRelease(VW_REPO_ID, 'v2026.11.0')).k).toBe('bad-response');
    expect((await client.getRelease(0, 'v1')).k).toBe('bad-response');
    expect((await client.getRelease(1, 'bad tag')).k).toBe('bad-response');
  });

  it('peels annotated tags through /git/tags and returns lightweight tags directly', async () => {
    const {emu, client, fake} = setup();
    emu.setTag('dani-garcia/bw_web_builds', VW_REPO_ID, 'v2026.10.1', {
      commit: 'f35c1cbb7b582781243d1166f5cad21f6988ab5f',
      tagObject: '878e7d7a00f5989f1d743cd0c2d7b9aa460107c5',
    });
    expect(await client.getTagRef(VW_REPO_ID, 'v2026.10.1')).toEqual({
      k: 'ok',
      value: {
        commit: 'f35c1cbb7b582781243d1166f5cad21f6988ab5f',
        tagObject: '878e7d7a00f5989f1d743cd0c2d7b9aa460107c5',
      },
    });
    expect(fake.calls.map(c => new URL(c.url).pathname)).toEqual([
      `/repositories/${VW_REPO_ID}/git/ref/tags/v2026.10.1`,
      `/repositories/${VW_REPO_ID}/git/tags/878e7d7a00f5989f1d743cd0c2d7b9aa460107c5`,
    ]);
    emu.setTag('bitwarden/clients', 53538899, 'web-v2026.10.1', {
      commit: '91214c3b978edb5496a32a946451960fe7d44531',
    });
    expect(await client.getTagRef(53538899, 'web-v2026.10.1')).toEqual({
      k: 'ok',
      value: {commit: '91214c3b978edb5496a32a946451960fe7d44531'},
    });
    expect(await client.getTagRef(53538899, 'web-v2099.1.1')).toEqual({k: 'not-found'});
  });
});

describe('reduceRelease', () => {
  it('reads the digest only in its exact sha256:<hex> form', () => {
    const r = reduceRelease({
      tag_name: 't',
      assets: [
        {name: 'a', size: 1, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: 'u'},
        {name: 'b', size: 1, digest: `sha256:${'A'.repeat(64)}`, browser_download_url: 'u'},
        {name: 'c', size: 1, digest: null, browser_download_url: 'u'},
        {name: 'd', size: 1, digest: `sha512:${'a'.repeat(128)}`, browser_download_url: 'u'},
        {name: 'e', size: -1, browser_download_url: 'u'},
        {name: 'f', size: 1, browser_download_url: 'u', state: 'starter'},
      ],
    });
    expect(r?.assets.map(a => [a.name, a.sha256, a.uploaded])).toEqual([
      ['a', 'a'.repeat(64), true],
      ['b', null, true],
      ['c', null, true],
      ['d', null, true],
      ['f', null, false],
    ]);
    expect(reduceRelease({tag_name: 1, assets: []})).toBeNull();
  });
});
