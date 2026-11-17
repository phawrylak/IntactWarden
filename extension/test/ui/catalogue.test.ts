/**
 * Catalogue completeness: every lattice key, every key used in
 * UI code and every code map value exists in both `en` and `pl` with the same
 * placeholders; plural keys carry all four categories; profile-named refusal
 * messages and the ids the UI labels exist.
 */

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {LATTICE} from '@intactwarden/core/verdict/states.ts';
import {APP_PROFILES} from '@intactwarden/profiles';
import {MANIFEST_MESSAGE_KEYS} from '../../src/contracts.ts';
import {checkCatalogues} from '../../build/locales.ts';
import {reasonKey, stateDescKey, stateKey} from '../../src/i18n/t.ts';
import * as labels from '../../src/ui/shared/labels.ts';
import {CHECKLIST_KEYS} from '../../src/ui/incidents/model.ts';
import {NOT_PROVEN_KEYS} from '../../src/ui/onboarding/model.ts';
import {loadCatalogue} from './helpers.ts';

const en = loadCatalogue('en');
const pl = loadCatalogue('pl');
const SRC = join(import.meta.dirname, '..', '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const UI_FILES = [...files(join(SRC, 'ui')), ...files(join(SRC, 'i18n'))];

function codeKeys(): {single: Set<string>; plural: Set<string>} {
  const single = new Set<string>();
  const plural = new Set<string>();
  for (const f of UI_FILES) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) single.add(m[1]!);
    for (const m of text.matchAll(/\btn\(\s*'([A-Za-z0-9_]+)'/g)) plural.add(m[1]!);
  }
  return {single, plural};
}

function mapKeys(): string[] {
  const out: string[] = [];
  for (const value of Object.values(labels)) {
    if (typeof value === 'object' && value !== null)
      out.push(...(Object.values(value) as string[]));
  }
  out.push(...CHECKLIST_KEYS, ...NOT_PROVEN_KEYS);
  return out;
}

describe('catalogues', () => {
  it('pass the build checks (structure, en/pl parity, placeholders, manifest keys)', () => {
    expect(
      checkCatalogues(
        new Map([
          ['en', en],
          ['pl', pl],
        ]),
        MANIFEST_MESSAGE_KEYS,
      ),
    ).toEqual([]);
  });

  it('carry every verdict-lattice key in both languages', () => {
    const missing: string[] = [];
    for (const row of LATTICE) {
      const keys = [
        stateKey(row.state),
        stateDescKey(row.state),
        ...row.reasons.map(r => reasonKey(row.state, r)),
      ];
      for (const k of keys) {
        if (!(k in en)) missing.push(`en:${k}`);
        if (!(k in pl)) missing.push(`pl:${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('carry every key the UI code uses', () => {
    const {single, plural} = codeKeys();
    expect(single.size).toBeGreaterThan(100);
    const missing = [...single, ...mapKeys()].filter(k => !(k in en) || !(k in pl));
    expect(missing).toEqual([]);
    for (const base of plural) {
      for (const c of ['one', 'few', 'many', 'other']) {
        expect(en, `${base}_${c}`).toHaveProperty(`${base}_${c}`);
        expect(pl, `${base}_${c}`).toHaveProperty(`${base}_${c}`);
      }
    }
  });

  it('has a label for every third party and deployment of the bundled profiles', () => {
    for (const p of APP_PROFILES) {
      for (const tp of p.third_party)
        expect(labels.keyFor(labels.THIRD_PARTY_LABEL, tp.id), tp.id).not.toBeNull();
      for (const d of p.deployments)
        expect(labels.keyFor(labels.DEPLOYMENT_LABEL, d.id), d.id).not.toBeNull();
    }
  });

  it('has no empty message, and Polish is a translation, not a copy', () => {
    const keys = Object.keys(en);
    for (const k of keys) {
      expect(en[k]!.message.trim(), k).not.toBe('');
      expect(pl[k]!.message.trim(), k).not.toBe('');
    }
    const same = keys.filter(k => en[k]!.message === pl[k]!.message);
    // Product names, browser names, formats like "{state}: …" and hash rows are legitimately equal.
    expect(same.length / keys.length).toBeLessThan(0.1);
  });

  it('uses Polish typographic quotes and dashes, never ASCII double quotes', () => {
    for (const [k, v] of Object.entries(pl)) expect(v.message, k).not.toMatch(/"/);
  });
});
