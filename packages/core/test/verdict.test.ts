import {describe, expect, it} from 'vitest';
import {
  ASSURANCE_CLASSES,
  isGreen,
  isVerdictState,
  join,
  joinAll,
  LATTICE,
  rankOf,
  stateRow,
  type VerdictState,
} from '../src/verdict/states.ts';

const VERDICT_STATES: readonly VerdictState[] = LATTICE.map(r => r.state);

/** The rank of every state, highest first. */
const RANKS: Record<VerdictState, number> = {
  MISMATCH: 30,
  DISPUTED: 26,
  PROTECTION_LOST: 25,
  BUILD_UNVERIFIED: 20,
  CO_RESIDENT_UNVERIFIED: 19,
  THIRD_PARTY_CODE: 17,
  UNVERIFIED_STYLE: 16,
  RECOVERING: 14,
  ROLLBACK: 13,
  NEW_BUILD: 11,
  NOT_COVERED: 6,
  VERIFIED: 1,
  NOT_PROTECTED: 0,
};

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('verdict lattice table', () => {
  it('names reasons in kebab-case, one list per state', () => {
    for (const r of LATTICE) {
      for (const code of r.reasons) expect(code, r.state).toMatch(KEBAB);
    }
    // A reason that is data (THIRD_PARTY_CODE: the host) has no codes.
    expect(stateRow('THIRD_PARTY_CODE').reasons).toEqual([]);
  });

  it('has exactly these states and ranks, highest first', () => {
    expect(Object.fromEntries(LATTICE.map(r => [r.state, r.rank]))).toEqual(RANKS);
    const ranks = LATTICE.map(r => r.rank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(LATTICE)).toBe(true);
    for (const r of LATTICE) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.reasons)).toBe(true);
    }
    expect(() => (LATTICE as unknown as unknown[]).push({})).toThrow();
  });

  it('maps icons to colours consistently', () => {
    const red = LATTICE.filter(r => r.colour === 'red').map(r => r.state);
    expect(red).toEqual(['MISMATCH', 'DISPUTED', 'PROTECTION_LOST']);
    expect(stateRow('PROTECTION_LOST').icon).toBe('red-outline');
    expect(stateRow('NEW_BUILD').icon).toBe('amber-spinner');
    expect(stateRow('NOT_COVERED').icon).toBe('grey-outline');
    expect(stateRow('VERIFIED').icon).toBe('green-solid');
    expect(stateRow('NOT_PROTECTED').icon).toBe('default');
    expect(LATTICE.filter(r => r.colour === 'green').map(r => r.state)).toEqual(['VERIFIED']);
  });

  it('carries one action per state', () => {
    expect(stateRow('MISMATCH').action).toBe('deny');
    expect(stateRow('DISPUTED')).toMatchObject({reasons: ['pin-changed'], action: 'deny'});
    const bu = stateRow('BUILD_UNVERIFIED');
    expect(bu.reasons).toEqual(['not-derivable', 'selfhost-unpublished', 'image-only-release']);
    // Every reason is denied; "Proceed once" is the only way past.
    expect(bu.action).toBe('deny');
    expect(bu.proceed_once).toBe(true);
    expect(stateRow('CO_RESIDENT_UNVERIFIED').reasons).toContain('third-party-code');
    expect(stateRow('THIRD_PARTY_CODE').action).toBe('deny-unless-tab-allowed');
    expect(stateRow('UNVERIFIED_STYLE')).toMatchObject({
      colour: 'amber',
      reasons: ['custom-rules', 'malformed'],
      action: 'deny-unless-tab-allowed',
    });
    // A new build is never released while it is checked; an older build is amber, never denied.
    expect(stateRow('NEW_BUILD').action).toBe('deny-with-auto-retry');
    expect(stateRow('ROLLBACK')).toMatchObject({colour: 'amber', action: 'allow'});
    // An auth-flow page with content is denied like /admin, with no way past it.
    expect(stateRow('NOT_COVERED').action).toBe('deny');
    expect(stateRow('NOT_COVERED').proceed_once).toBeUndefined();
    expect(stateRow('PROTECTION_LOST').action).toBe('deny');
    for (const s of ['VERIFIED', 'NOT_PROTECTED'] as const)
      expect(stateRow(s).action).toBe('allow');
  });
});

describe('join', () => {
  it('returns the higher-rank state', () => {
    expect(join('VERIFIED', 'MISMATCH')).toBe('MISMATCH');
    expect(join('MISMATCH', 'VERIFIED')).toBe('MISMATCH');
    expect(join('NEW_BUILD', 'NOT_COVERED')).toBe('NEW_BUILD');
    expect(join('NOT_PROTECTED', 'VERIFIED')).toBe('VERIFIED');
  });

  it('is commutative, associative and idempotent', () => {
    for (const a of VERDICT_STATES) {
      expect(join(a, a)).toBe(a);
      for (const b of VERDICT_STATES) {
        expect(join(a, b)).toBe(join(b, a));
        expect(rankOf(join(a, b))).toBe(Math.max(rankOf(a), rankOf(b)));
        for (const c of ['MISMATCH', 'BUILD_UNVERIFIED', 'VERIFIED'] as const) {
          expect(join(join(a, b), c)).toBe(join(a, join(b, c)));
        }
      }
    }
  });

  it('treats unknown values as PROTECTION_LOST (fail closed, R1)', () => {
    const bogus = 'GREEN' as VerdictState;
    expect(isVerdictState(bogus)).toBe(false);
    expect(join(bogus, 'VERIFIED')).toBe('PROTECTION_LOST');
    expect(join('VERIFIED', bogus)).toBe('PROTECTION_LOST');
    expect(join(bogus, 'MISMATCH')).toBe('MISMATCH');
    expect(isGreen(join(bogus, bogus))).toBe(false);
    expect(join('toString' as VerdictState, 'NOT_PROTECTED')).toBe('PROTECTION_LOST');
  });

  it('joinAll() folds from NOT_PROTECTED', () => {
    expect(joinAll([])).toBe('NOT_PROTECTED');
    expect(joinAll(['VERIFIED', 'ROLLBACK', 'VERIFIED'])).toBe('ROLLBACK');
  });
});

describe('isGreen', () => {
  it('is true only for VERIFIED', () => {
    expect(VERDICT_STATES.filter(isGreen)).toEqual(['VERIFIED']);
    expect(isGreen('NOT_PROTECTED')).toBe(false);
    expect(isGreen('NEW_BUILD')).toBe(false);
  });
});

describe('assurance classes', () => {
  it('only release-exact and release-derived exist', () => {
    expect([...ASSURANCE_CLASSES]).toEqual(['release-exact', 'release-derived']);
  });
});
