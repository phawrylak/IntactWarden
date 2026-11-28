/**
 * Unknown-build helpers of the engine: the input
 * of the pure decideUnknownBuild, the record of its decision, and the tab record's view of it. The
 * engine (engine/index.ts) carries the decision out (hint fetch, TrustStore.ensureRelease, timers).
 */

import {
  buildIdOf,
  type BindResult,
  type ProtectedOrigin,
  type ReleaseFailure,
  type ReleaseKey,
  type ReleaseState,
  type TabStateRecord,
  type TrustStore,
  type UnknownBuildDecision,
  type UnknownBuildInput,
  type UnknownBuildRecord,
} from '../contracts.ts';
import type {DeepVerifyBudget} from './budget.ts';
import type {SessionRec} from './types.ts';

type Tried = Extract<BindResult, {k: 'unbound'}>['tried'];

/** The release the server's version hint names for the deployment's variant; null without a hint. */
export function hintedKey(s: SessionRec, origin: ProtectedOrigin): ReleaseKey | null {
  const version = s.unknownBuild?.hint?.version ?? null;
  if (version === null) return null;
  return {app: origin.app, variant: origin.deployment.variant as ReleaseKey['variant'], version};
}

/** differsAtManifestPath: the document path is a manifest path of the hinted, known core and the bytes differ. */
export function differs(tried: Tried | undefined, key: ReleaseKey | null): boolean {
  if (tried === undefined || key === null) return false;
  const id = buildIdOf(key);
  return tried.some(t => t.differsAtManifestPath && t.buildId === id);
}

/**
 * The release state the decision sees: a release deep verify would have to start while the
 * origin's deep-verify budget is spent is `limit-reached` (permanent for this document).
 */
function budgetedState(
  state: ReleaseState,
  key: ReleaseKey,
  exhausted: (key: ReleaseKey) => boolean,
  now: number,
): ReleaseState {
  const wouldStart = state.k === 'unknown' || (state.k === 'failed' && state.transient);
  if (!wouldStart || !exhausted(key)) return state;
  return {k: 'failed', failure: 'limit-reached', transient: false, at: now, retryAt: null};
}

export function unknownInput(
  s: SessionRec,
  origin: ProtectedOrigin,
  trust: TrustStore,
  tried: Tried | undefined,
  now: number,
  budget: Pick<DeepVerifyBudget, 'exhausted' | 'startedAt'>,
  backgroundRetry: (key: ReleaseKey) => boolean,
): UnknownBuildInput {
  const key = hintedKey(s, origin);
  const exhausted = (k: ReleaseKey): boolean => budget.exhausted(s.origin, k, now);
  return {
    deploymentKind: origin.deployment.kind,
    hint: s.unknownBuild?.hint ?? null,
    release:
      key === null
        ? null
        : {key, state: budgetedState(trust.releaseState(key), key, exhausted, now)},
    differsAtManifestPath: differs(tried, key),
    waitingSince: (key === null ? null : budget.startedAt(s.origin, key, now)) ?? s.startedAt,
    backgroundRetry: key !== null && backgroundRetry(key),
    now,
  };
}

export function withDecision(
  rec: UnknownBuildRecord,
  input: UnknownBuildInput,
  decision: UnknownBuildDecision,
  now: number,
): UnknownBuildRecord {
  return {
    ...rec,
    attempts:
      input.release === null
        ? []
        : [
            {
              key: input.release.key,
              state: input.release.state.k,
              ...(input.release.state.k === 'failed' ? {failure: input.release.state.failure} : {}),
              at: now,
            },
          ],
    decision,
  };
}

/** The tab record's unknown-build line for a session. */
export function unknownBuildView(
  s: SessionRec,
  origin: ProtectedOrigin | null,
  trust: TrustStore,
): TabStateRecord['unknownBuild'] {
  const ub = s.unknownBuild;
  if (ub === null || s.binding !== null) return null;
  const d = ub.decision;
  const phase =
    d === null || d.k === 'fetch-hint' ? 'hint' : d.k === 'final' ? 'final' : 'deep-verify';
  // What the last decision saw (it includes a spent deep-verify budget), then the store's state.
  let failure: ReleaseFailure | null =
    ub.attempts.find(a => a.failure !== undefined)?.failure ?? null;
  const key = origin === null ? null : hintedKey(s, origin);
  if (key !== null) {
    const st = trust.releaseState(key);
    if (st.k === 'failed' && failure === null) failure = st.failure;
  }
  return {phase, failure};
}
