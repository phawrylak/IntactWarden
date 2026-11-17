import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {downloadVerified, readBodyCapped, type DownloadOptions} from '../../src/trust/download.ts';
import {bytesResponse, createFakeFetch} from './helpers/fakeFetch.ts';
import {flip} from './helpers/memory.ts';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const URL_A = 'https://github.com/o/r/releases/download/v1.0.0/a.zip';
const URL_B = 'https://release-assets.githubusercontent.com/x/a.zip';
const HOSTS = ['github.com', 'release-assets.githubusercontent.com'];

function payload(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

function options(bytes: Uint8Array, over: Partial<DownloadOptions> = {}): DownloadOptions {
  return {
    url: URL_A,
    sha256: sha256(bytes),
    size: bytes.length,
    maxBytes: 1024 * 1024,
    allowedHosts: HOSTS,
    idleTimeoutMs: 1000,
    totalTimeoutMs: 5000,
    ...over,
  };
}

/** github.com → 302 → release-assets with `serve` as the body. */
function serving(serve: Uint8Array, extra: Parameters<typeof bytesResponse>[1] = {}) {
  const fake = createFakeFetch();
  fake.route('GET', URL_A, () => new Response(null, {status: 302, headers: {location: URL_B}}));
  fake.route('GET', URL_B, req =>
    bytesResponse(serve, {chunkSize: 1000, signal: req.init.signal ?? null, ...extra}),
  );
  return fake;
}

describe('downloadVerified', () => {
  it('follows the redirect, streams, hashes and reports progress', async () => {
    const bytes = payload(10_500);
    const fake = serving(bytes);
    const progress: number[] = [];
    const r = await downloadVerified(fake.fetch, {
      ...options(bytes),
      onProgress: b => progress.push(b),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(sha256(r.bytes)).toBe(sha256(bytes));
    expect(progress.at(-1)).toBe(bytes.length);
    expect(progress.length).toBe(11);
    expect(fake.calls[0]!.init.credentials).toBe('omit');
    expect(fake.calls[0]!.init.cache).toBe('no-store');
  });

  it('refuses bytes that do not hash to the listed digest', async () => {
    const bytes = payload(5000);
    const tampered = bytes.slice();
    flip(tampered, 100, 1);
    const r = await downloadVerified(serving(tampered).fetch, options(bytes));
    expect(r).toEqual({ok: false, failure: 'digest-mismatch'});
  });

  it('refuses an oversized asset without requesting it', async () => {
    const bytes = payload(5000);
    const fake = serving(bytes);
    const r = await downloadVerified(fake.fetch, options(bytes, {maxBytes: 4999}));
    expect(r).toEqual({ok: false, failure: 'too-large'});
    expect(fake.calls).toHaveLength(0);
  });

  it('stops reading as soon as the body exceeds the listed size', async () => {
    const bytes = payload(5000);
    let pulls = 0;
    const longer = payload(100_000);
    const r = await downloadVerified(
      serving(longer, {onPull: () => pulls++}).fetch,
      options(bytes),
    );
    expect(r).toEqual({ok: false, failure: 'digest-mismatch'});
    expect(pulls).toBeLessThan(10);
  });

  it('refuses a short body and a Content-Length that disagrees with the listed size', async () => {
    const bytes = payload(5000);
    expect(await downloadVerified(serving(bytes.slice(0, 4000)).fetch, options(bytes))).toEqual({
      ok: false,
      failure: 'digest-mismatch',
    });
    const r = await downloadVerified(
      serving(bytes, {headers: {'content-length': '4000'}}).fetch,
      options(bytes),
    );
    expect(r).toEqual({ok: false, failure: 'digest-mismatch'});
  });

  it('refuses a download that ends on a host outside the allowed set', async () => {
    const bytes = payload(100);
    const fake = createFakeFetch();
    fake.route(
      'GET',
      URL_A,
      () => new Response(null, {status: 302, headers: {location: 'https://evil.example/a.zip'}}),
    );
    fake.route('GET', 'https://evil.example/a.zip', () => bytesResponse(bytes));
    expect(await downloadVerified(fake.fetch, options(bytes))).toEqual({
      ok: false,
      failure: 'bad-host',
    });
  });

  it('maps every error status and a failed request to network', async () => {
    const bytes = payload(100);
    const fake = createFakeFetch();
    for (const status of [404, 410, 503]) {
      fake.route('GET', URL_A, () => new Response('x', {status}));
      expect(await downloadVerified(fake.fetch, options(bytes)), String(status)).toEqual({
        ok: false,
        failure: 'network',
      });
    }
    const broken = createFakeFetch();
    expect(await downloadVerified(broken.fetch, options(bytes))).toEqual({
      ok: false,
      failure: 'network',
    });
  });

  it('fails as network (transient), never as a mismatch, when the buffer cannot be allocated', async () => {
    // A listed size no buffer can hold: the allocation fails, as on a low-memory device.
    const huge = 2 ** 53 - 1;
    const r = await downloadVerified(
      serving(payload(10)).fetch,
      options(payload(10), {size: huge, maxBytes: huge}),
    );
    expect(r).toEqual({ok: false, failure: 'network'});
  });

  it('aborts on an idle server', async () => {
    const bytes = payload(5000);
    const idle = await downloadVerified(
      serving(bytes, {stallAfter: 2}).fetch,
      options(bytes, {idleTimeoutMs: 30}),
    );
    expect(idle).toEqual({ok: false, failure: 'network'});
  });
});

describe('readBodyCapped', () => {
  it('returns the body up to the cap and null beyond it', async () => {
    expect(await readBodyCapped(new Response('abc'), 3)).toEqual(new TextEncoder().encode('abc'));
    expect(await readBodyCapped(new Response('abcd'), 3)).toBeNull();
    expect(
      await readBodyCapped(new Response('ab', {headers: {'content-length': '99'}}), 3),
    ).toBeNull();
  });
});
