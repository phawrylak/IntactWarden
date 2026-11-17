/**
 * Strict tar reader for upstream release archives, the counterpart of zip.ts for `.tar.gz` assets
 * (`iterateTarGzFiles`).
 *
 * Node and the extension must accept exactly the same inputs. The reader accepts
 * only what GNU tar (`tar -czf`, the writer of the Vaultwarden release tarball)
 * produces and fails closed on everything that could make two tar parsers see
 * different files:
 *
 * - the GNU magic only, valid checksums, and octal numeric fields (no base-256
 *   or signed values);
 * - entry types '0' and '5' only, plus a GNU long name ('L') directly before
 *   such an entry, whose own name field must be the first 100 bytes of the long
 *   name; links, devices, pax headers and every other type are refused;
 * - nothing after a text field's first NUL, nothing from header byte 345 on, and
 *   all-zero data padding, so nothing hides between entries;
 * - every byte after the first all-zero block is zero (at least two zero blocks);
 * - names follow archive/names.ts, shared with zip.ts.
 *
 * Mode, uid, gid, uname, gname and mtime must parse but never enter a core.
 * Declared sizes are bounded by TarLimits before an entry's data is read.
 *
 * The reader is sequential: it takes the archive as chunks (for a `.tar.gz`,
 * the output of gzip.ts `inflateGzip`), so a 169 MB tarball is never held in
 * one buffer. A file may be yielded before a later error (a later entry, the
 * name checks at the end, or the gzip checks after the last chunk), so a
 * consumer must discard everything it received if iteration throws.
 */

import {inflateGzip, readGzipMember, type GzipLimits} from './gzip.ts';
import {
  bytesEqual,
  describeName as describe,
  entryNameProblem,
  findNameConflict,
  insidePrefix,
  isValidStripPrefix,
  type NamedEntry,
} from './names.ts';

export type TarErrorCode =
  | 'truncated'
  | 'bad-header'
  | 'bad-checksum'
  | 'bad-number'
  | 'unsupported-format'
  | 'unsupported-entry-type'
  | 'bad-link'
  | 'bad-long-name'
  | 'bad-name'
  | 'duplicate-name'
  | 'path-conflict'
  | 'bad-directory-entry'
  | 'bad-padding'
  | 'bad-end-of-archive'
  | 'limit-exceeded'
  | 'prefix-mismatch';

export class TarError extends Error {
  /** One of TarErrorCode; typed as string so callers can log it verbatim. */
  code: string;

  constructor(code: TarErrorCode, message: string) {
    super(message);
    this.name = 'TarError';
    this.code = code;
  }
}

export interface TarLimits {
  /** Maximum number of entries (files and directories). */
  maxEntries?: number;
  /** Maximum declared size of one file, in bytes. */
  maxEntrySize?: number;
  /** Maximum sum of declared file sizes, in bytes. */
  maxTotalSize?: number;
}

export const DEFAULT_TAR_LIMITS: Readonly<Required<TarLimits>> = Object.freeze({
  maxEntries: 20_000,
  maxEntrySize: 256 * 1024 * 1024,
  maxTotalSize: 1024 * 1024 * 1024,
});

export interface TarFile {
  /** "/" + the entry name without the stripped prefix. */
  path: string;
  /** The file data, which the caller must not modify. */
  bytes: Uint8Array;
}

export interface TarIterateOptions {
  stripPrefix?: string;
  limits?: TarLimits;
}

const BLOCK = 512;
const MAX_LONG_NAME = 4096;
const NAME_FIELD = 100;
const GNU_LONG_LINK = '././@LongLink';
/** Where the ustar prefix, and GNU's atime, ctime, sparse map and extension flag, would start. */
const GNU_TAIL = 345;

const TYPE_FILE = 0x30; // '0'
const TYPE_DIRECTORY = 0x35; // '5'
const TYPE_GNU_LONG_NAME = 0x4c; // 'L'

const EMPTY: Uint8Array = new Uint8Array(0);
const utf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

/** [offset, length] of the header fields. */
const F = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  chksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 8], // magic (6) + version (2)
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
} as const satisfies Record<string, readonly [number, number]>;

const MAGIC_GNU = [0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00]; // "ustar  \0"

interface Header {
  typeflag: number;
  /** Raw name field bytes up to the first NUL. */
  nameField: Uint8Array;
  name: string;
  size: number;
}

/** Reads exact byte counts from a chunk iterator; `pos` counts the bytes read so far. */
class ChunkReader {
  pos = 0;
  #chunk: Uint8Array = EMPTY;
  #at = 0;
  #done = false;
  readonly #it: AsyncIterator<Uint8Array>;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.#it = chunks[Symbol.asyncIterator]();
  }

  /** The next 1 to `max` bytes (a view of the current chunk), or none at the end of the input. */
  async read(max: number): Promise<Uint8Array> {
    if (max === 0) return EMPTY;
    while (this.#at === this.#chunk.length) {
      if (this.#done) return EMPTY;
      const step = await this.#it.next();
      if (step.done === true) {
        this.#done = true;
        return EMPTY;
      }
      this.#chunk = step.value;
      this.#at = 0;
    }
    const part = this.#chunk.subarray(this.#at, this.#at + max);
    this.#at += part.length;
    this.pos += part.length;
    return part;
  }

  /** Exactly `n` bytes; the input ending first is `truncated`. */
  async take(n: number): Promise<Uint8Array> {
    const first = await this.read(n);
    if (first.length === n) return first;
    const out = new Uint8Array(n);
    out.set(first);
    for (let fill = first.length; fill < n;) {
      const part = await this.read(n - fill);
      if (part.length === 0) throw new TarError('truncated', 'archive is truncated');
      out.set(part, fill);
      fill += part.length;
    }
    return out;
  }

  /** Reads `n` bytes without keeping them; false if one is not zero. */
  async zeros(n: number): Promise<boolean> {
    while (n > 0) {
      const part = await this.read(n);
      if (part.length === 0) throw new TarError('truncated', 'archive is truncated');
      if (!isZero(part, 0, part.length)) return false;
      n -= part.length;
    }
    return true;
  }

  /**
   * Requires the input to end here. Asking for more lets the source finish, so its own final
   * checks run (gzip: ISIZE, trailing data, CRC-32) before the archive is accepted.
   */
  async end(): Promise<void> {
    if ((await this.read(1)).length !== 0) {
      throw new TarError('bad-end-of-archive', 'input continues past the archive length');
    }
  }

  /** Stops the source if it has not ended (after an error or a consumer's break). */
  async close(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    try {
      await this.#it.return?.();
    } catch {
      // The reader's own outcome stands.
    }
  }
}

/**
 * Yields the regular files of a tar archive of exactly `length` bytes, given in
 * chunks of any size, in archive order, as path '/' + (name without
 * stripPrefix). With stripPrefix (which must end in '/'), every file must lie
 * below it, and every directory entry must be below it or one of its
 * ancestors. The input is read to its end before iteration finishes, and the
 * source is stopped when iteration ends early. See the module comment for why
 * a consumer discards everything when this throws.
 */
export async function* iterateTar(
  chunks: AsyncIterable<Uint8Array>,
  length: number,
  opts: TarIterateOptions = {},
): AsyncGenerator<TarFile, void, undefined> {
  const prefix = opts.stripPrefix ?? '';
  if (!isValidStripPrefix(prefix)) {
    throw new TypeError(`iterateTar: invalid stripPrefix ${describe(prefix)}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError('iterateTar: length must be a non-negative integer');
  }
  const maxEntries = opts.limits?.maxEntries ?? DEFAULT_TAR_LIMITS.maxEntries;
  const maxEntrySize = opts.limits?.maxEntrySize ?? DEFAULT_TAR_LIMITS.maxEntrySize;
  const maxTotalSize = opts.limits?.maxTotalSize ?? DEFAULT_TAR_LIMITS.maxTotalSize;
  const input = new ChunkReader(chunks);
  try {
    if (length % BLOCK !== 0) {
      throw new TarError('truncated', `archive length ${length} is not a multiple of 512`);
    }
    const entries: NamedEntry[] = [];
    let totalSize = 0;
    let longName: {name: string; bytes: Uint8Array} | null = null;
    for (;;) {
      const p = input.pos;
      if (p + BLOCK > length) {
        throw new TarError('truncated', 'archive ends without an end-of-archive block');
      }
      const block = await input.take(BLOCK);
      if (isZero(block, 0, BLOCK)) {
        if (longName !== null) {
          throw new TarError('bad-long-name', 'GNU long name is not followed by an entry');
        }
        // After the first all-zero block every remaining byte must be zero, and
        // there must be at least two zero blocks.
        if (length - p < 2 * BLOCK) {
          throw new TarError('bad-end-of-archive', 'end-of-archive marker needs two zero blocks');
        }
        if (!(await input.zeros(length - input.pos))) {
          throw new TarError('bad-end-of-archive', 'data after the end-of-archive marker');
        }
        break;
      }
      const h = readHeader(block, p);
      const padding = Math.ceil(h.size / BLOCK) * BLOCK - h.size;
      if (input.pos + h.size + padding > length) {
        throw new TarError('truncated', `${describe(h.name)}: data is truncated`);
      }
      const readData = async (keep: boolean, name: string): Promise<Uint8Array> => {
        const data = keep ? await input.take(h.size) : EMPTY;
        if (!(await input.zeros(padding))) {
          throw new TarError('bad-padding', `${describe(name)}: non-zero padding after the data`);
        }
        return data;
      };

      if (h.typeflag === TYPE_GNU_LONG_NAME) {
        if (longName !== null) throw new TarError('bad-long-name', 'two GNU long names in a row');
        const at = `GNU long name at offset ${p}`;
        if (h.name !== GNU_LONG_LINK) {
          throw new TarError('bad-long-name', `${at}: header name must be ${GNU_LONG_LINK}`);
        }
        if (h.size < 2 || h.size > MAX_LONG_NAME + 1) {
          throw new TarError('bad-long-name', `${at}: invalid length ${h.size}`);
        }
        longName = readLongName(await readData(true, h.name), at);
        continue;
      }

      let name = h.name;
      if (longName !== null) {
        // The entry's own name field must be the first 100 bytes of the long
        // name, so a reader that ignores 'L' sees a prefix, never another name.
        if (!bytesEqual(h.nameField, longName.bytes.subarray(0, NAME_FIELD))) {
          throw new TarError(
            'bad-long-name',
            `${describe(longName.name)}: the entry's name field does not start the long name`,
          );
        }
        name = longName.name;
        longName = null;
      }
      const where = describe(name);
      const problem = entryNameProblem(name);
      if (problem !== undefined) throw new TarError('bad-name', `${where}: ${problem}`);
      const isDirectory = h.typeflag === TYPE_DIRECTORY;
      if (isDirectory !== name.endsWith('/')) {
        throw new TarError(
          isDirectory ? 'bad-directory-entry' : 'bad-name',
          isDirectory
            ? `${where}: directory name must end with "/"`
            : `${where}: file name must not end with "/"`,
        );
      }
      if (isDirectory && h.size !== 0) {
        throw new TarError('bad-directory-entry', `${where}: directory entry has content`);
      }
      if (entries.length + 1 > maxEntries) {
        throw new TarError('limit-exceeded', `more than ${maxEntries} entries`);
      }
      if (h.size > maxEntrySize) {
        throw new TarError(
          'limit-exceeded',
          `${where}: ${h.size} bytes exceed the entry limit of ${maxEntrySize}`,
        );
      }
      totalSize += h.size;
      if (totalSize > maxTotalSize) {
        throw new TarError('limit-exceeded', `total size exceeds the limit of ${maxTotalSize}`);
      }
      const entry = {name, isDirectory};
      if (!insidePrefix(entry, prefix)) {
        throw new TarError('prefix-mismatch', `${where} is outside ${describe(prefix)}`);
      }
      entries.push(entry);
      const bytes = await readData(!isDirectory, name);
      if (!isDirectory) yield {path: '/' + name.slice(prefix.length), bytes};
    }
    const conflict = findNameConflict(entries);
    if (conflict !== undefined) throw new TarError(conflict.code, conflict.message);
    await input.end();
  } finally {
    await input.close();
  }
}

/**
 * The regular files of a single-member `.tar.gz` (gzip.ts: CRC-32 and ISIZE
 * checked; then the tar rules), as `iterateTar` names them: the member is
 * inflated as a stream into the tar reader.
 */
export async function* iterateTarGzFiles(
  gz: Uint8Array,
  opts: TarIterateOptions & {gzipLimits?: GzipLimits} = {},
): AsyncGenerator<TarFile, void, undefined> {
  const member = readGzipMember(gz, opts.gzipLimits);
  yield* iterateTar(inflateGzip(member), member.isize, opts);
}

// ---------------------------------------------------------------------------
// Headers

/** One 512-byte header `block` that starts at offset `p` of the archive. */
function readHeader(block: Uint8Array, p: number): Header {
  const at = `header at offset ${p}`;

  const stored = parseOctal(block, F.chksum, 'chksum', at);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= F.chksum[0] && i < F.chksum[0] + F.chksum[1] ? 0x20 : block[i]!;
  }
  if (stored !== sum) throw new TarError('bad-checksum', `${at}: checksum mismatch`);

  if (!fieldEquals(block, F.magic, MAGIC_GNU)) {
    throw new TarError('unsupported-format', `${at}: not a GNU tar header`);
  }

  const typeflag = block[F.typeflag[0]]!;
  if (typeflag !== TYPE_FILE && typeflag !== TYPE_DIRECTORY && typeflag !== TYPE_GNU_LONG_NAME) {
    throw new TarError(
      'unsupported-entry-type',
      `${at}: unsupported entry type ${JSON.stringify(String.fromCharCode(typeflag))}`,
    );
  }
  if (textField(block, F.linkname, 'linkname', at).length !== 0) {
    throw new TarError('bad-link', `${at}: linkname must be empty`);
  }
  // uname and gname must be well-formed; their values are ignored.
  textField(block, F.uname, 'uname', at);
  textField(block, F.gname, 'gname', at);
  for (const [field, name] of [
    [F.devmajor, 'devmajor'],
    [F.devminor, 'devminor'],
  ] as const) {
    // GNU tar leaves both empty for non-device entries.
    if (!isZero(block, field[0], field[0] + field[1]) && parseOctal(block, field, name, at) !== 0) {
      throw new TarError('bad-header', `${at}: ${name} must be 0`);
    }
  }
  if (!isZero(block, GNU_TAIL, BLOCK)) {
    throw new TarError(
      'bad-header',
      `${at}: GNU header has prefix, atime, ctime, sparse or extension data`,
    );
  }
  // Mode, uid, gid and mtime must parse; their values are ignored.
  for (const [field, name] of [
    [F.mode, 'mode'],
    [F.uid, 'uid'],
    [F.gid, 'gid'],
    [F.mtime, 'mtime'],
  ] as const) {
    parseOctal(block, field, name, at);
  }

  const nameField = textField(block, F.name, 'name', at);
  return {
    typeflag,
    nameField,
    name: decodeName(nameField, at),
    size: parseOctal(block, F.size, 'size', at),
  };
}

/** The payload of a GNU 'L' entry: one NUL-terminated name longer than the name field. */
function readLongName(data: Uint8Array, at: string): {name: string; bytes: Uint8Array} {
  const nul = data.indexOf(0);
  if (nul !== data.length - 1) {
    throw new TarError('bad-long-name', `${at}: name must be one NUL-terminated string`);
  }
  const bytes = data.subarray(0, nul);
  if (bytes.length <= NAME_FIELD) {
    throw new TarError('bad-long-name', `${at}: name fits the header and needs no long name`);
  }
  return {name: decodeName(bytes, at), bytes};
}

/**
 * The bytes of a NUL-padded text field up to its first NUL; every byte after
 * that NUL must be NUL too.
 */
function textField(
  block: Uint8Array,
  [offset, length]: readonly [number, number],
  name: string,
  at: string,
): Uint8Array {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  if (nul === -1) return field;
  if (!isZero(field, nul, field.length)) {
    throw new TarError('bad-header', `${at}: ${name} has bytes after its terminating NUL`);
  }
  return field.subarray(0, nul);
}

/**
 * An octal numeric field: one or more ASCII digits 0-7, then only NUL or
 * space terminators up to the end of the field (or no terminator at all).
 * Base-256 (high bit set), leading spaces, signs and other bytes are refused.
 */
function parseOctal(
  block: Uint8Array,
  [offset, length]: readonly [number, number],
  name: string,
  at: string,
): number {
  let value = 0;
  let digits = 0;
  let i = offset;
  const end = offset + length;
  for (; i < end; i++) {
    const b = block[i]!;
    if (b < 0x30 || b > 0x37) break;
    value = value * 8 + (b - 0x30);
    digits++;
  }
  for (; i < end; i++) {
    const b = block[i]!;
    if (b !== 0x00 && b !== 0x20) break;
  }
  if (digits === 0 || i !== end || !Number.isSafeInteger(value)) {
    throw new TarError('bad-number', `${at}: ${name} is not an octal number`);
  }
  return value;
}

/** Entry names are UTF-8 (the producers here write ASCII); invalid UTF-8 is refused. */
function decodeName(bytes: Uint8Array, at: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new TarError('bad-name', `${at}: name is not valid UTF-8`);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function isZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (bytes[i] !== 0) return false;
  return true;
}

function fieldEquals(
  block: Uint8Array,
  [offset, length]: readonly [number, number],
  expected: readonly number[],
): boolean {
  for (let i = 0; i < length; i++) if (block[offset + i] !== expected[i]) return false;
  return true;
}
