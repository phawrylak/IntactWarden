import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {readZipDirectory, readZipEntry} from '@intactwarden/core/archive/zip.ts';
import {listFiles} from '../../build/files.ts';
import {createZip, DOS_DATE, zipDirectory} from '../../build/zip.ts';

const enc = new TextEncoder();
const entry = (path: string, text: string) => ({path, bytes: enc.encode(text)});

describe('createZip', () => {
  it('is independent of input order and round-trips through the strict reader', async () => {
    const a = createZip([entry('b.txt', 'bee'), entry('a/z.js', 'zed'), entry('a.json', '{}')]);
    const b = createZip([entry('a.json', '{}'), entry('b.txt', 'bee'), entry('a/z.js', 'zed')]);
    expect(b).toEqual(a);
    const read = readZipDirectory(a);
    expect(read.map(e => e.name)).toEqual(['a.json', 'a/z.js', 'b.txt']);
    expect(new TextDecoder().decode(await readZipEntry(a, read[1]!))).toBe('zed');
  });

  it('writes the fixed STORE layout: no flags, 1980-01-01 00:00, no extras, no attributes', () => {
    const zip = createZip([entry('x', 'hello')]);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(4, true)).toBe(10); // version needed
    expect(v.getUint16(6, true)).toBe(0); // flags
    expect(v.getUint16(8, true)).toBe(0); // STORE
    expect(v.getUint16(10, true)).toBe(0); // time
    expect(v.getUint16(12, true)).toBe(DOS_DATE);
    expect(v.getUint16(28, true)).toBe(0); // extra length
    const cd = 30 + 1 + 5;
    expect(v.getUint32(cd, true)).toBe(0x02014b50);
    expect(v.getUint16(cd + 4, true)).toBe(20); // made by MS-DOS 2.0
    expect(v.getUint32(cd + 38, true)).toBe(0); // external attributes
    expect(zip.length).toBe(30 + 1 + 5 + 46 + 1 + 22);
  });

  it('an empty archive is just the end record', () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(readZipDirectory(zip)).toEqual([]);
  });

  it('refuses duplicates and paths outside the package alphabet', () => {
    expect(() => createZip([entry('a', '1'), entry('a', '2')])).toThrow(/duplicate/);
    for (const bad of ['/abs', 'a/../b', './a', 'a//b', 'a\\b', 'ü.txt', 'a b', '']) {
      expect(() => createZip([entry(bad, '')])).toThrow(/invalid package path/);
    }
  });

  const unzip = spawnSync('unzip', ['-v'], {encoding: 'utf8'});
  it.runIf(unzip.status === 0)('passes `unzip -t` when unzip is installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iw-zip-'));
    try {
      const file = join(dir, 'x.zip');
      await writeFile(file, createZip([entry('manifest.json', '{}'), entry('ui/popup.js', 'x')]));
      const r = spawnSync('unzip', ['-t', file], {encoding: 'utf8'});
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('No errors detected');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe('zipDirectory and listFiles', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, {recursive: true, force: true});
    dir = null;
  });

  it('zips regular files in byte order, the same bytes every time', async () => {
    dir = await mkdtemp(join(tmpdir(), 'iw-zipdir-'));
    await mkdir(join(dir, 'ui'), {recursive: true});
    await writeFile(join(dir, 'b.js'), 'b');
    await writeFile(join(dir, 'C.js'), 'C');
    await writeFile(join(dir, 'ui', 'a.html'), '<!doctype html>');
    expect(await listFiles(dir)).toEqual(['C.js', 'b.js', 'ui/a.html']);
    const first = await zipDirectory(dir);
    expect(await zipDirectory(dir)).toEqual(first);
    expect(readZipDirectory(first).map(e => e.name)).toEqual(['C.js', 'b.js', 'ui/a.html']);
  });

  it('refuses symbolic links', async () => {
    dir = await mkdtemp(join(tmpdir(), 'iw-zipdir-'));
    await writeFile(join(dir, 'a.js'), 'a');
    await symlink(join(dir, 'a.js'), join(dir, 'link.js'));
    await expect(listFiles(dir)).rejects.toThrow(/not a regular file/);
  });
});
