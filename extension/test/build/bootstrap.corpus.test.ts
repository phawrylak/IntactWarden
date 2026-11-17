/**
 * Corpus test of the bootstrap data of test packages (opt-in: INTACTWARDEN_CORPUS=1;
 * uses the digest-addressed cache in fixtures/corpora/.downloads/,
 * downloading the pinned assets once).
 *
 * Generates the bootstrap from the real corpus locks and checks that every
 * bundled core equals, byte for byte, what the recompute command
 * (tools/recompute.ts) writes for the same release, and the golden digests of
 * the builders' corpus tests; and that the bundled pins are the locks' values.
 */

import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {main as recompute} from '../../../tools/recompute.ts';
import {GOLDEN_CORES} from '../../../packages/builders/test/helpers/golden.ts';
import {
  CORPUS_ENABLED,
  fetchBitwardenConfigs,
  fetchBitwardenZip,
  fetchVaultwardenTarball,
  loadBitwardenLock,
  loadVaultwardenLock,
  sha256,
} from '../../../tools/corpus.ts';
import {buildBootstrap, writeBootstrap, type BootstrapData} from '../../build/bootstrap.ts';

const BW = loadBitwardenLock('2026.10.1');
const VW = loadVaultwardenLock('2026.10.1');

describe.runIf(CORPUS_ENABLED)('bootstrap data of test packages', () => {
  let dir: string;
  let data: BootstrapData;

  async function cli(args: string[]): Promise<Uint8Array> {
    const out = join(dir, `cli-${Math.random().toString(36).slice(2)}.json`);
    let stderr = '';
    const status = await recompute([...args, '--out', out], {
      stdout: () => {},
      stderr: t => void (stderr += t),
    });
    expect(status, stderr).toBe(0);
    return new Uint8Array(await readFile(out));
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'iw-bootstrap-corpus-'));
    data = await buildBootstrap();
  });

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, {recursive: true, force: true});
  });

  it('bundles the four current cores with their golden digests', () => {
    expect(data.index.cores.map(c => [c.build_id, c.sha256])).toEqual(
      Object.entries(GOLDEN_CORES).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    for (const c of data.index.cores) {
      expect(sha256(data.files.get(c.path)!)).toBe(c.sha256);
    }
    expect(data.index.generated_from.map(g => g.lock)).toEqual([
      'fixtures/corpora/bitwarden-web-2026.10.1.lock.json',
      'fixtures/corpora/vaultwarden-web-2026.10.1.lock.json',
    ]);
  });

  it('equals the recompute command output byte for byte', async () => {
    const zip = join(dir, 'release.zip');
    await writeFile(zip, await fetchBitwardenZip(BW));
    const configs = await fetchBitwardenConfigs(BW);
    for (const name of ['base', 'cloud', 'euprd'] as const) {
      await writeFile(join(dir, `${name}.json`), configs[name]);
    }
    const bitwarden = (variant: string) =>
      cli([
        '--app',
        'bitwarden-web',
        '--variant',
        variant,
        '--version',
        '2026.10.1',
        '--asset',
        zip,
        '--asset-sha256',
        BW.release.sha256,
        '--commit',
        BW.release.commit,
        '--config-dir',
        dir,
      ]);
    const tarball = join(dir, 'release.tar.gz');
    await writeFile(tarball, await fetchVaultwardenTarball(VW));
    const expected: Record<string, Uint8Array> = {
      'bitwarden-web@2026.10.1+selfhosted-commercial': await bitwarden('selfhosted-commercial'),
      'bitwarden-web@2026.10.1+cloud-us': await bitwarden('cloud-us'),
      'bitwarden-web@2026.10.1+cloud-eu': await bitwarden('cloud-eu'),
      'vaultwarden-web@2026.10.1+release': await cli([
        '--app',
        'vaultwarden-web',
        '--variant',
        'release',
        '--version',
        '2026.10.1',
        '--asset',
        tarball,
        '--asset-sha256',
        VW.release.sha256,
        '--commit',
        VW.release.commit,
        '--tag-object',
        VW.release.tag_object,
      ]),
    };
    expect(data.index.cores).toHaveLength(Object.keys(expected).length);
    for (const c of data.index.cores) {
      const bundled = data.files.get(c.path)!;
      expect(Buffer.from(bundled).equals(Buffer.from(expected[c.build_id]!)), c.build_id).toBe(
        true,
      );
    }
  });

  it('bundles the lock values as pins', () => {
    const pins = data.index.pins.pins;
    expect(pins.filter(p => p.kind === 'config-file').map(p => [p.path, p.sha256])).toEqual(
      (['base', 'cloud', 'euprd'] as const).map(n => [BW.config[n].path, BW.config[n].sha256]),
    );
    const assets = pins.flatMap(p => (p.kind === 'release-asset' ? [p] : []));
    expect(assets.map(p => [p.asset, p.sha256, p.size, p.tag_commit, p.tag_object])).toEqual([
      [BW.release.asset, BW.release.sha256, BW.release.size, BW.release.commit, undefined],
      [
        VW.release.asset,
        VW.release.sha256,
        VW.release.size,
        VW.release.commit,
        VW.release.tag_object,
      ],
    ]);
  });

  it('writes the package files', async () => {
    const out = join(dir, 'dist');
    await writeBootstrap(out, data);
    for (const [path, bytes] of data.files) {
      expect(sha256(new Uint8Array(await readFile(join(out, ...path.split('/'))))), path).toBe(
        sha256(bytes),
      );
    }
  });
});
