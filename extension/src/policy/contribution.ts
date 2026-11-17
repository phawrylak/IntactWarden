/**
 * Item outcome → lattice contribution (R4, R11): an unverifiable active item is PROTECTION_LOST,
 * because the engine could not judge it, and so is a listed file of any class that reached the page
 * unverified. One that went on to the page unverified is evidence that code nobody verified ran
 * (`ran`); one the backend withheld is not. Pure.
 */

import type {Contribution, ItemContribution, ItemRecord, UnverifiableReason} from '../contracts.ts';
import {isActiveClass} from './util.ts';

/** PROTECTION_LOST reason for an unverifiable item (lattice reason list). */
export function protectionLostReason(r: UnverifiableReason): string {
  switch (r) {
    case 'timeout':
    case 'filter-failed':
    case 'sw-served':
    case 'verifier-restarted':
    case 'unbound':
    case 'internal-error':
      return r;
    default:
      return 'unverifiable-active';
  }
}

const c = (state: Contribution['state'], reason: string | null): Contribution => ({state, reason});

export const itemContribution: ItemContribution = (item: ItemRecord, binding) => {
  const o = item.outcome;
  switch (o.r) {
    case 'ok':
    case 'passive':
    case 'non-executing':
      return null;
    case 'recorded':
      // Kept for retro-verification while the document is unbound. An active one left over once
      // the document is bound was never judged: an engine fault, never green.
      return binding !== null && isActiveClass(item.cls)
        ? c('PROTECTION_LOST', 'internal-error')
        : null;
    case 'mismatch':
      return c('MISMATCH', o.reason);
    case 'style-rejected':
      return c('UNVERIFIED_STYLE', o.reason);
    case 'third-party':
      if (o.kind !== 'unpinnable-script') return null;
      return c('THIRD_PARTY_CODE', o.host);
    case 'unverifiable': {
      // A passive item that could not be read changes no state, except a listed file (listed
      // files must match, and the page reads them): one cut off by the buffering budget, which
      // every listed file is far below, and one that reached the page unverified.
      const listedUnverified =
        item.key !== null && (o.reason === 'too-large' || o.delivered === true);
      if (!isActiveClass(item.cls) && !listedUnverified) return null;
      const lost = c('PROTECTION_LOST', protectionLostReason(o.reason));
      return o.delivered === true ? {...lost, unverifiedCode: 'ran'} : lost;
    }
  }
};
