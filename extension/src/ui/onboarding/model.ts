/**
 * Onboarding view model.
 * Pure: input is the OnboardingStatus the background returns.
 */

import type {OnboardingStatus, PermissionStatus} from '../../contracts.ts';
import {tn} from '../../i18n/plural.ts';
import {t} from '../../i18n/t.ts';

/** "What this does not prove" (docs/guide.md), in order. */
export const NOT_PROVEN_KEYS: readonly string[] = Object.freeze([
  'not_proven_source',
  'not_proven_server',
  'not_proven_operator',
  'not_proven_stylesheet',
  'not_proven_earlier',
  'not_proven_extensions',
  'not_proven_others',
  'not_proven_device',
  'not_proven_lookalike',
]);

type RequiredPurpose = Exclude<PermissionStatus['purpose'], 'instance'>;

const PURPOSE_KEY: Readonly<Record<RequiredPurpose, string>> = Object.freeze({
  official: 'onboarding_purpose_official',
  'deep-verify': 'onboarding_purpose_deep_verify',
});

export interface PermissionRow {
  readonly pattern: string;
  readonly purpose: string;
  readonly granted: boolean;
  readonly status: string;
}

export function permissionRows(status: OnboardingStatus): PermissionRow[] {
  // Only the required patterns (official and GitHub hosts); an instance is never required.
  return status.permissions
    .filter((p): p is PermissionStatus & {purpose: RequiredPurpose} => p.required)
    .map(p => ({
      pattern: p.pattern,
      purpose: t(PURPOSE_KEY[p.purpose]),
      granted: p.granted,
      status: p.granted ? t('onboarding_granted') : t('onboarding_not_granted'),
    }));
}

/** Required patterns that are not granted (requested together in one click). */
export function missingPatterns(status: OnboardingStatus): string[] {
  return status.permissions.filter(p => p.required && !p.granted).map(p => p.pattern);
}

export interface OnboardingModel {
  /** Step 1: what IntactWarden does in Firefox. */
  readonly protection: string;
  readonly protectionDetail: string;
  readonly permissionsIntro: string;
  readonly permissions: readonly PermissionRow[];
  readonly missing: readonly string[];
  readonly privateWindows: string;
  readonly pin: string;
  readonly pinHint: string;
  readonly openTabs: string | null;
}

export function onboardingModel(s: OnboardingStatus): OnboardingModel {
  return {
    protection: t('onboarding_protection'),
    protectionDetail: t('onboarding_protection_detail'),
    permissionsIntro: t('onboarding_permissions_intro'),
    permissions: permissionRows(s),
    missing: missingPatterns(s),
    privateWindows: s.incognitoAllowed
      ? t('onboarding_private_allowed')
      : t('onboarding_private_not_allowed'),
    pin:
      s.pinned === true
        ? t('onboarding_pin_done')
        : s.pinned === false
          ? t('onboarding_pin_missing')
          : t('onboarding_pin_unknown'),
    pinHint: t('onboarding_pin_hint'),
    openTabs: s.openProtectedTabs > 0 ? tn('onboarding_open_tabs', s.openProtectedTabs) : null,
  };
}
