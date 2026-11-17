/**
 * The release loader and the release-exact core (src/release.ts) of both apps, through the
 * CoreBuilder: the core's entries and envelope, determinism, and the loader's refusals.
 */

import {describe, expect, it} from 'vitest';
import {canonicalBytes, canonicalize} from '@intactwarden/core/jcs/canonicalize.ts';
import {coreProblem, isDynamicEntry, type ExactEntry} from '@intactwarden/core/schema/manifest.ts';
import {BuildError, type BuildRefusal, type BuildRequest} from '../src/api.ts';
import {createCoreBuilder} from '../src/coreBuilder.ts';
import {
  bitwardenRequest,
  buildReleaseZip,
  COMMIT,
  INTEGRATIONS_CHUNK,
  releaseFiles,
  SELF,
  sha256,
  SHARED_CHUNK,
  SM_CHUNK,
  TAG,
  VERSION,
} from './helpers/bitwardenFixture.ts';
import {
  VW_ASSET,
  VW_COMMIT,
  VW_MAIN,
  VW_TAG,
  VW_TAG_OBJECT,
  vwFiles,
  vwRequest,
  vwTarball,
  type TarballOptions,
  type VwFiles,
} from './helpers/vaultwardenFixture.ts';

const builder = createCoreBuilder();
const enc = new TextEncoder();
const ZIP = buildReleaseZip();
const TARBALL = vwTarball();

const build = (request: BuildRequest) => builder.build(request);

/** Refused with `code`, and a message that matches `message`. */
async function refused(request: BuildRequest, code: BuildRefusal, message: string | RegExp) {
  const promise = build(request);
  await expect(promise).rejects.toBeInstanceOf(BuildError);
  await expect(promise).rejects.toMatchObject({code});
  await expect(promise).rejects.toThrow(message);
}

describe('Bitwarden release core', () => {
  it('lists every file of the release with digest, size and class', async () => {
    const {core} = await build(bitwardenRequest(ZIP));
    const files = releaseFiles();
    expect(Object.keys(core.files).sort()).toEqual([...files.keys()].map(n => '/' + n).sort());
    for (const [name, data] of files) {
      if (name === 'app-id.json') continue;
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      expect(core.files['/' + name]).toMatchObject({sha256: sha256(bytes), size: bytes.length});
    }
    const kind = (p: string) => (core.files[p] as ExactEntry).class;
    expect(kind('/index.html')).toBe('document');
    expect(kind(`/app/main.${SELF.main}.js`)).toBe('script');
    expect(kind(`/app/main.${SELF.main}.js.map`)).toBe('sourcemap');
    expect(kind('/styles.7993c0193ec4dde2a2a5.css')).toBe('style');
    expect(kind('/edbccabf45fa994a91dc.module.wasm')).toBe('wasm');
    expect(kind('/fonts/bwi-font.9ae6e12297499bbf04d1.woff2')).toBe('font');
    expect(kind('/images/logo.svg')).toBe('image');
    expect(kind('/favicon.ico')).toBe('image');
    expect(kind('/videos/intro.mp4')).toBe('media');
    expect(kind('/version.json')).toBe('data');
    expect(kind('/app/vendor.9515864ec4d3ce1acf45.js.LICENSE.txt')).toBe('data');
    expect(kind('/browserconfig.xml')).toBe('data');
    expect(kind('/.nojekyll')).toBe('data');
  });

  it('emits the core manifest envelope', async () => {
    const {core} = await build(bitwardenRequest(ZIP));
    expect(core).toMatchObject({
      schema: 'intactwarden.manifest/1',
      build_id: `bitwarden-web@${VERSION}+selfhosted-commercial`,
      app: 'bitwarden-web',
      variant: 'selfhosted-commercial',
      version: {label: VERSION},
      source: {
        repo: 'https://github.com/bitwarden/clients',
        repo_id: 53538899,
        tag: TAG,
        commit: COMMIT,
      },
      artifact: {
        kind: 'github-release-asset',
        name: `web-${VERSION}-selfhosted-COMMERCIAL.zip`,
        sha256: sha256(ZIP),
        size: ZIP.length,
        root: 'build/',
      },
      routing: {
        hosting: 'bitwarden-selfhost',
        base_path: '/',
        index: '/index.html',
        not_found: '/404.html',
      },
    });
    expect(Object.keys(core).sort()).toEqual([
      'app',
      'artifact',
      'build_id',
      'files',
      'routing',
      'schema',
      'source',
      'variant',
      'version',
    ]);
  });

  it('marks /app-id.json dynamic (the self-hosted server overrides it)', async () => {
    const {core} = await build(bitwardenRequest(ZIP));
    expect(core.files['/app-id.json']).toEqual({class: 'data', dynamic: true});
    const without = buildReleaseZip({override: {'app-id.json': null}});
    const {core: core2} = await build(bitwardenRequest(without));
    expect(core2.files['/app-id.json']).toEqual({class: 'data', dynamic: true});
  });

  it('lists the Secrets Manager chunks as ordinary exact entries', async () => {
    const {core} = await build(bitwardenRequest(ZIP));
    for (const p of [SM_CHUNK, SHARED_CHUNK, INTEGRATIONS_CHUNK]) {
      expect(Object.keys(core.files[p]!).sort(), p).toEqual(['class', 'sha256', 'size']);
    }
  });

  it('returns valid, canonical bytes and their digest', async () => {
    const r = await build(bitwardenRequest(ZIP));
    expect(coreProblem(r.core)).toBeNull();
    expect(r.bytes).toEqual(canonicalBytes(r.core));
    const text = new TextDecoder().decode(r.bytes);
    expect(JSON.parse(text)).toEqual(r.core);
    expect(canonicalize(JSON.parse(text))).toBe(text);
    expect(r.sha256).toBe(sha256(r.bytes));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('is deterministic: entry order and compression do not change the core', async () => {
    const a = await build(bitwardenRequest(ZIP));
    for (const zip of [buildReleaseZip({reverse: true}), buildReleaseZip({stored: true})]) {
      expect(sha256(zip)).not.toBe(sha256(ZIP));
      const c = await build(bitwardenRequest(zip));
      // Only the artifact digest and size differ.
      expect({...c.core, artifact: null}).toEqual({...a.core, artifact: null});
    }
  });

  it('cross-checks version.json and refuses unknown file types', async () => {
    const other = buildReleaseZip({override: {'version.json': '{"version":"2026.10.0"}'}});
    await refused(bitwardenRequest(other), 'version-mismatch', /version\.json says 2026\.10\.0/);
    const extra = buildReleaseZip({override: {'version.json': '{"version":"2026.10.1","x":1}'}});
    await refused(bitwardenRequest(extra), 'version-mismatch', /must be \{"version"/);
    const none = buildReleaseZip({override: {'version.json': null}});
    await refused(bitwardenRequest(none), 'version-mismatch', /no \/version\.json/);
    const wat = buildReleaseZip({override: {'app/extra.wat': '(module)'}});
    await refused(bitwardenRequest(wat), 'unsupported', /unknown file type "\.wat"/);
  });

  it('records the tag object of an annotated tag', async () => {
    const {core} = await build(
      bitwardenRequest(ZIP, 'selfhosted-commercial', {
        release: {tag: TAG, commit: COMMIT, tagObject: VW_TAG_OBJECT},
      }),
    );
    expect(core.source.tag_object).toBe(VW_TAG_OBJECT);
  });
});

describe('Vaultwarden release core', () => {
  it('builds a valid release-exact core from the release tarball', async () => {
    const {core, bytes, sha256: digest} = await build(vwRequest(TARBALL));
    expect(coreProblem(core)).toBeNull();
    expect(core).toMatchObject({
      schema: 'intactwarden.manifest/1',
      build_id: 'vaultwarden-web@2026.10.1+release',
      app: 'vaultwarden-web',
      variant: 'release',
      version: {label: '2026.10.1'},
      source: {
        repo: 'https://github.com/dani-garcia/bw_web_builds',
        repo_id: 161632059,
        tag: VW_TAG,
        commit: VW_COMMIT,
        tag_object: VW_TAG_OBJECT,
      },
      artifact: {
        kind: 'github-release-asset',
        name: VW_ASSET,
        sha256: sha256(TARBALL),
        size: TARBALL.length,
        root: 'web-vault/',
      },
      routing: {hosting: 'vaultwarden-rocket', base_path: '/', index: '/index.html'},
    });
    expect(core.routing.not_found).toBeUndefined();
    expect(Object.keys(core.files)).toHaveLength(Object.keys(vwFiles()).length);
    expect(core.files['/css/vaultwarden.css']).toBeUndefined();
    expect(core.files['/.nojekyll']).toMatchObject({class: 'data', size: 0});
    expect(core.files[`/app/main.${VW_MAIN}.js`]).toMatchObject({class: 'script'});
    expect(core.files[`/app/main.${VW_MAIN}.js.map`]).toMatchObject({class: 'sourcemap'});
    const text = new TextDecoder().decode(bytes);
    expect(JSON.parse(text)).toEqual(core);
    expect(canonicalize(JSON.parse(text))).toBe(text);
    expect(sha256(bytes)).toBe(digest);
  });

  it('lists every file as an exact entry, except the dynamic /app-id.json', async () => {
    const {core} = await build(vwRequest(TARBALL));
    for (const [path, content] of Object.entries(vwFiles())) {
      const entry = core.files['/' + path]!;
      if (path === 'app-id.json') {
        expect(isDynamicEntry(entry)).toBe(true);
        continue;
      }
      const bytes = typeof content === 'string' ? enc.encode(content) : content;
      expect(entry, path).toMatchObject({sha256: sha256(bytes), size: bytes.length});
    }
  });

  it('omits source.tag_object when no tag object is given', async () => {
    const {core} = await build(vwRequest(TARBALL, {release: {tag: VW_TAG, commit: VW_COMMIT}}));
    expect(core.source).toEqual({
      repo: 'https://github.com/dani-garcia/bw_web_builds',
      repo_id: 161632059,
      tag: VW_TAG,
      commit: VW_COMMIT,
    });
  });

  it('is deterministic and independent of entry order and metadata', async () => {
    const a = await build(vwRequest(TARBALL));
    expect((await build(vwRequest(TARBALL))).bytes).toEqual(a.bytes);
    const other = vwTarball(vwFiles(), {reverse: true, mtime: 1, level: 1});
    expect(other).not.toEqual(TARBALL);
    const b = await build(vwRequest(other));
    // Only the artifact digest and size differ.
    expect({...b.core, artifact: null}).toEqual({...a.core, artifact: null});
  });

  const refusedFiles = (
    files: VwFiles,
    code: BuildRefusal,
    message: string,
    opts: TarballOptions = {},
  ) => refused(vwRequest(vwTarball(files, opts)), code, message);

  it('cross-checks vw-version.json and version.json with the tag', async () => {
    await refusedFiles(
      {...vwFiles(), 'vw-version.json': '{"version":"2026.10.2"}'},
      'version-mismatch',
      'vw-version.json says',
    );
    await refusedFiles(
      {...vwFiles(), 'version.json': '{"version":"2026.10.0"}'},
      'version-mismatch',
      '/version.json says 2026.10.0',
    );
    const missing = vwFiles();
    delete missing['vw-version.json'];
    await refusedFiles(missing, 'version-mismatch', 'release has no /vw-version.json');
  });

  it('refuses a build that ships the server-generated stylesheet', async () => {
    await refusedFiles(
      {...vwFiles(), 'css/vaultwarden.css': 'x{}'},
      'forbidden-content',
      'which the server generates itself',
    );
  });

  it('refuses unknown file types and unsafe archives', async () => {
    await refusedFiles({...vwFiles(), 'tool.exe': 'MZ'}, 'unsupported', 'unknown file type ".exe"');
    await refusedFiles(vwFiles(), 'archive-invalid', 'is outside "web-vault/"', {
      extra: [{name: 'other/evil.js', data: 'alert(1)'}],
    });
    await refusedFiles(vwFiles(), 'archive-invalid', 'unsupported entry type', {
      extra: [{name: 'web-vault/link.js', typeflag: '2', linkname: '/etc/passwd'}],
    });
    await refusedFiles(vwFiles(), 'archive-invalid', 'is outside', {root: 'build/'});
    await refused(
      vwRequest(enc.encode('PK\x03\x04 not a tarball')),
      'archive-invalid',
      'not a gzip file',
    );
  });
});
