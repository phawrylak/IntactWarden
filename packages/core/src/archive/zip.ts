/**
 * Strict ZIP reader for upstream release archives, over bytes in memory
 *.
 *
 * Node (the build, the recompute command) and the extension (deep verify) must
 * accept and reject exactly the same archives. The reader therefore supports
 * only the plain subset that release tooling produces and fails closed on
 * everything else, in particular on anything that lets two ZIP parsers see
 * different files:
 *
 * - the end-of-central-directory record is the last 22 bytes (no archive
 *   comment), no ZIP64, no multi-disk, no encryption, methods 0 (stored) and
 *   8 (deflate) only;
 * - every central-directory entry must agree with its local header, and the
 *   local records must tile the bytes before the central directory exactly,
 *   in central-directory order (no overlaps, no gaps, no prefix), so there is
 *   no hidden data;
 * - entry names follow archive/names.ts;
 * - entry contents are checked against the declared size and CRC-32.
 *
 * Declared sizes are bounded by ZipLimits before anything is inflated. Data
 * descriptors (flag bit 3) are accepted: AMO's signer writes one for every
 * file, and tools/verify-store-package.ts reads signed packages with this
 * reader.
 */

import {crc32} from './crc32.ts';
import {InflateError, inflateRawExact} from './inflate.ts';
import {
  bytesEqual,
  describeName as describe,
  entryNameProblem,
  findNameConflict,
  insidePrefix,
  isValidStripPrefix,
} from './names.ts';

export type ZipErrorCode =
  | 'not-zip'
  | 'multi-disk'
  | 'zip64'
  | 'bad-central-directory'
  | 'limit-exceeded'
  | 'encrypted'
  | 'unsupported-flags'
  | 'unsupported-method'
  | 'bad-extra-field'
  | 'bad-name'
  | 'duplicate-name'
  | 'path-conflict'
  | 'bad-directory-entry'
  | 'unsupported-file-type'
  | 'bad-entry'
  | 'local-header-mismatch'
  | 'bad-data-descriptor'
  | 'overlap'
  | 'gap'
  | 'truncated'
  | 'bad-deflate'
  | 'size-mismatch'
  | 'crc-mismatch'
  | 'prefix-mismatch';

export class ZipError extends Error {
  /** One of ZipErrorCode; typed as string so callers can log it verbatim. */
  code: string;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

export interface ZipLimits {
  maxEntries?: number;
  /** Maximum declared uncompressed size of one entry, in bytes. */
  maxEntrySize?: number;
  /** Maximum sum of declared uncompressed sizes, in bytes. */
  maxTotalSize?: number;
}

export const DEFAULT_ZIP_LIMITS: Readonly<Required<ZipLimits>> = Object.freeze({
  maxEntries: 20_000,
  maxEntrySize: 256 * 1024 * 1024,
  maxTotalSize: 2 * 1024 * 1024 * 1024,
});

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** Offset of the entry's data, just after its local header. */
  dataStart: number;
  isDirectory: boolean;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADERS = 0x2000;
const FLAGS_ENCRYPTION = FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS;
// Bits 1 and 2 only record the deflate compression level.
const FLAGS_ALLOWED = 0x0002 | 0x0004 | FLAG_DATA_DESCRIPTOR | FLAG_UTF8;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_STRONG_ENCRYPTION = 0x0017;
const EXTRA_UNICODE_PATH = 0x7075;
const EXTRA_AES = 0x9901;

const DOS_ATTR_DIRECTORY = 0x10;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const utf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

/** Central-directory record plus the fields needed to cross-check the local header. */
interface CentralRecord {
  entry: Omit<ZipEntry, 'dataStart'>;
  flags: number;
  nameBytes: Uint8Array;
  localHeaderOffset: number;
}

interface LocalHeader {
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  nameBytes: Uint8Array;
  extra: Uint8Array;
  dataStart: number;
}

/**
 * Parses and validates the whole archive structure without inflating any
 * data. Entries are returned in central-directory order.
 */
export function readZipDirectory(zip: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? DEFAULT_ZIP_LIMITS.maxEntries;
  const maxEntrySize = limits.maxEntrySize ?? DEFAULT_ZIP_LIMITS.maxEntrySize;
  const maxTotalSize = limits.maxTotalSize ?? DEFAULT_ZIP_LIMITS.maxTotalSize;
  const view = viewOf(zip);

  // The end record is the last 22 bytes: an archive comment is refused, so no
  // second, differently-read end record can hide in one.
  const eocd = zip.length - EOCD_SIZE;
  if (
    eocd < 0 ||
    view.getUint32(eocd, true) !== SIG_EOCD ||
    view.getUint16(eocd + 20, true) !== 0
  ) {
    throw new ZipError('not-zip', 'no end of central directory record in the last 22 bytes');
  }
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  if (
    [disk, cdDisk, diskEntries, totalEntries].includes(U16_MAX) ||
    cdSize === U32_MAX ||
    cdOffset === U32_MAX ||
    (eocd >= ZIP64_LOCATOR_SIZE &&
      view.getUint32(eocd - ZIP64_LOCATOR_SIZE, true) === SIG_ZIP64_LOCATOR)
  ) {
    throw new ZipError('zip64', 'ZIP64 archives are not supported');
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) {
    throw new ZipError('multi-disk', 'multi-disk archives are not supported');
  }
  if (totalEntries > maxEntries) {
    throw new ZipError(
      'limit-exceeded',
      `${totalEntries} entries exceed the limit of ${maxEntries}`,
    );
  }
  if (cdOffset + cdSize !== eocd) {
    throw new ZipError(
      'bad-central-directory',
      cdOffset + cdSize > eocd
        ? 'central directory extends past the end record'
        : 'unexpected bytes between central directory and end record',
    );
  }

  const records: CentralRecord[] = [];
  let totalSize = 0;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    const record = readCentralRecord(zip, view, p, eocd);
    const {entry} = record;
    if (entry.uncompressedSize > maxEntrySize) {
      throw new ZipError(
        'limit-exceeded',
        `${describe(entry.name)}: ${entry.uncompressedSize} bytes exceed the entry limit of ${maxEntrySize}`,
      );
    }
    totalSize += entry.uncompressedSize;
    if (totalSize > maxTotalSize) {
      throw new ZipError('limit-exceeded', `total size exceeds the limit of ${maxTotalSize}`);
    }
    records.push(record);
    p = record.next;
  }
  if (p !== eocd) {
    throw new ZipError('bad-central-directory', 'unexpected bytes after the last central entry');
  }

  checkNames(records.map(r => r.entry));

  // The local records cover [0, cdOffset) exactly, in central-directory order.
  const entries: ZipEntry[] = [];
  let pos = 0;
  for (const r of records) {
    if (r.localHeaderOffset < pos) {
      throw new ZipError('overlap', `${describe(r.entry.name)}: overlaps another entry`);
    }
    if (r.localHeaderOffset > pos) throw new ZipError('gap', `unaccounted bytes at offset ${pos}`);
    const local = checkLocalRecord(zip, view, r, cdOffset);
    entries.push({...r.entry, dataStart: local.dataStart});
    pos = local.end;
  }
  if (pos !== cdOffset) throw new ZipError('gap', `unaccounted bytes at offset ${pos}`);
  return entries;
}

/**
 * Returns the uncompressed bytes of one entry of `zip` (a fresh copy); `entry`
 * comes from readZipDirectory on the same bytes, which checked its local header.
 * Deflate data is inflated with DecompressionStream, and the result must match
 * the declared size and CRC-32 exactly.
 */
export async function readZipEntry(zip: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const where = describe(entry.name);
  const dataEnd = entry.dataStart + entry.compressedSize;
  if (!isU32(entry.dataStart) || !isU32(entry.compressedSize) || dataEnd > zip.length) {
    throw new ZipError('truncated', `${where}: data is outside the archive`);
  }
  const data = zip.subarray(entry.dataStart, dataEnd);
  const out =
    entry.method === 0 ? data.slice() : await inflateRaw(data, entry.uncompressedSize, where);
  if (crc32(out) !== entry.crc32) throw new ZipError('crc-mismatch', `${where}: CRC-32 mismatch`);
  return out;
}

/**
 * Yields the regular files of a validated archive in central-directory order,
 * as path '/' + (name without stripPrefix). With stripPrefix (which must end
 * in '/'), every file must lie below it, and every directory entry must be
 * below it or one of its ancestors. The whole directory is validated before
 * the first file is yielded; a later entry can still fail its size or CRC
 * check, so consumers must discard everything if iteration throws. Each file
 * is inflated in turn, so at most one entry is in memory at a time (plus what
 * the caller keeps).
 */
export async function* iterateZipFiles(
  zip: Uint8Array,
  opts: {stripPrefix?: string; limits?: ZipLimits} = {},
): AsyncGenerator<{path: string; bytes: Uint8Array}> {
  const prefix = opts.stripPrefix ?? '';
  if (!isValidStripPrefix(prefix)) {
    throw new TypeError(`iterateZipFiles: invalid stripPrefix ${describe(prefix)}`);
  }
  const entries = readZipDirectory(zip, opts.limits);
  for (const entry of entries) {
    if (!insidePrefix(entry, prefix)) {
      throw new ZipError(
        'prefix-mismatch',
        `${describe(entry.name)} is outside ${describe(prefix)}`,
      );
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    yield {path: '/' + entry.name.slice(prefix.length), bytes: await readZipEntry(zip, entry)};
  }
}

// ---------------------------------------------------------------------------
// Structure

function viewOf(zip: Uint8Array): DataView {
  return new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
}

function readCentralRecord(
  zip: Uint8Array,
  view: DataView,
  p: number,
  cdEnd: number,
): CentralRecord & {next: number} {
  if (p + CENTRAL_HEADER_SIZE > cdEnd || view.getUint32(p, true) !== SIG_CENTRAL) {
    throw new ZipError('bad-central-directory', 'malformed central directory entry');
  }
  const flags = view.getUint16(p + 8, true);
  const method = view.getUint16(p + 10, true);
  const crc = view.getUint32(p + 16, true);
  const compressedSize = view.getUint32(p + 20, true);
  const uncompressedSize = view.getUint32(p + 24, true);
  const nameLength = view.getUint16(p + 28, true);
  const extraLength = view.getUint16(p + 30, true);
  const commentLength = view.getUint16(p + 32, true);
  const diskStart = view.getUint16(p + 34, true);
  const externalAttr = view.getUint32(p + 38, true);
  const localHeaderOffset = view.getUint32(p + 42, true);
  const nameStart = p + CENTRAL_HEADER_SIZE;
  const next = nameStart + nameLength + extraLength + commentLength;
  if (next > cdEnd) {
    throw new ZipError('bad-central-directory', 'central directory entry is truncated');
  }

  const nameBytes = zip.subarray(nameStart, nameStart + nameLength);
  const name = decodeName(nameBytes, flags);
  const where = describe(name);
  const problem = entryNameProblem(name);
  if (problem !== undefined) throw new ZipError('bad-name', `${where}: ${problem}`);
  checkFlags(flags, where);
  if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
    throw new ZipError('zip64', `${where}: ZIP64 entries are not supported`);
  }
  if (diskStart !== 0) throw new ZipError('multi-disk', `${where}: entry starts on another disk`);
  if (method !== 0 && method !== 8) {
    throw new ZipError('unsupported-method', `${where}: unsupported compression method ${method}`);
  }
  checkExtraFields(view, nameStart + nameLength, extraLength, where);

  const isDirectory = name.endsWith('/');
  checkFileType(externalAttr, isDirectory, where);
  if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0 || crc !== 0)) {
    throw new ZipError('bad-directory-entry', `${where}: directory entry has content`);
  }
  if (method === 0 && compressedSize !== uncompressedSize) {
    throw new ZipError('bad-entry', `${where}: stored entry with differing sizes`);
  }
  const entry = {name, method, compressedSize, uncompressedSize, crc32: crc, isDirectory} as const;
  return {entry, flags, nameBytes, localHeaderOffset, next};
}

function readLocalHeader(zip: Uint8Array, view: DataView, p: number, end: number): LocalHeader {
  const missing = (): ZipError =>
    new ZipError('local-header-mismatch', `no local header at offset ${p}`);
  if (p + LOCAL_HEADER_SIZE > end || view.getUint32(p, true) !== SIG_LOCAL) throw missing();
  const nameLength = view.getUint16(p + 26, true);
  const extraLength = view.getUint16(p + 28, true);
  const nameStart = p + LOCAL_HEADER_SIZE;
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart > end) throw new ZipError('truncated', `local header at offset ${p} is truncated`);
  return {
    flags: view.getUint16(p + 6, true),
    method: view.getUint16(p + 8, true),
    crc32: view.getUint32(p + 14, true),
    compressedSize: view.getUint32(p + 18, true),
    uncompressedSize: view.getUint32(p + 22, true),
    nameBytes: zip.subarray(nameStart, nameStart + nameLength),
    extra: zip.subarray(nameStart + nameLength, dataStart),
    dataStart,
  };
}

/**
 * Without a data descriptor the local header repeats CRC and sizes; with one
 * (flag bit 3) each of them may instead be zero.
 */
function localSizesAgree(header: LocalHeader, entry: CentralRecord['entry']): boolean {
  const pairs: Array<[number, number]> = [
    [header.crc32, entry.crc32],
    [header.compressedSize, entry.compressedSize],
    [header.uncompressedSize, entry.uncompressedSize],
  ];
  const deferred = (header.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  return pairs.every(([local, central]) => local === central || (deferred && local === 0));
}

/**
 * Cross-checks the local record of a central entry and returns where its data
 * starts and the offset just past the record (header, data and data
 * descriptor). Records must lie entirely before the central directory.
 */
function checkLocalRecord(
  zip: Uint8Array,
  view: DataView,
  record: CentralRecord,
  cdOffset: number,
): {dataStart: number; end: number} {
  const {entry, flags} = record;
  const where = describe(entry.name);
  if (record.localHeaderOffset >= cdOffset) {
    throw new ZipError('overlap', `${where}: local header is not before the central directory`);
  }
  const header = readLocalHeader(zip, view, record.localHeaderOffset, cdOffset);
  if (
    header.flags !== flags ||
    header.method !== entry.method ||
    !bytesEqual(header.nameBytes, record.nameBytes) ||
    !localSizesAgree(header, entry)
  ) {
    throw new ZipError(
      'local-header-mismatch',
      `${where}: local header does not match the central directory`,
    );
  }
  checkExtraFields(viewOf(header.extra), 0, header.extra.length, where);
  const {dataStart} = header;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > cdOffset) {
    throw new ZipError('overlap', `${where}: data overlaps the central directory`);
  }
  if ((flags & FLAG_DATA_DESCRIPTOR) === 0) return {dataStart, end: dataEnd};
  // Up to 16 bytes (signature, CRC-32 and both sizes), bounded by the central directory.
  const available = Math.min(16, cdOffset - dataEnd);
  return {
    dataStart,
    end: dataEnd + dataDescriptorLength(view, dataEnd, dataEnd + available, entry),
  };
}

/**
 * A data descriptor is CRC-32 and both sizes, optionally preceded by a
 * signature; it must repeat the central-directory values.
 */
function dataDescriptorLength(
  view: DataView,
  p: number,
  end: number,
  entry: CentralRecord['entry'],
): number {
  const matches = (q: number): boolean =>
    q + 12 <= end &&
    view.getUint32(q, true) === entry.crc32 &&
    view.getUint32(q + 4, true) === entry.compressedSize &&
    view.getUint32(q + 8, true) === entry.uncompressedSize;
  if (p + 4 <= end && view.getUint32(p, true) === SIG_DATA_DESCRIPTOR && matches(p + 4)) return 16;
  if (matches(p)) return 12;
  throw new ZipError(
    'bad-data-descriptor',
    `${describe(entry.name)}: data descriptor does not match`,
  );
}

function checkFlags(flags: number, where: string): void {
  if ((flags & FLAGS_ENCRYPTION) !== 0) {
    throw new ZipError('encrypted', `${where}: entry is encrypted`);
  }
  if ((flags & ~FLAGS_ALLOWED) !== 0) {
    throw new ZipError('unsupported-flags', `${where}: unsupported flags 0x${flags.toString(16)}`);
  }
}

function checkExtraFields(view: DataView, start: number, length: number, where: string): void {
  const end = start + length;
  let p = start;
  while (p < end) {
    if (p + 4 > end) throw new ZipError('bad-extra-field', `${where}: malformed extra field`);
    const id = view.getUint16(p, true);
    p += 4 + view.getUint16(p + 2, true);
    if (p > end) throw new ZipError('bad-extra-field', `${where}: malformed extra field`);
    if (id === EXTRA_ZIP64) {
      throw new ZipError('zip64', `${where}: ZIP64 entries are not supported`);
    }
    if (id === EXTRA_STRONG_ENCRYPTION || id === EXTRA_AES) {
      throw new ZipError('encrypted', `${where}: entry is encrypted`);
    }
    if (id === EXTRA_UNICODE_PATH) {
      // Some parsers prefer this over the header name, giving the entry two names.
      throw new ZipError('bad-extra-field', `${where}: Unicode Path extra field is not supported`);
    }
  }
}

/**
 * Only regular files and directories; symlinks or devices would extract
 * differently. The upper 16 bits of the external attributes are read as a
 * Unix mode whatever the "made by" host: Info-ZIP does so for Unix, OS X, VMS,
 * Atari, BeOS, AtheOS, QDOS, Tandem and (after a consistency check) FAT
 * entries, so a non-zero file type other than the expected one fails closed.
 */
function checkFileType(externalAttr: number, isDirectory: boolean, where: string): void {
  if ((externalAttr & DOS_ATTR_DIRECTORY) !== 0 && !isDirectory) {
    throw new ZipError('unsupported-file-type', `${where}: file entry has the directory attribute`);
  }
  const type = (externalAttr >>> 16) & S_IFMT;
  if (type !== 0 && type !== (isDirectory ? S_IFDIR : S_IFREG)) {
    throw new ZipError('unsupported-file-type', `${where}: not a regular file or directory`);
  }
}

// ---------------------------------------------------------------------------
// Names

/** UTF-8 when flag bit 11 is set, otherwise pure ASCII (code page 437 is not guessed). */
function decodeName(bytes: Uint8Array, flags: number): string {
  if ((flags & FLAG_UTF8) === 0 && bytes.some(b => b >= 0x80)) {
    throw new ZipError('bad-name', 'non-ASCII entry name without the UTF-8 flag');
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new ZipError('bad-name', 'entry name is not valid UTF-8');
  }
}

function checkNames(entries: ReadonlyArray<CentralRecord['entry']>): void {
  const conflict = findNameConflict(entries);
  if (conflict !== undefined) throw new ZipError(conflict.code, conflict.message);
}

// ---------------------------------------------------------------------------
// Inflate

/**
 * Inflates raw deflate data that must produce exactly `expectedSize` bytes
 * (archive/inflate.ts: chunked, cancelled at the first excess chunk, and
 * trailing data rejected on every platform).
 */
async function inflateRaw(
  data: Uint8Array,
  expectedSize: number,
  where: string,
): Promise<Uint8Array> {
  try {
    return await inflateRawExact(data, {expectedSize});
  } catch (err) {
    if (!(err instanceof InflateError)) throw err;
    switch (err.failure) {
      case 'too-large':
      case 'size-mismatch':
        throw new ZipError('size-mismatch', `${where}: ${err.message}`);
      case 'bad-deflate':
      case 'trailing-data':
        throw new ZipError('bad-deflate', `${where}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers

function isU32(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= U32_MAX;
}
