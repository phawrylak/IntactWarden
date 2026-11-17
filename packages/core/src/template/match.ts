/**
 * Masked-hash template matcher, shared by the builders and the extension.
 *
 * Walks the file once: literal runs are taken by length, and each slot is
 * replaced in the hash input by MARK(name) after its value has been taken as
 * the longest run of charset bytes (bounded by max). The masked input is then
 * hashed in one WebCrypto call (a transient copy of at most the file's size).
 * The file matches only if every constraint holds and the masked digest equals
 * the template's. Every failure is reported, never thrown.
 */

import {isSha256Hex} from '../hash/hex.ts';
import {sha256HexOfParts} from '../hash/sha256.ts';
import type {SlotOccurrence, Template} from './build.ts';
import {getSlotSpec, slotMark, type SlotSpec} from './slots.ts';

export type MatchResult =
  | {ok: true; slots: Record<string, string>; occurrences: SlotOccurrence[]}
  | {ok: false; reason: string};

type Step = {kind: 'lit'; n: number} | {kind: 'slot'; spec: SlotSpec};

interface Compiled {
  maskedSha256: string;
  litTotal: number;
  steps: Step[];
}

type Compile = {ok: true; value: Compiled} | {ok: false; reason: string};

function bad(reason: string): {ok: false; reason: string} {
  return {ok: false, reason};
}

function isNonNegativeSafeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Strictly validates an untrusted template object and copies it into an
 * internal form, reading every property exactly once. Canonical shape:
 * `lit (slot lit)*`; with at least one slot, every literal is non-empty (a
 * slot is always preceded and followed by a literal byte, and two slots are
 * never adjacent).
 */
function compile(t: unknown): Compile {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return bad('not an object');
  const o = t as Record<string, unknown>;
  const maskedSha256 = o.masked_sha256;
  const lengthWithoutSlots = o.length_without_slots;
  const parts = o.parts;
  if (!isSha256Hex(maskedSha256)) return bad('masked_sha256 is not lowercase hex SHA-256');
  if (!isNonNegativeSafeInteger(lengthWithoutSlots)) return bad('bad length_without_slots');
  if (!Array.isArray(parts) || parts.length === 0) return bad('parts must be a non-empty array');
  const count = parts.length;
  if (count % 2 !== 1) return bad('parts must alternate literal and slot, ending with a literal');
  const hasSlots = count > 1;
  const steps: Step[] = [];
  let litTotal = 0;
  for (let i = 0; i < count; i++) {
    const part: unknown = parts[i];
    if (part === null || typeof part !== 'object' || Array.isArray(part)) {
      return bad(`part ${i} is not an object`);
    }
    const keys = Object.keys(part);
    if (keys.length !== 1) return bad(`part ${i} must have exactly one key`);
    if (i % 2 === 0) {
      if (keys[0] !== 'lit') return bad(`part ${i} must be a literal`);
      const n = (part as {lit: unknown}).lit;
      if (!isNonNegativeSafeInteger(n)) return bad(`part ${i}: bad literal length`);
      if (hasSlots && n === 0) return bad(`part ${i}: a literal next to a slot must be non-empty`);
      litTotal += n;
      if (!Number.isSafeInteger(litTotal)) return bad('literal lengths overflow');
      steps.push({kind: 'lit', n});
    } else {
      if (keys[0] !== 'slot') return bad(`part ${i} must be a slot`);
      const name = (part as {slot: unknown}).slot;
      const spec = typeof name === 'string' ? getSlotSpec(name) : undefined;
      if (spec === undefined) return bad(`part ${i}: slot is not allowlisted`);
      steps.push({kind: 'slot', spec});
    }
  }
  if (litTotal !== lengthWithoutSlots)
    return bad('length_without_slots does not equal the literals');
  return {ok: true, value: {maskedSha256, litTotal, steps}};
}

/** Returns null if `t` is a well-formed template, else the reason. */
export function validateTemplate(t: unknown): string | null {
  const c = compile(t);
  return c.ok ? null : c.reason;
}

/** The bytes `start` to `end` (exclusive) as a string, one character per byte. */
export function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * Matches `bytes` against template `t`. `bound` pins slot values known from
 * elsewhere (e.g. MAIN from the request path); a bound slot that does not
 * occur in this template constrains nothing, but a bound name outside the slot
 * allowlist is an error.
 */
export async function matchTemplate(
  t: Template,
  bytes: Uint8Array,
  bound?: Readonly<Record<string, string>>,
): Promise<MatchResult> {
  const c = compile(t);
  if (!c.ok) return bad(`invalid template: ${c.reason}`);
  const {maskedSha256, litTotal, steps} = c.value;
  if (!(bytes instanceof Uint8Array)) return bad('bytes is not a Uint8Array');

  const boundValues = new Map<string, string>();
  if (bound !== undefined) {
    if (bound === null || typeof bound !== 'object') return bad('bound is not an object');
    for (const name of Object.keys(bound)) {
      const value: unknown = bound[name];
      if (getSlotSpec(name) === undefined) return bad(`bound slot ${name} is not allowlisted`);
      if (typeof value !== 'string') return bad(`bound value for ${name} is not a string`);
      boundValues.set(name, value);
    }
  }

  let minLength = litTotal;
  let maxLength = litTotal;
  for (const step of steps) {
    if (step.kind === 'slot') {
      minLength += step.spec.min;
      maxLength += step.spec.max;
    }
  }
  if (bytes.length < minLength || bytes.length > maxLength) {
    return bad(`file length ${bytes.length} outside [${minLength}, ${maxLength}]`);
  }
  // MARK uses NUL, so a NUL-free file makes the masked digest alone pin down
  // where the slots are (defence in depth: `parts` fixes the literal lengths too).
  const nul = bytes.indexOf(0);
  if (nul !== -1) return bad(`NUL byte at offset ${nul}`);

  const masked: Uint8Array[] = [];
  const values = new Map<string, string>();
  const occurrences: SlotOccurrence[] = [];
  let pos = 0;
  for (const step of steps) {
    if (step.kind === 'lit') {
      if (step.n > bytes.length - pos) return bad(`file ends inside the literal at ${pos}`);
      masked.push(bytes.subarray(pos, pos + step.n));
      pos += step.n;
      continue;
    }
    const {spec} = step;
    const limit = Math.min(bytes.length, pos + spec.max);
    let end = pos;
    while (end < limit && spec.inCharset(bytes[end]!)) end++;
    if (end - pos < spec.min) return bad(`slot ${spec.name} at ${pos} is shorter than ${spec.min}`);
    if (end < bytes.length && spec.inCharset(bytes[end]!)) {
      return bad(`slot ${spec.name} at ${pos} is longer than ${spec.max}`);
    }
    const value = ascii(bytes, pos, end);
    if (spec.refused?.has(value) === true) {
      return bad(`slot ${spec.name} at ${pos} has a refused value`);
    }
    const previous = values.get(spec.name);
    if (previous === undefined) {
      const pinned = boundValues.get(spec.name);
      if (pinned !== undefined && pinned !== value) {
        return bad(`slot ${spec.name} at ${pos} differs from its bound value`);
      }
      values.set(spec.name, value);
    } else if (previous !== value) {
      return bad(`slot ${spec.name} at ${pos} differs from its earlier occurrence`);
    }
    occurrences.push({offset: pos, length: end - pos, slot: spec.name});
    masked.push(slotMark(spec.name));
    pos = end;
  }
  if (pos !== bytes.length) return bad(`${bytes.length - pos} trailing bytes`);
  if ((await sha256HexOfParts(masked)) !== maskedSha256) return bad('masked digest mismatch');
  return {ok: true, slots: Object.fromEntries(values), occurrences};
}
