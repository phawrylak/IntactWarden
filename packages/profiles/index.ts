/**
 * Bundled, code-reviewed app profiles, written as typed constants. The
 * same profiles are used by the extension, its build and the recompute command. The invariants
 * the type system cannot express are checked by packages/profiles/test/profiles.test.ts.
 *
 * Bundled: bitwarden-web (cloud and self-hosted Bitwarden) and vaultwarden-web
 * (self-hosted Vaultwarden). Not included: Bitwarden Send (whether it serves the vault build is
 * not known yet; docs/security.md).
 */

import {profileOrigins, type AppProfile} from '@intactwarden/core/schema/profile.ts';
import {bitwardenWeb as bitwardenWebSource} from './bitwarden-web.ts';
import {vaultwardenWeb as vaultwardenWebSource} from './vaultwarden-web.ts';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const bitwardenWeb: AppProfile = deepFreeze(bitwardenWebSource);
export const vaultwardenWeb: AppProfile = deepFreeze(vaultwardenWebSource);

export const APP_PROFILES: readonly AppProfile[] = Object.freeze([bitwardenWeb, vaultwardenWeb]);

const BY_APP: ReadonlyMap<string, AppProfile> = new Map(APP_PROFILES.map(p => [p.app, p]));

export function profileByApp(app: string): AppProfile | undefined {
  return BY_APP.get(app);
}

/**
 * Official origins of the bundled apps (the canonical origins of their cloud
 * deployments: vault.bitwarden.com and vault.bitwarden.eu), sorted. These are
 * the required host permissions.
 */
export const OFFICIAL_ORIGINS: readonly string[] = Object.freeze(
  [...new Set(APP_PROFILES.flatMap(p => profileOrigins(p).map(o => o.origin)))].sort(),
);
