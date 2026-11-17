/**
 * Builds a masked-hash template from a file and its slot occurrences. Used by the core builders
 * only; refuses (throws TemplateError) unless every soundness condition that can be checked on
 * bytes holds. The caller (the builder) gets the occurrences from the derivation and checks their
 * JS/HTML context (builders/src/contexts.ts) before calling this.
 */

import {sha256HexOfParts} from '../hash/sha256.ts';
import {ascii, matchTemplate} from './match.ts';
import {getSlotSpec, slotMark} from './slots.ts';

export type TemplatePart = {readonly lit: number} | {readonly slot: string};

/**
 * Masked-hash template, as a core's template entry stores it (schema/manifest.ts
 * `TemplateEntry`). Read-only, so it is passed to matchTemplate() as it is.
 */
export interface Template {
  /** SHA-256 of lit_0 ‖ MARK(slot_1) ‖ lit_1 ‖ … */
  readonly masked_sha256: string;
  /** Sum of all literal lengths. */
  readonly length_without_slots: number;
  /** Canonical form `lit (slot lit)*`. */
  readonly parts: readonly TemplatePart[];
}

export interface SlotOccurrence {
  /** Byte offset of the slot value in the file. */
  offset: number;
  /** Byte length of the slot value. */
  length: number;
  slot: string;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/**
 * Soundness checks, in order:
 * - no NUL byte anywhere in the file (MARK uses NUL);
 * - every slot name is allowlisted (template/slots.ts);
 * - occurrences are sorted, non-overlapping, non-adjacent and inside bounds;
 * - each slot is preceded and followed by a literal byte outside its charset
 *   (so a slot can neither start the file nor end it);
 * - each value is all charset bytes and within [min, max] (and not refused, through the round
 *   trip);
 * - repeated occurrences of a slot carry identical values;
 * - round trip: matchTemplate() on the same bytes succeeds and finds exactly
 *   these occurrences and values.
 */
export async function buildTemplate(
  bytes: Uint8Array,
  occurrences: readonly SlotOccurrence[],
): Promise<Template> {
  if (!(bytes instanceof Uint8Array)) throw new TemplateError('bytes is not a Uint8Array');
  if (!Array.isArray(occurrences)) throw new TemplateError('occurrences is not an array');
  const nul = bytes.indexOf(0);
  if (nul !== -1) throw new TemplateError(`file contains a NUL byte at offset ${nul}`);

  const masked: Uint8Array[] = [];
  const parts: TemplatePart[] = [];
  const values = new Map<string, string>();
  const accepted: SlotOccurrence[] = [];
  let pos = 0;
  let slotBytes = 0;
  for (let i = 0; i < occurrences.length; i++) {
    const occurrence: unknown = occurrences[i];
    if (occurrence === null || typeof occurrence !== 'object') {
      throw new TemplateError(`occurrence ${i} is not an object`);
    }
    const {offset, length, slot} = occurrence as Record<string, unknown>;
    const spec = typeof slot === 'string' ? getSlotSpec(slot) : undefined;
    if (spec === undefined) throw new TemplateError(`occurrence ${i}: slot not allowlisted`);
    const where = `occurrence ${i} (${spec.name})`;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
      throw new TemplateError(`${where}: offset and length must be integers`);
    }
    const start = offset as number;
    const end = start + (length as number);
    if (start < pos) throw new TemplateError(`${where}: unsorted or overlapping`);
    if (i > 0 && start === pos) throw new TemplateError(`${where}: adjacent to the previous slot`);
    if (start < 1) throw new TemplateError(`${where}: a slot must be preceded by a literal byte`);
    if (end - start < spec.min || end - start > spec.max) {
      throw new TemplateError(`${where}: length outside [${spec.min}, ${spec.max}]`);
    }
    if (end >= bytes.length) {
      throw new TemplateError(`${where}: a slot must be followed by a literal byte`);
    }
    for (let k = start; k < end; k++) {
      if (!spec.inCharset(bytes[k]!)) {
        throw new TemplateError(`${where}: byte at ${k} outside charset ${spec.charset}`);
      }
    }
    if (spec.inCharset(bytes[start - 1]!)) {
      throw new TemplateError(`${where}: the byte before the slot is inside its charset`);
    }
    if (spec.inCharset(bytes[end]!)) {
      throw new TemplateError(`${where}: the byte after the slot is inside its charset`);
    }
    const value = ascii(bytes, start, end);
    const previous = values.get(spec.name);
    if (previous === undefined) {
      values.set(spec.name, value);
    } else if (previous !== value) {
      throw new TemplateError(`${where}: value differs from an earlier occurrence`);
    }

    parts.push({lit: start - pos});
    masked.push(bytes.subarray(pos, start));
    parts.push({slot: spec.name});
    masked.push(slotMark(spec.name));
    accepted.push({offset: start, length: end - start, slot: spec.name});
    slotBytes += end - start;
    pos = end;
  }
  parts.push({lit: bytes.length - pos});
  masked.push(bytes.subarray(pos));

  const template: Template = {
    masked_sha256: await sha256HexOfParts(masked),
    length_without_slots: bytes.length - slotBytes,
    parts,
  };

  // Round trip through the independent matcher.
  const r = await matchTemplate(template, bytes);
  if (!r.ok) throw new TemplateError(`round trip failed: ${r.reason}`);
  const sameOccurrences =
    r.occurrences.length === accepted.length &&
    r.occurrences.every((o, k) => {
      const a = accepted[k]!;
      return o.offset === a.offset && o.length === a.length && o.slot === a.slot;
    });
  const sameValues =
    Object.keys(r.slots).length === values.size &&
    [...values].every(([name, value]) => r.slots[name] === value);
  if (!sameOccurrences || !sameValues) {
    throw new TemplateError('round trip found different slot occurrences or values');
  }
  return template;
}
