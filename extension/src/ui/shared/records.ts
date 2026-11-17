/**
 * Shape checks for persisted records the UI reads directly from storage.
 * The UI reads only persisted state (R10) and never trusts it
 * blindly: a record that does not have the contract's shape is treated as
 * unreadable, which the toolbar shows as PROTECTION_LOST-style "cannot read
 * state" (fail closed), never as green.
 */

import {VERDICT_FLAGS, isVerdictState} from '@intactwarden/core/verdict/states.ts';
import type {OriginAlert, TabStateRecord} from '../../contracts.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

/** Minimal structural check of a TabStateRecord (fields the toolbar and popup depend on). */
export function isTabStateRecord(v: unknown): v is TabStateRecord {
  if (!isObject(v)) return false;
  if (v['v'] !== 1 || typeof v['tab'] !== 'number') return false;
  if (!isVerdictState(v['state'])) return false;
  if (!isStringArray(v['reasons'])) return false;
  const flags = v['flags'];
  if (!Array.isArray(flags) || !flags.every(f => (VERDICT_FLAGS as readonly unknown[]).includes(f)))
    return false;
  if (typeof v['permissionMissing'] !== 'boolean') return false;
  if (v['top'] !== null && !isObject(v['top'])) return false;
  if (!Array.isArray(v['frames'])) return false;
  return true;
}

export function isOriginAlert(v: unknown): v is OriginAlert {
  return (
    isObject(v) &&
    typeof v['origin'] === 'string' &&
    typeof v['at'] === 'number' &&
    typeof v['incident_id'] === 'string' &&
    typeof v['acknowledged'] === 'boolean' &&
    isVerdictState(v['state'])
  );
}

/** Unacknowledged alerts in a `l:v1:originAlerts` value (malformed entries count as unacknowledged: fail closed). */
export function unacknowledgedCount(value: unknown): number {
  if (!isObject(value)) return 0;
  let n = 0;
  for (const alert of Object.values(value)) {
    if (!isOriginAlert(alert) || !alert.acknowledged) n++;
  }
  return n;
}
