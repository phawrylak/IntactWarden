/**
 * Unknown-build decision vectors. The engine
 * decides only after the trust store is ready, so there is no vector for a store that is not.
 */

import {stateRow} from '@intactwarden/core/verdict/states.ts';
import {describe, expect, it} from 'vitest';
import type {ReleaseKey, ReleaseState, UnknownBuildInput} from '../../src/contracts.ts';
import {decideUnknownBuild, GIVE_UP_MS} from '../../src/policy/unknownBuild.ts';

const NOW = 1_700_000_000_000;
const hint = (version: string | null) => ({version, at: NOW});
const key = (
  variant: ReleaseKey['variant'],
  version: string,
  app: ReleaseKey['app'] = 'bitwarden-web',
): ReleaseKey => ({
  app,
  variant,
  version,
});
const failed = (
  failure: Extract<ReleaseState, {k: 'failed'}>['failure'],
  transient: boolean,
  retryAt: number | null = null,
): ReleaseState => ({
  k: 'failed',
  failure,
  transient,
  at: NOW,
  retryAt,
});
const known: ReleaseState = {k: 'known', refs: []};
const working: ReleaseState = {k: 'working', jobId: 'j', phase: 'downloading', since: NOW};

/** The hinted cloud-us release 2026.11.0 in `state`. */
const cloudUs = (state: ReleaseState) => ({key: key('cloud-us', '2026.11.0'), state});

function input(over: Partial<UnknownBuildInput>): UnknownBuildInput {
  return {
    deploymentKind: 'cloud',
    hint: hint('2026.11.0'),
    release: cloudUs({k: 'unknown'}),
    differsAtManifestPath: false,
    waitingSince: NOW - 1000,
    backgroundRetry: false,
    now: NOW,
    ...over,
  };
}

describe('decideUnknownBuild (decision vectors)', () => {
  it('hint not fetched → fetch-hint', () => {
    expect(decideUnknownBuild(input({hint: null})).k).toBe('fetch-hint');
  });
  it('cloud, hint 404 → BUILD_UNVERIFIED not-derivable', () => {
    const d = decideUnknownBuild(input({hint: hint(null), release: null}));
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'not-derivable'},
    });
  });
  it('unknown (no state yet) → ensure: deep verify starts', () => {
    const d = decideUnknownBuild(input({}));
    expect(d).toMatchObject({k: 'ensure', key: key('cloud-us', '2026.11.0')});
  });
  it('working → wait catching-up', () => {
    const d = decideUnknownBuild(input({release: cloudUs(working)}));
    expect(d).toMatchObject({k: 'wait', retryAt: null, contribution: {reason: 'catching-up'}});
  });
  it('known, differs at the document path → MISMATCH release-differs', () => {
    const d = decideUnknownBuild(input({release: cloudUs(known), differsAtManifestPath: true}));
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'MISMATCH', reason: 'release-differs'},
    });
  });
  it('Vaultwarden image-only release → BUILD_UNVERIFIED image-only-release', () => {
    const d = decideUnknownBuild(
      input({
        deploymentKind: 'self-hosted',
        release: {
          key: key('release', '2026.8.0', 'vaultwarden-web'),
          state: failed('image-only-release', false),
        },
      }),
    );
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'image-only-release'},
    });
  });
  it('self-hosted, no such release → selfhost-unpublished', () => {
    const d = decideUnknownBuild(
      input({
        deploymentKind: 'self-hosted',
        release: {
          key: key('selfhosted-commercial', '2026.11.0'),
          state: failed('release-not-found', false),
        },
      }),
    );
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'selfhost-unpublished'},
    });
  });
  it('rate-limited, first attempt 1 min ago → wait unavailable until retryAt', () => {
    const d = decideUnknownBuild(
      input({
        release: cloudUs(failed('rate-limited', true, NOW + 300_000)),
        waitingSince: NOW - 60_000,
      }),
    );
    expect(d).toMatchObject({
      k: 'wait',
      retryAt: NOW + 300_000,
      contribution: {reason: 'unavailable'},
    });
  });
  it('rate-limited, first attempt 11 min ago → final per kind, no retry before retryAt', () => {
    const d = decideUnknownBuild(
      input({
        release: cloudUs(failed('rate-limited', true, NOW + 300_000)),
        waitingSince: NOW - GIVE_UP_MS - 60_000,
      }),
    );
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'not-derivable'},
    });
    expect(d).not.toHaveProperty('ensure');
  });
  it('GitHub permission missing → wait unavailable until the give-up time, then final per kind', () => {
    // The store retries a missing permission 10 minutes after the failure, which came just after
    // the first deep verify.
    const release = cloudUs(failed('permission-missing', true, NOW - 59_000 + 10 * 60_000));
    const start = NOW - 60_000;
    expect(decideUnknownBuild(input({release, waitingSince: start}))).toMatchObject({
      k: 'wait',
      retryAt: start + GIVE_UP_MS + 1,
      contribution: {state: 'NEW_BUILD', reason: 'unavailable'},
    });
    const late = decideUnknownBuild(input({release, waitingSince: NOW - GIVE_UP_MS - 1}));
    expect(late).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'not-derivable'},
    });
    expect(late).not.toHaveProperty('ensure');
  });
  it('a transient failure with its retry due → ensure before the give-up time, final with a background ensure after it', () => {
    const states = [
      failed('network', true, null),
      failed('network', true, NOW - 1),
      failed('rate-limited', true, NOW - 1),
      // After a browser restart: no deep verify yet in this session, the clock is the document's.
      failed('permission-missing', true, NOW - 1),
    ];
    for (const st of states) {
      const release = cloudUs(st);
      expect(decideUnknownBuild(input({release, waitingSince: NOW - 60_000}))).toMatchObject({
        k: 'ensure',
      });
      expect(
        decideUnknownBuild(input({release, waitingSince: NOW - GIVE_UP_MS - 1})),
      ).toMatchObject({
        k: 'final',
        contribution: {state: 'BUILD_UNVERIFIED', reason: 'not-derivable'},
        ensure: key('cloud-us', '2026.11.0'),
      });
    }
  });
  it('past the give-up time: permanent failures, a spent budget, disputes and image-only releases start no retry', () => {
    const states: ReleaseState[] = [
      failed('release-not-found', false),
      failed('asset-not-found', false),
      failed('digest-unavailable', false),
      failed('digest-mismatch', false),
      failed('build-refused', false),
      // engine/unknownBuild.ts: a retry the deep-verify budget does not allow.
      failed('limit-reached', false),
      failed('image-only-release', false),
      {k: 'disputed', reason: 'pin-changed', at: NOW},
    ];
    for (const st of states) {
      for (const waitingSince of [NOW - 60_000, NOW - GIVE_UP_MS - 60_000]) {
        const d = decideUnknownBuild(input({release: cloudUs(st), waitingSince}));
        expect(d.k, `${JSON.stringify(st)}`).toBe('final');
        expect(d, `${JSON.stringify(st)}`).not.toHaveProperty('ensure');
      }
    }
  });
  it('past the give-up time: unknown (never tried, or a failure forgotten) → one fresh attempt', () => {
    const d = decideUnknownBuild(input({waitingSince: NOW - GIVE_UP_MS - 60_000}));
    expect(d).toMatchObject({k: 'ensure', key: key('cloud-us', '2026.11.0')});
  });
  it('past the give-up time: a running deep verify (the first, a fresh attempt) is waited for', () => {
    const d = decideUnknownBuild(
      input({release: cloudUs(working), waitingSince: NOW - GIVE_UP_MS - 60_000}),
    );
    expect(d).toMatchObject({k: 'wait', retryAt: null, contribution: {reason: 'catching-up'}});
  });
  it('a background retry running → final past the give-up time (no second retry), else wait', () => {
    const release = cloudUs(working);
    const late = decideUnknownBuild(
      input({release, backgroundRetry: true, waitingSince: NOW - GIVE_UP_MS - 60_000}),
    );
    expect(late).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'not-derivable'},
    });
    expect(late).not.toHaveProperty('ensure');
    // Another origin's background retry of the same release, before this origin's give-up time.
    expect(
      decideUnknownBuild(input({release, backgroundRetry: true, waitingSince: NOW - 60_000})),
    ).toMatchObject({k: 'wait', contribution: {reason: 'catching-up'}});
  });
  it('disputed → DISPUTED pin-changed', () => {
    const d = decideUnknownBuild(
      input({release: cloudUs({k: 'disputed', reason: 'pin-changed', at: NOW})}),
    );
    expect(d).toMatchObject({k: 'final', contribution: {state: 'DISPUTED', reason: 'pin-changed'}});
  });
  it('self-hosted: the hinted release is known and differs → MISMATCH at once', () => {
    // One variant per deployment: no second edition to wait for.
    const d = decideUnknownBuild(
      input({
        deploymentKind: 'self-hosted',
        release: {key: key('selfhosted-commercial', '2026.10.1'), state: known},
        differsAtManifestPath: true,
      }),
    );
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'MISMATCH', reason: 'release-differs'},
    });
  });
  it('known, document path not in the core → final per kind', () => {
    const d = decideUnknownBuild(input({release: cloudUs(known)}));
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'not-derivable'},
    });
  });
  it('digest-mismatch (permanent) → final per kind', () => {
    const d = decideUnknownBuild(input({release: cloudUs(failed('digest-mismatch', false))}));
    expect(d).toMatchObject({
      k: 'final',
      contribution: {state: 'BUILD_UNVERIFIED', reason: 'not-derivable'},
    });
  });
  it('is never red without evidence', () => {
    const disputed: ReleaseState = {k: 'disputed', reason: 'pin-changed', at: NOW};
    const states: ReleaseState[] = [
      {k: 'unknown'},
      known,
      working,
      failed('network', true),
      failed('build-refused', false),
      failed('release-not-found', false),
      disputed,
    ];
    for (const st of states) {
      for (const differs of [false, true]) {
        for (const deploymentKind of ['cloud', 'self-hosted'] as const) {
          const d = decideUnknownBuild(
            input({release: cloudUs(st), differsAtManifestPath: differs, deploymentKind}),
          );
          if (!('contribution' in d) || stateRow(d.contribution.state).colour !== 'red') continue;
          // Evidence: a known release whose bytes differ, or GitHub contradicting a pin.
          const evidence = (st.k === 'known' && differs) || st.k === 'disputed';
          expect(evidence, `${st.k} differs=${differs} ${deploymentKind}`).toBe(true);
        }
      }
    }
  });
});
