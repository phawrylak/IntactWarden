/**
 * Origin-taint source rules: a document that runs and did not
 * verify (a "Proceed once" page, one whose StreamFilter failed) or a verified document in which
 * code nobody verified may have run, or for which IntactWarden can no longer vouch, as
 * `unverifiable`; a released document that went MISMATCH; a document allowed to run a payment
 * script (`third-party-code`). A response IntactWarden denied ran nothing and taints nothing.
 * Bookkeeping and liveness are the engine's. Pure.
 */

import type {TaintSourceClass} from '../contracts.ts';

export const taintSourceClass: TaintSourceClass = s => {
  // A document that never ran (denied) cannot script anything.
  if (!s.alive || s.blocked || s.docClass === 'pending') return null;
  // Every other document class (server-rendered, not covered, dynamic, unknown) is denied; one that
  // ran all the same (its StreamFilter failed, so the denial could not be applied) ran unverified.
  if (s.docClass !== 'manifest') return 'unverifiable';
  if (s.state === 'MISMATCH') return 'released-mismatch';
  if (s.binding === null || !s.docVerified) return 'unverifiable';
  // A verified document whose release GitHub now contradicts, or with evidence about code nobody
  // verified (`unverifiedCode`): a response that went on to the page unverified, a sensor's report,
  // an open filter a restart did not close, a request no document owns, an engine fault, its host
  // permission gone. One that is red only because an item of it was denied ran nothing unverified.
  if (s.state === 'DISPUTED' || s.unverifiedCode !== null) return 'unverifiable';
  // A payment script it may run can reach the origin's storage and service workers from here.
  if (s.allowedThirdParty !== null) return 'third-party-code';
  return null;
};
