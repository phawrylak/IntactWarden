/**
 * Minimal ZIP writer for synthetic test archives (stored and deflate, Unix
 * regular-file and directory modes), accepted by the strict reader in
 * @intactwarden/core/archive/zip.ts.
 */

import {deflateRawSync} from 'node:zlib';
import {crc32} from '@intactwarden/core/archive/crc32.ts';

export interface ZipSpec {
  /** Member name; a trailing "/" makes a directory entry. */
  readonly name: string;
  readonly data?: string | Uint8Array;
  /** Default: 8 (deflate) for files, 0 for directories. */
  readonly method?: 0 | 8;
}

function le(size: 2 | 4, value: number): Uint8Array {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (size === 2) view.setUint16(0, value, true);
  else view.setUint32(0, value >>> 0, true);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();

export function writeZip(specs: readonly ZipSpec[]): Uint8Array {
  const records: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const spec of specs) {
    const isDirectory = spec.name.endsWith('/');
    const data =
      typeof spec.data === 'string' ? encoder.encode(spec.data) : (spec.data ?? new Uint8Array());
    const method = spec.method ?? (isDirectory ? 0 : 8);
    const payload = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = crc32(data);
    const name = encoder.encode(spec.name);
    const flags = [...spec.name].some(c => c.charCodeAt(0) >= 0x80) ? 0x800 : 0;
    const local = concat([
      le(4, 0x04034b50),
      le(2, 20),
      le(2, flags),
      le(2, method),
      le(2, 0),
      le(2, 0x21),
      le(4, crc),
      le(4, payload.length),
      le(4, data.length),
      le(2, name.length),
      le(2, 0),
      name,
    ]);
    records.push(local, payload);
    const attr = isDirectory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0;
    central.push(
      concat([
        le(4, 0x02014b50),
        le(2, 0x031e),
        le(2, 20),
        le(2, flags),
        le(2, method),
        le(2, 0),
        le(2, 0x21),
        le(4, crc),
        le(4, payload.length),
        le(4, data.length),
        le(2, name.length),
        le(2, 0),
        le(2, 0),
        le(2, 0),
        le(2, 0),
        le(4, attr),
        le(4, offset),
        name,
      ]),
    );
    offset += local.length + payload.length;
  }
  const cd = concat(central);
  const eocd = concat([
    le(4, 0x06054b50),
    le(2, 0),
    le(2, 0),
    le(2, specs.length),
    le(2, specs.length),
    le(4, cd.length),
    le(4, offset),
    le(2, 0),
  ]);
  return concat([...records, cd, eocd]);
}
