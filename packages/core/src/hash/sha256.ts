/**
 * SHA-256 over raw bytes with WebCrypto (available in Firefox, extension pages
 * and Node). WebCrypto has no incremental digest: every caller hashes one
 * buffer, so nothing is hashed in JavaScript.
 */

import {toHex} from './hex.ts';

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

/** SHA-256 (lowercase hex) of the concatenation of `parts`, copied into one buffer first. */
export async function sha256HexOfParts(parts: readonly Uint8Array[]): Promise<string> {
  let size = 0;
  for (const part of parts) size += part.length;
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return sha256Hex(all);
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}
