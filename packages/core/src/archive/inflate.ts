/**
 * Raw deflate (RFC 1951) helpers shared by the strict archive readers
 * (zip.ts for entries, gzip.ts for the single gzip member).
 *
 * The readers run in the browser (deep verify) and in Node (the build, the
 * recompute command and the tests) and must accept exactly the same inputs on
 * both. The Compression Streams spec makes DecompressionStream fail on bytes
 * after the end of the deflate stream, and browsers do; Node 22 silently
 * ignores them for 'deflate-raw'. Both readers require "the stream ends exactly
 * at the last input byte": zip.ts through `inflateRawExact`, gzip.ts (which
 * streams its output) through `platformRejectsTrailingData` and
 * `inflatesCleanly`. The platform is probed once; where it ignores trailing
 * bytes, the input minus its last byte is inflated a second time.
 */

/** Feeds DecompressionStream in small chunks, so excess output is noticed early. */
export const INFLATE_CHUNK = 64 * 1024;

/** Why `inflateRawExact` refused its input. */
export type InflateFailure = 'bad-deflate' | 'too-large' | 'size-mismatch' | 'trailing-data';

export class InflateError extends Error {
  readonly failure: InflateFailure;

  constructor(failure: InflateFailure, message: string) {
    super(message);
    this.name = 'InflateError';
    this.failure = failure;
  }
}

export function chunked(data: Uint8Array, size: number): ReadableStream<BufferSource> {
  let offset = 0;
  return new ReadableStream<BufferSource>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + size, data.length);
      controller.enqueue(data.slice(offset, end));
      offset = end;
    },
  });
}

/** True if `data` inflates without error (output discarded). */
export async function inflatesCleanly(
  data: Uint8Array,
  chunkSize = INFLATE_CHUNK,
): Promise<boolean> {
  try {
    const reader = chunked(data, chunkSize)
      .pipeThrough(new DecompressionStream('deflate-raw'))
      .getReader();
    for (;;) {
      if ((await reader.read()).done) return true;
    }
  } catch {
    return false;
  }
}

// The empty deflate stream (final fixed-Huffman block, end-of-block) plus one junk byte.
const EMPTY_DEFLATE_WITH_JUNK = new Uint8Array([0x03, 0x00, 0x00]);
let trailingDataProbe: Promise<boolean> | undefined;

/**
 * True if this platform's DecompressionStream('deflate-raw') rejects bytes
 * after the end of the stream (junk in the same and in a separate chunk).
 * Probed once per realm.
 */
export function platformRejectsTrailingData(): Promise<boolean> {
  trailingDataProbe ??= Promise.all([
    inflatesCleanly(EMPTY_DEFLATE_WITH_JUNK),
    inflatesCleanly(EMPTY_DEFLATE_WITH_JUNK, 2),
  ]).then(([sameChunk, nextChunk]) => !sameChunk && !nextChunk);
  return trailingDataProbe;
}

export interface InflateExactOptions {
  /**
   * The output must be exactly this long. Exceeding it cancels the stream
   * after at most one chunk of excess output (decompression-bomb guard).
   */
  readonly expectedSize: number;
}

/**
 * Inflates raw deflate data that must produce exactly `expectedSize` bytes
 * and end exactly at the last input byte. Throws InflateError otherwise.
 * The output buffer is allocated once, at `expectedSize`: callers must bound
 * that number before calling.
 */
export async function inflateRawExact(
  data: Uint8Array,
  {expectedSize}: InflateExactOptions,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new InflateError('size-mismatch', `invalid expected size ${String(expectedSize)}`);
  }
  const out = new Uint8Array(expectedSize);
  let written = 0;
  try {
    const reader = chunked(data, INFLATE_CHUNK)
      .pipeThrough(new DecompressionStream('deflate-raw'))
      .getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value.length > expectedSize - written) {
        await reader.cancel();
        throw new InflateError('too-large', `inflates to more than ${expectedSize} bytes`);
      }
      out.set(value, written);
      written += value.length;
    }
  } catch (err) {
    if (err instanceof InflateError) throw err;
    throw new InflateError('bad-deflate', 'invalid deflate data');
  }
  if (written !== expectedSize) {
    throw new InflateError(
      'size-mismatch',
      `inflates to ${written} bytes, expected ${expectedSize}`,
    );
  }
  // If the stream already ends before the last input byte, there is trailing data.
  if (!(await platformRejectsTrailingData()) && (await inflatesCleanly(data.subarray(0, -1)))) {
    throw new InflateError('trailing-data', 'trailing data after the deflate stream');
  }
  return out;
}
