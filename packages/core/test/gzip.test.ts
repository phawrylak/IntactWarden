import {deflateRawSync, gzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {crc32} from '../src/archive/crc32.ts';
import {
  DEFAULT_GZIP_LIMITS,
  GzipError,
  inflateGzip,
  readGzipMember,
  type GzipLimits,
} from '../src/archive/gzip.ts';
import {platformRejectsTrailingData} from '../src/archive/inflate.ts';
import {utf8} from '../src/hash/sha256.ts';

// Where DecompressionStream itself rejects data after the deflate stream (Firefox, Node 24),
// reading fails with bad-deflate before the reader's own checks run (Node 22). Both refuse the input.
const platformRejects = await platformRejectsTrailingData();
const orBadDeflate = (code: string): string => (platformRejects ? 'bad-deflate' : code);

const gz = (data: Uint8Array | string, level = 6): Uint8Array =>
  new Uint8Array(gzipSync(typeof data === 'string' ? utf8(data) : data, {level}));

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A gzip member assembled by hand: header, raw deflate data, trailer. */
function member(
  deflate: Uint8Array,
  trailer: {crc: number; isize: number},
  header: Partial<{flags: number; method: number; mtime: number; os: number}> = {},
): Uint8Array {
  return concat([
    Uint8Array.of(0x1f, 0x8b, header.method ?? 8, header.flags ?? 0),
    le32(header.mtime ?? 0),
    Uint8Array.of(0, header.os ?? 3),
    deflate,
    le32(trailer.crc),
    le32(trailer.isize),
  ]);
}

function pseudoRandom(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** The whole output of a single-member gzip file, through the streaming reader. */
async function gunzip(input: Uint8Array, limits: GzipLimits = {}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of inflateGzip(readGzipMember(input, limits))) parts.push(chunk);
  return concat(parts);
}

async function expectCode(input: Uint8Array, code: string, limits = {}): Promise<void> {
  await expect(gunzip(input, limits)).rejects.toMatchObject({name: 'GzipError', code});
}

describe('gunzip: valid input', () => {
  it('round-trips zlib output', async () => {
    const data = utf8('hello gzip '.repeat(1000));
    expect(await gunzip(gz(data))).toEqual(data);
    expect(await gunzip(gz(''))).toEqual(new Uint8Array());
  });

  it('accepts every valid deflate stream regardless of where it ends', async () => {
    for (let n = 0; n < 300; n += 13) {
      const data = pseudoRandom(n, n + 7);
      for (const level of [0, 1, 9]) expect(await gunzip(gz(data, level))).toEqual(data);
    }
  });

  it('reads the trailer and accepts a subarray view', async () => {
    const data = utf8('abc');
    const bytes = member(
      new Uint8Array(deflateRawSync(data)),
      {crc: crc32(data), isize: 3},
      {
        mtime: 1_762_012_973,
        os: 255,
      },
    );
    const m = readGzipMember(bytes);
    expect(m).toMatchObject({crc32: crc32(data), isize: 3});
    const framed = concat([utf8('xx'), bytes, utf8('yy')]);
    expect(await gunzip(framed.subarray(2, 2 + bytes.length))).toEqual(data);
  });

  it('applies a 1 GiB default output limit', () => {
    expect(DEFAULT_GZIP_LIMITS.maxOutputSize).toBe(1024 * 1024 * 1024);
  });
});

describe('gunzip: header and framing', () => {
  it('rejects input that is not gzip or too short', async () => {
    await expectCode(utf8('PK\x03\x04'), 'not-gzip');
    await expectCode(new Uint8Array(), 'not-gzip');
    await expectCode(Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0), 'truncated');
    await expectCode(gz('abc').subarray(0, 17), 'truncated');
  });

  it('rejects methods other than deflate', async () => {
    const bytes = gz('abc');
    bytes[2] = 7;
    await expectCode(bytes, 'unsupported-method');
  });

  it('rejects every header flag', async () => {
    for (const flag of [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]) {
      const bytes = gz('abc');
      bytes[3] = flag;
      await expectCode(bytes, 'unsupported-flags');
    }
  });

  it('rejects a second member (multi-member gzip)', async () => {
    // Equal lengths, so the first member alone matches the last trailer's ISIZE.
    await expectCode(concat([gz('first!'), gz('second')]), orBadDeflate('trailing-data'));
    await expectCode(
      concat([gz('first!'), gz('a much longer second member')]),
      orBadDeflate('size-mismatch'),
    );
  });

  it('rejects data after the deflate stream, even with a matching trailer', async () => {
    const data = utf8('hello hello hello');
    const deflate = new Uint8Array(deflateRawSync(data));
    for (const junk of [Uint8Array.of(0), utf8('xyz'), deflate]) {
      await expectCode(
        member(concat([deflate, junk]), {crc: crc32(data), isize: data.length}),
        orBadDeflate('trailing-data'),
      );
    }
  });

  it('rejects bytes appended after the trailer', async () => {
    for (const junk of [Uint8Array.of(0), utf8('garbage!'), new Uint8Array(1024)]) {
      await expect(gunzip(concat([gz('payload'), junk]))).rejects.toBeInstanceOf(GzipError);
    }
  });
});

describe('gunzip: content checks', () => {
  it('rejects a CRC mismatch', async () => {
    const data = utf8('abc');
    const bytes = member(new Uint8Array(deflateRawSync(data)), {
      crc: crc32(data) ^ 1,
      isize: 3,
    });
    await expectCode(bytes, 'crc-mismatch');
  });

  it('rejects an ISIZE that differs from the output', async () => {
    const data = utf8('0123456789'.repeat(20));
    const deflate = new Uint8Array(deflateRawSync(data));
    for (const isize of [data.length - 1, data.length + 1, 0]) {
      await expectCode(member(deflate, {crc: crc32(data), isize}), 'size-mismatch');
    }
  });

  it('enforces the output limit before inflating', async () => {
    const data = utf8('x'.repeat(5000));
    await expectCode(gz(data), 'limit-exceeded', {maxOutputSize: 4999});
    expect(await gunzip(gz(data), {maxOutputSize: 5000})).toEqual(data);
  });

  it('refuses an ISIZE no deflate stream of that length can produce', async () => {
    const deflate = new Uint8Array(deflateRawSync(utf8('a')));
    await expectCode(member(deflate, {crc: 0, isize: 900_000_000}), 'size-mismatch');
  });

  it('stops a decompression bomb at ISIZE', async () => {
    const bomb = new Uint8Array(32 * 1024 * 1024);
    const bytes = gz(bomb, 9);
    bytes.set(le32(100), bytes.length - 4);
    await expectCode(bytes, 'size-mismatch');
  });

  it('rejects corrupt and truncated deflate data', async () => {
    const data = utf8('hello hello hello hello');
    const deflate = new Uint8Array(deflateRawSync(data));
    for (const bad of [
      Uint8Array.of(0xff, 0xff, 0xff),
      deflate.subarray(0, -1),
      new Uint8Array(),
    ]) {
      await expectCode(member(bad, {crc: crc32(data), isize: data.length}), 'bad-deflate');
    }
  });

  it('validates the limits', async () => {
    for (const maxOutputSize of [-1, 1.5, 2 ** 32, Number.NaN]) {
      await expect(gunzip(gz('a'), {maxOutputSize})).rejects.toThrow(TypeError);
    }
    await expect(gunzip('x' as unknown as Uint8Array)).rejects.toThrow(TypeError);
  });

  it('stops the decompressor when the consumer stops early', async () => {
    const data = pseudoRandom(1024 * 1024, 5);
    let chunks = 0;
    for await (const chunk of inflateGzip(readGzipMember(gz(data, 1)))) {
      expect(chunk.length).toBeGreaterThan(0);
      if (++chunks === 2) break;
    }
    expect(chunks).toBe(2);
  });
});
