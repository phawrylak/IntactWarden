/**
 * i18n runtime: `t()` asks the browser (Firefox's getMessage, here the stub of
 * ./helpers.ts), falls back to the key, and Polish plural rules.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {formatCount, pluralCategory, pluralKey, tn} from '../../src/i18n/plural.ts';
import {
  currentLang,
  hasMessage,
  langOf,
  reasonKey,
  stateDescKey,
  stateKey,
  t,
} from '../../src/i18n/t.ts';
import {resetI18n, useCatalogue, useLang} from './helpers.ts';

afterEach(() => resetI18n());

describe('t', () => {
  it('formats the browser message and falls back to the key', () => {
    useLang('en');
    expect(t('state_VERIFIED')).toBe('Verified');
    expect(t('popup_self_hosted_lead', ['6 Nov 2026'])).toBe(
      'Server you added on 6 Nov 2026. This proves the code, not who runs the server.',
    );
    expect(t('no_such_key')).toBe('no_such_key');
    expect(hasMessage('no_such_key')).toBe(false);
  });

  it('follows the browser language', () => {
    useLang('pl');
    expect(t('state_VERIFIED')).toBe('Zweryfikowano');
    expect(currentLang()).toBe('pl');
    resetI18n();
    expect(t('state_VERIFIED')).toBe('state_VERIFIED');
    expect(currentLang()).toBe('en');
  });

  it('builds lattice keys as the lattice generator names them', () => {
    expect(stateKey('PROTECTION_LOST')).toBe('state_PROTECTION_LOST');
    expect(stateDescKey('NEW_BUILD')).toBe('state_NEW_BUILD_desc');
    expect(reasonKey('PROTECTION_LOST', 'filter-failed')).toBe(
      'reason_PROTECTION_LOST__filter_failed',
    );
  });

  it('maps browser languages to the shipped catalogues', () => {
    expect(langOf('pl')).toBe('pl');
    expect(langOf('pl-PL')).toBe('pl');
    expect(langOf('pl_PL')).toBe('pl');
    expect(langOf('plk')).toBe('en');
    expect(langOf('de')).toBe('en');
    expect(langOf(undefined)).toBe('en');
  });
});

describe('plurals (Intl.PluralRules)', () => {
  it('uses one, few, many and other in Polish', () => {
    expect([1, 2, 3, 4, 5, 11, 12, 21, 22, 25, 112, 1.5].map(n => pluralCategory(n, 'pl'))).toEqual(
      ['one', 'few', 'few', 'few', 'many', 'many', 'many', 'many', 'few', 'many', 'many', 'other'],
    );
  });

  it('uses one and other in English', () => {
    expect([0, 1, 2, 5].map(n => pluralCategory(n, 'en'))).toEqual([
      'other',
      'one',
      'other',
      'other',
    ]);
  });

  it('formats Polish counts naturally ("1 plik, 2 pliki, 5 plików" style)', () => {
    useLang('pl');
    expect(tn('popup_server_style_accepted', 1)).toBe(
      'Arkusz stylów serwera: zaakceptowany, ukrywa 1 rodzaj elementów.',
    );
    expect(tn('popup_server_style_accepted', 3)).toBe(
      'Arkusz stylów serwera: zaakceptowany, ukrywa 3 rodzaje elementów.',
    );
    expect(tn('popup_server_style_accepted', 12)).toBe(
      'Arkusz stylów serwera: zaakceptowany, ukrywa 12 rodzajów elementów.',
    );
    expect(tn('popup_server_style_accepted', 22)).toBe(
      'Arkusz stylów serwera: zaakceptowany, ukrywa 22 rodzaje elementów.',
    );
    expect(tn('trust_cores_count', 5)).toBe('Dostępnych 5 manifestów.');
    expect(pluralKey('trust_cores_count', 1, 'pl')).toBe('trust_cores_count_one');
  });

  it('formats English counts', () => {
    useLang('en');
    expect(tn('popup_server_style_accepted', 1)).toBe(
      'Server stylesheet: accepted, hides 1 element type.',
    );
    expect(tn('popup_server_style_accepted', 12)).toBe(
      'Server stylesheet: accepted, hides 12 element types.',
    );
    expect(formatCount(1234, 'en')).toBe('1,234');
  });

  it('falls back to the other form when a category key is missing', () => {
    useCatalogue({x_other: {message: '$N$ things', placeholders: {n: {content: '$1'}}}}, 'pl');
    expect(tn('x', 3)).toBe('3 things');
  });
});
