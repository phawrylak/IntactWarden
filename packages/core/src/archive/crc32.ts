/**
 * CRC-32 as used by ZIP, gzip and PNG (CRC-32/ISO-HDLC: reflected polynomial
 * 0xEDB88320, initial value and final XOR 0xFFFFFFFF).
 *
 * `seed` is a previous return value, so a CRC can be computed incrementally:
 * crc32(b, crc32(a)) === crc32(concat(a, b)). Results are unsigned 32-bit.
 *
 * A plain byte-wise table loop (~400 MB/s in V8) is fast enough for release
 * archives; slicing-by-N was measured at only ~1.4x and is not worth the code.
 */

const TABLE = makeTable();

function makeTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}

export function crc32(bytes: Uint8Array, seed = 0): number {
  const t = TABLE;
  let c = ~seed;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
