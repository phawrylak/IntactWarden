/**
 * Corpus test for the Vaultwarden builder on bw_web_builds v2026.10.1
 * (opt-in: INTACTWARDEN_CORPUS=1; downloads ~42 MB from github.com once, then
 * uses the digest-addressed cache in fixtures/corpora/.downloads/).
 *
 * Builds the release core from the real tarball pinned in
 * fixtures/corpora/vaultwarden-web-2026.10.1.lock.json and checks it against the lock: 295 files,
 * the lock's sample digests, the set digest over every file, the golden core digest and
 * determinism. None of its nine HTML documents has inline code.
 */

import {beforeAll, describe, expect, it} from 'vitest';
import {fileIndexOf} from '@intactwarden/core/routing/fileIndex.ts';
import {mapUrl} from '@intactwarden/core/routing/mapUrl.ts';
import {coreProblem, isExactEntry} from '@intactwarden/core/schema/manifest.ts';
import {
  CORPUS_ENABLED,
  fetchVaultwardenTarball,
  loadVaultwardenLock,
  sha256,
} from '../../../tools/corpus.ts';
import {BuildError, type BuildRequest, type BuiltCore} from '../src/api.ts';
import {createCoreBuilder} from '../src/coreBuilder.ts';
import {compareStrings} from '../src/files.ts';
import {loadRelease, type LoadedRelease} from '../src/release.ts';
import {GOLDEN_CORES} from './helpers/golden.ts';
import {inlineCodeIn} from './helpers/inlineCode.ts';

const LOCK = loadVaultwardenLock('2026.10.1');

/** Golden core digest (test/helpers/golden.ts). */
const GOLDEN = GOLDEN_CORES['vaultwarden-web@2026.10.1+release']!;

const builder = createCoreBuilder();

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe.runIf(CORPUS_ENABLED)('vaultwarden builder on bw_web_builds v2026.10.1', () => {
  let tarball: Uint8Array;
  let request: BuildRequest;
  let loaded: LoadedRelease;
  let build: BuiltCore;

  beforeAll(async () => {
    tarball = await fetchVaultwardenTarball(LOCK);
    request = {
      app: 'vaultwarden-web',
      variant: 'release',
      version: '2026.10.1',
      release: {
        tag: LOCK.release.tag,
        commit: LOCK.release.commit,
        tagObject: LOCK.release.tag_object,
      },
      asset: {
        name: LOCK.release.asset,
        sha256: LOCK.release.sha256,
        size: LOCK.release.size,
        bytes: tarball,
      },
    };
    loaded = await loadRelease(
      builder.plan('vaultwarden-web', 'release', '2026.10.1'),
      request.release,
      request.asset,
    );
    build = await builder.build(request);
  });

  it('reads all 295 files of the tarball, equal to the lock', () => {
    const {files} = loaded;
    expect(files.size).toBe(LOCK.files.count);
    expect([...files.values()].reduce((n, f) => n + f.size, 0)).toBe(LOCK.files.total_size);
    const setText = [...files.values()]
      .sort((a, b) => compareStrings(a.path, b.path))
      .map(f => `${f.sha256}  ${f.path}\n`)
      .join('');
    expect(sha256(enc(setText))).toBe(LOCK.files.set_sha256);
    for (const [path, digest] of Object.entries(LOCK.files.sample)) {
      expect({path, sha256: files.get(path)?.sha256}).toEqual({path, sha256: digest});
    }
  });

  it('has no inline code in its HTML documents', () => {
    const {documents, findings} = inlineCodeIn(loaded.files);
    expect(documents).toEqual(
      Object.keys(build.core.files)
        .filter(p => build.core.files[p]!.class === 'document')
        .sort(),
    );
    expect(documents).toHaveLength(9);
    expect(findings).toEqual([]);
  });

  it('builds the release core', () => {
    const {core} = build;
    expect(coreProblem(core)).toBeNull();
    expect(core.build_id).toBe('vaultwarden-web@2026.10.1+release');
    expect(Object.keys(core.files)).toHaveLength(LOCK.files.count);
    expect(core.source).toEqual({
      repo: `https://github.com/${LOCK.release.repo}`,
      repo_id: LOCK.release.repo_id,
      tag: LOCK.release.tag,
      commit: LOCK.release.commit,
      tag_object: LOCK.release.tag_object,
    });
    expect(core.artifact).toEqual({
      kind: 'github-release-asset',
      name: LOCK.release.asset,
      sha256: LOCK.release.sha256,
      size: LOCK.release.size,
      root: LOCK.release.root,
    });
    expect(core.routing).toEqual({
      hosting: 'vaultwarden-rocket',
      base_path: '/',
      index: '/index.html',
    });
    const entries = Object.entries(core.files);
    expect(entries.filter(([, e]) => e.class === 'document')).toHaveLength(LOCK.files.documents);
    expect(entries.filter(([, e]) => e.class === 'wasm').map(([p]) => p)).toEqual([
      '/466839efc4da38d60ce3.module.wasm',
    ]);
    expect(entries.some(([, e]) => 'areas' in e)).toBe(false);
    expect(entries.filter(([, e]) => e.class === 'sourcemap')).toHaveLength(LOCK.files.sourcemaps);
    expect(entries.filter(([p]) => !p.endsWith('.map'))).toHaveLength(LOCK.files.non_map_files);
    expect(entries.filter(([, e]) => !isExactEntry(e))).toEqual([]);
    for (const [path, digest] of Object.entries(LOCK.files.sample)) {
      const e = core.files[path]!;
      expect({path, sha256: isExactEntry(e) && e.sha256}).toEqual({path, sha256: digest});
    }
    expect(core.files['/css/vaultwarden.css']).toBeUndefined();
  });

  it('routes the real core as the Vaultwarden server serves it', () => {
    const {core} = build;
    const files = fileIndexOf(core.files);
    const o = 'https://vw.example.org';
    expect(mapUrl(`${o}/`, core.routing, files, 200)).toMatchObject({
      kind: 'file',
      key: '/index.html',
    });
    // Rocket's 303 from /index.html to the base path is the header guard's to allow.
    expect(mapUrl(`${o}/index.html`, core.routing, files, 303).kind).toBe('invalid');
    expect(mapUrl(`${o}/no-such-file.js`, core.routing, files, 404)).toEqual({
      kind: 'server-not-found',
    });
    // Rocket serves every reachable listed file: a 404 for one is a missing file.
    expect(mapUrl(`${o}/locales/en/messages.json`, core.routing, files, 404)).toEqual({
      kind: 'missing-file',
      path: '/locales/en/messages.json',
      key: '/locales/en/messages.json',
    });
    // The one listed file Rocket never serves (a segment starting with ".") is the empty
    // /.nojekyll, which nothing in the release requests.
    const dotted = Object.keys(core.files).filter(path =>
      path
        .slice(1)
        .split('/')
        .some(s => s.startsWith('.')),
    );
    expect(dotted).toEqual(['/.nojekyll']);
    expect(core.files['/.nojekyll']).toMatchObject({size: 0});
    expect(mapUrl(`${o}/app`, core.routing, files, 200)).toMatchObject({kind: 'file', key: null});
    expect(
      mapUrl(`${o}/vw/app/main.1176a28a68b7b4809391.js`, core.routing, files, 200, {
        basePath: '/vw/',
      }),
    ).toMatchObject({kind: 'file', key: '/app/main.1176a28a68b7b4809391.js'});
  });

  it('is deterministic (golden digest)', async () => {
    const again = await builder.build(request);
    expect(again.bytes).toEqual(build.bytes);
    expect(build.sha256).toBe(GOLDEN);
  });

  it('refuses the tarball under any other pin', async () => {
    const refusal = (r: BuildRequest) =>
      builder.build(r).then(
        () => 'built',
        (e: unknown) => (e as BuildError).code,
      );
    expect(await refusal({...request, asset: {...request.asset, sha256: '0'.repeat(64)}})).toBe(
      'digest-mismatch',
    );
    expect(
      await refusal({
        ...request,
        version: '2026.7.0',
        release: {...request.release, tag: 'v2026.7.0'},
      }),
    ).toBe('asset-name-mismatch');
  });
});
