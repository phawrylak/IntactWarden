/**
 * Minimal tar writer for synthetic test archives: GNU headers (`ustar  \0`,
 * as GNU tar writes them, with automatic 'L' long names).
 * Every field can be overridden, so each rejection rule of the strict reader
 * in src/archive/tar.ts can be exercised with an otherwise valid archive.
 * Shared with the builders' tests (synthetic Vaultwarden release tarballs).
 */

export interface TarSpec {
  /** Entry name; a trailing "/" makes a directory (typeflag '5') by default. */
  readonly name: string;
  readonly data?: string | Uint8Array;
  /** One character, e.g. '0', '5', '2', 'x'; default '0' or '5'. */
  readonly typeflag?: string;
  readonly linkname?: string;
  /** Raw bytes written over the header (offset → bytes) before the checksum. */
  readonly patch?: ReadonlyArray<readonly [number, Uint8Array | string]>;
  /** Overrides the computed checksum value. */
  readonly checksum?: number;
  /** Raw bytes used as the padding after the data (default zeros). */
  readonly padding?: Uint8Array;
  /** Emit no automatic GNU long name for a name over 100 bytes. */
  readonly noLongName?: boolean;
  readonly mtime?: number;
  readonly mode?: number;
}

export interface TarOptions {
  /** Zero blocks after the last entry (default 2). */
  readonly endBlocks?: number;
  /** Pad the archive with zeros to a multiple of this many bytes (e.g. 10240). */
  readonly recordSize?: number;
  /** Bytes appended after everything else. */
  readonly trailer?: Uint8Array;
}

const BLOCK = 512;
const encoder = new TextEncoder();

export const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? encoder.encode(data) : data;

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Octal field: zero-padded digits plus a NUL, `width` bytes in all (as GNU tar writes it). */
export function octal(value: number, width: number): Uint8Array {
  return encoder.encode(value.toString(8).padStart(width - 1, '0') + '\0');
}

function put(block: Uint8Array, offset: number, bytes: Uint8Array | string): void {
  block.set(toBytes(bytes), offset);
}

/** One header block for `spec` with the given name field bytes and data size. */
export function tarHeader(spec: TarSpec, nameField: Uint8Array, size: number): Uint8Array {
  const isDir = spec.name.endsWith('/');
  const block = new Uint8Array(BLOCK);
  put(block, 0, nameField.subarray(0, 100));
  put(block, 100, octal(spec.mode ?? (isDir ? 0o755 : 0o644), 8));
  put(block, 108, octal(0, 8));
  put(block, 116, octal(0, 8));
  put(block, 124, octal(size, 12));
  put(block, 136, octal(spec.mtime ?? 0o15271661257, 12));
  put(block, 156, spec.typeflag ?? (isDir ? '5' : '0'));
  if (spec.linkname !== undefined) put(block, 157, spec.linkname);
  put(block, 257, 'ustar  \0');
  put(block, 265, 'root');
  put(block, 297, 'root');
  for (const [offset, bytes] of spec.patch ?? []) put(block, offset, bytes);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  const checksum = spec.checksum ?? sum;
  put(block, 148, encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '));
  return block;
}

function padded(data: Uint8Array, padding?: Uint8Array): Uint8Array {
  const rest = (BLOCK - (data.length % BLOCK)) % BLOCK;
  const pad = new Uint8Array(rest);
  if (padding !== undefined) pad.set(padding.subarray(0, rest));
  return concat([data, pad]);
}

export function writeTar(specs: readonly TarSpec[], options: TarOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const spec of specs) {
    const data = toBytes(spec.data ?? '');
    const name = encoder.encode(spec.name);
    if (name.length > 100 && spec.noLongName !== true) {
      const payload = concat([name, new Uint8Array(1)]);
      parts.push(
        tarHeader(
          {name: '././@LongLink', typeflag: 'L'},
          encoder.encode('././@LongLink'),
          payload.length,
        ),
        padded(payload),
      );
    }
    parts.push(tarHeader(spec, name, data.length), padded(data, spec.padding));
  }
  parts.push(new Uint8Array(BLOCK * (options.endBlocks ?? 2)));
  let out = concat(parts);
  if (options.recordSize !== undefined && out.length % options.recordSize !== 0) {
    out = concat([out, new Uint8Array(options.recordSize - (out.length % options.recordSize))]);
  }
  return options.trailer === undefined ? out : concat([out, options.trailer]);
}
