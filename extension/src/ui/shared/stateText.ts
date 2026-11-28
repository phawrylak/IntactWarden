/**
 * State wording shared by the popup, the toolbar title, notifications and the
 * blocked page. Pure: input is the
 * persisted TabStateRecord (R10); nothing here decides a state, it only
 * chooses words and the lattice icon for the state the engine wrote. Every
 * state has a title, a description and one line per reason.
 */

import {profileByApp} from '@intactwarden/profiles';
import {rankOf, stateRow} from '@intactwarden/core/verdict/states.ts';
import type {AppId, TabStateRecord, VerdictFlag, VerdictState} from '../../contracts.ts';
import {formatDate, formatTime, isVersion, releaseName} from './format.ts';
import {FLAG_LABEL} from './labels.ts';
import {hasMessage, reasonKey, stateDescKey, stateKey, t} from '../../i18n/t.ts';
import type {ActionIcon} from '../../platform/iconPaths.ts';

/**
 * The icon for a tab state. While CHECKING withholds green the icon is never
 * green: a grey spinner unless a state of rank ≥ 4 applies, whose own icon is
 * shown instead.
 */
export function toolbarIconFor(state: VerdictState, flags: readonly VerdictFlag[]): ActionIcon {
  if (flags.includes('CHECKING') && rankOf(state) < 4) return 'grey-spinner';
  return stateRow(state).icon;
}

/** Colour class for page styling ("red", "amber", "grey", "green", "none"). */
export function colourFor(state: VerdictState, flags: readonly VerdictFlag[]): string {
  return toolbarIconFor(state, flags) === 'grey-spinner' ? 'grey' : stateRow(state).colour;
}

export function stateTitle(state: VerdictState): string {
  return t(stateKey(state));
}

/**
 * The release tag the profile names for a version ("web-v2026.8.0",
 * "v2026.8.0") and its repository, from the bundled profile; null when the
 * version is not x.y.z.
 */
export function hintedRelease(
  app: AppId | null,
  version: string | null | undefined,
): {readonly repo: string; readonly tag: string; readonly name: string} | null {
  if (app === null || !isVersion(version)) return null;
  const profile = profileByApp(app);
  const pattern = profile?.upstream.tag_pattern;
  if (!profile || pattern === undefined) return null;
  const tag = pattern.replace('{version}', version);
  const name = releaseName(profile.upstream.repo, tag);
  return name === null ? null : {repo: profile.upstream.repo, tag, name};
}

/** Words for one reason of a state; THIRD_PARTY_CODE reasons are hosts (data). Null if unknown. */
export function reasonText(state: VerdictState, reason: string): string | null {
  if (state === 'THIRD_PARTY_CODE') return t('reason_third_party_host', [reason]);
  const key = reasonKey(state, reason);
  return hasMessage(key) ? t(key) : null;
}

export function flagText(flag: VerdictFlag, retroAt: number | null): string {
  if (flag === 'RETRO' && retroAt !== null) return t('flag_retro_at', [formatTime(retroAt)]);
  return t(FLAG_LABEL[flag]);
}

/** "Server you added on <date>. This proves the code, not who runs the server." */
export function selfHostedLead(record: Pick<TabStateRecord, 'kind' | 'instance'>): string | null {
  if (record.kind !== 'instance' || record.instance === null) return null;
  return t('popup_self_hosted_lead', [formatDate(record.instance.added_at)]);
}

/** The state's description; the reason lines say what was seen. */
export function stateDescription(state: VerdictState): string {
  return t(stateDescKey(state));
}

/** The toolbar tooltip: the state's title and description. */
export function actionTitle(record: TabStateRecord | null): string {
  if (record === null) return t('actionTitle');
  if (record.permissionMissing) return t('action_title_grant');
  if (toolbarIconFor(record.state, record.flags) === 'grey-spinner') {
    return t('action_title_checking');
  }
  if (record.state === 'NOT_PROTECTED') return t('actionTitle');
  return t('action_title', [stateTitle(record.state), stateDescription(record.state)]);
}
