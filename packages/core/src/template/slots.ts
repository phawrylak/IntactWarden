/**
 * Closed allowlist of masked-hash template slots.
 *
 * Slot names, charsets and length bounds are defined here, in code. Remote
 * data (manifests, templates) can only refer to these slots by name; it can
 * never add a slot, widen a charset or relax a bound. Charsets are byte
 * predicates over printable ASCII, never regular expressions built from data
 * (rule R8).
 */

export interface SlotSpec {
  readonly name: string;
  /** Human-readable charset, for messages (e.g. "a-z0-9"). */
  readonly charset: string;
  /** True iff the byte may appear in a value of this slot. */
  readonly inCharset: (byte: number) => boolean;
  readonly min: number;
  readonly max: number;
  /** Values that are never accepted, whatever the charset allows. */
  readonly refused?: ReadonlySet<string>;
}

/**
 * Bytes no slot charset may ever contain. Together with the builders' context check
 * (builders/src/contexts.ts) this means a slot value can never end the string or comment it
 * sits in, start a template substitution or open a tag.
 */
export const FORBIDDEN_SLOT_BYTES: readonly number[] = Object.freeze(
  ['"', "'", '`', '\\', '<', '>', '$', '{', '}', '\n', '\r', '\0', ' ', '%'].map(c =>
    c.charCodeAt(0),
  ),
);

// --- byte predicates -------------------------------------------------------

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39; // 0-9
}

function isLowerAlpha(b: number): boolean {
  return b >= 0x61 && b <= 0x7a; // a-z
}

function isUpperAlpha(b: number): boolean {
  return b >= 0x41 && b <= 0x5a; // A-Z
}

function isLowerAlnum(b: number): boolean {
  return isDigit(b) || isLowerAlpha(b);
}

function isLowerHex(b: number): boolean {
  return isDigit(b) || (b >= 0x61 && b <= 0x66); // 0-9a-f
}

// --- the allowlist ---------------------------------------------------------

/**
 * JavaScript reserved words, keywords and the literals null, true and false, plus `async` and
 * `let`: never a CACHE_TAG value. A CACHE_TAG site is followed by `"` (builders/src/contexts.ts);
 * should a release ever put one in code instead of a string, every accepted value would make the
 * script a syntax error, where a unary keyword (`typeof`, `void`, `delete`, `new`, `await`,
 * `yield`) would let the server choose code.
 */
const JS_RESERVED: ReadonlySet<string> = new Set([
  ...['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default'],
  ...['delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for'],
  ...['function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new'],
  ...['null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super'],
  ...['switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with'],
  ...['yield', 'async'],
]);

const HEX20 = {
  charset: '0-9a-f',
  inCharset: isLowerHex,
  min: 20,
  max: 20,
} as const;

/** The slots of the Bitwarden cloud derivation (derive/bitwarden-cloud-v1.ts). */
const SLOTS: ReadonlyMap<string, SlotSpec> = new Map(
  (
    [
      {
        name: 'CACHE_TAG',
        charset: 'a-z0-9',
        inCharset: isLowerAlnum,
        min: 1,
        max: 11,
        refused: JS_RESERVED,
      },
      {name: 'MAIN', ...HEX20},
      {name: 'DUO_JS', ...HEX20},
      {name: 'WEBAUTHN_FB_JS', ...HEX20},
    ] satisfies SlotSpec[]
  ).map(s => [s.name, Object.freeze(s)]),
);

// Load-time invariant: fail closed if a future edit widens a charset unsafely.
for (const s of SLOTS.values()) {
  for (const b of FORBIDDEN_SLOT_BYTES) {
    if (s.inCharset(b)) throw new Error(`slot ${s.name}: charset contains forbidden byte ${b}`);
  }
  if (!(Number.isSafeInteger(s.min) && s.min >= 1 && s.max >= s.min)) {
    throw new Error(`slot ${s.name}: invalid length bounds`);
  }
}

/** The slot spec, or undefined if `name` is not allowlisted. */
export function getSlotSpec(name: string): SlotSpec | undefined {
  if (typeof name !== 'string') return undefined;
  return SLOTS.get(name);
}

/** NUL "INTACTWARDEN:" (ASCII), the bytes before the slot name in MARK(name). */
const MARK_PREFIX: readonly number[] = [
  0x00, 0x49, 0x4e, 0x54, 0x41, 0x43, 0x54, 0x57, 0x41, 0x52, 0x44, 0x45, 0x4e, 0x3a,
];

/** MARK(name) = 0x00 "INTACTWARDEN:" name 0x00. Names are ASCII [A-Z0-9_]. */
export function slotMark(name: string): Uint8Array {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('slotMark: empty name');
  const out = new Uint8Array(MARK_PREFIX.length + name.length + 1);
  out.set(MARK_PREFIX, 0);
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!(isUpperAlpha(c) || isDigit(c) || c === 0x5f)) throw new TypeError('slotMark: bad name');
    out[MARK_PREFIX.length + i] = c;
  }
  out[out.length - 1] = 0x00;
  return out;
}
