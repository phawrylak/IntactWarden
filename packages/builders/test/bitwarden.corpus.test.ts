/**
 * Corpus test for the Bitwarden builders on web-v2026.10.1 (opt-in:
 * INTACTWARDEN_CORPUS=1; downloads ~50 MB from github.com once, then uses the
 * digest-addressed cache in fixtures/corpora/.downloads/).
 *
 * Builds the self-hosted COMMERCIAL release core and the cloud-us and
 * cloud-eu cores from the real release zip and the tagged configs pinned in
 * fixtures/corpora/bitwarden-web-2026.10.1.lock.json, and checks them
 * against what was observed live on vault.bitwarden.com and
 * vault.bitwarden.eu: the derived bytes hash to the live files, each
 * template matches them and extracts the live bindings, a CACHE_TAG-only
 * redeploy still matches and a one-byte code change does not. None of the
 * zip's nine HTML documents has inline code.
 */

import {beforeAll, describe, expect, it} from 'vitest';
import {iterateZipFiles} from '@intactwarden/core/archive/zip.ts';
import {
  coreProblem,
  isExactEntry,
  isTemplateEntry,
  type CoreManifest,
  type TemplateEntry,
} from '@intactwarden/core/schema/manifest.ts';
import type {Template} from '@intactwarden/core/template/build.ts';
import {matchTemplate} from '@intactwarden/core/template/match.ts';
import {
  CORPUS_ENABLED,
  fetchBitwardenConfigs,
  fetchBitwardenZip,
  loadBitwardenLock,
  sha256,
} from '../../../tools/corpus.ts';
import type {BuildRequest, BuiltCore} from '../src/api.ts';
import {createCoreBuilder} from '../src/coreBuilder.ts';
import {compareStrings} from '../src/files.ts';
import {loadRelease, type LoadedRelease} from '../src/release.ts';
import {deriveCloudFiles, type DerivedCloudFile} from './helpers/cloudFiles.ts';
import {GOLDEN_CORES} from './helpers/golden.ts';
import {inlineCodeIn} from './helpers/inlineCode.ts';

const LOCK = loadBitwardenLock('2026.10.1');

/** Secrets Manager chunks 541 and 195 are ordinary exact entries of the core. */
function expectSecretsManager(core: CoreManifest): void {
  expect(core.files['/541.f38c2a08966cd91bbade.js']).toEqual({
    sha256: '6abb120c1babf14b2d78a9e4f0363131b6802fbfeb7108d35f283cba5a3ad3a5',
    size: expect.any(Number) as number,
    class: 'script',
  });
  expect(core.files['/195.d4ed0c5d550e92c646e9.js']).toEqual({
    sha256: '83161b5d723b9a722a18c23d8701903a042971118fcc01b8e47ab240bd5a06fe',
    size: 39665,
    class: 'script',
  });
}

/** Golden core digests (test/helpers/golden.ts), by variant. */
const GOLDEN: Record<string, string> = Object.fromEntries(
  ['selfhosted-commercial', 'cloud-us', 'cloud-eu'].map(v => [
    v,
    GOLDEN_CORES[`bitwarden-web@2026.10.1+${v}`]!,
  ]),
);

const CLOUD_VARIANTS = ['cloud-us', 'cloud-eu'] as const;

const builder = createCoreBuilder();

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const fromLatin1 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'latin1'));

function templateOf(entry: unknown): Template {
  // A manifest template is a Template (read-only): matchTemplate takes it as is.
  return (entry as TemplateEntry).template;
}

describe.runIf(CORPUS_ENABLED)('bitwarden builders on web-v2026.10.1', () => {
  let zip: Uint8Array;
  let loaded: LoadedRelease;
  let selfhosted: BuiltCore;
  const cloud = new Map<string, BuiltCore>();
  /** The six files each cloud deployment served live, derived again from the release. */
  const derived = new Map<string, DerivedCloudFile[]>();

  const request = (variant: BuildRequest['variant'], configs: BuildRequest['configs']) =>
    ({
      app: 'bitwarden-web',
      variant,
      version: '2026.10.1',
      release: {tag: LOCK.release.tag, commit: LOCK.release.commit},
      asset: {
        name: LOCK.release.asset,
        sha256: LOCK.release.sha256,
        size: LOCK.release.size,
        bytes: zip,
      },
      configs,
    }) satisfies BuildRequest;

  beforeAll(async () => {
    zip = await fetchBitwardenZip(LOCK);
    const configs = await fetchBitwardenConfigs(LOCK);
    const byPath = Object.fromEntries(
      (['base', 'cloud', 'euprd'] as const).map(n => [LOCK.config[n].path, configs[n]]),
    );
    loaded = await loadRelease(
      builder.plan('bitwarden-web', 'selfhosted-commercial', '2026.10.1'),
      LOCK.release,
      {...LOCK.release, bytes: zip},
    );
    selfhosted = await builder.build(request('selfhosted-commercial', {}));
    const files = new Map<string, Uint8Array>();
    for await (const {path, bytes} of iterateZipFiles(zip, {stripPrefix: 'build/'})) {
      files.set(path, bytes);
    }
    for (const variant of CLOUD_VARIANTS) {
      const r = LOCK.regions[variant]!;
      cloud.set(variant, await builder.build(request(variant, byPath)));
      derived.set(
        variant,
        deriveCloudFiles(
          files,
          {base: configs.base, env: configs[r.env], envName: r.env},
          {
            cacheTag: r.cache_tag,
            mainName: r.main_name,
            duoJsName: r.duo_js_name,
            webauthnFbJsName: r.webauthn_fb_js_name,
          },
        ),
      );
    }
  });

  it('plans the pinned asset and config files, and records the pinned config digests', () => {
    const plan = builder.plan('bitwarden-web', 'cloud-us', '2026.10.1');
    expect(plan.assetName).toBe(LOCK.release.asset);
    expect(plan.tag).toBe(LOCK.release.tag);
    expect(plan.configPaths).toEqual([
      LOCK.config.base.path,
      LOCK.config.cloud.path,
      LOCK.config.euprd.path,
    ]);
    expect(cloud.get('cloud-us')!.configInputs?.map(i => i.sha256)).toEqual([
      LOCK.config.base.sha256,
      LOCK.config.cloud.sha256,
    ]);
    expect(cloud.get('cloud-eu')!.configInputs?.map(i => i.sha256)).toEqual([
      LOCK.config.base.sha256,
      LOCK.config.euprd.sha256,
    ]);
  });

  it('has no inline code in its HTML documents', () => {
    // None of the nine HTML files has inline code.
    const {documents, findings} = inlineCodeIn(loaded.files);
    expect(documents).toHaveLength(9);
    expect(findings).toEqual([]);
  });

  it('builds the self-hosted COMMERCIAL release core', () => {
    const {core} = selfhosted;
    expect(coreProblem(core)).toBeNull();
    expect(Object.keys(core.files)).toHaveLength(314);
    expect(core.build_id).toBe('bitwarden-web@2026.10.1+selfhosted-commercial');
    expect(core.artifact).toEqual({
      kind: 'github-release-asset',
      name: LOCK.release.asset,
      sha256: LOCK.release.sha256,
      size: LOCK.release.size,
      root: 'build/',
    });
    const sha = (p: string) => {
      const e = core.files[p]!;
      return isExactEntry(e) ? e.sha256 : null;
    };
    // Real hashes of the release zip's files.
    expect(sha('/index.html')).toBe(
      'd650326e88a8ddb1e4d6ac91cec77a8c871999dbf1fe17d39ade5cf130d73cb0',
    );
    expect(sha('/404.html')).toBe(
      'bc6b4374b4057e451e727aa62851acff0f8ba8572b17e636aa0c41e78fd84e09',
    );
    expect(core.files['/version.json']).toMatchObject({
      sha256: '56ef835b70c95edbb58816273bb0030fc0b67f87abdc4a07c84f1326b707bb6c',
      size: 27,
      class: 'data',
    });
    expect(sha('/' + LOCK.selfhosted.main_name)).toBe(
      '9735ff09dd90b5cdf1b86c50c7218ab1916768382bd32a8dbd8560d664359e6e',
    );
    for (const [path, digest] of Object.entries(LOCK.unchanged.sample)) {
      expect({path, sha256: sha(path)}).toEqual({path, sha256: digest});
    }
    expect(sha('/edbccabf45fa994a91dc.module.wasm')).toBe(
      'f8ce5e9bc6dbf47c04d89e07a8d54d2b7b1d44902b22cb2eb16a8e9fd04ef73d',
    );
    expectSecretsManager(core);
    expect(core.files['/app-id.json']).toEqual({class: 'data', dynamic: true});
    expect(Object.values(core.files).filter(e => e.class === 'sourcemap')).toHaveLength(38);
    expect(selfhosted.sha256).toBe(GOLDEN['selfhosted-commercial']);
  });

  for (const variant of CLOUD_VARIANTS) {
    describe(variant, () => {
      const region = LOCK.regions[variant]!;
      const bindings = () => ({
        CACHE_TAG: region.cache_tag,
        MAIN: region.main_name.slice('app/main.'.length, -3),
        DUO_JS: region.duo_js_name.slice('connectors/duo-redirect.'.length, -3),
        WEBAUTHN_FB_JS: region.webauthn_fb_js_name.slice(
          'connectors/webauthn-fallback.'.length,
          -3,
        ),
      });

      it('derives bytes identical to the live files', () => {
        const got = Object.fromEntries(
          derived.get(variant)!.map(d => [d.path, {sha256: sha256(d.bytes), size: d.bytes.length}]),
        );
        expect(got).toEqual(region.expected);
      });

      it('matches the live bytes with every template and extracts the slot values', async () => {
        const {core} = cloud.get(variant)!;
        expect(coreProblem(core)).toBeNull();
        for (const d of derived.get(variant)!) {
          const t = templateOf(core.files[d.key]);
          const r = await matchTemplate(t, d.bytes, bindings());
          expect(r.ok, d.key).toBe(true);
          if (!r.ok) continue;
          for (const [slot, value] of Object.entries(r.slots)) {
            expect(value).toBe(bindings()[slot as keyof ReturnType<typeof bindings>]);
          }
        }
      });

      it('accepts a CACHE_TAG-only redeploy and rejects a one-byte code change', async () => {
        const {core} = cloud.get(variant)!;
        const main = derived.get(variant)!.find(d => d.key === '/app/main.{MAIN}.js')!;
        const t = templateOf(core.files[main.key]);
        const text = latin1(main.bytes);
        const tag = region.cache_tag;
        expect(text.split(`?cache=${tag}"`)).toHaveLength(3);
        const hotfix = fromLatin1(text.replaceAll(`?cache=${tag}"`, '?cache=intacthfix1"'));
        expect(await matchTemplate(t, hotfix, {MAIN: bindings().MAIN})).toMatchObject({
          ok: true,
          slots: {CACHE_TAG: 'intacthfix1'},
        });
        // Flip one byte in the middle of the code, and one right next to a slot.
        for (const offset of [Math.floor(main.bytes.length / 2), text.indexOf(`?cache=${tag}"`)]) {
          const changed = main.bytes.slice();
          changed[offset] = changed[offset]! ^ 0x01;
          expect((await matchTemplate(t, changed)).ok, `offset ${offset}`).toBe(false);
        }
        // A changed config value (e.g. another Stripe key) is a code change, too.
        const stripe = text.indexOf('pk_live_');
        expect(stripe).toBeGreaterThan(0);
        const key = fromLatin1(text.slice(0, stripe) + 'pk_test_' + text.slice(stripe + 8));
        expect((await matchTemplate(t, key)).ok).toBe(false);
        expect((await matchTemplate(t, enc('x'))).ok).toBe(false);
      });

      it('keeps the 270 unchanged non-map files and 35 source maps exact', () => {
        const {core} = cloud.get(variant)!;
        const exact = Object.entries(core.files).filter(([, e]) => isExactEntry(e));
        const nonMap = exact.filter(([p]) => !p.endsWith('.map'));
        expect(nonMap).toHaveLength(LOCK.unchanged.files);
        expect(exact.length - nonMap.length).toBe(35);
        expect(Object.values(core.files).filter(isTemplateEntry)).toHaveLength(6);
        const setText = nonMap
          .map(([p, e]) => [p, isExactEntry(e) ? e.sha256 : ''] as const)
          .sort(([a], [b]) => compareStrings(a, b))
          .map(([p, digest]) => `${digest}  ${p}\n`)
          .join('');
        expect(sha256(enc(setText))).toBe(LOCK.unchanged.set_sha256);
        expectSecretsManager(core);
      });

      it('equals the golden digest', () => {
        expect(cloud.get(variant)!.sha256).toBe(GOLDEN[variant]);
      });
    });
  }

  it('gives the two regions different cores', () => {
    expect(cloud.get('cloud-us')!.sha256).not.toBe(cloud.get('cloud-eu')!.sha256);
  });
});
