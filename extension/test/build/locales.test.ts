import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  checkCatalogues,
  copyLocales,
  manifestMessageKeys,
  readCatalogues,
} from '../../build/locales.ts';

const en = {
  extName: {message: 'IntactWarden'},
  extDescription: {message: 'Checks web vaults.'},
  actionTitle: {message: 'IntactWarden'},
  count: {message: '$N$ files', placeholders: {n: {content: '$1', example: '3'}}},
};
const pl = {
  extName: {message: 'IntactWarden'},
  extDescription: {message: 'Sprawdza sejfy.'},
  actionTitle: {message: 'IntactWarden'},
  count: {message: 'Pliki: $n$', placeholders: {N: {content: '$1'}}},
};
const REQUIRED = ['extName', 'extDescription', 'actionTitle'];

const omit = (o: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

const check = (c: Record<string, unknown>, required: readonly string[] = REQUIRED): string[] =>
  checkCatalogues(new Map(Object.entries(c)), required);

describe('checkCatalogues', () => {
  it('accepts matching en and pl catalogues (placeholder names ignore case)', () => {
    expect(check({en, pl})).toEqual([]);
  });

  it('requires en and pl', () => {
    expect(check({en})).toEqual(['missing required locale pl']);
  });

  it('requires the manifest keys in en', () => {
    expect(check({en: omit(en, 'actionTitle'), pl: omit(pl, 'actionTitle')})).toEqual([
      'en: missing required key actionTitle',
    ]);
  });

  it('requires key parity with en', () => {
    const errors = check({en, pl: {...pl, extra: {message: 'x'}, count: undefined}});
    expect(errors).toContain('pl: key extra is not in en');
    expect(errors.some(e => e.startsWith('pl: count'))).toBe(true);
    expect(check({en, pl: omit(pl, 'count')})).toEqual(['pl: missing key count']);
  });

  it('requires the same placeholders per key', () => {
    const errors = check({
      en,
      pl: {...pl, count: {message: '$m$', placeholders: {m: {content: '$1'}}}},
    });
    expect(errors).toEqual(['pl: count placeholders [m] differ from [n]']);
  });

  it('refuses undeclared placeholder references but allows $$', () => {
    expect(
      check({en: {...en, cost: {message: '$$5 and $x$'}}, pl: {...pl, cost: {message: '5'}}}),
    ).toEqual(['en: cost: undeclared placeholder $x$']);
    expect(
      check({en: {...en, cost: {message: 'US$$5'}}, pl: {...pl, cost: {message: '5'}}}),
    ).toEqual([]);
  });

  it('refuses invalid names, case-only duplicates, bad entries and bad placeholder content', () => {
    const errors = check({
      en: {
        ...en,
        'bad-name': {message: 'x'},
        '@@ui_locale': {message: 'x'},
        Count: {message: 'y'},
        noMessage: {description: 'd'},
        extra: {message: 'x', unknown: 1},
        ph: {message: '$a$', placeholders: {a: {content: '$0'}}},
      },
      pl,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'en: bad-name: invalid name',
        'en: @@ui_locale: invalid name',
        'en: Count: differs from count only in case',
        'en: noMessage: entry needs a string "message"',
        'en: extra: unknown field unknown',
        'en: ph: placeholder a uses $0',
      ]),
    );
  });

  it('refuses locale directory names that are not locale codes', () => {
    expect(check({en, pl, 'en-US': en})).toContain('en-US: not a WebExtension locale code');
    expect(check({en, pl, en_GB: en})).toEqual([]);
  });
});

describe('copyLocales', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, {recursive: true, force: true});
    dir = null;
  });

  it('copies every catalogue byte for byte after checking', async () => {
    dir = await mkdtemp(join(tmpdir(), 'iw-locales-'));
    const src = join(dir, 'src');
    const enText = `${JSON.stringify(en, null, 2)}\n`;
    const plText = `${JSON.stringify(pl, null, 4)}`;
    await mkdir(join(src, 'en'), {recursive: true});
    await mkdir(join(src, 'pl'), {recursive: true});
    await writeFile(join(src, 'en', 'messages.json'), enText);
    await writeFile(join(src, 'pl', 'messages.json'), plText);
    const out = join(dir, 'out');
    expect(await copyLocales(src, out, REQUIRED)).toEqual([
      '_locales/en/messages.json',
      '_locales/pl/messages.json',
    ]);
    expect(await readFile(join(out, '_locales', 'en', 'messages.json'), 'utf8')).toBe(enText);
    expect(await readFile(join(out, '_locales', 'pl', 'messages.json'), 'utf8')).toBe(plText);
  });

  it('fails with every error and copies nothing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'iw-locales-'));
    const src = join(dir, 'src');
    await mkdir(join(src, 'en'), {recursive: true});
    await writeFile(join(src, 'en', 'messages.json'), JSON.stringify(en));
    await expect(copyLocales(src, join(dir, 'out'), REQUIRED)).rejects.toThrow(
      /missing required locale pl/,
    );
    await expect(readCatalogues(join(dir, 'nope'))).rejects.toThrow(/catalogue is required/);
  });

  it('reports a catalogue that is not JSON', async () => {
    dir = await mkdtemp(join(tmpdir(), 'iw-locales-'));
    await mkdir(join(dir, 'en'), {recursive: true});
    await writeFile(join(dir, 'en', 'messages.json'), '{');
    await expect(readCatalogues(dir)).rejects.toThrow(/messages\.json/);
  });
});

describe('manifestMessageKeys', () => {
  it('lists every __MSG_*__ key in a manifest', () => {
    expect(
      manifestMessageKeys({
        name: '__MSG_extName__',
        action: {default_title: '__MSG_actionTitle__'},
        list: ['__MSG_b__ and __MSG_a__'],
      }),
    ).toEqual(['a', 'actionTitle', 'b', 'extName']);
  });
});
