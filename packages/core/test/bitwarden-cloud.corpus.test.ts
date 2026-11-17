/**
 * Corpus test for the Bitwarden cloud derivation (opt-in: INTACTWARDEN_CORPUS=1).
 *
 * Downloads the web-v2026.10.1 COMMERCIAL release zip and the tagged config
 * files, checks them against the digests pinned in
 * fixtures/corpora/bitwarden-web-2026.10.1.lock.json before using them, then
 * derives the 6 cloud files for vault.bitwarden.com and vault.bitwarden.eu and
 * compares them with the hashes observed live. Vendor bytes are cached only in
 * the git-ignored fixtures/corpora/.downloads/, under their digest.
 *
 * Behind an HTTPS proxy, run Node with NODE_USE_ENV_PROXY=1.
 */

import {beforeAll, describe, expect, it} from 'vitest';
import {
  configUrl,
  CORPUS_ENABLED,
  fetchBitwardenZip,
  fetchPinned,
  loadBitwardenLock,
  sha256,
} from '../../../tools/corpus.ts';
import {iterateZipFiles} from '../src/archive/zip.ts';
import {
  deriveCloudConnectorJs,
  deriveCloudHtml,
  deriveCloudMain,
  extractCacheTag,
  type DerivedFile,
} from '../src/derive/bitwarden-cloud-v1.ts';

const LOCK = loadBitwardenLock('2026.10.1');

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

describe.runIf(CORPUS_ENABLED)('the cloud derivation on web-v2026.10.1', () => {
  /** sha256 of every non-map file of the release, by path ('/app/...'). */
  const releaseHashes = new Map<string, string>();
  /** Bytes of the self-hosted files the recipe derives from. */
  const inputs = new Map<string, Uint8Array>();
  const configs = new Map<string, unknown>();

  const sh = LOCK.selfhosted;
  const derivedFrom = [
    '/index.html',
    '/duo-redirect-connector.html',
    '/webauthn-fallback-connector.html',
    '/' + sh.main_name,
    '/' + sh.duo_js_name,
    '/' + sh.webauthn_fb_js_name,
  ];

  beforeAll(async () => {
    const {release} = LOCK;
    const zip = await fetchBitwardenZip(LOCK);
    for await (const {path, bytes} of iterateZipFiles(zip, {stripPrefix: release.root})) {
      if (path.endsWith('.map')) continue;
      releaseHashes.set(path, sha256(bytes));
      if (derivedFrom.includes(path)) inputs.set(path, bytes);
    }
    for (const [name, file] of Object.entries(LOCK.config)) {
      expect(file.commit).toBe(release.commit);
      expect(file.url).toBe(configUrl(LOCK, file));
      const bytes = await fetchPinned(configUrl(LOCK, file), file.sha256);
      configs.set(name, JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    }
  });

  const input = (path: string): Uint8Array => {
    const bytes = inputs.get(path);
    if (bytes === undefined) throw new Error(`${path} missing from the release`);
    return bytes;
  };

  it('finds the self-hosted inputs and their CACHE_TAG', () => {
    expect(releaseHashes.size).toBe(LOCK.unchanged.non_map_files);
    expect([...inputs.keys()].sort()).toEqual([...derivedFrom].sort());
    const text = (path: string) => new TextDecoder().decode(input(path));
    expect(extractCacheTag(text('/' + sh.main_name))).toBe(sh.cache_tag);
    expect(extractCacheTag(text('/' + sh.duo_js_name))).toBe(sh.cache_tag);
    expect(extractCacheTag(text('/' + sh.webauthn_fb_js_name))).toBe(sh.cache_tag);
  });

  for (const [id, region] of Object.entries(LOCK.regions)) {
    it(`reproduces the 6 differing files of ${region.origin} (${id})`, () => {
      const tag = region.cache_tag;
      const env = configs.get(region.env);
      const derived = new Map<string, DerivedFile>([
        [
          '/index.html',
          deriveCloudHtml(input('/index.html'), [
            {from: sh.main_name, to: region.main_name, slot: 'MAIN'},
          ]),
        ],
        [
          '/duo-redirect-connector.html',
          deriveCloudHtml(input('/duo-redirect-connector.html'), [
            {from: sh.duo_js_name, to: region.duo_js_name, slot: 'DUO_JS'},
          ]),
        ],
        [
          '/webauthn-fallback-connector.html',
          deriveCloudHtml(input('/webauthn-fallback-connector.html'), [
            {from: sh.webauthn_fb_js_name, to: region.webauthn_fb_js_name, slot: 'WEBAUTHN_FB_JS'},
          ]),
        ],
        [
          '/' + region.main_name,
          deriveCloudMain(
            input('/' + sh.main_name),
            {base: configs.get('base'), env, envName: region.env},
            tag,
            basename(region.main_name) + '.map',
          ),
        ],
        [
          '/' + region.duo_js_name,
          deriveCloudConnectorJs(
            input('/' + sh.duo_js_name),
            tag,
            basename(region.duo_js_name) + '.map',
            'DUO_JS',
          ),
        ],
        [
          '/' + region.webauthn_fb_js_name,
          deriveCloudConnectorJs(
            input('/' + sh.webauthn_fb_js_name),
            tag,
            basename(region.webauthn_fb_js_name) + '.map',
            'WEBAUTHN_FB_JS',
          ),
        ],
      ]);
      expect([...derived.keys()].sort()).toEqual(Object.keys(region.expected).sort());
      for (const [path, {bytes}] of derived) {
        expect({path, sha256: sha256(bytes), size: bytes.length}).toEqual({
          path,
          ...region.expected[path],
        });
      }
      // The derived main embeds the observed CACHE_TAG.
      const main = new TextDecoder().decode(derived.get('/' + region.main_name)?.bytes);
      expect(extractCacheTag(main)).toBe(tag);
    });
  }

  it('serves every other non-map file unchanged (sample and full set)', () => {
    const unchanged = [...releaseHashes]
      .filter(([path]) => !derivedFrom.includes(path))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    expect(unchanged.length).toBe(LOCK.unchanged.files);
    expect(releaseHashes.size - unchanged.length).toBe(LOCK.unchanged.derived_files);
    const sample = Object.entries(LOCK.unchanged.sample);
    expect(sample.length).toBeGreaterThanOrEqual(10);
    for (const [path, digest] of sample) {
      expect({path, sha256: releaseHashes.get(path)}).toEqual({path, sha256: digest});
    }
    const setText = unchanged.map(([path, digest]) => `${digest}  ${path}\n`).join('');
    expect(sha256(new TextEncoder().encode(setText))).toBe(LOCK.unchanged.set_sha256);
  });
});
