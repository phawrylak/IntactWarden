/**
 * The strict gzip and tar readers on a real release asset (opt-in:
 * INTACTWARDEN_CORPUS=1): Vaultwarden's bw_web_v2026.10.1.tar.gz (GNU tar, one
 * gzip member, 379 entries of which 84 directories), fetched by the digest
 * pinned in fixtures/corpora/ and cached only in the git-ignored downloads
 * directory.
 */

import {describe, expect, it} from 'vitest';
import {
  CORPUS_ENABLED,
  fetchVaultwardenTarball,
  loadVaultwardenLock,
} from '../../../tools/corpus.ts';
import {readGzipMember} from '../src/archive/gzip.ts';
import {iterateTarGzFiles} from '../src/archive/tar.ts';
import {sha256Hex} from '../src/hash/sha256.ts';

const LOCK = loadVaultwardenLock('2026.10.1');

describe.runIf(CORPUS_ENABLED)('tar.gz reader on bw_web_v2026.10.1.tar.gz', () => {
  it('reads every file of the release below web-vault/', async () => {
    const gz = await fetchVaultwardenTarball(LOCK);
    expect(await sha256Hex(gz)).toBe(LOCK.release.sha256);
    // One member, FLG 0, MTIME 0, OS 3; ISIZE 169021440.
    expect(readGzipMember(gz).isize).toBe(169_021_440);
    const paths: string[] = [];
    let version: unknown;
    for await (const file of iterateTarGzFiles(gz, {stripPrefix: LOCK.release.root})) {
      paths.push(file.path);
      if (file.path === '/vw-version.json')
        version = JSON.parse(new TextDecoder().decode(file.bytes));
    }
    expect(paths).toHaveLength(LOCK.files.count);
    expect(paths).toContain('/index.html');
    expect(version).toEqual({version: '2026.10.1'});
  });
});
