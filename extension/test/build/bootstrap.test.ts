/**
 * Unit tests of the bootstrap generator (extension/build/bootstrap.ts) on
 * synthetic corpus locks: the synthetic Bitwarden zip and Vaultwarden tarball
 * of packages/builders/test/helpers, served by an in-memory pinned fetch that
 * checks size and digest like tools/corpus.ts. No vendor bytes, no network.
 */

import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {canonicalBytes} from '@intactwarden/core/jcs/canonicalize.ts';
import {coreProblem, type CoreManifest} from '@intactwarden/core/schema/manifest.ts';
import {
  BASE_CONFIG,
  buildReleaseZip,
  CLOUD_CONFIG,
  COMMERCIAL_ASSET,
  COMMIT,
  configBytes,
  EUPRD_CONFIG,
  sha256,
  TAG,
  VERSION,
} from '../../../packages/builders/test/helpers/bitwardenFixture.ts';
import {
  VW_ASSET,
  VW_COMMIT,
  VW_REPO,
  VW_TAG,
  VW_TAG_OBJECT,
  vwTarball,
} from '../../../packages/builders/test/helpers/vaultwardenFixture.ts';
import {
  buildBootstrap,
  isBootstrapSelection,
  writeBootstrap,
  type PinnedFetch,
} from '../../build/bootstrap.ts';
import {BOOTSTRAP_INDEX_PATH, type BootstrapIndex} from '../../src/contracts.ts';
import {validatePins} from '../../src/trust/pins.ts';

const BW_REPO = 'bitwarden/clients';
const ZIP = buildReleaseZip();
const TARBALL = vwTarball();
const CONFIGS = {
  base: configBytes(BASE_CONFIG),
  cloud: configBytes(CLOUD_CONFIG),
  euprd: configBytes(EUPRD_CONFIG),
};

const download = (repo: string, tag: string, asset: string): string =>
  `https://github.com/${repo}/releases/download/${tag}/${asset}`;
const raw = (path: string): string =>
  `https://raw.githubusercontent.com/${BW_REPO}/${COMMIT}/${path}`;

/** What the synthetic GitHub serves, by URL. */
const SERVED = new Map<string, Uint8Array>([
  [download(BW_REPO, TAG, COMMERCIAL_ASSET), ZIP],
  [raw('apps/web/config/base.json'), CONFIGS.base],
  [raw('apps/web/config/cloud.json'), CONFIGS.cloud],
  [raw('apps/web/config/euprd.json'), CONFIGS.euprd],
  [download(VW_REPO, VW_TAG, VW_ASSET), TARBALL],
]);

function makeFetch(calls: string[] = []): PinnedFetch {
  return async (url, digest, size) => {
    calls.push(url);
    const bytes = SERVED.get(url);
    if (bytes === undefined) throw new Error(`GET ${url}: HTTP 404`);
    if (size !== undefined && bytes.length !== size) throw new Error(`${url}: size`);
    if (sha256(bytes) !== digest)
      throw new Error(`${url}: sha256 ${sha256(bytes)}, pinned ${digest}`);
    return bytes;
  };
}

type Lock = Record<string, unknown>;

function bitwardenLock(): Lock {
  const config = (name: string, bytes: Uint8Array) => ({
    path: `apps/web/config/${name}.json`,
    commit: COMMIT,
    url: raw(`apps/web/config/${name}.json`),
    sha256: sha256(bytes),
  });
  return {
    $comment: 'synthetic',
    pinned_at: '2026-11-06T11:01:01Z',
    release: {
      repo: BW_REPO,
      tag: TAG,
      commit: COMMIT,
      asset: COMMERCIAL_ASSET,
      url: download(BW_REPO, TAG, COMMERCIAL_ASSET),
      sha256: sha256(ZIP),
      size: ZIP.length,
      root: 'build/',
      immutable: false,
    },
    config: {
      base: config('base', CONFIGS.base),
      cloud: config('cloud', CONFIGS.cloud),
      euprd: config('euprd', CONFIGS.euprd),
    },
  };
}

function vaultwardenLock(): Lock {
  return {
    pinned_at: '2026-11-06T20:03:45Z',
    release: {
      repo: VW_REPO,
      repo_id: 161632059,
      tag: VW_TAG,
      commit: VW_COMMIT,
      tag_object: VW_TAG_OBJECT,
      asset: VW_ASSET,
      url: download(VW_REPO, VW_TAG, VW_ASSET),
      sha256: sha256(TARBALL),
      size: TARBALL.length,
      root: 'web-vault/',
      immutable: true,
    },
  };
}

let dir: string;
let locks: string;

async function writeLocks(bw: Lock | null = bitwardenLock(), vw: Lock | null = vaultwardenLock()) {
  await rm(locks, {recursive: true, force: true});
  await mkdir(locks, {recursive: true});
  if (bw !== null) {
    await writeFile(join(locks, `bitwarden-web-${VERSION}.lock.json`), JSON.stringify(bw));
  }
  if (vw !== null) {
    await writeFile(join(locks, `vaultwarden-web-${VERSION}.lock.json`), JSON.stringify(vw));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iw-bootstrap-'));
  locks = join(dir, 'locks');
  await writeLocks();
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

describe('buildBootstrap', () => {
  it('builds every core of every lock with the CoreBuilder, plus bundled pins', async () => {
    const data = await buildBootstrap({locksDir: locks, fetchPinned: makeFetch()});
    const {index} = data;
    expect(index.schema).toBe('intactwarden.bootstrap/1');
    expect(index.cores.map(c => c.build_id)).toEqual([
      `bitwarden-web@${VERSION}+cloud-eu`,
      `bitwarden-web@${VERSION}+cloud-us`,
      `bitwarden-web@${VERSION}+selfhosted-commercial`,
      `vaultwarden-web@${VERSION}+release`,
    ]);
    expect(index.cores.map(c => c.assurance)).toEqual([
      'release-derived',
      'release-derived',
      'release-exact',
      'release-exact',
    ]);
    expect(index.generated_from.map(g => g.lock)).toEqual([
      `bitwarden-web-${VERSION}.lock.json`,
      `vaultwarden-web-${VERSION}.lock.json`,
    ]);
    for (const g of index.generated_from) {
      expect(g.sha256).toBe(sha256(new Uint8Array(await readFile(join(locks, g.lock)))));
    }

    // Same bytes as the CoreBuilder on the same inputs.
    const builder = createCoreBuilder();
    const bySha = new Map(index.cores.map(c => [c.build_id, c.sha256]));
    for (const variant of ['selfhosted-commercial', 'cloud-us', 'cloud-eu'] as const) {
      const c = await builder.build({
        app: 'bitwarden-web',
        variant,
        version: VERSION,
        release: {tag: TAG, commit: COMMIT},
        asset: {name: COMMERCIAL_ASSET, sha256: sha256(ZIP), size: ZIP.length, bytes: ZIP},
        configs: {
          'apps/web/config/base.json': CONFIGS.base,
          'apps/web/config/cloud.json': CONFIGS.cloud,
          'apps/web/config/euprd.json': CONFIGS.euprd,
        },
      });
      expect(bySha.get(c.buildId)).toBe(c.sha256);
    }

    // Every core file: named by its digest, canonical, a valid core naming its entry.
    for (const entry of index.cores) {
      expect(entry.path).toBe(`data/bootstrap/cores/${entry.sha256}.json`);
      const bytes = data.files.get(entry.path)!;
      expect(sha256(bytes)).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.size);
      const core = JSON.parse(new TextDecoder().decode(bytes)) as CoreManifest;
      expect(canonicalBytes(core)).toEqual(bytes);
      expect(coreProblem(core)).toBeNull();
      expect(core.build_id).toBe(entry.build_id);
      expect(core.version.label).toBe(entry.version);
    }
    expect([...data.files.keys()]).toEqual([...[...data.files.keys()].sort()]);
    expect(data.files.get(BOOTSTRAP_INDEX_PATH)).toBe(data.indexBytes);
    expect(canonicalBytes(JSON.parse(new TextDecoder().decode(data.indexBytes)))).toEqual(
      data.indexBytes,
    );
    expect(data.indexSha256).toBe(sha256(data.indexBytes));
  });

  it('pins the release assets and the configs at the tag commit', async () => {
    const {index} = await buildBootstrap({locksDir: locks, fetchPinned: makeFetch()});
    expect(index.pins.schema).toBe('intactwarden.localpins/1');
    expect(index.pins.pins).toEqual([
      ...['base', 'cloud', 'euprd'].map(name => ({
        kind: 'config-file',
        repo: BW_REPO,
        commit: COMMIT,
        path: `apps/web/config/${name}.json`,
        sha256: sha256(CONFIGS[name as keyof typeof CONFIGS]),
        source: 'bundled',
      })),
      {
        kind: 'release-asset',
        repo: BW_REPO,
        tag: TAG,
        tag_commit: COMMIT,
        asset: COMMERCIAL_ASSET,
        sha256: sha256(ZIP),
        size: ZIP.length,
        source: 'bundled',
      },
      {
        kind: 'release-asset',
        repo: VW_REPO,
        tag: VW_TAG,
        tag_commit: VW_COMMIT,
        tag_object: VW_TAG_OBJECT,
        asset: VW_ASSET,
        sha256: sha256(TARBALL),
        size: TARBALL.length,
        source: 'bundled',
      },
    ]);
    // The extension's loader keeps every bundled pin the build writes (closed key sets).
    expect(validatePins(index.pins, 'bundled')).toEqual({pins: index.pins.pins, dropped: 0});
  });

  it('is deterministic', async () => {
    const a = await buildBootstrap({locksDir: locks, fetchPinned: makeFetch()});
    const b = await buildBootstrap({locksDir: locks, fetchPinned: makeFetch()});
    expect(b.indexBytes).toEqual(a.indexBytes);
    expect([...b.files.keys()]).toEqual([...a.files.keys()]);
  });

  it('bundles only the selected apps', async () => {
    const calls: string[] = [];
    const none = await buildBootstrap({
      locksDir: locks,
      fetchPinned: makeFetch(calls),
      apps: 'none',
    });
    expect(none.index).toEqual({
      schema: 'intactwarden.bootstrap/1',
      generated_from: [],
      cores: [],
      pins: {schema: 'intactwarden.localpins/1', pins: []},
    } satisfies BootstrapIndex);
    expect([...none.files.keys()]).toEqual([BOOTSTRAP_INDEX_PATH]);
    expect(calls).toEqual([]);

    const bw = await buildBootstrap({locksDir: locks, fetchPinned: makeFetch(), apps: 'bitwarden'});
    expect(bw.index.cores.map(c => c.app)).toEqual(Array(3).fill('bitwarden-web'));
    expect(bw.index.pins.pins.every(p => p.repo === BW_REPO)).toBe(true);
    const vw = await buildBootstrap({
      locksDir: locks,
      fetchPinned: makeFetch(),
      apps: 'vaultwarden',
    });
    expect(vw.index.cores.map(c => c.build_id)).toEqual([`vaultwarden-web@${VERSION}+release`]);
    expect(vw.index.generated_from).toHaveLength(1);
    expect(isBootstrapSelection('bitwarden')).toBe(true);
    expect(isBootstrapSelection('other')).toBe(false);
    await expect(
      buildBootstrap({locksDir: locks, apps: 'other' as 'all', fetchPinned: makeFetch()}),
    ).rejects.toThrow(TypeError);
  });

  it('refuses locks that disagree with the builder plan', async () => {
    const cases: [string, (bw: Lock, vw: Lock) => void, RegExp][] = [
      ['url', bw => ((bw['release'] as Lock)['url'] = 'https://mirror.example/x.zip'), /url/],
      ['tag', bw => ((bw['release'] as Lock)['tag'] = 'web-v2026.10.2'), /release\.tag/],
      ['repo', bw => ((bw['release'] as Lock)['repo'] = 'evil/clients'), /release\.repo/],
      [
        'config commit',
        bw => (((bw['config'] as Lock)['cloud'] as Lock)['commit'] = '0'.repeat(40)),
        /tag commit/,
      ],
      [
        'config path',
        bw => (((bw['config'] as Lock)['euprd'] as Lock)['path'] = 'apps/web/config/qa.json'),
        /config\.euprd\.path/,
      ],
      ['repo id', (_, vw) => ((vw['release'] as Lock)['repo_id'] = 1), /repo_id/],
      ['tag object', (_, vw) => ((vw['release'] as Lock)['tag_object'] = 'v1'), /tag_object/],
    ];
    for (const [name, mutate, message] of cases) {
      const bw = bitwardenLock();
      const vw = vaultwardenLock();
      mutate(bw, vw);
      await writeLocks(bw, vw);
      await expect(
        buildBootstrap({locksDir: locks, fetchPinned: makeFetch()}),
        name,
      ).rejects.toThrow(message);
    }
  });

  it('refuses unknown lock files and bytes that do not match a pin', async () => {
    await writeFile(join(locks, 'other-web-1.0.0.lock.json'), '{}');
    await expect(buildBootstrap({locksDir: locks, fetchPinned: makeFetch()})).rejects.toThrow(
      /not a known corpus lock name/,
    );
    const bw = bitwardenLock();
    (bw['release'] as Lock)['sha256'] = sha256(new Uint8Array(1));
    await writeLocks(bw, null);
    await expect(buildBootstrap({locksDir: locks, fetchPinned: makeFetch()})).rejects.toThrow(
      /sha256/,
    );
    await writeFile(join(locks, `bitwarden-web-${VERSION}.lock.json`), '{not json');
    await expect(buildBootstrap({locksDir: locks, fetchPinned: makeFetch()})).rejects.toThrow(
      /not UTF-8 JSON/,
    );
  });
});

describe('writeBootstrap', () => {
  it('replaces data/bootstrap as a whole and leaves the rest of the package alone', async () => {
    const out = join(dir, 'dist');
    await mkdir(join(out, 'data', 'bootstrap', 'cores'), {recursive: true});
    await writeFile(join(out, 'data', 'bootstrap', 'cores', 'stale.json'), '{}');
    await writeFile(join(out, 'manifest.json'), '{}');
    const data = await buildBootstrap({locksDir: locks, fetchPinned: makeFetch()});
    await writeBootstrap(out, data);
    expect(new Uint8Array(await readFile(join(out, ...BOOTSTRAP_INDEX_PATH.split('/'))))).toEqual(
      data.indexBytes,
    );
    for (const [path, bytes] of data.files) {
      expect(new Uint8Array(await readFile(join(out, ...path.split('/'))))).toEqual(bytes);
    }
    await expect(readFile(join(out, 'data', 'bootstrap', 'cores', 'stale.json'))).rejects.toThrow();
    expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe('{}');
  });
});
