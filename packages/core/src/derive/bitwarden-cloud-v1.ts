/**
 * The Bitwarden cloud derivation.
 *
 * Bitwarden publishes only self-hosted builds of the web vault as release
 * assets. vault.bitwarden.com (ENV=cloud) and vault.bitwarden.eu (ENV=euprd)
 * are separate webpack builds of the same commit. Of the 276 non-map files in
 * `web-<v>-selfhosted-COMMERCIAL.zip`, 270 are served unchanged. The other 6
 * differ only in:
 *
 * - values that webpack's EnvironmentPlugin inlines from
 *   `apps/web/config/{base,<env>}.json` at the tag commit (URLS, PAYPAL_CONFIG,
 *   BRAINTREE_KEY, STRIPE_KEY, ENV);
 * - `CACHE_TAG`, a per-build random nonce
 *   (`Math.random().toString(36).substring(7)`, apps/web/webpack.base.js);
 * - content-hashed file names that follow from those changes (the trailing
 *   `sourceMappingURL` comment of each changed script, and the `src` of the
 *   HTML that loads it).
 *
 * The 6 files and the rules that apply to each:
 *
 * | file                                   | function                  |
 * |----------------------------------------|---------------------------|
 * | `app/main.<h>.js`                      | deriveCloudMain           |
 * | `connectors/duo-redirect.<h>.js`       | deriveCloudConnectorJs    |
 * | `connectors/webauthn-fallback.<h>.js`  | deriveCloudConnectorJs    |
 * | `index.html`                           | deriveCloudHtml (main)    |
 * | `duo-redirect-connector.html`          | deriveCloudHtml (duo)     |
 * | `webauthn-fallback-connector.html`     | deriveCloudHtml (webauthn)|
 *
 * The two connector scripts were checked with a byte diff against the live
 * files (US and EU, 2026-11-05): they differ from the release only in the
 * `messages.json?cache=` tag and the `sourceMappingURL` name. No further rule
 * was needed for any of the 6 files.
 *
 * The derivation is closed and fails closed:
 * - every substitution is an exact literal that must occur exactly once in
 *   the original text, and all substitutions are located in the original text
 *   and applied in one pass, so one can never create, hide or rewrite the
 *   needle of another (overlaps are rejected);
 * - guard counts make sure there is no further `?cache=` site or
 *   `sourceMappingURL` comment that the derivation does not handle;
 * - every input that is not a release byte (CACHE_TAG, file names, config
 *   values) is checked against a fixed charset, so no input can end a string
 *   literal, open a tag or add code;
 * - config files may only contain keys whose effect on the build is known.
 *
 * Anything unexpected throws DeriveError; there is then no core for that
 * variant (never a guess). Text is decoded as strict UTF-8 (a BOM is
 * kept) and re-encoded, so untouched bytes round-trip exactly.
 *
 * Reproduced byte-identically for web-v2026.10.1 on both regions; see
 * fixtures/corpora/bitwarden-web-2026.10.1.lock.json and
 * packages/core/test/bitwarden-cloud.corpus.test.ts.
 */

import {isPlainObject} from '../schema/validate.ts';
import type {SlotOccurrence} from '../template/build.ts';

export interface BitwardenConfigs {
  /** Parsed `apps/web/config/base.json` at the tag commit. */
  base: unknown;
  /** Parsed `apps/web/config/<envName>.json` at the tag commit. */
  env: unknown;
  envName: 'cloud' | 'euprd';
}

export class DeriveError extends Error {
  override name = 'DeriveError';
}

/** A derived file and where the slot values were written into it (byte offsets, in order). */
export interface DerivedFile {
  readonly bytes: Uint8Array;
  readonly slots: readonly SlotOccurrence[];
}

// --- input validation ------------------------------------------------------

/** CACHE_TAG charset and length bounds (the slot list in template/slots.ts). */
const CACHE_TAG_RE = /^[a-z0-9]{1,11}$/;
const MAIN_MAP_RE = /^main\.[0-9a-f]{20}\.js\.map$/;
const CONNECTOR_MAP_RE = /^(?:duo-redirect|webauthn-fallback)\.[0-9a-f]{20}\.js\.map$/;
/** A content-hashed script path as referenced from the HTML. */
const SCRIPT_NAME_RE = /^[A-Za-z0-9._/-]+\.[0-9a-f]{20}\.js$/;
/** Length of the `.<20 hex>.js` suffix of a SCRIPT_NAME_RE name. */
const SCRIPT_HASH_SUFFIX_LENGTH = 24;
/** Object keys that Terser prints unquoted, and that are never `__proto__`. */
const OBJECT_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

const ENV_NAMES: readonly string[] = ['cloud', 'euprd'];

/** The only Bitwarden environment name of the release builds. */
const SELFHOSTED_ENV = 'selfhosted';

const CACHE_MARKER = 'messages.json?cache=';
const DROPIN_MARKER = 'scripts/dropin.js?cache=';
const CACHE_QUERY = '?cache=';
const SOURCE_MAP_MARKER = 'sourceMappingURL';
// A template, so the bundle holds no literal source-map comment (AMO's linter reads one as
// minified code).
const SOURCE_MAP_LINE = `\n//# ${SOURCE_MAP_MARKER}=`;

function checkCacheTag(tag: unknown, label: string): string {
  if (typeof tag !== 'string' || !CACHE_TAG_RE.test(tag)) {
    throw new DeriveError(`${label}: CACHE_TAG must match [a-z0-9]{1,11}, got ${preview(tag)}`);
  }
  return tag;
}

function checkName(name: unknown, re: RegExp, label: string): string {
  if (typeof name !== 'string' || !re.test(name)) {
    throw new DeriveError(`${label}: invalid file name ${preview(name)}`);
  }
  return name;
}

/**
 * Printable ASCII that Terser prints verbatim inside a double-quoted string
 * and that JSON.stringify does not escape. Excludes quotes, backslash, the
 * backtick, `<` and `>` (Terser's inline_script escaping), control characters
 * and non-ASCII (escaping and U+2028/U+2029 rules differ between the two).
 */
function isPlainLiteral(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
    if (c === 0x22 || c === 0x27 || c === 0x5c || c === 0x60 || c === 0x3c || c === 0x3e) {
      return false;
    }
  }
  return true;
}

function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : String(JSON.stringify(value));
  } catch {
    s = Object.prototype.toString.call(value);
  }
  return JSON.stringify(s.length > 120 ? `${s.slice(0, 120)}...` : s);
}

// --- Terser-compatible literal emission ------------------------------------

/** A string literal exactly as Terser prints it (double quotes, no escapes). */
function emitString(value: string): string {
  return `"${value}"`;
}

/** An object literal of string values exactly as Terser prints it. */
function emitObject(entries: ReadonlyArray<readonly [string, string]>): string {
  return `{${entries.map(([k, v]) => `${k}:${emitString(v)}`).join(',')}}`;
}

// --- config files ----------------------------------------------------------

type JsonObject = Record<string, unknown>;

/**
 * Top-level keys of apps/web/config/*.json with a known effect on the build
 * (apps/web/config.js and webpack.base.js at web-v2026.10.1). `dev` only
 * configures the dev server and `devFlags` is replaced by `{}` in production
 * builds; the others are handled below. Any other key fails the derivation
 * until this code has been reviewed for it.
 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'urls',
  'stripeKey',
  'braintreeKey',
  'paypal',
  'flags',
  'additionalRegions',
  'dev',
  'devFlags',
]);

function readConfig(value: unknown, label: string): JsonObject {
  if (!isPlainObject(value)) throw new DeriveError(`${label}: config must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new DeriveError(`${label}: unsupported config key ${preview(key)}`);
    }
  }
  return value;
}

function own(obj: JsonObject, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** `{...base, ...env}[key]`, the shallow merge done by apps/web/config.js. */
function merged(base: JsonObject, env: JsonObject, key: string): unknown {
  return Object.hasOwn(env, key) ? env[key] : own(base, key);
}

function readEntries(
  value: unknown,
  label: string,
  allowEmpty: boolean,
): Array<readonly [string, string]> {
  if (!isPlainObject(value)) throw new DeriveError(`${label}: must be a JSON object`);
  const entries: Array<readonly [string, string]> = [];
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (!OBJECT_KEY_RE.test(key))
      throw new DeriveError(`${label}: unsupported key ${preview(key)}`);
    if (typeof v !== 'string' || !isPlainLiteral(v)) {
      throw new DeriveError(`${label}.${key}: must be a string of plain printable ASCII`);
    }
    entries.push([key, v]);
  }
  if (!allowEmpty && entries.length === 0) throw new DeriveError(`${label}: must not be empty`);
  return entries;
}

function readKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isPlainLiteral(value)) {
    throw new DeriveError(`${label}: must be a non-empty string of plain printable ASCII`);
  }
  return value;
}

/** The EnvironmentPlugin values that differ between builds. */
interface EnvValues {
  urls: ReadonlyArray<readonly [string, string]>;
  stripeKey: string;
  braintreeKey: string;
  paypal: ReadonlyArray<readonly [string, string]>;
}

function envValues(base: JsonObject, env: JsonObject, label: string): EnvValues {
  const urls = merged(base, env, 'urls');
  return {
    // webpack.base.js: `URLS: envConfig["urls"] ?? {}`.
    urls: urls === undefined ? [] : readEntries(urls, `${label}.urls`, true),
    stripeKey: readKey(merged(base, env, 'stripeKey'), `${label}.stripeKey`),
    braintreeKey: readKey(merged(base, env, 'braintreeKey'), `${label}.braintreeKey`),
    // The self-hosted needle must be distinctive, so an empty object is refused.
    paypal: readEntries(merged(base, env, 'paypal'), `${label}.paypal`, false),
  };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

/**
 * Values the derivation does not substitute must be the same in the self-hosted
 * and in the cloud build, or the derivation would silently be wrong.
 */
function checkUnchangedValues(base: JsonObject, env: JsonObject): void {
  // config.js deep-merges `flags`: an env flag must not change base's value.
  if (Object.hasOwn(env, 'flags')) {
    const envFlags = env['flags'];
    const baseFlags = own(base, 'flags') ?? {};
    if (!isPlainObject(envFlags) || !isPlainObject(baseFlags)) {
      throw new DeriveError('config: flags must be JSON objects');
    }
    for (const key of Object.keys(envFlags)) {
      if (!Object.hasOwn(baseFlags, key) || !jsonEqual(baseFlags[key], envFlags[key])) {
        throw new DeriveError(`config: env flag ${preview(key)} changes FLAGS; not derivable`);
      }
    }
  }
  // `ADDITIONAL_REGIONS: envConfig["additionalRegions"] ?? []`.
  if (Object.hasOwn(env, 'additionalRegions')) {
    if (!jsonEqual(env['additionalRegions'], own(base, 'additionalRegions') ?? [])) {
      throw new DeriveError('config: env additionalRegions differ from base; not derivable');
    }
  }
}

/**
 * Values in the self-hosted build and in the cloud build. The self-hosted
 * build merges base.json with selfhosted.json, which at web-v2026.10.1 only
 * sets `dev` and an empty `flags`; so its values are base.json's. Should it
 * set `urls`, a key or `paypal`, a needle is not found and the derivation
 * fails; `flags` or `additionalRegions` set there are not detected, and the
 * derived files would differ from the live ones.
 */
function resolveConfigs(cfg: BitwardenConfigs): {selfhosted: EnvValues; target: EnvValues} {
  const base = readConfig(cfg.base, 'base config');
  const env = readConfig(cfg.env, 'env config');
  checkUnchangedValues(base, env);
  return {selfhosted: envValues(base, {}, 'base'), target: envValues(base, env, 'env')};
}

// --- text and substitutions ------------------------------------------------

const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const encoder = new TextEncoder();

function decodeStrict(bytes: Uint8Array, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new DeriveError(`${label}: not valid UTF-8`);
  }
}

/** All start positions of `needle`, overlapping ones included. */
function positions(text: string, needle: string): number[] {
  if (needle.length === 0) throw new DeriveError('internal: empty needle');
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function requireCount(text: string, needle: string, count: number, label: string): void {
  const n = positions(text, needle).length;
  if (n !== count) {
    throw new DeriveError(
      `${label}: expected ${count} occurrence(s) of ${preview(needle)}, found ${n}`,
    );
  }
}

interface Edit {
  label: string;
  /** Must occur exactly once in the original text. */
  needle: string;
  replacement: string;
  /** The slot value this edit writes: `length` characters at `at` in `replacement`. */
  slot?: {name: string; at: number; length: number};
}

/**
 * Applies all edits at once, each located in the original text, and returns the
 * bytes with the positions of the slot values the edits wrote. Fails if a
 * needle does not occur exactly once or if two needles overlap.
 */
function applyEdits(text: string, edits: readonly Edit[]): DerivedFile {
  const spans = edits
    .map(edit => {
      const at = positions(text, edit.needle);
      if (at.length !== 1) {
        throw new DeriveError(
          `${edit.label}: expected exactly 1 occurrence of ${preview(edit.needle)}, found ${at.length}`,
        );
      }
      return {start: at[0]!, end: at[0]! + edit.needle.length, edit};
    })
    .sort((a, b) => a.start - b.start);
  // Needles and replacements are ASCII, so the text is cut between characters and the pieces
  // encode to the bytes of the whole.
  const pieces: Uint8Array[] = [];
  const slots: SlotOccurrence[] = [];
  let size = 0;
  const put = (piece: string): void => {
    const b = encoder.encode(piece);
    pieces.push(b);
    size += b.length;
  };
  let pos = 0;
  for (const {start, end, edit} of spans) {
    if (start < pos) throw new DeriveError(`${edit.label}: overlaps another substitution`);
    put(text.slice(pos, start));
    if (edit.slot !== undefined) {
      slots.push({offset: size + edit.slot.at, length: edit.slot.length, slot: edit.slot.name});
    }
    put(edit.replacement);
    pos = end;
  }
  put(text.slice(pos));
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const b of pieces) {
    bytes.set(b, at);
    at += b.length;
  }
  return {bytes, slots};
}

function cacheTagEdit(marker: string, from: string, to: string): Edit {
  // The closing quote ends the string literal, so the tag cannot be a prefix.
  return {
    label: `CACHE_TAG ${marker}`,
    needle: `${marker}${from}"`,
    replacement: `${marker}${to}"`,
    slot: {name: 'CACHE_TAG', at: marker.length, length: to.length},
  };
}

/**
 * The `//# sourceMappingURL=<name>` comment that webpack appends as the last
 * line (no trailing newline). It must be the only mention of
 * sourceMappingURL in the file.
 */
function sourceMapEdit(
  text: string,
  re: RegExp,
  newName: string,
  label: string,
  slot: string,
): Edit {
  requireCount(text, SOURCE_MAP_MARKER, 1, `${label} sourceMappingURL`);
  const at = text.lastIndexOf(SOURCE_MAP_LINE);
  const oldName = at < 0 ? '' : text.slice(at + SOURCE_MAP_LINE.length);
  if (!re.test(oldName)) {
    throw new DeriveError(`${label}: the last line must be a sourceMappingURL comment for ${re}`);
  }
  return {
    label: `${label} sourceMappingURL`,
    needle: SOURCE_MAP_LINE + oldName,
    replacement: SOURCE_MAP_LINE + newName,
    // The 20 hex digits after "<stem>.".
    slot: {name: slot, at: SOURCE_MAP_LINE.length + newName.indexOf('.') + 1, length: 20},
  };
}

function fileStem(mapName: string): string {
  return mapName.slice(0, mapName.indexOf('.'));
}

// --- public API ------------------------------------------------------------

/**
 * The CACHE_TAG of a bundle, read from its `messages.json?cache=<tag>"`
 * occurrences. All occurrences must be well formed and agree.
 */
export function extractCacheTag(text: string): string {
  let tag: string | undefined;
  for (const at of positions(text, CACHE_MARKER)) {
    const start = at + CACHE_MARKER.length;
    // At most 11 tag characters, then the closing quote.
    const window = text.slice(start, start + 12);
    const end = window.indexOf('"');
    if (end < 0) {
      throw new DeriveError(`extractCacheTag: no closing quote after ${preview(window)}`);
    }
    const candidate = checkCacheTag(window.slice(0, end), 'extractCacheTag');
    if (tag !== undefined && tag !== candidate) {
      throw new DeriveError(
        `extractCacheTag: CACHE_TAG occurrences disagree (${tag}, ${candidate})`,
      );
    }
    tag = candidate;
  }
  if (tag === undefined) throw new DeriveError(`extractCacheTag: no ${CACHE_MARKER} occurrence`);
  return tag;
}

/**
 * Derives the cloud `app/main.<hash>.js` from the self-hosted one.
 *
 * Rules (each needle exactly once, located in the self-hosted text):
 * 1. CACHE_TAG in `messages.json?cache=<tag>"` (i18n loader) and
 *    `scripts/dropin.js?cache=<tag>"` (Braintree drop-in loader); guard: no
 *    other `?cache=` in the file.
 * 2. URLS: `useValue:<base urls>}` (Angular provider of process.env.URLS) to
 *    the env urls object, keys unquoted as Terser prints them.
 * 3. PAYPAL_CONFIG: the base `{businessId:"..",buttonAction:".."}` literal to
 *    the env one.
 * 4. BRAINTREE_KEY and 5. STRIPE_KEY: the base string literal to the env one.
 * 6. ENV: `isSelfHost(){return"selfhosted"==="selfhosted".toString()}`, the
 *    only inlined use of process.env.ENV, gets the env name as second operand.
 * 7. The sourceMappingURL file name (the cloud bundle's own content hash).
 *
 * Slots: CACHE_TAG at both sites, MAIN in the sourceMappingURL name.
 *
 * @param cacheTag the cloud build's CACHE_TAG, `[a-z0-9]{1,11}`.
 * @param sourceMapName `main.<20 hex>.js.map` of the cloud bundle.
 */
export function deriveCloudMain(
  selfhostedMain: Uint8Array,
  cfg: BitwardenConfigs,
  cacheTag: string,
  sourceMapName: string,
): DerivedFile {
  checkCacheTag(cacheTag, 'deriveCloudMain');
  checkName(sourceMapName, MAIN_MAP_RE, 'deriveCloudMain sourceMapName');
  if (!ENV_NAMES.includes(cfg.envName)) {
    throw new DeriveError(`deriveCloudMain: unsupported envName ${preview(cfg.envName)}`);
  }
  const {selfhosted, target} = resolveConfigs(cfg);
  const text = decodeStrict(selfhostedMain, 'main');
  const srcTag = extractCacheTag(text);
  requireCount(text, CACHE_QUERY, 2, 'main CACHE_TAG sites');
  const selfhostedEnv = emitString(SELFHOSTED_ENV);
  return applyEdits(text, [
    cacheTagEdit(CACHE_MARKER, srcTag, cacheTag),
    cacheTagEdit(DROPIN_MARKER, srcTag, cacheTag),
    {
      label: 'URLS',
      needle: `useValue:${emitObject(selfhosted.urls)}}`,
      replacement: `useValue:${emitObject(target.urls)}}`,
    },
    {
      label: 'PAYPAL_CONFIG',
      needle: emitObject(selfhosted.paypal),
      replacement: emitObject(target.paypal),
    },
    {
      label: 'BRAINTREE_KEY',
      needle: emitString(selfhosted.braintreeKey),
      replacement: emitString(target.braintreeKey),
    },
    {
      label: 'STRIPE_KEY',
      needle: emitString(selfhosted.stripeKey),
      replacement: emitString(target.stripeKey),
    },
    {
      label: 'ENV',
      needle: `${selfhostedEnv}===${selfhostedEnv}.toString()`,
      replacement: `${selfhostedEnv}===${emitString(cfg.envName)}.toString()`,
    },
    sourceMapEdit(text, MAIN_MAP_RE, sourceMapName, 'main', 'MAIN'),
  ]);
}

/**
 * Derives a cloud `connectors/duo-redirect.<hash>.js` or
 * `connectors/webauthn-fallback.<hash>.js` from the self-hosted one. Verified
 * by byte diff against the live files: only the CACHE_TAG in
 * `messages.json?cache=<tag>"` (guard: the only `?cache=`) and the
 * sourceMappingURL name differ. The other connector scripts do not embed
 * CACHE_TAG and are served unchanged. Slots: CACHE_TAG, and `slot` in the
 * sourceMappingURL name.
 *
 * @param sourceMapName `<same connector>.<20 hex>.js.map` of the cloud script.
 * @param slot the connector's content-hash slot (DUO_JS or WEBAUTHN_FB_JS).
 */
export function deriveCloudConnectorJs(
  selfhostedJs: Uint8Array,
  cacheTag: string,
  sourceMapName: string,
  slot: string,
): DerivedFile {
  checkCacheTag(cacheTag, 'deriveCloudConnectorJs');
  checkName(sourceMapName, CONNECTOR_MAP_RE, 'deriveCloudConnectorJs sourceMapName');
  const text = decodeStrict(selfhostedJs, 'connector');
  const srcTag = extractCacheTag(text);
  requireCount(text, CACHE_QUERY, 1, 'connector CACHE_TAG sites');
  const mapEdit = sourceMapEdit(text, CONNECTOR_MAP_RE, sourceMapName, 'connector', slot);
  const oldName = mapEdit.needle.slice(SOURCE_MAP_LINE.length);
  if (fileStem(oldName) !== fileStem(sourceMapName)) {
    throw new DeriveError(
      `deriveCloudConnectorJs: ${preview(sourceMapName)} is not a map of ${preview(oldName)}'s connector`,
    );
  }
  return applyEdits(text, [cacheTagEdit(CACHE_MARKER, srcTag, cacheTag), mapEdit]);
}

function checkScriptName(name: unknown, label: string): string {
  const s = checkName(name, SCRIPT_NAME_RE, label);
  if (s.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) {
    throw new DeriveError(`${label}: invalid path segment in ${preview(s)}`);
  }
  return s;
}

/**
 * Derives a cloud HTML document (index.html, duo-redirect-connector.html,
 * webauthn-fallback-connector.html) from the self-hosted one by swapping the
 * content-hashed names of the scripts it loads. Each `from` must occur exactly
 * once in the document, as the value of a `src="..."` attribute; `to` must be
 * the same script path with another content hash, whose 20 hex digits are the
 * value of `slot`.
 */
export function deriveCloudHtml(
  selfhostedHtml: Uint8Array,
  renames: ReadonlyArray<{from: string; to: string; slot: string}>,
): DerivedFile {
  if (renames.length === 0) throw new DeriveError('deriveCloudHtml: no renames');
  const text = decodeStrict(selfhostedHtml, 'html');
  const edits = renames.map(({from, to, slot}): Edit => {
    checkScriptName(from, 'deriveCloudHtml from');
    checkScriptName(to, 'deriveCloudHtml to');
    if (from.slice(0, -SCRIPT_HASH_SUFFIX_LENGTH) !== to.slice(0, -SCRIPT_HASH_SUFFIX_LENGTH)) {
      throw new DeriveError(`deriveCloudHtml: ${preview(to)} is not a rename of ${preview(from)}`);
    }
    requireCount(text, from, 1, 'deriveCloudHtml');
    return {
      label: `rename ${from}`,
      needle: `src="${from}"`,
      replacement: `src="${to}"`,
      slot: {
        name: slot,
        at: 'src="'.length + to.length - SCRIPT_HASH_SUFFIX_LENGTH + 1,
        length: 20,
      },
    };
  });
  return applyEdits(text, edits);
}
