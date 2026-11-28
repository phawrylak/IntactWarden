/**
 * Strict gzip (RFC 1952) reader for upstream `.tar.gz` release assets
 * (Vaultwarden's bw_web_v<tag>.tar.gz), over bytes in memory.
 *
 * Node and the extension must accept exactly the same inputs. Accepted is one
 * gzip member that covers the whole input:
 * - CM = 8 and FLG = 0: release tooling (`tar -czf`) sets no flag, and
 *   optional header fields are where gzip parsers disagree. MTIME, XFL and OS
 *   carry no meaning.
 * - The deflate stream ends exactly where the 8-byte trailer starts, so a
 *   second member or any trailing byte is rejected.
 * - CRC-32 and ISIZE of the trailer match the output.
 * - The output is bounded by GzipLimits.maxOutputSize (decompression-bomb
 *   guard) before anything is inflated, and inflation stops at the first
 *   chunk past ISIZE.
 *
 * DecompressionStream('gzip') is deliberately not used for the member:
 * Node 22 decodes concatenated members into one output and ignores what
 * browsers reject (probed on Node 22.23), so the reader parses the
 * header and trailer itself (`readGzipMember`) and inflates the raw deflate
 * data in between with archive/inflate.ts, which rejects trailing data on
 * every platform. `inflateGzip` yields the output in chunks, so the tar reader
 * never holds the whole tar; the output length, the trailing-data rule and the
 * CRC-32 are checked after the last chunk, so a consumer must discard what it
 * received if the generator throws.
 */

import {crc32} from './crc32.ts';
import {chunked, INFLATE_CHUNK, inflatesCleanly, platformRejectsTrailingData} from './inflate.ts';

export type GzipErrorCode =
  | 'not-gzip'
  | 'truncated'
  | 'unsupported-method'
  | 'unsupported-flags'
  | 'limit-exceeded'
  | 'bad-deflate'
  | 'trailing-data'
  | 'size-mismatch'
  | 'crc-mismatch';

export class GzipError extends Error {
  /** One of GzipErrorCode; typed as string so callers can log it verbatim. */
  code: string;

  constructor(code: GzipErrorCode, message: string) {
    super(message);
    this.name = 'GzipError';
    this.code = code;
  }
}

export interface GzipLimits {
  /** Maximum decompressed size in bytes; at most 2^32 - 1 so ISIZE is exact. */
  maxOutputSize?: number;
}

export const DEFAULT_GZIP_LIMITS: Readonly<Required<GzipLimits>> = Object.freeze({
  maxOutputSize: 1024 * 1024 * 1024,
});

/** A checked single-member gzip file: its trailer and its raw deflate data. */
export interface GzipMember {
  /** CRC-32 and ISIZE from the trailer. */
  readonly crc32: number;
  readonly isize: number;
  /** The raw deflate data between header and trailer (a view of the input). */
  readonly deflate: Uint8Array;
}

const HEADER_SIZE = 10;
const TRAILER_SIZE = 8;
const CM_DEFLATE = 8;

/** Parses and checks the header and trailer of a single-member gzip file (nothing is inflated). */
export function readGzipMember(gz: Uint8Array, limits: GzipLimits = {}): GzipMember {
  if (!(gz instanceof Uint8Array)) throw new TypeError('readGzipMember: input must be bytes');
  const maxOutputSize = limits.maxOutputSize ?? DEFAULT_GZIP_LIMITS.maxOutputSize;
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) {
    throw new GzipError('not-gzip', 'not a gzip file (missing 1f 8b)');
  }
  if (gz.length < HEADER_SIZE + TRAILER_SIZE) {
    throw new GzipError('truncated', 'gzip file is truncated');
  }
  if (gz[2] !== CM_DEFLATE) {
    throw new GzipError('unsupported-method', `unsupported compression method ${gz[2]}`);
  }
  const flags = gz[3]!;
  if (flags !== 0) {
    throw new GzipError(
      'unsupported-flags',
      `gzip flags 0x${flags.toString(16)} are not supported (FLG must be 0)`,
    );
  }
  const end = gz.length - TRAILER_SIZE;
  const trailer = new DataView(gz.buffer, gz.byteOffset + end, TRAILER_SIZE);
  const isize = trailer.getUint32(4, true);
  if (isize > maxOutputSize) {
    throw new GzipError(
      'limit-exceeded',
      `${isize} decompressed bytes exceed the limit of ${maxOutputSize}`,
    );
  }
  return {crc32: trailer.getUint32(0, true), isize, deflate: gz.subarray(HEADER_SIZE, end)};
}

/**
 * Inflates `member` and yields its output in chunks (fresh buffers the
 * consumer may keep). Throws GzipError `size-mismatch` as soon as the output
 * passes ISIZE, `bad-deflate` for invalid deflate data, and, after the last
 * chunk, `size-mismatch` for a short output, `trailing-data` for a stream that
 * ends before the trailer, and `crc-mismatch`. Where DecompressionStream
 * itself rejects bytes after the deflate stream (Firefox, Node 24), a second
 * member or other trailing data fails earlier, as `bad-deflate`. Returning
 * early (a consumer's `break` or `return()`) cancels the decompressor.
 */
export async function* inflateGzip(
  member: GzipMember,
): AsyncGenerator<Uint8Array, void, undefined> {
  const {deflate, isize} = member;
  const reader = chunked(deflate, INFLATE_CHUNK)
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  let written = 0;
  let crc = 0;
  let finished = false;
  try {
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch {
        throw new GzipError('bad-deflate', 'invalid deflate data');
      }
      if (step.done) {
        finished = true;
        break;
      }
      const value = step.value;
      if (value.length > isize - written) {
        throw new GzipError(
          'size-mismatch',
          `output does not match ISIZE: inflates to more than ${isize} bytes`,
        );
      }
      crc = crc32(value, crc);
      written += value.length;
      yield value;
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
  }
  if (written !== isize) {
    throw new GzipError(
      'size-mismatch',
      `output does not match ISIZE: inflates to ${written} bytes, expected ${isize}`,
    );
  }
  // If the stream already ends before the last input byte, there is trailing data
  // (archive/inflate.ts: needed where DecompressionStream ignores it, e.g. Node 22).
  if (!(await platformRejectsTrailingData()) && (await inflatesCleanly(deflate.subarray(0, -1)))) {
    throw new GzipError(
      'trailing-data',
      'the deflate stream ends before the trailer (a second member or trailing data)',
    );
  }
  if (crc !== member.crc32) throw new GzipError('crc-mismatch', 'CRC-32 mismatch');
}
