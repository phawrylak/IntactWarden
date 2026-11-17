/**
 * Memory budgets of local deep verify on the corpus releases (opt-in: INTACTWARDEN_CORPUS=1; the
 * pinned assets come from fixtures/corpora/.downloads/).
 *
 * Deterministic accounting, not heap sampling: the loaded release says which bytes the loader
 * kept, and the archive bounds the largest file buffer. The cores must equal the golden cores byte
 * for byte. One Node heap measurement is printed, not asserted.
 */

import {afterAll, describe, expect, it} from 'vitest';
import {readGzipMember} from '@intactwarden/core/archive/gzip.ts';
import {iterateTarGzFiles} from '@intactwarden/core/archive/tar.ts';
import {readZipDirectory} from '@intactwarden/core/archive/zip.ts';
import {
  CORPUS_ENABLED,
  fetchBitwardenConfigs,
  fetchBitwardenZip,
  fetchVaultwardenTarball,
  loadBitwardenLock,
  loadVaultwardenLock,
} from '../../../tools/corpus.ts';
import {cloudCore} from '../src/bitwarden/cloudCore.ts';
import {createCoreBuilder} from '../src/coreBuilder.ts';
import {loadRelease, releaseCore, type ReleaseFileInfo} from '../src/release.ts';
import {isCheckedPath} from '../src/retain.ts';
import {GOLDEN_CORES} from './helpers/golden.ts';

const MiB = 1024 * 1024;
const BW = loadBitwardenLock('2026.10.1');
const VW = loadVaultwardenLock('2026.10.1');

/** Bytes the loader kept. */
function retained(files: ReadonlyMap<string, ReleaseFileInfo>): {total: number; paths: string[]} {
  let total = 0;
  const paths: string[] = [];
  for (const f of files.values()) {
    if (f.bytes !== undefined) {
      total += f.bytes.length;
      paths.push(f.path);
    }
  }
  return {total, paths};
}

const report: string[] = [];

describe.runIf(CORPUS_ENABLED)('deep verify memory budgets (corpus)', () => {
  afterAll(() => {
    if (report.length > 0) console.log(`[memory]\n${report.join('\n')}`);
  });

  it('Bitwarden COMMERCIAL zip: golden cores, only checked bytes kept', async () => {
    const zip = await fetchBitwardenZip(BW);
    const configs = await fetchBitwardenConfigs(BW);
    const directory = readZipDirectory(zip);
    const largestEntry = Math.max(...directory.map(e => e.uncompressedSize));

    const heapBefore = process.memoryUsage().arrayBuffers;
    const loaded = await loadRelease(
      createCoreBuilder().plan('bitwarden-web', 'selfhosted-commercial', '2026.10.1'),
      {commit: BW.release.commit},
      {sha256: BW.release.sha256, size: BW.release.size, bytes: zip},
    );
    const heapAfter = process.memoryUsage().arrayBuffers;
    const byPath = {
      [BW.config.base.path]: configs.base,
      [BW.config.cloud.path]: configs.cloud,
      [BW.config.euprd.path]: configs.euprd,
    };
    const selfhosted = await releaseCore(loaded);
    const us = await cloudCore(loaded, 'cloud-us', byPath);
    const eu = await cloudCore(loaded, 'cloud-eu', byPath);
    expect(selfhosted.sha256).toBe(GOLDEN_CORES['bitwarden-web@2026.10.1+selfhosted-commercial']);
    expect(us.sha256).toBe(GOLDEN_CORES['bitwarden-web@2026.10.1+cloud-us']);
    expect(eu.sha256).toBe(GOLDEN_CORES['bitwarden-web@2026.10.1+cloud-eu']);

    const kept = retained(loaded.files);
    // Every kept byte belongs to a file a check reads.
    expect(kept.paths.every(isCheckedPath)).toBe(true);
    expect(kept.paths.some(p => p.startsWith('/app/main.'))).toBe(true);
    expect(kept.total).toBeLessThanOrEqual(24 * MiB);
    report.push(
      `bitwarden COMMERCIAL zip ${zip.length} B: kept ${kept.total} B in ${kept.paths.length} files ` +
        `(of ${loaded.files.size}); largest entry ${largestEntry} B; ` +
        `Node arrayBuffers +${heapAfter - heapBefore} B (informative)`,
    );
  }, 300_000);

  it('Vaultwarden tarball: golden core, no buffer of the tar size, bounded retention', async () => {
    const tarball = await fetchVaultwardenTarball(VW);
    const tarSize = readGzipMember(tarball).isize;
    let largestFile = 0;
    for await (const f of iterateTarGzFiles(tarball)) {
      largestFile = Math.max(largestFile, f.bytes.length);
    }

    const loaded = await loadRelease(
      createCoreBuilder().plan('vaultwarden-web', 'release', '2026.10.1'),
      {commit: VW.release.commit, tagObject: VW.release.tag_object},
      {sha256: VW.release.sha256, size: VW.release.size, bytes: tarball},
    );
    const core = await releaseCore(loaded);
    expect(core.sha256).toBe(GOLDEN_CORES['vaultwarden-web@2026.10.1+release']);

    const kept = retained(loaded.files);
    expect(kept.paths.every(isCheckedPath)).toBe(true);
    expect(kept.total).toBeLessThanOrEqual(16 * MiB);
    // The tar is inflated as a stream: the largest buffer the tar reader allocates is one file
    // (main's source map, about a third of the tar), never the tar.
    expect(largestFile).toBeLessThan(tarSize / 2);
    report.push(
      `vaultwarden tarball ${tarball.length} B (tar ${tarSize} B): kept ${kept.total} B in ` +
        `${kept.paths.length} files (of ${loaded.files.size}); largest file ${largestFile} B`,
    );
  }, 300_000);
});
