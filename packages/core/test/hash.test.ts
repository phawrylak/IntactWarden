import {describe, expect, it} from 'vitest';
import {sha256Hex, utf8} from '../src/hash/sha256.ts';
import {isSha256Hex, toHex} from '../src/hash/hex.ts';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256', () => {
  it('matches known vectors', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(EMPTY);
    expect(await sha256Hex(utf8('abc'))).toBe(ABC);
    // A view hashes its own bytes, not its buffer.
    expect(await sha256Hex(utf8('xabcx').subarray(1, 4))).toBe(ABC);
  });
});

describe('hex', () => {
  it('is lowercase and strict', () => {
    expect(toHex(new Uint8Array([0, 1, 0xab, 0xff]))).toBe('0001abff');
    expect(isSha256Hex(EMPTY)).toBe(true);
    expect(isSha256Hex(EMPTY.toUpperCase())).toBe(false);
    expect(isSha256Hex(EMPTY + '0')).toBe(false);
  });
});
