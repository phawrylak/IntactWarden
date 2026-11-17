/**
 * Lookup of a normalised request path in a core's `files` keys, including
 * slot paths such as `/app/main.{MAIN}.js`.
 *
 * A slot path names a family of request paths: each `{NAME}` part matches a
 * run of bytes in the slot's charset, within its [min, max], and binds the
 * slot to that value. The matcher is hand-written (rule R8: nothing here
 * builds a RegExp from data) and deterministic:
 * - a segment holds at most one placeholder, and the byte after it (if any)
 *   must be outside the slot's charset, so the value is exactly the maximal
 *   run of charset bytes after the literal prefix;
 * - a slot that occurs in several segments must bind one value.
 *
 * The builders build this index for every core they emit (schema/manifest.ts coreProblem),
 * so a core never has two keys that one request path could match.
 */

import {getSlotSpec, type SlotSpec} from '../template/slots.ts';
import {RoutingError} from './normalizePath.ts';

/** One segment of a slot path: a literal, or `prefix{slot}suffix`. */
export type KeySegment =
  | {readonly lit: string}
  | {readonly prefix: string; readonly slot: SlotSpec; readonly suffix: string};

export interface ParsedKey {
  readonly key: string;
  readonly segments: readonly KeySegment[];
}

export interface FileMatch {
  /** The `files` key that matched: the path itself, or a slot path. */
  readonly key: string;
  /** Slot values bound from the request path (empty for an exact key). */
  readonly bound: Readonly<Record<string, string>>;
}

/** Resolves the slot spec of a placeholder in `key`, or undefined if it is not allowed. */
export type SlotResolver = (key: string, slot: string) => SlotSpec | undefined;

const SLOT_NAME = /^[A-Z][A-Z0-9_]{0,31}$/;

/** True if `key` contains a brace (and so must be a well-formed slot path). */
function hasPlaceholder(key: string): boolean {
  return key.includes('{') || key.includes('}');
}

/** Placeholder names of `key` in order, or null if the braces are malformed. */
export function placeholderNames(key: string): string[] | null {
  const names: string[] = [];
  for (const segment of key.split('/')) {
    const open = segment.indexOf('{');
    const close = segment.indexOf('}');
    if (open === -1 && close === -1) continue;
    if (open === -1 || close < open) return null;
    const name = segment.slice(open + 1, close);
    const rest = segment.slice(close + 1);
    if (!SLOT_NAME.test(name)) return null;
    if (rest.includes('{') || rest.includes('}')) return null;
    names.push(name);
  }
  return names;
}

/**
 * Parses a slot path. Returns the reason it is not acceptable as a string,
 * or the parsed key. A key without placeholders parses to literal segments.
 */
export function parseKey(key: string, resolve: SlotResolver): ParsedKey | string {
  if (!key.startsWith('/')) return 'path must start with "/"';
  if (placeholderNames(key) === null) {
    return 'malformed "{SLOT}" placeholder (at most one per segment, UPPER_SNAKE name)';
  }
  const segments: KeySegment[] = [];
  for (const segment of key.slice(1).split('/')) {
    const open = segment.indexOf('{');
    if (open === -1) {
      segments.push({lit: segment});
      continue;
    }
    const close = segment.indexOf('}');
    const name = segment.slice(open + 1, close);
    const slot = resolve(key, name);
    if (slot === undefined) return `slot ${name} is not allowed in this key`;
    const suffix = segment.slice(close + 1);
    if (suffix.length > 0 && slot.inCharset(suffix.charCodeAt(0))) {
      return `the byte after {${name}} must be outside the slot's charset`;
    }
    segments.push({prefix: segment.slice(0, open), slot, suffix});
  }
  return {key, segments};
}

/** Matches one request-path segment; returns the slot value, '' for a literal, or null. */
function matchSegment(seg: KeySegment, value: string): string | null {
  if ('lit' in seg) return seg.lit === value ? '' : null;
  if (!value.startsWith(seg.prefix)) return null;
  const start = seg.prefix.length;
  let end = start;
  while (end < value.length && seg.slot.inCharset(value.charCodeAt(end))) end++;
  const n = end - start;
  if (n < seg.slot.min || n > seg.slot.max) return null;
  if (value.slice(end) !== seg.suffix) return null;
  return value.slice(start, end);
}

/** Matches a normalised request path against a parsed key; returns the bindings or null. */
export function matchKey(parsed: ParsedKey, path: string): Record<string, string> | null {
  if (!path.startsWith('/')) return null;
  const parts = path.slice(1).split('/');
  if (parts.length !== parsed.segments.length) return null;
  const bound: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = parsed.segments[i]!;
    const v = matchSegment(seg, parts[i]!);
    if (v === null) return null;
    if ('slot' in seg) {
      const name = seg.slot.name;
      if (Object.hasOwn(bound, name) && bound[name] !== v) return null;
      bound[name] = v;
    }
  }
  return bound;
}

/** Conservative: true unless the two segments provably match no common string. */
function segmentsMayOverlap(a: KeySegment, b: KeySegment): boolean {
  if ('lit' in a && 'lit' in b) return a.lit === b.lit;
  if ('lit' in a) return matchSegment(b, a.lit) !== null;
  if ('lit' in b) return matchSegment(a, b.lit) !== null;
  // A common string starts with both prefixes and ends with both suffixes.
  const prefixesAgree = a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
  const suffixesAgree = a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix);
  return prefixesAgree && suffixesAgree;
}

/**
 * True if one request path might match both keys. Sound (never false for
 * overlapping keys); it may report overlap for two slot paths that cannot
 * actually meet, which only causes a rejection.
 */
export function keysMayOverlap(a: ParsedKey, b: ParsedKey): boolean {
  if (a.segments.length !== b.segments.length) return false;
  return a.segments.every((seg, i) => segmentsMayOverlap(seg, b.segments[i]!));
}

/**
 * The set of `files` keys of one core, for routing lookups. Exact keys are
 * looked up directly; slot paths by matching. Construction throws
 * RoutingError for a malformed slot path or for two keys that may overlap,
 * so a lookup is never ambiguous.
 */
export interface FileIndex {
  /** The matching key and bindings, or null when the path is not listed. */
  lookup(path: string): FileMatch | null;
}

export function createFileIndex(keys: Iterable<string>, resolve: SlotResolver): FileIndex {
  const exact = new Set<string>();
  const slotted: ParsedKey[] = [];
  for (const key of keys) {
    if (!hasPlaceholder(key)) {
      exact.add(key);
      continue;
    }
    const parsed = parseKey(key, resolve);
    if (typeof parsed === 'string') throw new RoutingError(`files key ${key}: ${parsed}`);
    slotted.push(parsed);
  }
  for (let i = 0; i < slotted.length; i++) {
    const a = slotted[i]!;
    for (const key of exact) {
      if (matchKey(a, key) !== null)
        throw new RoutingError(`files keys ${a.key} and ${key} overlap`);
    }
    for (let j = i + 1; j < slotted.length; j++) {
      if (keysMayOverlap(a, slotted[j]!)) {
        throw new RoutingError(`files keys ${a.key} and ${slotted[j]!.key} may overlap`);
      }
    }
  }

  const lookup = (path: string): FileMatch | null => {
    if (exact.has(path)) return {key: path, bound: {}};
    for (const parsed of slotted) {
      const bound = matchKey(parsed, path);
      if (bound !== null) return {key: parsed.key, bound};
    }
    return null;
  };

  return Object.freeze({lookup});
}

/**
 * Slot resolver for a core's `files`: a placeholder is allowed only in a
 * template entry's key, with an allowlisted slot (template/slots.ts).
 */
export function templateSlotResolver(files: Readonly<Record<string, unknown>>): SlotResolver {
  return (key, slot) => {
    const entry: unknown = Object.hasOwn(files, key) ? files[key] : undefined;
    if (entry === null || typeof entry !== 'object' || !('template' in entry)) return undefined;
    const template: unknown = entry.template;
    if (template === null || typeof template !== 'object') return undefined;
    return getSlotSpec(slot);
  };
}

/** File index of a core manifest's `files` (exact keys and template slot paths). */
export function fileIndexOf(files: Readonly<Record<string, unknown>>): FileIndex {
  return createFileIndex(Object.keys(files), templateSlotResolver(files));
}
