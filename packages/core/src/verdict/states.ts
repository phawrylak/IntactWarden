/**
 * Verdict lattice: the one table of states, with their ranks, reasons, icons and actions. Severity
 * only rises within a document (R6), so states combine with `join`, which keeps the higher rank.
 */

/** Assurance classes. */
export const ASSURANCE_CLASSES = ['release-exact', 'release-derived'] as const;
export type Assurance = (typeof ASSURANCE_CLASSES)[number];

export type VerdictState =
  | 'MISMATCH'
  | 'DISPUTED'
  | 'PROTECTION_LOST'
  | 'BUILD_UNVERIFIED'
  | 'CO_RESIDENT_UNVERIFIED'
  | 'THIRD_PARTY_CODE'
  | 'UNVERIFIED_STYLE'
  | 'RECOVERING'
  | 'ROLLBACK'
  | 'NEW_BUILD'
  | 'NOT_COVERED'
  | 'VERIFIED'
  | 'NOT_PROTECTED';

export type Colour = 'red' | 'amber' | 'grey' | 'green' | 'none';

export type Icon =
  | 'red-bang' // red "!"
  | 'red-outline'
  | 'amber'
  | 'amber-spinner'
  | 'grey-outline'
  | 'green-solid'
  | 'default';

/**
 * What happens in a state (the `action` of its row in LATTICE).
 * `deny-unless-tab-allowed` denies only the item (a server stylesheet allowed for the tab, a
 * payment script allowed for one page load), never the document.
 */
export type Action = 'deny' | 'deny-with-auto-retry' | 'deny-unless-tab-allowed' | 'allow';

export interface LatticeRow {
  readonly state: VerdictState;
  readonly rank: number;
  readonly colour: Colour;
  readonly icon: Icon;
  /**
   * Closed set of reason codes for this state (i18n keys derive from them), as
   * in the Reasons column of the state table. Empty for a
   * state without a reason, and for THIRD_PARTY_CODE, whose reason is data
   * (the third party's host).
   */
  readonly reasons: readonly string[];
  readonly action: Action;
  /** The blocked page offers "Proceed once (unverified)". */
  readonly proceed_once?: boolean;
}

export type VerdictFlag = 'CHECKING' | 'BLOCKED' | 'RETRO';
export const VERDICT_FLAGS: readonly VerdictFlag[] = Object.freeze([
  'CHECKING',
  'BLOCKED',
  'RETRO',
]);

function row(r: LatticeRow): LatticeRow {
  return Object.freeze({
    ...r,
    reasons: Object.freeze([...r.reasons]),
  });
}

/** The lattice, highest rank first. */
export const LATTICE: readonly LatticeRow[] = Object.freeze([
  row({
    state: 'MISMATCH',
    rank: 30,
    colour: 'red',
    icon: 'red-bang',
    reasons: [
      'bytes',
      'header',
      'unknown-path',
      'release-differs',
      'inline-code',
      'service-worker',
    ],
    action: 'deny',
  }),
  row({
    state: 'DISPUTED',
    rank: 26,
    colour: 'red',
    icon: 'red-bang',
    // pin-changed: a pinned upstream fact (GitHub-listed digest, size, tag commit or tag
    // object) changed after this browser first saw it (TOFU pins).
    reasons: ['pin-changed'],
    action: 'deny',
  }),
  row({
    state: 'PROTECTION_LOST',
    rank: 25,
    colour: 'red',
    icon: 'red-outline',
    reasons: [
      'filter-failed',
      'unverifiable-active',
      'timeout',
      'permission-revoked',
      'verifier-restarted',
      'internal-error',
      'untracked', // R2
      'unbound', // subresource without a bound document
      'sw-served',
    ],
    action: 'deny',
  }),
  row({
    state: 'BUILD_UNVERIFIED',
    rank: 20,
    colour: 'amber',
    icon: 'amber',
    // image-only-release: a self-hosted instance runs a release published only
    // as a container image (Vaultwarden bw_web_builds v2026.8.0), which has no
    // release asset to compare with.
    reasons: ['not-derivable', 'selfhost-unpublished', 'image-only-release'],
    action: 'deny',
    proceed_once: true,
  }),
  row({
    state: 'CO_RESIDENT_UNVERIFIED',
    rank: 19,
    colour: 'amber',
    icon: 'amber',
    reasons: ['third-party-code', 'released-mismatch', 'unverifiable'],
    action: 'allow',
  }),
  row({
    state: 'THIRD_PARTY_CODE',
    rank: 17,
    colour: 'amber',
    icon: 'amber',
    reasons: [],
    action: 'deny-unless-tab-allowed',
  }),
  row({
    // A stylesheet the server generates itself (profile resources.server_styles,
    // e.g. Vaultwarden's /css/vaultwarden.css) that its closed validator did
    // not accept: it cannot run script, but it can change what the user sees.
    // The stylesheet (not the document) is denied unless allowed for the tab;
    // the vault keeps working without it.
    state: 'UNVERIFIED_STYLE',
    rank: 16,
    colour: 'amber',
    icon: 'amber',
    reasons: ['custom-rules', 'malformed'],
    action: 'deny-unless-tab-allowed',
  }),
  row({
    state: 'RECOVERING',
    rank: 14,
    colour: 'amber',
    icon: 'amber',
    reasons: [],
    action: 'allow',
  }),
  row({
    state: 'ROLLBACK',
    rank: 13,
    colour: 'amber',
    icon: 'amber',
    reasons: [],
    action: 'allow',
  }),
  row({
    state: 'NEW_BUILD',
    rank: 11,
    colour: 'amber',
    icon: 'amber-spinner',
    reasons: ['catching-up', 'unavailable'],
    action: 'deny-with-auto-retry',
  }),
  row({
    state: 'NOT_COVERED',
    rank: 6,
    colour: 'grey',
    icon: 'grey-outline',
    reasons: ['admin-portal', 'auth-flow', 'not-covered-path'],
    action: 'deny',
  }),
  row({
    state: 'VERIFIED',
    rank: 1,
    colour: 'green',
    icon: 'green-solid',
    reasons: [],
    action: 'allow',
  }),
  row({
    state: 'NOT_PROTECTED',
    rank: 0,
    colour: 'none',
    icon: 'default',
    reasons: [],
    action: 'allow',
  }),
]);

const BY_STATE: ReadonlyMap<string, LatticeRow> = new Map(LATTICE.map(r => [r.state, r]));

export function isVerdictState(value: unknown): value is VerdictState {
  return typeof value === 'string' && BY_STATE.has(value);
}

/** The lattice row of a state. Unknown input yields the PROTECTION_LOST row (fail closed). */
export function stateRow(state: VerdictState): LatticeRow {
  return BY_STATE.get(state) ?? BY_STATE.get('PROTECTION_LOST')!;
}

export function rankOf(state: VerdictState): number {
  return stateRow(state).rank;
}

/**
 * Least upper bound: the state with the higher rank. A value that is not a
 * known state counts as PROTECTION_LOST (R1: internal errors never lower a
 * verdict and never produce green).
 */
export function join(a: VerdictState, b: VerdictState): VerdictState {
  const ra = stateRow(a);
  const rb = stateRow(b);
  return rb.rank > ra.rank ? rb.state : ra.state;
}

export function joinAll(states: Iterable<VerdictState>): VerdictState {
  let acc: VerdictState = 'NOT_PROTECTED';
  for (const s of states) acc = join(acc, s);
  return acc;
}

export function isGreen(state: VerdictState): boolean {
  return state === 'VERIFIED';
}
