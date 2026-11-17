/**
 * Incidents page view models.
 * Pure: inputs are origin alerts and incident log records (origin and path
 * only); text comes from `kind`, state and reason codes, never from free text.
 */

import type {IncidentRecord, OriginAlert} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {formatDateTime, fullHash} from '../shared/format.ts';
import {INCIDENT_KIND_LABEL} from '../shared/labels.ts';
import {reasonText, stateTitle} from '../shared/stateText.ts';

/** The recovery checklist (docs/guide.md), in order. */
export const CHECKLIST_KEYS: readonly string[] = Object.freeze([
  'checklist_address',
  // A service worker IntactWarden reported stays registered until the site's data is cleared.
  'checklist_site_data',
  'checklist_logout',
  'checklist_password',
  'checklist_devices',
]);

export interface AlertView {
  readonly origin: string;
  readonly incidentId: string;
  readonly title: string;
  readonly when: string;
  readonly reasons: readonly string[];
}

export function alertView(a: OriginAlert): AlertView {
  return {
    origin: a.origin,
    incidentId: a.incident_id,
    title: stateTitle(a.state),
    when: formatDateTime(a.at),
    reasons: a.reasons.map(r => reasonText(a.state, r)).filter((x): x is string => x !== null),
  };
}

/** Alerts the user has not acknowledged yet, newest first. */
export function openAlerts(alerts: readonly OriginAlert[]): AlertView[] {
  return [...alerts]
    .filter(a => !a.acknowledged)
    .sort((a, b) => b.at - a.at)
    .map(alertView);
}

export interface IncidentRow {
  readonly id: string;
  readonly when: string;
  readonly kind: string;
  readonly where: string;
  readonly state: string | null;
  readonly reasons: string;
  readonly build: string | null;
  readonly hashes: string | null;
}

export function incidentRow(r: IncidentRecord): IncidentRow {
  const reasons =
    r.state === null
      ? ''
      : r.reasons
          .map(x => reasonText(r.state!, x))
          .filter((x): x is string => x !== null)
          .join('; ');
  return {
    id: r.id,
    when: formatDateTime(r.at),
    // A NEW_BUILD denial is logged as `build-unverified`; its page waited for a release IntactWarden
    // did not have yet, which is no sign of unverified code.
    kind:
      r.kind === 'build-unverified' && r.state === 'NEW_BUILD'
        ? stateTitle('NEW_BUILD')
        : t(INCIDENT_KIND_LABEL[r.kind]),
    where: `${r.origin}${r.path}`,
    state: r.state ? stateTitle(r.state) : null,
    reasons,
    build: r.buildId,
    hashes:
      r.expected || r.observed
        ? t('incident_hashes', [fullHash(r.expected), fullHash(r.observed)])
        : null,
  };
}
