/**
 * Locale catalogue checks and copy. The build copies the catalogue
 * (`extension/_locales/<locale>/messages.json`) byte for byte after checking:
 *
 * - `en` (the manifests' `default_locale`) and `pl` exist; locale directory names are WebExtension
 *   locale codes;
 * - every file is a JSON object of `{message, description?, placeholders?}` entries with valid
 *   names (ASCII letters, digits, `_`, `@`; no `@@` prefix; no two names that differ only in case,
 *   because browsers look names up case-insensitively);
 * - every locale has exactly the key set of `en`, and each key the same placeholder names;
 * - every `$name$` in a message is a declared placeholder, and every placeholder content is
 *   `$1`…`$9` or literal text;
 * - the keys the build needs (`MANIFEST_MESSAGE_KEYS`, every `__MSG_*__` of the manifest) exist.
 */

import {copyFile, mkdir, readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const DEFAULT_LOCALE = 'en';
/** Locales every build must ship (English and Polish). */
export const REQUIRED_LOCALES = Object.freeze(['en', 'pl']);

const LOCALE_CODE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MESSAGE_NAME = /^[A-Za-z0-9_@]+$/;
const PLACEHOLDER_NAME = /^[A-Za-z0-9_@]+$/;
const PLACEHOLDER_REF = /\$([A-Za-z0-9_@]+)\$/g;
const PLACEHOLDER_CONTENT_REF = /\$([0-9]+)/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates one parsed catalogue; returns its placeholder names per key, or errors. */
function checkCatalogue(
  locale: string,
  raw: unknown,
  errors: string[],
): Map<string, string[]> | null {
  if (!isRecord(raw)) {
    errors.push(`${locale}: messages.json is not a JSON object`);
    return null;
  }
  const out = new Map<string, string[]>();
  const lower = new Map<string, string>();
  for (const [name, entry] of Object.entries(raw)) {
    const where = `${locale}: ${name}`;
    if (!MESSAGE_NAME.test(name) || name.startsWith('@@')) errors.push(`${where}: invalid name`);
    const prev = lower.get(name.toLowerCase());
    if (prev !== undefined) errors.push(`${where}: differs from ${prev} only in case`);
    lower.set(name.toLowerCase(), name);
    if (!isRecord(entry) || typeof entry['message'] !== 'string') {
      errors.push(`${where}: entry needs a string "message"`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!['message', 'description', 'placeholders'].includes(key)) {
        errors.push(`${where}: unknown field ${key}`);
      }
    }
    if (entry['description'] !== undefined && typeof entry['description'] !== 'string') {
      errors.push(`${where}: description must be a string`);
    }
    const declared = new Map<string, string>();
    const ph = entry['placeholders'];
    if (ph !== undefined) {
      if (!isRecord(ph)) {
        errors.push(`${where}: placeholders must be an object`);
      } else {
        for (const [pName, p] of Object.entries(ph)) {
          if (!PLACEHOLDER_NAME.test(pName)) errors.push(`${where}: invalid placeholder ${pName}`);
          if (declared.has(pName.toLowerCase())) {
            errors.push(`${where}: placeholder ${pName} declared twice (names ignore case)`);
          }
          declared.set(pName.toLowerCase(), pName);
          if (!isRecord(p) || typeof p['content'] !== 'string') {
            errors.push(`${where}: placeholder ${pName} needs a string "content"`);
            continue;
          }
          for (const m of p['content'].matchAll(PLACEHOLDER_CONTENT_REF)) {
            const n = Number(m[1]);
            if (n < 1 || n > 9) errors.push(`${where}: placeholder ${pName} uses $${m[1]}`);
          }
        }
      }
    }
    // `$$` is a literal dollar sign; remove it before looking for references.
    const message = entry['message'].replaceAll('$$', '');
    for (const m of message.matchAll(PLACEHOLDER_REF)) {
      const ref = m[1] ?? '';
      if (!declared.has(ref.toLowerCase()))
        errors.push(`${where}: undeclared placeholder $${ref}$`);
    }
    out.set(name, [...declared.keys()].sort());
  }
  return out;
}

/**
 * Checks parsed catalogues (locale → parsed messages.json) for structure, parity with `en` and the
 * required keys. Returns error messages; empty means the catalogue may ship.
 */
export function checkCatalogues(
  catalogues: ReadonlyMap<string, unknown>,
  requiredKeys: readonly string[],
): string[] {
  const errors: string[] = [];
  for (const locale of REQUIRED_LOCALES) {
    if (!catalogues.has(locale)) errors.push(`missing required locale ${locale}`);
  }
  const checked = new Map<string, Map<string, string[]>>();
  for (const [locale, raw] of [...catalogues].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!LOCALE_CODE.test(locale)) errors.push(`${locale}: not a WebExtension locale code`);
    const c = checkCatalogue(locale, raw, errors);
    if (c !== null) checked.set(locale, c);
  }
  const reference = checked.get(DEFAULT_LOCALE);
  if (reference === undefined) return errors;
  for (const key of requiredKeys) {
    if (!reference.has(key)) errors.push(`${DEFAULT_LOCALE}: missing required key ${key}`);
  }
  for (const [locale, c] of checked) {
    if (locale === DEFAULT_LOCALE) continue;
    for (const key of reference.keys()) {
      if (!c.has(key)) errors.push(`${locale}: missing key ${key}`);
    }
    for (const [key, placeholders] of c) {
      const ref = reference.get(key);
      if (ref === undefined) errors.push(`${locale}: key ${key} is not in ${DEFAULT_LOCALE}`);
      else if (ref.join(',') !== placeholders.join(',')) {
        errors.push(`${locale}: ${key} placeholders [${placeholders}] differ from [${ref}]`);
      }
    }
  }
  return errors;
}

/** Reads `<dir>/<locale>/messages.json` for every locale directory. */
export async function readCatalogues(dir: string): Promise<Map<string, unknown>> {
  let names: string[];
  try {
    names = (await readdir(dir, {withFileTypes: true}))
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${dir} is missing: the i18n catalogue is required to build`);
    }
    throw e;
  }
  const out = new Map<string, unknown>();
  for (const locale of names) {
    const path = join(dir, locale, 'messages.json');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new Error(`${path} is missing`);
    }
    try {
      out.set(locale, JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Checks the catalogue in `srcDir` and copies every `messages.json`, byte for byte, to
 * `<outDir>/_locales/<locale>/messages.json`. Throws with every error found.
 */
export async function copyLocales(
  srcDir: string,
  outDir: string,
  requiredKeys: readonly string[],
): Promise<string[]> {
  const catalogues = await readCatalogues(srcDir);
  const errors = checkCatalogues(catalogues, requiredKeys);
  if (errors.length > 0) throw new Error(`locale catalogue:\n  ${errors.join('\n  ')}`);
  const written: string[] = [];
  for (const locale of catalogues.keys()) {
    const dest = join(outDir, '_locales', locale);
    await mkdir(dest, {recursive: true});
    await copyFile(join(srcDir, locale, 'messages.json'), join(dest, 'messages.json'));
    written.push(`_locales/${locale}/messages.json`);
  }
  return written;
}

/** The `__MSG_<key>__` names a manifest references (in any string value). */
export function manifestMessageKeys(manifest: unknown): string[] {
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) keys.add(m[1] ?? '');
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (isRecord(v)) {
      Object.values(v).forEach(walk);
    }
  };
  walk(manifest);
  return [...keys].sort();
}
