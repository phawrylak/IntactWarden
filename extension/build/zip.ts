/**
 * Deterministic ZIP writer. The bytes depend only on the file paths and contents:
 *
 * - entries sorted by path (byte order), files only (no directory entries);
 * - STORE method (no deflate, so nothing depends on a zlib version);
 * - fixed DOS timestamp 1980-01-01 00:00:00, "made by" MS-DOS 2.0, version needed 1.0, no flags,
 *   internal and external attributes 0, no extra fields, no comments;
 * - package paths limited to ASCII letters, digits, `.`, `_`, `-`, `@` and `/` (files.ts), so no
 *   UTF-8 flag or path normalisation question arises; no ZIP64 (fails beyond 65534 entries or
 *   4 GiB).
 */

import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isPackagePath, listFiles} from './files.ts';
import {crc32} from '@intactwarden/core/archive/crc32.ts';

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
/** 1980-01-01: ((1980 - 1980) << 9) | (1 << 5) | 1. */
export const DOS_DATE = 0x0021;
export const DOS_TIME = 0x0000;
const VERSION_MADE_BY = 20; // MS-DOS host, spec 2.0: no Unix permission bits are implied.
const VERSION_NEEDED = 10; // stored entries only
const MAX_ENTRIES = 0xfffe;
const MAX_OFFSET = 0xffffffff;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Builds the archive. Throws on a duplicate or invalid path, or beyond the non-ZIP64 limits. */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => compare(a.path, b.path));
  if (sorted.length > MAX_ENTRIES) throw new Error('too many zip entries (no ZIP64)');
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!.path;
    if (!isPackagePath(p)) throw new Error(`invalid package path: ${JSON.stringify(p)}`);
    if (i > 0 && sorted[i - 1]!.path === p) throw new Error(`duplicate zip entry ${p}`);
  }
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const {path, bytes} of sorted) {
    const name = enc.encode(path);
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, bytes.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, VERSION_MADE_BY, true);
    cv.setUint16(6, VERSION_NEEDED, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, bytes);
    centrals.push(central);
    offset += local.length + bytes.length;
    if (offset > MAX_OFFSET) throw new Error('zip larger than 4 GiB (no ZIP64)');
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  if (offset + centralSize > MAX_OFFSET) throw new Error('zip larger than 4 GiB (no ZIP64)');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_SIG, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, sorted.length, true);
  ev.setUint16(10, sorted.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let o = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Zips every regular file below `dir` (package paths relative to it). */
export async function zipDirectory(dir: string): Promise<Uint8Array> {
  const paths = await listFiles(dir);
  const entries: ZipEntry[] = [];
  for (const path of paths)
    entries.push({path, bytes: new Uint8Array(await readFile(join(dir, path)))});
  return createZip(entries);
}
