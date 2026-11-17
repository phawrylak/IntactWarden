/**
 * The strict ZIP reader on a real release asset (opt-in: INTACTWARDEN_CORPUS=1): the
 * web-v2026.10.1 COMMERCIAL zip, fetched by the digest pinned in
 * fixtures/corpora/ and cached only in the git-ignored downloads directory.
 */

import {describe, expect, it} from 'vitest';
import {CORPUS_ENABLED, fetchBitwardenZip, loadBitwardenLock} from '../../../tools/corpus.ts';
import {iterateZipFiles, readZipDirectory} from '../src/archive/zip.ts';
import {sha256Hex} from '../src/hash/sha256.ts';

const LOCK = loadBitwardenLock('2026.10.1');

describe.runIf(CORPUS_ENABLED)('zip reader on web-v2026.10.1', () => {
  it('reads every file of the release below build/', async () => {
    const zip = await fetchBitwardenZip(LOCK);
    expect(await sha256Hex(zip)).toBe(LOCK.release.sha256);
    const entries = readZipDirectory(zip);
    expect(entries.filter(e => !e.isDirectory)).toHaveLength(314);
    const paths: string[] = [];
    let version: unknown;
    for await (const file of iterateZipFiles(zip, {stripPrefix: LOCK.release.root})) {
      paths.push(file.path);
      if (file.path === '/version.json') version = JSON.parse(new TextDecoder().decode(file.bytes));
    }
    expect(paths).toHaveLength(314);
    expect(paths).toContain('/index.html');
    expect(version).toEqual({version: '2026.10.1'});
  });
});
