/**
 * The context rule of slot templates for the derived cloud files: varying a slot value within its
 * charset can never change code.
 *
 * JavaScript: a lexical rule for the derivation's two kinds of slot site, which the derivation
 * itself writes (derive/bitwarden-cloud-v1.ts) and this module re-checks on the bytes:
 * - CACHE_TAG directly after `?cache=` and directly before `"`. Inside a string, comment,
 *   template literal or regular expression a value from [a-z0-9] cannot end the token. In code,
 *   a value followed by `"` is a syntax error (an identifier, number or keyword directly followed
 *   by a string) except for a unary keyword such as `typeof`; the slot spec refuses every
 *   JavaScript reserved word as a CACHE_TAG value (template/slots.ts), so a script whose site
 *   were code would not run with any accepted value.
 * - a content hash in the file's last line, which must be exactly `//# sourceMappingURL=`
 *   followed by bytes from [0-9A-Za-z._-] up to the end of the file (the site sourceMapEdit
 *   writes). That line holds no byte that can end or escape anything (no `*`, backtick, quote,
 *   `\`, `$` or line terminator): if it starts in code it is a line comment; if it starts inside
 *   a block comment, template literal or continued string, that construct stays open to the end
 *   of the file and the script does not parse with any value. Either way no slot value changes
 *   code.
 *
 * HTML: every occurrence must sit inside a double-quoted `src` or `href` value. A small scanner
 * follows the WHATWG tokenizer for tags, attributes, comments and raw-text elements, and fails
 * closed on the constructs it does not model (abrupt comment endings, `--!>`, CDATA, `<!--`
 * inside a script element).
 *
 * Everything here fails closed: an occurrence whose context cannot be established is an error,
 * never a guess.
 */

import type {SlotOccurrence} from '@intactwarden/core/template/build.ts';
import {RefusalError} from './files.ts';

export class ContextError extends RefusalError {
  override name = 'ContextError';
  constructor(message: string) {
    super(message, 'derivation-failed');
  }
}

/** HTML attributes that may carry a slot (URL attributes only; never on*, style or srcdoc). */
const SLOT_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'href']);

const strictUtf8 = new TextDecoder('utf-8', {fatal: true});

function decode(bytes: Uint8Array, what: string): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new ContextError(`${what}: not valid UTF-8`);
  }
}

function describe(o: SlotOccurrence): string {
  return `slot ${o.slot} at byte ${o.offset}`;
}

/** Checks bounds and that the occurrence is ASCII (so it starts on a character boundary). */
function checkOccurrence(bytes: Uint8Array, o: SlotOccurrence): void {
  if (
    !Number.isSafeInteger(o.offset) ||
    !Number.isSafeInteger(o.length) ||
    o.offset < 1 ||
    o.length < 1 ||
    o.offset + o.length > bytes.length
  ) {
    throw new ContextError(`${describe(o)}: out of bounds`);
  }
  for (let i = o.offset; i < o.offset + o.length; i++) {
    if (bytes[i]! >= 0x80) throw new ContextError(`${describe(o)}: non-ASCII slot byte`);
  }
}

// ---------------------------------------------------------------------------
// JavaScript

/** `?cache=`, the bytes before every CACHE_TAG site of the derivation. */
export const CACHE_SITE = '?cache=';
/**
 * The start of the last line, the only site of a content-hash slot. A template, so the bundle
 * holds no literal source-map comment (AMO's linter reads one as minified code).
 */
const MAP_SITE = `//# ${'sourceMappingURL'}=`;
const QUOTE = 0x22;
const LF = 0x0a;

/** [0-9A-Za-z._-]: the bytes of a source-map file name. */
function isMapNameByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b === 0x2e ||
    b === 0x5f ||
    b === 0x2d
  );
}

/**
 * Checks the slot occurrences of a derived script with the lexical rule of the derivation's two
 * kinds of slot site (module comment). Throws ContextError unless every CACHE_TAG occurrence sits
 * directly after `?cache=` and directly before `"`, and every other occurrence lies after the
 * `//# sourceMappingURL=` that starts the file's last line, whose other bytes are all from
 * [0-9A-Za-z._-].
 */
export function checkJsSlots(bytes: Uint8Array, occurrences: readonly SlotOccurrence[]): void {
  const lastLine = bytes.lastIndexOf(LF) + 1;
  const nameStart = lastLine + MAP_SITE.length;
  const mapLine =
    startsWithAscii(bytes, lastLine, MAP_SITE) && bytes.subarray(nameStart).every(isMapNameByte);
  for (const o of occurrences) {
    checkOccurrence(bytes, o);
    const ok =
      o.slot === 'CACHE_TAG'
        ? startsWithAscii(bytes, o.offset - CACHE_SITE.length, CACHE_SITE) &&
          bytes[o.offset + o.length] === QUOTE
        : mapLine && o.offset >= nameStart;
    if (!ok) {
      throw new ContextError(
        `${describe(o)}: not a ?cache=<CACHE_TAG>" site and not in the final sourceMappingURL line`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// HTML

interface HtmlAttributeValue {
  /** Lowercase tag and attribute names. */
  readonly tag: string;
  readonly attr: string;
  /** Byte offsets of the value, without quotes. */
  readonly start: number;
  readonly end: number;
  readonly quote: '"' | "'" | null;
}

/** Elements whose content the tokenizer reads as raw text or RCDATA (scripting enabled). */
const RAW_TEXT: ReadonlySet<string> = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const EQ = 0x3d;
const DQ = 0x22;
const SQ = 0x27;

function isSpace(c: number | undefined): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

function isAlpha(c: number | undefined): boolean {
  return c !== undefined && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a));
}

function lowerAscii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) {
    const c = bytes[i]!;
    s += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c | 0x20 : c);
  }
  return s;
}

function startsWithAscii(bytes: Uint8Array, pos: number, ascii: string, caseless = false): boolean {
  if (pos + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    let c = bytes[pos + i]!;
    if (caseless && c >= 0x41 && c <= 0x5a) c |= 0x20;
    if (c !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

export function indexOfAscii(bytes: Uint8Array, ascii: string, from: number): number {
  const first = ascii.charCodeAt(0);
  for (let i = bytes.indexOf(first, from); i >= 0; i = bytes.indexOf(first, i + 1)) {
    if (startsWithAscii(bytes, i, ascii)) return i;
  }
  return -1;
}

interface Tag {
  readonly name: string;
  /** Offset just after the closing '>'. */
  readonly end: number;
  readonly values: HtmlAttributeValue[];
}

/** Tag name and attributes from `pos` (the first byte of the name) to the closing '>'. */
function scanTag(bytes: Uint8Array, pos: number): Tag {
  const n = bytes.length;
  let p = pos;
  while (p < n && !isSpace(bytes[p]) && bytes[p] !== SLASH && bytes[p] !== GT) p++;
  const name = lowerAscii(bytes, pos, p);
  const values: HtmlAttributeValue[] = [];
  const eof = (): never => {
    throw new ContextError(`html: end of file inside <${name}>`);
  };
  for (;;) {
    while (p < n && isSpace(bytes[p])) p++;
    if (p >= n) eof();
    const c = bytes[p]!;
    if (c === GT) return {name, end: p + 1, values};
    if (c === SLASH) {
      p++;
      if (bytes[p] === GT) return {name, end: p + 1, values};
      continue;
    }
    // Attribute name; a leading '=' belongs to the name.
    const nameStart = p++;
    while (
      p < n &&
      !isSpace(bytes[p]) &&
      bytes[p] !== SLASH &&
      bytes[p] !== GT &&
      bytes[p] !== EQ
    ) {
      p++;
    }
    const attr = lowerAscii(bytes, nameStart, p);
    while (p < n && isSpace(bytes[p])) p++;
    if (bytes[p] !== EQ) continue;
    p++;
    while (p < n && isSpace(bytes[p])) p++;
    if (p >= n) eof();
    const q = bytes[p]!;
    if (q === DQ || q === SQ) {
      const end = bytes.indexOf(q, p + 1);
      if (end < 0) eof();
      values.push({tag: name, attr, start: p + 1, end, quote: q === DQ ? '"' : "'"});
      p = end + 1;
    } else if (q === GT) {
      return {name, end: p + 1, values};
    } else {
      const start = p;
      while (p < n && !isSpace(bytes[p]) && bytes[p] !== GT) p++;
      values.push({tag: name, attr, start, end: p, quote: null});
    }
  }
}

/** Offset of the end tag `</name` that closes a raw-text element, or -1. */
function rawTextEnd(bytes: Uint8Array, name: string, from: number): number {
  for (let i = indexOfAscii(bytes, '</', from); i >= 0; i = indexOfAscii(bytes, '</', i + 1)) {
    if (startsWithAscii(bytes, i + 2, name, true)) {
      const after = bytes[i + 2 + name.length];
      if (after === undefined || isSpace(after) || after === SLASH || after === GT) return i;
    }
  }
  return -1;
}

/**
 * Attribute values of all start tags of an HTML document, in document order.
 * Throws ContextError on constructs the scanner does not model.
 */
function scanHtmlAttributeValues(bytes: Uint8Array): HtmlAttributeValue[] {
  decode(bytes, 'html');
  const n = bytes.length;
  const out: HtmlAttributeValue[] = [];
  let pos = 0;
  while (pos < n) {
    const lt = bytes.indexOf(LT, pos);
    if (lt < 0) break;
    pos = lt;
    const next = bytes[pos + 1];
    if (startsWithAscii(bytes, pos, '<!--')) {
      if (startsWithAscii(bytes, pos + 4, '>') || startsWithAscii(bytes, pos + 4, '->')) {
        throw new ContextError(`html: abruptly closed comment at ${pos}`);
      }
      const end = indexOfAscii(bytes, '-->', pos + 4);
      if (end < 0) throw new ContextError(`html: unterminated comment at ${pos}`);
      const bang = indexOfAscii(bytes, '--!>', pos + 4);
      if (bang >= 0 && bang < end)
        throw new ContextError(`html: comment closed by "--!>" at ${pos}`);
      pos = end + 3;
    } else if (startsWithAscii(bytes, pos, '<![CDATA[')) {
      throw new ContextError(`html: CDATA section at ${pos}`);
    } else if (next === 0x21 || next === 0x3f) {
      // <!DOCTYPE ...>, <?...> and other bogus comments end at the first '>'.
      const end = bytes.indexOf(GT, pos + 2);
      if (end < 0) throw new ContextError(`html: unterminated markup declaration at ${pos}`);
      pos = end + 1;
    } else if (next === SLASH) {
      if (isAlpha(bytes[pos + 2])) {
        pos = scanTag(bytes, pos + 2).end; // end tag; its attributes are ignored
      } else {
        const end = bytes.indexOf(GT, pos + 2);
        if (end < 0) throw new ContextError(`html: unterminated end tag at ${pos}`);
        pos = end + 1;
      }
    } else if (isAlpha(next)) {
      const tag = scanTag(bytes, pos + 1);
      out.push(...tag.values);
      pos = tag.end;
      if (tag.name === 'plaintext') break;
      if (RAW_TEXT.has(tag.name)) {
        const close = rawTextEnd(bytes, tag.name, pos);
        const contentEnd = close < 0 ? n : close;
        if (
          tag.name === 'script' &&
          indexOfAscii(bytes.subarray(0, contentEnd), '<!--', pos) >= 0
        ) {
          throw new ContextError(`html: "<!--" inside a script element at ${pos}`);
        }
        pos = contentEnd;
      }
    } else {
      pos += 1; // a '<' in text
    }
  }
  return out;
}

/**
 * Checks the slot occurrences of an HTML document. Throws ContextError unless each occurrence
 * lies inside one double-quoted value of a `src` or `href` attribute.
 */
export function checkHtmlSlots(bytes: Uint8Array, occurrences: readonly SlotOccurrence[]): void {
  const values = scanHtmlAttributeValues(bytes);
  for (const o of occurrences) {
    checkOccurrence(bytes, o);
    const end = o.offset + o.length;
    const value = values.find(v => v.start <= o.offset && end <= v.end);
    if (value === undefined) {
      throw new ContextError(`${describe(o)}: not inside an attribute value`);
    }
    if (value.quote !== '"') {
      throw new ContextError(`${describe(o)}: attribute value is not double-quoted`);
    }
    if (!SLOT_ATTRIBUTES.has(value.attr)) {
      throw new ContextError(`${describe(o)}: attribute ${value.attr} may not carry a slot`);
    }
  }
}
