/**
 * evaluateSession(): total, pure, fail closed (the fail-closed rules R1–R14 are listed in
 * test/policy/rules.test.ts). Joins all contributions with the lattice from
 * @intactwarden/core (join, stateRow), applies R6 monotonicity with its
 * exceptions (CHECKING clears; NEW_BUILD resolves; RECOVERING ends with the
 * alert), R13 taint before green, an open origin alert withholding green, and
 * computes the document's action and the origin alert to raise. VERIFIED has
 * one source, the base contribution of a bound, verified document; every
 * other requirement of green is a contribution that outranks it.
 *
 * The alert follows evidence, never a reason string: MISMATCH and DISPUTED are
 * evidence of an attack; PROTECTION_LOST raises it only when a contribution
 * says that code nobody verified may have run (`unverifiedCode: 'ran'`). A
 * denied document or item says nothing of the kind: nothing of it ran.
 */

import {
  isGreen,
  join,
  rankOf,
  stateRow,
  type VerdictFlag,
  type VerdictState,
} from '@intactwarden/core/verdict/states.ts';
import {
  SESSION_LIMITS,
  type Contribution,
  type DecisionFor,
  type DocumentAction,
  type EvaluateInput,
  type EvaluateSession,
  type Evaluation,
  type UnverifiedCode,
} from '../contracts.ts';
import {itemContribution} from './contribution.ts';

/**
 * Whether a document in `state` meets the origin alert's condition (the "origin alert" of its
 * state): evidence of an attack (MISMATCH, DISPUTED), or
 * PROTECTION_LOST with evidence that code nobody verified may have run in it.
 */
export function meetsAlert(state: VerdictState, unverifiedCode: UnverifiedCode | null): boolean {
  return (
    state === 'MISMATCH' ||
    state === 'DISPUTED' ||
    (state === 'PROTECTION_LOST' && unverifiedCode === 'ran')
  );
}

/** The stronger of two pieces of evidence about unverified code (`ran` over `unchecked`). */
function stronger(
  a: UnverifiedCode | null,
  b: UnverifiedCode | null | undefined,
): UnverifiedCode | null {
  if (a === 'ran' || b === 'ran') return 'ran';
  return a ?? b ?? null;
}

const contrib = (
  state: VerdictState,
  reason: string | null,
  unverifiedCode?: UnverifiedCode,
): Contribution =>
  unverifiedCode === undefined ? {state, reason} : {state, reason, unverifiedCode};

function documentContribution(i: EvaluateInput): Contribution | null {
  const s = i.session;
  switch (s.docClass) {
    case 'pending':
      return null;
    case 'manifest':
      if (s.binding !== null) return null;
      // A document whose own bytes could not be read carries an unverifiable document item instead.
      if (s.unknownBuild === null) return null;
      return s.unknownBuild.decision?.contribution ?? contrib('NEW_BUILD', 'catching-up');
    case 'server-rendered':
      return contrib(
        'NOT_COVERED',
        s.docClassDetail === 'auth-flow' ? 'auth-flow' : 'admin-portal',
      );
    case 'not-covered':
      return contrib('NOT_COVERED', 'not-covered-path');
    case 'dynamic-document':
    case 'unknown':
      // R3: an unknown document is unverified active code, which is denied: nothing of it runs.
      return contrib('PROTECTION_LOST', 'unverifiable-active');
  }
}

/** A content sensor saw it in the running page: code nobody verified may have run (`ran`). */
function sensorContribution(event: string): Contribution | null {
  switch (event) {
    case 'inline-script':
    case 'inline-handler':
    case 'javascript-url':
      return contrib('MISMATCH', 'inline-code', 'ran');
    case 'sw-register':
      return contrib('MISMATCH', 'service-worker', 'ran');
    case 'blob-frame':
    case 'data-frame':
    case 'srcdoc':
    case 'object-element':
    case 'base-element':
      return contrib('PROTECTION_LOST', 'unverifiable-active', 'ran');
    default:
      return null;
  }
}

/** What a state's action does to its document. */
function documentAction(state: VerdictState): DocumentAction {
  switch (stateRow(state).action) {
    case 'deny':
      return 'deny';
    case 'deny-with-auto-retry':
      return 'deny-with-retry';
    default:
      // `deny-unless-tab-allowed` (UNVERIFIED_STYLE, THIRD_PARTY_CODE) denies the item, never the
      // document.
      return 'allow';
  }
}

const STRICTNESS: Readonly<Record<DocumentAction, number>> = {
  allow: 0,
  'deny-with-retry': 1,
  deny: 2,
};

/**
 * The row that decides the document: the strictest action of every contribution, not only the top
 * state's, and of those the highest rank. A state above that is allowed (CO_RESIDENT_UNVERIFIED, a
 * rejected server stylesheet) never releases a document its own row denies, such as a not-covered
 * page while a taint source is open. The blocked page
 * and the incident follow this row: a NEW_BUILD under CO_RESIDENT_UNVERIFIED waits for its release.
 */
function decidingState(state: VerdictState, contributions: readonly Contribution[]): VerdictState {
  let by = state;
  for (const x of contributions) {
    const d = STRICTNESS[documentAction(x.state)] - STRICTNESS[documentAction(by)];
    if (d > 0 || (d === 0 && rankOf(x.state) > rankOf(by))) by = x.state;
  }
  return by;
}

const reasonsOf = (c: readonly Contribution[], state: VerdictState): string[] =>
  [
    ...new Set(c.filter(x => x.state === state && x.reason !== null).map(x => x.reason as string)),
  ].slice(0, SESSION_LIMITS.reasons);

function evaluateInner(i: EvaluateInput): Evaluation {
  const s = i.session;
  const c: Contribution[] = [];
  // What IntactWarden cannot vouch for, with no evidence that unverified code ran: a trust store
  // that failed to start (R5), a request no document owns (R2), an engine fault, a failed start,
  // a missing host permission.
  if (!i.trust.loaded) c.push(contrib('PROTECTION_LOST', 'internal-error', 'unchecked'));
  if (s.untracked) c.push(contrib('PROTECTION_LOST', 'untracked', 'unchecked'));
  // An open filter a restarted instance did not close (R7): its bytes may have run unverified.
  if (s.engineFault !== null) {
    const fault = s.engineFault === 'verifier-restarted' ? 'ran' : 'unchecked';
    c.push(contrib('PROTECTION_LOST', s.engineFault, fault));
  }
  if (!i.engineHealthy) c.push(contrib('PROTECTION_LOST', 'internal-error', 'unchecked'));
  for (const item of Object.values(s.items)) {
    const ic = itemContribution(item, s.binding);
    if (ic !== null) c.push(ic);
  }
  // R4 is the engine's: it turns a request pending too long into an `unverifiable:timeout` item.
  const pendingCount = Object.keys(s.pending).length;
  // A session that lost count of its items or requests can no longer show that nothing ran.
  if (s.overflow) c.push(contrib('PROTECTION_LOST', 'unverifiable-active', 'ran'));
  for (const st of Object.values(s.serverStyles)) {
    if (!st.accepted) c.push(contrib('UNVERIFIED_STYLE', st.reason ?? 'custom-rules'));
  }
  const dc = documentContribution(i);
  if (dc !== null) c.push(dc);
  // A bound core whose local pin GitHub now contradicts (a changed listed digest or size, tag
  // commit or tag object): red with evidence.
  if (s.binding !== null && i.buildStatus === 'disputed')
    c.push(contrib('DISPUTED', 'pin-changed'));
  if (!i.permissionGranted) c.push(contrib('PROTECTION_LOST', 'permission-revoked', 'unchecked'));
  for (const sensor of s.sensors) {
    const sc = sensorContribution(sensor.event);
    if (sc !== null) c.push(sc);
  }
  if (s.coResident !== null) c.push(contrib('CO_RESIDENT_UNVERIFIED', s.coResident.class));
  // A document allowed to run a payment script may run code nobody verified, from the
  // moment its floor admits the vendor, whether or not a script element was seen.
  if (s.allowedThirdParty !== null) c.push(contrib('THIRD_PARTY_CODE', s.allowedThirdParty.host));
  if (s.binding !== null && i.rollback) c.push(contrib('ROLLBACK', null));
  // The base contribution: the only source of VERIFIED.
  if (s.binding !== null && s.docVerified) c.push(contrib('VERIFIED', null));

  let top: VerdictState = 'NOT_PROTECTED';
  for (const x of c) top = join(top, x.state);
  // Total (R3): a manifest document whose own bytes neither verified nor await an unknown-build
  // decision is PROTECTION_LOST whatever else contributes. The engine always
  // stores a document item that says so, but the kernel must not rely on it.
  if (
    s.docClass === 'manifest' &&
    !s.docVerified &&
    s.unknownBuild === null &&
    rankOf(top) < rankOf('PROTECTION_LOST')
  ) {
    c.push(contrib('PROTECTION_LOST', 'internal-error'));
    top = 'PROTECTION_LOST';
  }
  // R6 with its exceptions: a resolved NEW_BUILD does not hold the state up, nor does RECOVERING
  // once its alert is closed.
  const resolved = s.binding !== null || s.unknownBuild?.decision?.k === 'final';
  const peak =
    (s.peakState === 'NEW_BUILD' && resolved) || s.peakState === 'RECOVERING'
      ? 'NOT_PROTECTED'
      : s.peakState;
  let state = join(top, isGreen(peak) ? 'NOT_PROTECTED' : peak);

  // Any pending item withholds green: the UI never shows green while CHECKING.
  const flags = new Set<VerdictFlag>();
  if (pendingCount > 0 || s.docClass === 'pending') flags.add('CHECKING');
  if (s.blocked) flags.add('BLOCKED');
  if (s.binding?.retro === true) flags.add('RETRO');

  // An open origin alert withholds green until the user closes it, so a reload alone never hides
  // it. It replaces only a state that would be green, so it never stands in for a state that is denied.
  if (isGreen(state) && i.originAlert !== null && !i.originAlert.acknowledged) {
    c.push(contrib('RECOVERING', null));
    state = 'RECOVERING';
  }
  const reasons = reasonsOf(c, state);
  const by = decidingState(state, c);
  const action = documentAction(by);
  const denial =
    action === 'allow' ? null : {state: by, reasons: by === state ? reasons : reasonsOf(c, by)};

  const row = stateRow(state);
  // Sticky for the document's lifetime, like its state (R6).
  let unverifiedCode: UnverifiedCode | null = s.unverifiedCode ?? null;
  for (const x of c) unverifiedCode = stronger(unverifiedCode, x.unverifiedCode);
  const alert: Evaluation['alert'] = meetsAlert(state, unverifiedCode) ? {state, reasons} : null;
  const wasRed = stateRow(s.state).colour === 'red';
  const newRed =
    row.colour === 'red' && (!wasRed || (state !== s.state && rankOf(state) > rankOf(s.state)));
  return {state, reasons, flags: [...flags], action, denial, alert, unverifiedCode, newRed};
}

function failClosed(i: EvaluateInput): Evaluation {
  return {
    state: 'PROTECTION_LOST',
    reasons: ['internal-error'],
    flags: [],
    action: 'deny',
    denial: {state: 'PROTECTION_LOST', reasons: ['internal-error']},
    alert: null,
    unverifiedCode: i?.session?.unverifiedCode === 'ran' ? 'ran' : 'unchecked',
    newRed: i?.session?.state !== 'PROTECTION_LOST',
  };
}

export const evaluateSession: EvaluateSession = input => {
  try {
    return evaluateInner(input);
  } catch {
    return failClosed(input);
  }
};

/**
 * The backend decision for a document from an evaluation and the tab's allowances: "Proceed once"
 * releases a document whose deciding row offers it.
 */
export const decisionFor: DecisionFor = (evaluation, allowances, docSha256) => {
  const denial = evaluation.denial;
  if (evaluation.action === 'allow' || denial === null) return {act: 'allow'};
  if (
    evaluation.action === 'deny' &&
    stateRow(denial.state).proceed_once === true &&
    docSha256 !== null &&
    (allowances?.proceedOnce.includes(docSha256) ?? false)
  ) {
    return {act: 'allow'};
  }
  return {act: 'block', state: denial.state, reason: denial.reasons[0] ?? null};
};
