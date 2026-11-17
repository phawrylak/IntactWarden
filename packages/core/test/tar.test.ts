import {createGzip, deflateRawSync, gzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {crc32} from '../src/archive/crc32.ts';
import {
  DEFAULT_TAR_LIMITS,
  iterateTar,
  iterateTarGzFiles,
  TarError,
  type TarIterateOptions,
} from '../src/archive/tar.ts';
import {utf8} from '../src/hash/sha256.ts';
import {concat, octal, tarHeader, toBytes, writeTar, type TarSpec} from './helpers/tarWriter.ts';

const decoder = new TextDecoder();

/** `tar` as chunks of `size` bytes (one chunk by default). */
async function* chunksOf(tar: Uint8Array, size = tar.length || 1): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < tar.length; at += size) yield tar.subarray(at, at + size);
}

/** Every file of a plain tar, path → text; rejects as the reader does. */
async function files(
  tar: Uint8Array,
  opts: TarIterateOptions = {},
  chunk?: number,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const f of iterateTar(chunksOf(tar, chunk), tar.length, opts)) {
    out[f.path] = decoder.decode(f.bytes);
  }
  return out;
}

async function expectCode(tar: Uint8Array, code: string, limits = {}): Promise<void> {
  const error: unknown = await files(tar, {limits}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(TarError);
  expect((error as TarError).code).toBe(code);
}

/** The release layout of bw_web_v<tag>.tar.gz in miniature (GNU format). */
const RELEASE: TarSpec[] = [
  {name: 'web-vault/'},
  {name: 'web-vault/index.html', data: '<!doctype html>'},
  {name: 'web-vault/app/'},
  {name: 'web-vault/app/main.0123456789abcdef0123.js', data: 'console.log(1)'},
  {name: 'web-vault/.nojekyll'},
  {name: 'web-vault/images/'},
  {name: 'web-vault/images/icon.png', data: new Uint8Array(1300).fill(7)},
];
const RELEASE_FILES = {
  '/index.html': '<!doctype html>',
  '/app/main.0123456789abcdef0123.js': 'console.log(1)',
  '/.nojekyll': '',
  '/images/icon.png': decoder.decode(new Uint8Array(1300).fill(7)),
};

describe('iterateTar: valid archives', () => {
  it('yields the files of a GNU archive in order, with the root stripped', async () => {
    const tar = writeTar(RELEASE, {recordSize: 10240});
    expect(await files(tar, {stripPrefix: 'web-vault/'})).toEqual(RELEASE_FILES);
    const all = await files(tar);
    expect(Object.keys(all)).toEqual([
      '/web-vault/index.html',
      '/web-vault/app/main.0123456789abcdef0123.js',
      '/web-vault/.nojekyll',
      '/web-vault/images/icon.png',
    ]);
  });

  it('reads the same files whatever the chunking', async () => {
    const tar = writeTar(RELEASE);
    for (const chunk of [1, 7, 100, 511, 512, 513, 1024, 65536]) {
      expect(await files(tar, {stripPrefix: 'web-vault/'}, chunk), `chunk ${chunk}`).toEqual(
        RELEASE_FILES,
      );
    }
  });

  it('accepts an empty archive, extra zero blocks and a subarray view', async () => {
    expect(await files(writeTar([]))).toEqual({});
    expect(Object.keys(await files(writeTar(RELEASE, {endBlocks: 7})))).toHaveLength(4);
    const tar = writeTar(RELEASE);
    const framed = concat([new Uint8Array(512).fill(9), tar]);
    expect(await files(framed.subarray(512))).toEqual(await files(tar));
  });

  it('accepts GNU long names before files and directories', async () => {
    const dir = 'web-vault/' + 'd'.repeat(95) + '/';
    const file = dir + 'f'.repeat(30) + '.js';
    const tar = writeTar([{name: 'web-vault/'}, {name: dir}, {name: file, data: 'long'}]);
    expect(await files(tar, {stripPrefix: 'web-vault/'})).toEqual({
      ['/' + file.slice(10)]: 'long',
    });
  });

  it('applies the default limits', () => {
    expect(DEFAULT_TAR_LIMITS).toEqual({
      maxEntries: 20_000,
      maxEntrySize: 256 * 1024 * 1024,
      maxTotalSize: 1024 * 1024 * 1024,
    });
  });
});

describe('iterateTar: framing', () => {
  it('requires whole blocks and an end-of-archive marker', async () => {
    const tar = writeTar(RELEASE);
    await expectCode(tar.subarray(0, tar.length - 1), 'truncated');
    await expectCode(writeTar(RELEASE, {endBlocks: 0}), 'truncated');
    await expectCode(writeTar(RELEASE, {endBlocks: 1}), 'bad-end-of-archive');
    await expectCode(new Uint8Array(512), 'bad-end-of-archive');
  });

  it('rejects anything after the end-of-archive marker', async () => {
    const second = writeTar([{name: 'evil.js', data: 'alert(1)'}]);
    await expectCode(writeTar(RELEASE, {trailer: second}), 'bad-end-of-archive');
    const tail = new Uint8Array(512);
    tail[511] = 1;
    await expectCode(writeTar(RELEASE, {trailer: tail}), 'bad-end-of-archive');
  });

  it('rejects truncated data and non-zero padding', async () => {
    const tar = writeTar([{name: 'a.js', data: 'x'.repeat(600)}], {endBlocks: 0});
    await expectCode(tar.subarray(0, 1024), 'truncated');
    await expectCode(
      writeTar([{name: 'a.js', data: 'abc', padding: utf8('hidden')}]),
      'bad-padding',
    );
  });

  it('refuses input that disagrees with the declared length', async () => {
    const tar = writeTar(RELEASE);
    const longer = (async function* () {
      yield tar;
      yield new Uint8Array(512);
    })();
    await expect(
      (async () => {
        for await (const f of iterateTar(longer, tar.length)) void f;
      })(),
    ).rejects.toMatchObject({code: 'bad-end-of-archive'});
    await expect(
      (async () => {
        for await (const f of iterateTar(chunksOf(tar.subarray(0, 1024)), tar.length)) void f;
      })(),
    ).rejects.toMatchObject({code: 'truncated'});
    await expect(
      (async () => {
        for await (const f of iterateTar(chunksOf(tar), -1)) void f;
      })(),
    ).rejects.toThrow(TypeError);
  });
});

describe('iterateTar: headers', () => {
  it('rejects a bad checksum', async () => {
    await expectCode(writeTar([{name: 'a', data: 'x', checksum: 1}]), 'bad-checksum');
    const tar = writeTar([{name: 'a', data: 'x'}]);
    tar[0] = tar[0]! ^ 0x01;
    await expectCode(tar, 'bad-checksum');
  });

  it('accepts only the GNU magic', async () => {
    await expectCode(
      writeTar([{name: 'a', patch: [[257, new Uint8Array(8)]]}]),
      'unsupported-format',
    );
    // POSIX ustar ("ustar\0" "00"), as bsdtar, Go and Python write it.
    await expectCode(writeTar([{name: 'a', patch: [[257, 'ustar\x0000']]}]), 'unsupported-format');
    await expectCode(writeTar([{name: 'a', patch: [[257, 'ustar\0  ']]}]), 'unsupported-format');
    await expectCode(writeTar([{name: 'a', patch: [[257, 'ustar \0\0']]}]), 'unsupported-format');
  });

  it('rejects every entry type except files, directories and GNU long names', async () => {
    for (const typeflag of [
      '1',
      '2',
      '3',
      '4',
      '6',
      '7',
      'x',
      'g',
      'K',
      'S',
      'M',
      'N',
      'V',
      '\0',
    ]) {
      await expectCode(writeTar([{name: 'a', typeflag}]), 'unsupported-entry-type');
    }
  });

  it('rejects link names', async () => {
    await expectCode(writeTar([{name: 'a', linkname: '/etc/passwd'}]), 'bad-link');
  });

  it('parses numeric fields strictly', async () => {
    const size = (field: string): Uint8Array => writeTar([{name: 'a', patch: [[124, field]]}]);
    await expectCode(size(' 0000000000\0'), 'bad-number'); // leading space
    await expectCode(size('0000000000x\0'), 'bad-number');
    await expectCode(size('00000000009\0'), 'bad-number');
    await expectCode(size('00000\x00' + '000000'), 'bad-number'); // digits after the terminator
    await expectCode(size('\0\0\0\0\0\0\0\0\0\0\0\0'), 'bad-number'); // empty
    await expectCode(size('\x80\0\0\0\0\0\0\0\0\0\0\x01'), 'bad-number'); // base-256
    await expectCode(size('-0000000001\0'), 'bad-number');
    // Digits filling the whole field, or NUL and space terminators, are fine.
    expect(await files(writeTar([{name: 'a', patch: [[124, '000000000000']]}]))).toEqual({
      '/a': '',
    });
    expect(await files(writeTar([{name: 'a', patch: [[124, '0000000000 \0']]}]))).toEqual({
      '/a': '',
    });
    await expectCode(writeTar([{name: 'a', patch: [[100, '07x7\0\0\0\0']]}]), 'bad-number'); // mode
    await expectCode(writeTar([{name: 'a', patch: [[136, 'yesterday\0\0\0']]}]), 'bad-number'); // mtime
  });

  it('requires zero device numbers', async () => {
    await expectCode(writeTar([{name: 'a', patch: [[329, octal(8, 8)]]}]), 'bad-header');
    await expectCode(writeTar([{name: 'a', patch: [[337, octal(1, 8)]]}]), 'bad-header');
    await expectCode(writeTar([{name: 'a', patch: [[329, 'zz\0']]}]), 'bad-number');
  });

  it('requires NUL-padded text fields', async () => {
    await expectCode(writeTar([{name: 'a', patch: [[2, 'b']]}]), 'bad-header');
    await expectCode(writeTar([{name: 'a', patch: [[270, 'x']]}]), 'bad-header'); // uname
  });

  it('rejects a prefix and GNU extension data', async () => {
    await expectCode(writeTar([{name: 'a', patch: [[345, 'web-vault']]}]), 'bad-header'); // prefix
    await expectCode(writeTar([{name: 'a', patch: [[345, octal(1, 12)]]}]), 'bad-header'); // atime
    await expectCode(writeTar([{name: 'a', patch: [[482, '\x01']]}]), 'bad-header'); // isextended
    await expectCode(writeTar([{name: 'a', patch: [[505, '\x01']]}]), 'bad-header');
  });
});

describe('iterateTar: names and entries', () => {
  it('rejects unsafe names', async () => {
    const bad = [
      '/etc/passwd',
      '../x',
      'a/../b',
      'a//b',
      './a',
      'a/./b',
      'a\\b',
      'a\u0001b',
      'c:x',
    ];
    for (const name of bad) await expectCode(writeTar([{name, data: 'x'}]), 'bad-name');
    await expectCode(writeTar([{name: 'a', patch: [[0, new Uint8Array(100)]]}]), 'bad-name'); // empty
    await expectCode(writeTar([{name: 'a', patch: [[0, Uint8Array.of(0xc0, 0xae)]]}]), 'bad-name');
    await expectCode(writeTar([{name: '/abs/'}]), 'bad-name');
  });

  it('requires "/" exactly on directory names and empty directories', async () => {
    await expectCode(writeTar([{name: 'dir', typeflag: '5'}]), 'bad-directory-entry');
    await expectCode(writeTar([{name: 'file/', typeflag: '0'}]), 'bad-name');
    await expectCode(writeTar([{name: 'dir/', data: 'content'}]), 'bad-directory-entry');
  });

  it('rejects duplicates, also after case folding and NFC normalisation', async () => {
    await expectCode(
      writeTar([
        {name: 'a.js', data: '1'},
        {name: 'a.js', data: '2'},
      ]),
      'duplicate-name',
    );
    await expectCode(writeTar([{name: 'App.js'}, {name: 'app.JS'}]), 'duplicate-name');
    await expectCode(writeTar([{name: 'café'}, {name: 'café'}]), 'duplicate-name');
    await expectCode(writeTar([{name: 'd/'}, {name: 'D/'}]), 'duplicate-name');
  });

  it('rejects paths that are both a file and a directory', async () => {
    await expectCode(writeTar([{name: 'a'}, {name: 'a/'}]), 'path-conflict');
    await expectCode(writeTar([{name: 'a'}, {name: 'a/b'}]), 'path-conflict');
    await expectCode(writeTar([{name: 'A/b'}, {name: 'a'}]), 'path-conflict');
  });

  it('enforces limits before reading data', async () => {
    const tar = writeTar([
      {name: 'a', data: 'xx'},
      {name: 'b', data: 'yy'},
    ]);
    await expectCode(tar, 'limit-exceeded', {maxEntries: 1});
    await expectCode(tar, 'limit-exceeded', {maxEntrySize: 1});
    await expectCode(tar, 'limit-exceeded', {maxTotalSize: 3});
    expect(await files(tar, {limits: {maxEntries: 2, maxEntrySize: 2, maxTotalSize: 4}})).toEqual({
      '/a': 'xx',
      '/b': 'yy',
    });
    // A declared size beyond the input is truncated, whatever the limits.
    await expectCode(writeTar([{name: 'a', patch: [[124, octal(2 ** 32, 12)]]}]), 'truncated', {
      maxEntrySize: 2 ** 40,
      maxTotalSize: 2 ** 40,
    });
  });
});

describe('iterateTar: GNU long names', () => {
  const long = 'web-vault/' + 'x'.repeat(120) + '.js';
  const nameBytes = utf8(long);
  /** A GNU 'L' header + payload, written by hand. */
  const longLink = (payload: Uint8Array, specOverrides: Partial<TarSpec> = {}): Uint8Array =>
    writeTar([{name: '././@LongLink', typeflag: 'L', data: payload, ...specOverrides}], {
      endBlocks: 0,
    });
  const entry = (name = long, extra: Partial<TarSpec> = {}): Uint8Array =>
    writeTar([{name, data: 'x', noLongName: true, ...extra}]);
  const nul = Uint8Array.of(0);

  it('accepts a well-formed long name', async () => {
    const tar = concat([longLink(concat([nameBytes, nul])), entry()]);
    expect(await files(tar)).toEqual({['/' + long]: 'x'});
  });

  it('rejects malformed long names', async () => {
    await expectCode(concat([longLink(concat([nameBytes, nul])), writeTar([])]), 'bad-long-name');
    await expectCode(
      concat([longLink(concat([nameBytes, nul])), longLink(concat([nameBytes, nul])), entry()]),
      'bad-long-name',
    );
    await expectCode(concat([longLink(nameBytes), entry()]), 'bad-long-name'); // no NUL
    await expectCode(
      concat([longLink(concat([nameBytes.subarray(0, 50), nul, nameBytes, nul])), entry()]),
      'bad-long-name',
    );
    await expectCode(concat([longLink(utf8('short.js\0')), entry('short.js')]), 'bad-long-name');
    await expectCode(
      concat([longLink(concat([nameBytes, nul]), {name: 'LongLink'}), entry()]),
      'bad-long-name',
    );
    await expectCode(
      concat([longLink(concat([new Uint8Array(5000).fill(0x61), nul])), entry()]),
      'bad-long-name',
    );
  });

  it("requires the entry's name field to start the long name", async () => {
    await expectCode(
      concat([longLink(concat([nameBytes, nul])), entry('web-vault/other.js')]),
      'bad-long-name',
    );
  });

  it('checks the long name like any other name', async () => {
    const evil = '../' + 'x'.repeat(120);
    await expectCode(writeTar([{name: evil, data: 'x'}]), 'bad-name');
  });
});

describe('iterateTar: prefix and consumers', () => {
  it('requires every entry to be under stripPrefix', async () => {
    const outside = writeTar([
      {name: 'web-vault/a', data: 'a'},
      {name: 'other/b', data: 'b'},
    ]);
    await expect(files(outside, {stripPrefix: 'web-vault/'})).rejects.toMatchObject({
      code: 'prefix-mismatch',
    });
    const caseDiffers = writeTar([{name: 'Web-vault/a', data: 'a'}]);
    await expect(files(caseDiffers, {stripPrefix: 'web-vault/'})).rejects.toMatchObject({
      code: 'prefix-mismatch',
    });
    const nested = writeTar([{name: 'a/'}, {name: 'a/b/'}, {name: 'a/b/c.txt', data: 'c'}]);
    expect(await files(nested, {stripPrefix: 'a/b/'})).toEqual({'/c.txt': 'c'});
  });

  it('validates stripPrefix', async () => {
    const tar = writeTar(RELEASE);
    for (const stripPrefix of ['web-vault', '/web-vault/', '../', 'a//', 'web\\']) {
      await expect(files(tar, {stripPrefix})).rejects.toThrow(TypeError);
    }
  });

  it('never yields a file after an error, and stops the source after an error or a break', async () => {
    const t = writeTar([
      {name: 'web-vault/a', data: 'a'},
      {name: 'web-vault/b', data: 'b', checksum: 3},
      {name: 'web-vault/c', data: 'c'},
    ]);
    /** Chunks of 64 bytes that count what was pulled and whether the source was stopped. */
    const counted = (tar: Uint8Array) => {
      const stats = {pulled: 0, stopped: false};
      const source = (async function* () {
        try {
          for (let at = 0; at < tar.length; at += 64) {
            stats.pulled += 64;
            yield tar.subarray(at, at + 64);
          }
        } finally {
          stats.stopped = stats.pulled < tar.length;
        }
      })();
      return {source, stats};
    };
    const seen: string[] = [];
    const bad = counted(t);
    await expect(
      (async () => {
        for await (const f of iterateTar(bad.source, t.length, {stripPrefix: 'web-vault/'}))
          seen.push(f.path);
      })(),
    ).rejects.toMatchObject({code: 'bad-checksum'});
    expect(seen).toEqual(['/a']);
    expect(bad.stats.stopped).toBe(true);

    const big = writeTar(
      Array.from({length: 50}, (_, i) => ({name: `web-vault/f${i}`, data: 'z'.repeat(5000)})),
    );
    const broken = counted(big);
    for await (const f of iterateTar(broken.source, big.length, {stripPrefix: 'web-vault/'})) {
      expect(f.path).toBe('/f0');
      break;
    }
    expect(broken.stats.stopped).toBe(true);
  });

  it('a file may come before a later name conflict, which still fails the archive', async () => {
    const seen: string[] = [];
    const broken = writeTar([
      {name: 'a', data: 'a'},
      {name: 'a', data: 'b'},
    ]);
    await expect(
      (async () => {
        for await (const f of iterateTar(chunksOf(broken), broken.length)) seen.push(f.path);
      })(),
    ).rejects.toMatchObject({code: 'duplicate-name'});
    // The names are checked at the end of the archive (module comment: discard on a throw).
    expect(seen).toEqual(['/a', '/a']);
  });

  it('agrees with itself whatever the chunking on single-byte mutations', async () => {
    const sample = writeTar([
      {name: 'web-vault/'},
      {name: 'web-vault/index.html', data: '<html>hello</html>'},
      {name: 'web-vault/' + 'd'.repeat(120) + '/file.js', data: 'long'},
      {name: 'web-vault/empty.txt', data: ''},
    ]);
    const outcome = async (tar: Uint8Array, chunk?: number): Promise<string> =>
      files(tar, {stripPrefix: 'web-vault/'}, chunk).then(
        r => JSON.stringify(r),
        (e: unknown) => `${(e as Error).name}:${(e as TarError).code ?? (e as Error).message}`,
      );
    let rejected = 0;
    for (let i = 0; i < sample.length; i += i % 512 < 345 ? 1 : 13) {
      for (const v of [0x00, 0xff, 0x30]) {
        if (sample[i] === v) continue;
        const m = sample.slice();
        m[i] = v;
        const whole = await outcome(m);
        if (whole.startsWith('TarError')) rejected++;
        expect(await outcome(m, 509), `byte ${i} = ${v}`).toBe(whole);
      }
    }
    expect(rejected).toBeGreaterThan(500);
  }, 120_000);
});

describe('iterateTarGzFiles', () => {
  const gz = (tar: Uint8Array): Uint8Array => new Uint8Array(gzipSync(tar));
  const all = async (input: Uint8Array, opts: TarIterateOptions = {}): Promise<string[]> => {
    const out: string[] = [];
    for await (const f of iterateTarGzFiles(input, opts)) out.push(f.path);
    return out;
  };

  it('gunzips and iterates a .tar.gz', async () => {
    const member = gz(writeTar(RELEASE, {recordSize: 10240}));
    const out: Record<string, number> = {};
    for await (const f of iterateTarGzFiles(member, {stripPrefix: 'web-vault/'})) {
      out[f.path] = f.bytes.length;
    }
    expect(out).toEqual({
      '/index.html': 15,
      '/app/main.0123456789abcdef0123.js': 14,
      '/.nojekyll': 0,
      '/images/icon.png': 1300,
    });
    await expect(all(member, {stripPrefix: 'x'})).rejects.toThrow(TypeError);
  });

  const tar = writeTar([
    {name: 'web-vault/'},
    {name: 'web-vault/a.js', data: 'a'.repeat(1000)},
    {name: 'web-vault/b.js', data: 'b'},
  ]);
  const member = gz(tar);

  it('refuses a second member and trailing garbage', async () => {
    // The trailer is read from the end: the first error found (gzip, or tar framing from a
    // nonsense ISIZE) is reported; nothing is accepted.
    for (const extra of [member, Uint8Array.of(0), utf8('garbage')]) {
      await expect(all(concat([member, extra]))).rejects.toMatchObject({
        name: expect.stringMatching(/^(Gzip|Tar)Error$/) as string,
      });
    }
  });

  it('refuses a wrong ISIZE or CRC and a deflate stream that ends early', async () => {
    const isize = member.slice();
    new DataView(isize.buffer).setUint32(isize.length - 4, tar.length + 512, true);
    await expect(all(isize)).rejects.toMatchObject({name: 'GzipError', code: 'size-mismatch'});
    const crc = member.slice();
    crc[crc.length - 8] = crc[crc.length - 8]! ^ 0xff;
    await expect(all(crc)).rejects.toMatchObject({name: 'GzipError', code: 'crc-mismatch'});
    // The deflate data without its last bytes, the trailer kept.
    const deflate = new Uint8Array(deflateRawSync(tar));
    const early = concat([
      member.subarray(0, 10),
      deflate.subarray(0, deflate.length - 3),
      member.subarray(member.length - 8),
    ]);
    await expect(all(early)).rejects.toBeInstanceOf(Error);
  });

  it('runs the gzip checks after the last tar block (the tar itself is valid)', async () => {
    const view = member.slice();
    const data = new DataView(view.buffer);
    const crcAt = view.length - 8;
    data.setUint32(crcAt, (crc32(tar) ^ 1) >>> 0, true);
    await expect(all(view, {stripPrefix: 'web-vault/'})).rejects.toMatchObject({
      code: 'crc-mismatch',
    });
  });

  it('refuses a missing end-of-archive marker and a header error inside the stream', async () => {
    const noEnd = writeTar([{name: 'web-vault/a', data: 'a'}], {endBlocks: 0});
    await expect(all(gz(noEnd))).rejects.toMatchObject({code: 'truncated'});
    const bad = writeTar([
      {name: 'web-vault/a.js', data: 'a'.repeat(1000)},
      {name: 'web-vault/' + 'n'.repeat(80), data: 'b', checksum: 7},
    ]);
    await expect(all(gz(bad))).rejects.toMatchObject({code: 'bad-checksum'});
  });

  it('reads a 300 MiB tar.gz of zeros without a buffer of its size', async () => {
    // 300 files of 1 MiB of zeros, compressed on the fly (the tar itself is never built).
    const FILES = 300;
    const SIZE = 1024 * 1024;
    const z = createGzip({level: 1});
    const out: Buffer[] = [];
    z.on('data', (b: Buffer) => out.push(b));
    const done = new Promise<void>(resolve => z.on('end', resolve));
    const zeros = new Uint8Array(SIZE);
    for (let i = 0; i < FILES; i++) {
      const name = `web-vault/f${String(i).padStart(3, '0')}.bin`;
      z.write(tarHeader({name}, toBytes(name), SIZE));
      z.write(zeros);
    }
    z.write(new Uint8Array(1024));
    z.end();
    await done;
    const big = new Uint8Array(Buffer.concat(out));
    expect(big.length).toBeLessThan(2 * 1024 * 1024);

    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    let count = 0;
    let largest = 0;
    for await (const f of iterateTarGzFiles(big, {stripPrefix: 'web-vault/'})) {
      count++;
      largest = Math.max(largest, f.bytes.length);
      if (count % 10 === 0) peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }
    expect(count).toBe(FILES);
    expect(largest).toBe(SIZE);
    // A whole-buffer reader would hold the 300 MiB tar; the streaming reader holds one file at a
    // time (plus garbage the collector has not reclaimed yet).
    expect(peak - before).toBeLessThan(150 * 1024 * 1024);
  }, 60_000);
});
