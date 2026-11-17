/**
 * The enforced CSP floor of a document, with the sources of the one payment script the document may
 * run. Pure.
 */

import type {CspDirectiveName} from '@intactwarden/core/schema/profile.ts';
import type {CspFloor} from '../contracts.ts';

export const cspFloor: CspFloor = (origin, allowedThirdParty) => {
  const p = origin.profile;
  const tp = p.third_party.find(x => x.id === allowedThirdParty && x.kind === 'unpinnable-script');
  const out: string[] = [];
  for (const [name, value] of Object.entries(p.csp_floor) as [CspDirectiveName, string][]) {
    const extra = tp?.csp_allowance?.[name];
    out.push(`${name} ${extra === undefined ? value : `${value} ${extra.join(' ')}`}`.trim());
  }
  return out.length > 0 ? out.join('; ') : null;
};
