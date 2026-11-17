/**
 * i18n runtime.
 *
 * - `t(key, substitutions)` asks the browser (`i18n.getMessage`), which picks
 *   `_locales/en` or `_locales/pl` from Firefox's language, with `en` as the
 *   default locale, and fills the placeholders.
 * - Plurals: ./plural.ts (Intl.PluralRules). Times and numbers: ui/shared/format.ts.
 * - Lattice keys: `state_<STATE>`
 *   (title), `state_<STATE>_desc` (description), `reason_<STATE>__<reason>`
 *   with '-' replaced by '_'.
 *
 * A key that the catalogue lacks resolves to the key itself, so a missing
 * string is visible instead of silently empty; the catalogue test
 * (extension/test/ui/catalogue.test.ts) keeps that from shipping.
 */

import type {VerdictState} from '../contracts.ts';
import {getExt} from '../platform/api.ts';

export type Lang = 'en' | 'pl';

/** Maps a BCP 47 tag to a shipped language (anything that is not Polish falls back to English, the default locale). */
export function langOf(tag: string | null | undefined): Lang {
  return typeof tag === 'string' && /^pl(?:[-_]|$)/i.test(tag) ? 'pl' : 'en';
}

/** The browser's message for `key`, or '' (no browser, unknown key, or an error). */
function message(key: string, substitutions?: readonly string[]): string {
  try {
    return getExt().i18n.getMessage(key, substitutions);
  } catch {
    return '';
  }
}

/** Resolves a catalogue key. Substitutions fill `$1`..`$9`. */
export function t(key: string, substitutions: readonly string[] = []): string {
  return message(key, substitutions.length > 0 ? [...substitutions] : undefined) || key;
}

export function hasMessage(key: string): boolean {
  return message(key) !== '';
}

/** The language strings are shown in (for Intl formatting and `<html lang>`). */
export function currentLang(): Lang {
  try {
    return langOf(getExt().i18n.getUILanguage());
  } catch {
    return 'en';
  }
}

// ---------------------------------------------------------------------------
// Lattice keys

export function stateKey(state: VerdictState): string {
  return `state_${state}`;
}

export function stateDescKey(state: VerdictState): string {
  return `state_${state}_desc`;
}

export function reasonKey(state: VerdictState, reason: string): string {
  return `reason_${state}__${reason.replaceAll('-', '_')}`;
}
