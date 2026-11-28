/**
 * Unknown-build resolution. Pure.
 *
 * A document whose bytes match no known core: fetch the server's version hint, deep verify the
 * hinted release locally from GitHub (NEW_BUILD `catching-up` while it runs, `unavailable` while
 * GitHub cannot be reached), then MISMATCH `release-differs` (the release is known and the
 * document differs at one of its manifest paths), DISPUTED `pin-changed` (GitHub contradicts a
 * pin) or BUILD_UNVERIFIED (`not-derivable`, `selfhost-unpublished`, `image-only-release`; also a
 * release still not fetched GIVE_UP_MS after its first deep verify, whose due retries then run in
 * the background). A release that becomes known verifies the next load of the page; a page let
 * through by "Proceed once" stays BUILD_UNVERIFIED (flagged RETRO) or turns MISMATCH. Missing data
 * is never red: a build nobody can explain stays amber.
 */

import type {Contribution, DecideUnknownBuild, UnknownBuildInput} from '../contracts.ts';

export const GIVE_UP_MS = 10 * 60 * 1000;

const PERMANENT = new Set([
  'release-not-found',
  'asset-not-found',
  'digest-unavailable',
  'digest-mismatch',
  'build-refused',
  'limit-reached',
]);

const nb = (reason: 'catching-up' | 'unavailable'): Contribution => ({state: 'NEW_BUILD', reason});

function unverifiable(i: UnknownBuildInput): Contribution {
  return {
    state: 'BUILD_UNVERIFIED',
    reason: i.deploymentKind === 'cloud' ? 'not-derivable' : 'selfhost-unpublished',
  };
}

export const decideUnknownBuild: DecideUnknownBuild = i => {
  if (i.hint === null) return {k: 'fetch-hint', contribution: nb('catching-up')};
  // One deployment, one variant: the hinted version names one release.
  const r = i.release;
  if (i.hint.version === null || r === null) return {k: 'final', contribution: unverifiable(i)};
  const st = r.state;
  if (st.k === 'disputed') {
    return {k: 'final', contribution: {state: 'DISPUTED', reason: 'pin-changed'}};
  }
  if (st.k === 'known') {
    if (!i.differsAtManifestPath) return {k: 'final', contribution: unverifiable(i)};
    return {k: 'final', contribution: {state: 'MISMATCH', reason: 'release-differs'}};
  }
  if (st.k === 'working') {
    // Past the give-up time, a background retry (the `ensure` of a final decision, below) keeps
    // the decision final while it runs, so "Proceed once" still applies. Any other deep verify
    // (the first, a fresh attempt) is waited for.
    if (i.backgroundRetry && i.now - i.waitingSince > GIVE_UP_MS) {
      return {k: 'final', contribution: unverifiable(i)};
    }
    return {k: 'wait', retryAt: null, contribution: nb('catching-up')};
  }
  // Never tried, or a failure the store forgot (LocalTrustStore.permissionsChanged, a failure's
  // time to live): one fresh attempt, even after the give-up time.
  if (st.k === 'unknown') return {k: 'ensure', key: r.key, contribution: nb('catching-up')};
  if (st.failure === 'image-only-release') {
    return {k: 'final', contribution: {state: 'BUILD_UNVERIFIED', reason: 'image-only-release'}};
  }
  // An attempt failed. A permanent one (a spent deep-verify budget included) is never retried.
  if (PERMANENT.has(st.failure)) return {k: 'final', contribution: unverifiable(i)};
  // Rate limit, network, a missing GitHub permission: retry when the store's back-off allows.
  const due = st.transient && (st.retryAt === null || st.retryAt <= i.now);
  // GIVE_UP_MS after the first deep verify of this release for the origin (`waitingSince`; a
  // reload does not restart it), a release that cannot be downloaded is BUILD_UNVERIFIED: no
  // outage or missing GitHub permission waits forever. A retry that is due still starts, in the
  // background (`ensure`), so the page verifies once GitHub answers; the decision stays final, so
  // "Proceed once" applies meanwhile.
  if (i.now - i.waitingSince > GIVE_UP_MS) {
    return {k: 'final', contribution: unverifiable(i), ...(due ? {ensure: r.key} : {})};
  }
  // Before the give-up time: retry when due, else NEW_BUILD `unavailable` until the retry or the
  // give-up time.
  if (due) return {k: 'ensure', key: r.key, contribution: nb('catching-up')};
  const giveUp = i.waitingSince + GIVE_UP_MS + 1;
  const retryAt = st.retryAt === null ? giveUp : Math.min(giveUp, st.retryAt);
  return {k: 'wait', retryAt, contribution: nb('unavailable')};
};
