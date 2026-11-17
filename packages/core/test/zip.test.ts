import {crc32 as zlibCrc32, deflateRawSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {crc32} from '../src/archive/crc32.ts';
import {
  iterateZipFiles,
  readZipDirectory,
  readZipEntry,
  ZipError,
  type ZipEntry,
  type ZipLimits,
} from '../src/archive/zip.ts';
import {utf8} from '../src/hash/sha256.ts';

// ---------------------------------------------------------------------------
// Minimal ZIP writer for synthetic archives. Every field can be overridden so
// that each rejection rule can be exercised with an otherwise valid archive.

interface HeaderOverrides {
  flags?: number;
  method?: number;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
}

interface Spec {
  name: string;
  data?: string | Uint8Array;
  /** Default: 8 for files, 0 for directories. */
  method?: number;
  descriptor?: 'signed' | 'unsigned';
  /** OR'ed into the computed flags of both headers. */
  flags?: number;
  /** Raw name bytes for both headers (default: UTF-8 of name). */
  rawName?: Uint8Array;
  localRawName?: Uint8Array;
  cdExtra?: Uint8Array;
  localExtra?: Uint8Array;
  madeBy?: number;
  externalAttr?: number;
  /** Raw entry data as stored in the archive (default: compressed `data`). */
  payload?: Uint8Array;
  descriptorBytes?: Uint8Array;
  cd?: HeaderOverrides & {localHeaderOffset?: number; diskStart?: number};
  local?: HeaderOverrides;
  /** Junk inserted after this entry's local record. */
  gapAfter?: Uint8Array;
}

interface EocdOverrides {
  disk?: number;
  cdDisk?: number;
  diskEntries?: number;
  totalEntries?: number;
  cdSize?: number;
  cdOffset?: number;
}

interface ZipOptions {
  prefix?: Uint8Array;
  /** Bytes between the central directory and the end record. */
  beforeEocd?: Uint8Array;
  comment?: Uint8Array;
  /** Bytes after the end record (not covered by the comment length). */
  trailer?: Uint8Array;
  eocd?: EocdOverrides;
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function le(size: 2 | 4, value: number): Uint8Array {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (size === 2) view.setUint16(0, value, true);
  else view.setUint32(0, value >>> 0, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toBytes(data: string | Uint8Array | undefined): Uint8Array {
  return typeof data === 'string' ? utf8(data) : (data ?? new Uint8Array());
}

function extraField(id: number, data: Uint8Array): Uint8Array {
  return concat([le(2, id), le(2, data.length), data]);
}

function buildZip(specs: Spec[], options: ZipOptions = {}): Uint8Array {
  const prefix = options.prefix ?? new Uint8Array();
  const records: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = prefix.length;
  for (const spec of specs) {
    const isDirectory = spec.name.endsWith('/');
    const data = toBytes(spec.data);
    const method = spec.method ?? (isDirectory ? 0 : 8);
    const payload = spec.payload ?? (method === 8 ? new Uint8Array(deflateRawSync(data)) : data);
    const crc = crc32(data);
    const name = spec.rawName ?? utf8(spec.name);
    const localName = spec.localRawName ?? name;
    const localExtra = spec.localExtra ?? new Uint8Array();
    const cdExtra = spec.cdExtra ?? new Uint8Array();
    const nonAscii = [...spec.name].some(c => c.charCodeAt(0) >= 0x80);
    const flags = (spec.descriptor ? 0x08 : 0) | (nonAscii ? 0x800 : 0) | (spec.flags ?? 0);
    const deferred = spec.descriptor !== undefined;
    const local = spec.local ?? {};
    const cd = spec.cd ?? {};

    const localHeader = concat([
      le(4, 0x04034b50),
      le(2, 20),
      le(2, local.flags ?? flags),
      le(2, local.method ?? method),
      le(2, 0),
      le(2, 0x21),
      le(4, local.crc ?? (deferred ? 0 : crc)),
      le(4, local.compressedSize ?? (deferred ? 0 : payload.length)),
      le(4, local.uncompressedSize ?? (deferred ? 0 : data.length)),
      le(2, localName.length),
      le(2, localExtra.length),
      localName,
      localExtra,
    ]);
    const descriptor =
      spec.descriptorBytes ??
      (spec.descriptor === undefined
        ? new Uint8Array()
        : concat([
            spec.descriptor === 'signed' ? le(4, 0x08074b50) : new Uint8Array(),
            le(4, crc),
            le(4, payload.length),
            le(4, data.length),
          ]));
    const gap = spec.gapAfter ?? new Uint8Array();
    records.push(localHeader, payload, descriptor, gap);

    const defaultAttr = isDirectory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0;
    central.push(
      concat([
        le(4, 0x02014b50),
        le(2, spec.madeBy ?? 0x031e),
        le(2, 20),
        le(2, cd.flags ?? flags),
        le(2, cd.method ?? method),
        le(2, 0),
        le(2, 0x21),
        le(4, cd.crc ?? crc),
        le(4, cd.compressedSize ?? payload.length),
        le(4, cd.uncompressedSize ?? data.length),
        le(2, name.length),
        le(2, cdExtra.length),
        le(2, 0),
        le(2, cd.diskStart ?? 0),
        le(2, 0),
        le(4, spec.externalAttr ?? defaultAttr),
        le(4, cd.localHeaderOffset ?? offset),
        name,
        cdExtra,
      ]),
    );
    offset += localHeader.length + payload.length + descriptor.length + gap.length;
  }
  const cdBytes = concat(central);
  const comment = options.comment ?? new Uint8Array();
  const e = options.eocd ?? {};
  const eocd = concat([
    le(4, 0x06054b50),
    le(2, e.disk ?? 0),
    le(2, e.cdDisk ?? 0),
    le(2, e.diskEntries ?? specs.length),
    le(2, e.totalEntries ?? specs.length),
    le(4, e.cdSize ?? cdBytes.length),
    le(4, e.cdOffset ?? offset),
    le(2, comment.length),
    comment,
  ]);
  return concat([
    prefix,
    ...records,
    cdBytes,
    options.beforeEocd ?? new Uint8Array(),
    eocd,
    options.trailer ?? new Uint8Array(),
  ]);
}

function zipError(fn: () => unknown): ZipError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ZipError) return err;
    throw err;
  }
  throw new Error('expected a ZipError');
}

function expectCode(zip: Uint8Array, code: string, limits?: ZipLimits): void {
  expect(zipError(() => readZipDirectory(zip, limits)).code).toBe(code);
}

async function expectEntryCode(zip: Uint8Array, entry: ZipEntry, code: string): Promise<void> {
  const err: unknown = await readZipEntry(zip, entry).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ZipError);
  expect((err as ZipError).code).toBe(code);
}

async function collect(
  zip: Uint8Array,
  opts?: Parameters<typeof iterateZipFiles>[1],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const file of iterateZipFiles(zip, opts)) {
    files.set(file.path, new TextDecoder().decode(file.bytes));
  }
  return files;
}

/** Deterministic, partly compressible test data. */
function pseudoRandom(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = i % 3 === 0 ? 0x61 : x & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('crc32', () => {
  it('matches the standard check value and zlib', () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
    const data = pseudoRandom(10_007, 7);
    expect(crc32(data)).toBe(zlibCrc32(data) >>> 0);
  });

  it('is incremental via seed', () => {
    const data = pseudoRandom(4096, 3);
    for (const split of [0, 1, 7, 2048, 4095, 4096]) {
      expect(crc32(data.subarray(split), crc32(data.subarray(0, split)))).toBe(crc32(data));
    }
  });
});

describe('readZipDirectory / readZipEntry: valid archives', () => {
  const big = pseudoRandom(300_000, 42);
  const zip = buildZip([
    {name: 'build/'},
    {name: 'build/index.html', data: '<!doctype html><p>hello</p>'},
    {name: 'build/stored.txt', data: 'stored bytes', method: 0},
    {name: 'build/app/', data: ''},
    {name: 'build/app/main.js', data: 'console.log(1);'.repeat(100), descriptor: 'signed'},
    {name: 'build/app/big.bin', data: big, descriptor: 'unsigned'},
    {name: 'build/app/stored-dd.bin', data: 'dd', method: 0, descriptor: 'signed'},
    {name: 'build/empty.txt', data: ''},
    {name: 'build/zażółć.txt', data: 'utf-8 name'},
  ]);

  it('lists entries with central-directory metadata', () => {
    const entries = readZipDirectory(zip);
    expect(entries.map(e => e.name)).toEqual([
      'build/',
      'build/index.html',
      'build/stored.txt',
      'build/app/',
      'build/app/main.js',
      'build/app/big.bin',
      'build/app/stored-dd.bin',
      'build/empty.txt',
      'build/zażółć.txt',
    ]);
    const [dir, html, stored] = entries;
    expect(dir).toMatchObject({
      isDirectory: true,
      method: 0,
      compressedSize: 0,
      uncompressedSize: 0,
    });
    expect(html).toMatchObject({
      isDirectory: false,
      method: 8,
      crc32: crc32(utf8('<!doctype html><p>hello</p>')),
    });
    expect(stored).toMatchObject({method: 0, compressedSize: 12, uncompressedSize: 12});
    // The first entry's data follows its 30-byte local header and its name.
    expect(entries[0]!.dataStart).toBe(30 + 'build/'.length);
  });

  it('reads stored, deflated and data-descriptor entries', async () => {
    const entries = readZipDirectory(zip);
    const read = async (name: string) =>
      readZipEntry(
        zip,
        entries.find(e => e.name === name)!,
      );
    expect(new TextDecoder().decode(await read('build/stored.txt'))).toBe('stored bytes');
    expect(new TextDecoder().decode(await read('build/app/main.js'))).toBe(
      'console.log(1);'.repeat(100),
    );
    expect(await read('build/app/big.bin')).toEqual(big);
    expect(await read('build/empty.txt')).toEqual(new Uint8Array());
    expect(await read('build/')).toEqual(new Uint8Array());
  });

  it('returns copies, not views of the archive', async () => {
    const entries = readZipDirectory(zip);
    const stored = await readZipEntry(zip, entries[2]!);
    stored[0] = 0;
    expect(new TextDecoder().decode(await readZipEntry(zip, entries[2]!))).toBe('stored bytes');
  });

  it('iterates regular files with the prefix stripped', async () => {
    const files = await collect(zip, {stripPrefix: 'build/'});
    expect([...files.keys()]).toEqual([
      '/index.html',
      '/stored.txt',
      '/app/main.js',
      '/app/big.bin',
      '/app/stored-dd.bin',
      '/empty.txt',
      '/zażółć.txt',
    ]);
    expect(files.get('/index.html')).toBe('<!doctype html><p>hello</p>');
    const all = await collect(zip);
    expect(all.has('/build/index.html')).toBe(true);
  });

  it('accepts an empty archive and a subarray view', () => {
    expect(readZipDirectory(buildZip([]))).toEqual([]);
    const padded = concat([bytes(1, 2, 3), zip]);
    expect(readZipDirectory(padded.subarray(3))).toHaveLength(9);
  });

  it('accepts harmless extra fields', () => {
    const ut = extraField(0x5455, bytes(3, 0, 0, 0, 0));
    const z = buildZip([{name: 'a.txt', data: 'a', cdExtra: ut, localExtra: ut}]);
    expect(readZipDirectory(z)).toHaveLength(1);
  });

  it('accepts entries without Unix attributes (MS-DOS host)', () => {
    const z = buildZip([
      {name: 'd/', madeBy: 0x0014, externalAttr: 0x10},
      {name: 'd/f', data: 'x', madeBy: 0x0014, externalAttr: 0x20},
    ]);
    expect(readZipDirectory(z)).toHaveLength(2);
  });

  it('accepts local headers that repeat CRC and sizes despite a data descriptor', () => {
    const data = utf8('repeat');
    const payload = new Uint8Array(deflateRawSync(data));
    const z = buildZip([
      {
        name: 'a',
        data,
        descriptor: 'signed',
        local: {crc: crc32(data), compressedSize: payload.length, uncompressedSize: data.length},
      },
    ]);
    expect(readZipDirectory(z)).toHaveLength(1);
  });
});

describe('readZipDirectory: structural rejections', () => {
  const ok: Spec[] = [{name: 'a.txt', data: 'aaa'}];

  it('rejects non-zip input', () => {
    expectCode(new Uint8Array(), 'not-zip');
    expectCode(new Uint8Array(21), 'not-zip');
    expectCode(pseudoRandom(1000, 1), 'not-zip');
  });

  it('rejects bytes after the end record', () => {
    expectCode(buildZip(ok, {trailer: bytes(0)}), 'not-zip');
  });

  it('rejects an archive comment', () => {
    expectCode(buildZip(ok, {comment: utf8('release')}), 'not-zip');
    // A fake EOCD inside the comment that also ends exactly at the buffer end is read as the
    // end record (the last 22 bytes, as other parsers read it), and its directory does not fit.
    const fake = concat([le(4, 0x06054b50), new Uint8Array(16), le(2, 0)]);
    expectCode(buildZip(ok, {comment: fake}), 'bad-central-directory');
  });

  it('rejects an end record hidden in the comment that stops short of the last byte', () => {
    // [local A][CD -> A][EOCD, comment = [local B][CD -> B][EOCD, comment 0][0x00]]:
    // Python zipfile, Go archive/zip and Info-ZIP take the inner end record and
    // extract B, so the reader must not silently read A.
    const inner = buildZip([{name: 'build/app/main.js', data: 'console.log("EVIL");'}]);
    const zip = buildZip([{name: 'build/app/main.js', data: 'console.log("benign");'}], {
      comment: concat([inner, bytes(0)]),
    });
    expectCode(zip, 'not-zip');
  });

  it('rejects multi-disk archives', () => {
    expectCode(buildZip(ok, {eocd: {disk: 1}}), 'multi-disk');
    expectCode(buildZip(ok, {eocd: {cdDisk: 1}}), 'multi-disk');
    expectCode(buildZip(ok, {eocd: {diskEntries: 0}}), 'multi-disk');
    expectCode(buildZip([{name: 'a', data: 'a', cd: {diskStart: 1}}]), 'multi-disk');
  });

  it('rejects ZIP64', () => {
    expectCode(buildZip(ok, {eocd: {totalEntries: 0xffff, diskEntries: 0xffff}}), 'zip64');
    expectCode(buildZip(ok, {eocd: {cdOffset: 0xffffffff}}), 'zip64');
    expectCode(buildZip(ok, {eocd: {cdSize: 0xffffffff}}), 'zip64');
    expectCode(buildZip([{name: 'a', data: 'a', cd: {compressedSize: 0xffffffff}}]), 'zip64');
    expectCode(buildZip([{name: 'a', data: 'a', cd: {uncompressedSize: 0xffffffff}}]), 'zip64');
    expectCode(buildZip([{name: 'a', data: 'a', cd: {localHeaderOffset: 0xffffffff}}]), 'zip64');
    const zip64Extra = extraField(0x0001, new Uint8Array(16));
    expectCode(buildZip([{name: 'a', data: 'a', cdExtra: zip64Extra}]), 'zip64');
    expectCode(buildZip([{name: 'a', data: 'a', localExtra: zip64Extra}]), 'zip64');
    const locator = concat([le(4, 0x07064b50), new Uint8Array(16)]);
    expectCode(buildZip(ok, {beforeEocd: locator}), 'zip64');
  });

  it('rejects a central directory outside its bounds', () => {
    const zip = buildZip(ok);
    const cdSize = readU32(zip, zip.length - 10);
    expectCode(buildZip(ok, {eocd: {cdOffset: zip.length}}), 'bad-central-directory');
    expectCode(buildZip(ok, {eocd: {cdSize: cdSize + 1}}), 'bad-central-directory');
    expectCode(buildZip(ok, {beforeEocd: bytes(0, 0, 0, 0)}), 'bad-central-directory');
    // Declares more entries than the directory holds.
    expectCode(buildZip(ok, {eocd: {totalEntries: 2, diskEntries: 2}}), 'bad-central-directory');
    // Declares fewer entries: the rest of the directory is unexplained.
    expectCode(
      buildZip([...ok, {name: 'b', data: 'b'}], {eocd: {totalEntries: 1, diskEntries: 1}}),
      'bad-central-directory',
    );
  });

  it('rejects encrypted entries and unsupported flags', () => {
    expectCode(buildZip([{name: 'a', data: 'a', flags: 0x0001}]), 'encrypted');
    expectCode(buildZip([{name: 'a', data: 'a', flags: 0x0040}]), 'encrypted');
    expectCode(buildZip([{name: 'a', data: 'a', flags: 0x2000}]), 'encrypted');
    expectCode(
      buildZip([{name: 'a', data: 'a', cdExtra: extraField(0x9901, new Uint8Array(7))}]),
      'encrypted',
    );
    expectCode(buildZip([{name: 'a', data: 'a', flags: 0x0010}]), 'unsupported-flags');
    expectCode(buildZip([{name: 'a', data: 'a', flags: 0x0020}]), 'unsupported-flags');
  });

  it('rejects unsupported methods', () => {
    for (const method of [1, 9, 12, 14, 93, 99]) {
      expectCode(
        buildZip([{name: 'a', data: 'a', method, payload: bytes(1, 2, 3)}]),
        'unsupported-method',
      );
    }
  });

  it('rejects malformed and ambiguous extra fields', () => {
    expectCode(
      buildZip([{name: 'a', data: 'a', cdExtra: bytes(0x55, 0x54, 9)}]),
      'bad-extra-field',
    );
    expectCode(
      buildZip([{name: 'a', data: 'a', localExtra: concat([le(2, 0x5455), le(2, 9), bytes(1)])}]),
      'bad-extra-field',
    );
    const unicodePath = extraField(0x7075, concat([bytes(1), le(4, 0), utf8('evil.js')]));
    expectCode(buildZip([{name: 'a', data: 'a', cdExtra: unicodePath}]), 'bad-extra-field');
    expectCode(buildZip([{name: 'a', data: 'a', localExtra: unicodePath}]), 'bad-extra-field');
  });

  it('rejects directory entries with content', () => {
    expectCode(buildZip([{name: 'd/', data: 'x', method: 0}]), 'bad-directory-entry');
    expectCode(buildZip([{name: 'd/', data: '', method: 8}]), 'bad-directory-entry');
  });

  it('rejects stored entries whose sizes differ', () => {
    expectCode(
      buildZip([
        {
          name: 'a',
          data: 'abc',
          method: 0,
          cd: {uncompressedSize: 4},
          local: {uncompressedSize: 4},
        },
      ]),
      'bad-entry',
    );
  });

  it('rejects symlinks and other special files', () => {
    const symlink = (0o120777 << 16) >>> 0;
    expectCode(
      buildZip([{name: 'link', data: '/etc/passwd', method: 0, externalAttr: symlink}]),
      'unsupported-file-type',
    );
    expectCode(
      buildZip([{name: 'fifo', data: '', externalAttr: (0o010644 << 16) >>> 0}]),
      'unsupported-file-type',
    );
    // Directory mode on a name without trailing slash, and vice versa.
    expectCode(
      buildZip([{name: 'd', data: '', method: 0, externalAttr: (0o40755 << 16) >>> 0}]),
      'unsupported-file-type',
    );
    expectCode(
      buildZip([{name: 'd/', externalAttr: (0o100644 << 16) >>> 0}]),
      'unsupported-file-type',
    );
    expectCode(
      buildZip([{name: 'f', data: 'x', madeBy: 0x0014, externalAttr: 0x10}]),
      'unsupported-file-type',
    );
  });

  it('reads Unix file-type bits whatever the "made by" host', () => {
    // Info-ZIP restores symlinks from the mode bits for FAT, VMS, Atari, BeOS,
    // AtheOS, NTFS-with-mode and other hosts, not only Unix (3) and OS X (19).
    const symlink = (0o120777 << 16) >>> 0;
    for (const host of [0, 2, 5, 10, 11, 12, 13, 16, 17, 19, 30]) {
      expectCode(
        buildZip([
          {
            name: 'link',
            data: '/etc/hostname',
            method: 0,
            madeBy: (host << 8) | 30,
            externalAttr: symlink,
          },
        ]),
        'unsupported-file-type',
      );
    }
  });
});

describe('readZipDirectory: names', () => {
  const nameCase = (name: string, extra: Partial<Spec> = {}) =>
    buildZip([{name, data: name.endsWith('/') ? undefined : 'x', ...extra}]);

  it.each([
    ['', 'empty'],
    ['/abs.js', 'absolute'],
    ['/', 'root'],
    ['a//b', 'empty segment'],
    ['a//', 'empty segment in directory'],
    ['./a', 'dot'],
    ['a/./b', 'dot'],
    ['..', 'dot-dot'],
    ['../a', 'dot-dot'],
    ['a/../b', 'dot-dot'],
    ['a/..', 'dot-dot'],
    ['a\\b', 'backslash'],
    ['..\\a', 'backslash'],
    ['C:/a', 'drive letter'],
    ['c:a', 'drive letter'],
    ['a:b', 'colon'],
    ['a\u0000b', 'NUL'],
    ['a\nb', 'newline'],
    ['a\u007fb', 'DEL'],
    ['a\u0085b', 'C1 control'],
  ])('rejects %j (%s)', name => {
    expectCode(nameCase(name), 'bad-name');
  });

  it('rejects names that are not valid UTF-8 or not ASCII without the flag', () => {
    expectCode(nameCase('x', {rawName: bytes(0x61, 0xff), flags: 0x800}), 'bad-name');
    expectCode(nameCase('x', {rawName: bytes(0xc0, 0xaf), flags: 0x800}), 'bad-name'); // overlong '/'
    expectCode(nameCase('x', {rawName: bytes(0xed, 0xa0, 0x80), flags: 0x800}), 'bad-name'); // surrogate
    expectCode(nameCase('x', {rawName: bytes(0x61, 0xe9)}), 'bad-name'); // CP437/Latin-1 guess
  });

  it('keeps a leading BOM so the name round-trips exactly', async () => {
    const zip = nameCase('\ufeffa');
    const [entry] = readZipDirectory(zip);
    expect(entry!.name).toBe('\ufeffa');
    expect(new TextDecoder().decode(await readZipEntry(zip, entry!))).toBe('x');
  });

  it('rejects exact duplicates', () => {
    expectCode(
      buildZip([
        {name: 'a.js', data: '1'},
        {name: 'a.js', data: '2'},
      ]),
      'duplicate-name',
    );
    expectCode(buildZip([{name: 'd/'}, {name: 'd/'}]), 'duplicate-name');
  });

  it('rejects names that differ only by case or normalisation', () => {
    expectCode(
      buildZip([
        {name: 'App.js', data: '1'},
        {name: 'app.js', data: '2'},
      ]),
      'duplicate-name',
    );
    expectCode(buildZip([{name: 'D/'}, {name: 'd/'}]), 'duplicate-name');
    expectCode(
      buildZip([
        {name: 'caf\u00e9', data: '1'},
        {name: 'cafe\u0301', data: '2'},
      ]),
      'duplicate-name',
    );
    expectCode(
      buildZip([
        {name: 'stra\u00dfe', data: '1'},
        {name: 'STRASSE', data: '2'},
      ]),
      'duplicate-name',
    );
  });

  it('rejects paths that are both a file and a directory', () => {
    expectCode(buildZip([{name: 'a', data: '1'}, {name: 'a/'}]), 'path-conflict');
    expectCode(
      buildZip([
        {name: 'a', data: '1'},
        {name: 'a/b', data: '2'},
      ]),
      'path-conflict',
    );
    expectCode(
      buildZip([
        {name: 'x/y/z', data: '2'},
        {name: 'X/Y', data: '1'},
      ]),
      'path-conflict',
    );
  });
});

describe('readZipDirectory: local headers and layout', () => {
  it('rejects a missing or mismatching local header', () => {
    expectCode(
      buildZip([
        {name: 'a', data: 'a'},
        {name: 'b', data: 'b', cd: {localHeaderOffset: 1}},
      ]),
      'overlap',
    );
    expectCode(
      buildZip([{name: 'a.js', data: 'a', localRawName: utf8('b.js')}]),
      'local-header-mismatch',
    );
    expectCode(
      buildZip([{name: 'a.js', data: 'a', localRawName: utf8('a.jsx')}]),
      'local-header-mismatch',
    );
    expectCode(buildZip([{name: 'a', data: 'a', local: {method: 0}}]), 'local-header-mismatch');
    expectCode(buildZip([{name: 'a', data: 'a', local: {flags: 0x0002}}]), 'local-header-mismatch');
    expectCode(buildZip([{name: 'a', data: 'a', local: {crc: 1}}]), 'local-header-mismatch');
    expectCode(
      buildZip([{name: 'a', data: 'a', local: {compressedSize: 0}}]),
      'local-header-mismatch',
    );
    expectCode(
      buildZip([{name: 'a', data: 'a', local: {uncompressedSize: 5}}]),
      'local-header-mismatch',
    );
    expectCode(
      buildZip([{name: 'a', data: 'a', descriptor: 'signed', local: {crc: 7}}]),
      'local-header-mismatch',
    );
  });

  it('rejects data descriptors that disagree with the central directory', () => {
    const data = utf8('descriptor');
    const payload = new Uint8Array(deflateRawSync(data));
    const bad = concat([
      le(4, 0x08074b50),
      le(4, crc32(data) ^ 1),
      le(4, payload.length),
      le(4, data.length),
    ]);
    expectCode(
      buildZip([{name: 'a', data, descriptor: 'signed', descriptorBytes: bad}]),
      'bad-data-descriptor',
    );
    expectCode(
      buildZip([{name: 'a', data, descriptor: 'signed', descriptorBytes: new Uint8Array()}]),
      'bad-data-descriptor',
    );
  });

  it('rejects overlapping entries', () => {
    // Two central entries sharing one local record.
    const twice = buildZip([
      {name: 'a', data: 'x'},
      {name: 'b', data: 'x', cd: {localHeaderOffset: 0}},
    ]);
    expectCode(twice, 'overlap');
    // Entry a claims more data than it has, running into entry b's header.
    const data = utf8('aaaa');
    const longer = new Uint8Array(deflateRawSync(data)).length + 8;
    expectCode(
      buildZip([
        {name: 'a', data, cd: {compressedSize: longer}, local: {compressedSize: longer}},
        {name: 'b', data: 'b'},
      ]),
      'overlap',
    );
    // The last entry runs into the central directory.
    expectCode(
      buildZip([{name: 'a', data, cd: {compressedSize: longer}, local: {compressedSize: longer}}]),
      'overlap',
    );
  });

  it('rejects unaccounted bytes before, between and after entries', () => {
    expectCode(buildZip([{name: 'a', data: 'a'}], {prefix: utf8('MZ')}), 'gap');
    expectCode(
      buildZip([
        {name: 'a', data: 'a', gapAfter: bytes(0)},
        {name: 'b', data: 'b'},
      ]),
      'gap',
    );
    expectCode(buildZip([{name: 'a', data: 'a', gapAfter: utf8('hidden')}]), 'gap');
    // A hidden local record between two listed entries.
    const hidden = buildZip([{name: 'hidden.js', data: 'evil()'}]);
    const hiddenRecord = hidden.subarray(0, readU32(hidden, hidden.length - 6));
    expectCode(
      buildZip([
        {name: 'a', data: 'a', gapAfter: hiddenRecord},
        {name: 'b', data: 'b'},
      ]),
      'gap',
    );
  });

  it('requires the local records in central-directory order', () => {
    const ab = buildZip([
      {name: 'a', data: 'a'},
      {name: 'b', data: 'b'},
    ]);
    const cdOffset = readU32(ab, ab.length - 6);
    const cdSize = readU32(ab, ab.length - 10);
    const cd = ab.subarray(cdOffset, cdOffset + cdSize);
    // The two central entries have equal lengths: swap them, so b is listed first.
    const half = cdSize / 2;
    const swapped = concat([
      ab.subarray(0, cdOffset),
      cd.subarray(half),
      cd.subarray(0, half),
      ab.subarray(cdOffset + cdSize),
    ]);
    expect(readZipDirectory(ab).map(e => e.name)).toEqual(['a', 'b']);
    expectCode(swapped, 'gap');
  });

  it('enforces limits before inflating', () => {
    const zip = buildZip([
      {name: 'a', data: 'x'.repeat(1000)},
      {name: 'b', data: 'y'.repeat(1000)},
    ]);
    expect(
      readZipDirectory(zip, {maxEntries: 2, maxEntrySize: 1000, maxTotalSize: 2000}),
    ).toHaveLength(2);
    expectCode(zip, 'limit-exceeded', {maxEntries: 1});
    expectCode(zip, 'limit-exceeded', {maxEntrySize: 999});
    expectCode(zip, 'limit-exceeded', {maxTotalSize: 1999});
  });

  it('applies the default limits', () => {
    const huge = 256 * 1024 * 1024 + 1;
    expectCode(
      buildZip([
        {name: 'a', data: 'a', method: 0, cd: {compressedSize: huge, uncompressedSize: huge}},
      ]),
      'limit-exceeded',
    );
  });
});

describe('readZipEntry: content checks', () => {
  it('rejects a CRC mismatch', async () => {
    for (const method of [0, 8]) {
      const zip = buildZip([{name: 'a', data: 'abc', method, cd: {crc: 1}, local: {crc: 1}}]);
      await expectEntryCode(zip, readZipDirectory(zip)[0]!, 'crc-mismatch');
    }
  });

  it('rejects deflate data that inflates to a different size', async () => {
    const data = utf8('0123456789'.repeat(50));
    for (const declared of [data.length - 1, data.length + 1, 0]) {
      const zip = buildZip([
        {name: 'a', data, cd: {uncompressedSize: declared}, local: {uncompressedSize: declared}},
      ]);
      await expectEntryCode(zip, readZipDirectory(zip)[0]!, 'size-mismatch');
    }
  });

  it('stops inflating a decompression bomb at the declared size', async () => {
    const bomb = new Uint8Array(32 * 1024 * 1024); // inflates ~1000x
    const zip = buildZip([
      {name: 'a', data: bomb, cd: {uncompressedSize: 100}, local: {uncompressedSize: 100}},
    ]);
    await expectEntryCode(zip, readZipDirectory(zip)[0]!, 'size-mismatch');
  });

  it('rejects corrupt, truncated and empty deflate data', async () => {
    const data = utf8('hello hello hello hello');
    const payload = new Uint8Array(deflateRawSync(data));
    const variants = [
      bytes(0xff, 0xff, 0xff),
      payload.subarray(0, payload.length - 1),
      new Uint8Array(),
    ];
    for (const bad of variants) {
      const zip = buildZip([{name: 'a', data, payload: bad}]);
      await expectEntryCode(zip, readZipDirectory(zip)[0]!, 'bad-deflate');
    }
  });

  it('rejects trailing data after the deflate stream', async () => {
    const data = utf8('hello hello hello hello');
    const payload = new Uint8Array(deflateRawSync(data));
    for (const junk of [bytes(0), bytes(1, 2, 3), payload]) {
      const zip = buildZip([{name: 'a', data, payload: concat([payload, junk])}]);
      await expectEntryCode(zip, readZipDirectory(zip)[0]!, 'bad-deflate');
    }
  });

  it('accepts every valid deflate stream regardless of where it ends', async () => {
    // Guards the trailing-data fallback against false positives.
    for (let n = 0; n < 200; n += 7) {
      const data = pseudoRandom(n, n + 1);
      for (const level of [0, 1, 9]) {
        const payload = new Uint8Array(deflateRawSync(data, {level}));
        const zip = buildZip([{name: 'a', data, payload}]);
        expect(await readZipEntry(zip, readZipDirectory(zip)[0]!)).toEqual(data);
      }
    }
  });

  it('refuses an entry whose data lies outside the archive', async () => {
    const zip = buildZip([{name: 'a.js', data: 'a'}]);
    const [a] = readZipDirectory(zip);
    await expectEntryCode(zip, {...a!, dataStart: zip.length}, 'truncated');
    await expectEntryCode(zip, {...a!, dataStart: -1}, 'truncated');
  });
});

describe('iterateZipFiles', () => {
  it('requires every entry to be under stripPrefix', async () => {
    const zip = buildZip([
      {name: 'build/a', data: 'a'},
      {name: 'other/b', data: 'b'},
    ]);
    await expect(collect(zip, {stripPrefix: 'build/'})).rejects.toMatchObject({
      code: 'prefix-mismatch',
    });
    const dirOutside = buildZip([{name: 'build/a', data: 'a'}, {name: 'other/'}]);
    await expect(collect(dirOutside, {stripPrefix: 'build/'})).rejects.toMatchObject({
      code: 'prefix-mismatch',
    });
    const caseDiffers = buildZip([{name: 'Build/a', data: 'a'}]);
    await expect(collect(caseDiffers, {stripPrefix: 'build/'})).rejects.toMatchObject({
      code: 'prefix-mismatch',
    });
  });

  it('allows ancestor directories of a nested prefix', async () => {
    const zip = buildZip([{name: 'a/'}, {name: 'a/b/'}, {name: 'a/b/c.txt', data: 'c'}]);
    expect([...(await collect(zip, {stripPrefix: 'a/b/'})).entries()]).toEqual([['/c.txt', 'c']]);
  });

  it('validates stripPrefix', async () => {
    const zip = buildZip([{name: 'build/a', data: 'a'}]);
    for (const stripPrefix of ['build', '/build/', '../', 'a//', 'build\\']) {
      await expect(collect(zip, {stripPrefix})).rejects.toThrow(TypeError);
    }
  });

  it('passes limits through and yields nothing from an invalid archive', async () => {
    const zip = buildZip([
      {name: 'a', data: 'a'},
      {name: 'b', data: 'b'},
    ]);
    await expect(collect(zip, {limits: {maxEntries: 1}})).rejects.toMatchObject({
      code: 'limit-exceeded',
    });
    const seen: string[] = [];
    const broken = buildZip([
      {name: 'a', data: 'a'},
      {name: 'a', data: 'b'},
    ]);
    await expect(
      (async () => {
        for await (const file of iterateZipFiles(broken)) seen.push(file.path);
      })(),
    ).rejects.toMatchObject({code: 'duplicate-name'});
    expect(seen).toEqual([]);
  });
});

function readU32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, true);
}
