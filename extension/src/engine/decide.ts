/**
 * Decisions for subresources.
 * Document decisions come from the policy kernel (`decisionFor`); an item decision denies only the
 * item itself (a rejected server stylesheet gets an empty body, a payment script not allowed for
 * the document is dropped).
 */

import type {Decision, Evaluation, ItemRecord, TabAllowances} from '../contracts.ts';

export function itemDecision(
  item: ItemRecord,
  ev: Evaluation,
  allowances: TabAllowances | null,
): Decision {
  const o = item.outcome;
  let bad = false;
  switch (o.r) {
    case 'mismatch':
    case 'unverifiable':
      bad = true;
      break;
    case 'style-rejected':
      bad = !(allowances?.serverStyles.includes(item.path) ?? false);
      break;
    case 'third-party':
      bad = o.kind === 'unpinnable-script' && !o.allowed;
      break;
    default:
      bad = false;
  }
  return bad ? {act: 'block', state: ev.state, reason: ev.reasons[0] ?? null} : {act: 'allow'};
}

/** Fail-closed decision when the engine itself failed (R1). */
export const FAULT_DECISION: Decision = Object.freeze({
  act: 'block',
  state: 'PROTECTION_LOST',
  reason: 'internal-error',
});
