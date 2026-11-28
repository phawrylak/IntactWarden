/**
 * Plural messages: Intl.PluralRules picks
 * the category, and the catalogue holds one message per category as
 * `<base>_one`, `<base>_few`, `<base>_many` and `<base>_other`. Polish needs
 * all four ("1 plik", "2 pliki", "5 plików", "1,5 pliku"); English uses `one`
 * and `other`, and carries `few` / `many` copies of `other` so both
 * catalogues have the same keys (the build's parity check).
 *
 * The count is formatted with Intl.NumberFormat and passed as `$1`; further
 * substitutions follow as `$2`..`$9`.
 */

import {currentLang, t, type Lang} from './t.ts';

export type PluralCategory = 'one' | 'few' | 'many' | 'other';

const rulesCache = new Map<Lang, Intl.PluralRules>();

/** The catalogue category for `n` in `lang` (zero and two map to other, which the catalogues do not carry). */
export function pluralCategory(n: number, lang: Lang = currentLang()): PluralCategory {
  let rules = rulesCache.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(lang);
    rulesCache.set(lang, rules);
  }
  const c = rules.select(n);
  return c === 'one' || c === 'few' || c === 'many' ? c : 'other';
}

/** The key `tn` uses for `n` (exported for tests). */
export function pluralKey(base: string, n: number, lang: Lang = currentLang()): string {
  return `${base}_${pluralCategory(n, lang)}`;
}

export function formatCount(n: number, lang: Lang = currentLang()): string {
  return new Intl.NumberFormat(lang).format(n);
}

/** Plural message: `$1` is the formatted count, `extra` fills `$2`.. */
export function tn(base: string, n: number, extra: readonly string[] = []): string {
  const lang = currentLang();
  return t(pluralKey(base, n, lang), [formatCount(n, lang), ...extra]);
}
