/**
 * Toolbar icon, badge and title.
 *
 * - Reads only the persisted TabStateRecord `s:v1:tab:<tab>` (R10); never
 *   computes a verdict. A record that cannot be read or has the wrong shape
 *   shows the red-outline icon with "IntactWarden cannot read its state"
 *   (fail closed, never green).
 * - Icon: the lattice icon of the tab state, except that while CHECKING
 *   withholds green it is a grey spinner unless a state of rank ≥ 4 applies.
 * - Title: the full state sentence.
 * - Badge (global): the number of unacknowledged origin alerts
 *   (`l:v1:originAlerts`), or "!" with the title "Grant access" while a
 *   required host permission is missing, as the registry's permission status
 *   reports it (the one status source).
 *
 * Listeners (storage, permissions) are added synchronously when the
 * controller is created: background/main.ts must create it before its first
 * await (MV3 listener rule).
 */

import {
  LOCAL_KEYS,
  SESSION_KEYS,
  type ProfileRegistry,
  type TabStateRecord,
  type TabStateSink,
} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {actionIconPaths, type ActionIcon} from '../../platform/iconPaths.ts';
import type {Ext} from '../../platform/webext.ts';
import {uiWarn} from '../shared/log.ts';
import {isTabStateRecord, unacknowledgedCount} from '../shared/records.ts';
import {actionTitle, toolbarIconFor} from '../shared/stateText.ts';

/** What the toolbar shows for a tab; pure (exported for tests). */
export interface ToolbarView {
  readonly icon: ActionIcon;
  readonly title: string;
}

export type TabStateRead =
  {readonly ok: true; readonly record: TabStateRecord | null} | {readonly ok: false};

export function toolbarViewFor(read: TabStateRead): ToolbarView {
  if (!read.ok) return {icon: 'red-outline', title: t('action_title_error')};
  const record = read.record;
  if (record === null) return {icon: 'default', title: t('actionTitle')};
  return {icon: toolbarIconFor(record.state, record.flags), title: actionTitle(record)};
}

/** Global badge text and colour; pure (exported for tests). */
export function badgeFor(
  unacknowledged: number,
  permissionsMissing: boolean,
): {readonly text: string; readonly colour: string; readonly title: string | null} {
  if (permissionsMissing) return {text: '!', colour: '#c41e3a', title: t('action_title_grant')};
  if (unacknowledged > 0) {
    return {
      text: unacknowledged > 99 ? '99+' : String(unacknowledged),
      colour: '#c41e3a',
      title: null,
    };
  }
  return {text: '', colour: '#64748b', title: null};
}

export async function readTabState(ext: Ext, tab: number): Promise<TabStateRead> {
  const key = SESSION_KEYS.tab(tab);
  try {
    const got = await ext.storage.session.get(key);
    const value = got[key];
    if (value === undefined) return {ok: true, record: null};
    return isTabStateRecord(value) && value.tab === tab ? {ok: true, record: value} : {ok: false};
  } catch {
    return {ok: false};
  }
}

/** True while a required host permission is missing; an unreadable status counts as missing. */
export function requiredMissing(
  registry: Pick<ProfileRegistry, 'permissionStatus'>,
): Promise<boolean> {
  return registry.permissionStatus().then(
    list => list.some(p => p.required && !p.granted),
    () => true,
  );
}

export function createActionController(
  ext: Ext,
  registry: Pick<ProfileRegistry, 'permissionStatus'>,
): TabStateSink {
  /** Recomputes the global badge (alerts, missing permissions). */
  async function refreshBadge(): Promise<void> {
    try {
      const got = await ext.storage.local.get(LOCAL_KEYS.originAlerts);
      const missing = await requiredMissing(registry);
      const badge = badgeFor(unacknowledgedCount(got[LOCAL_KEYS.originAlerts]), missing);
      await ext.action.setBadgeBackgroundColor({color: badge.colour});
      await ext.action.setBadgeText({text: badge.text});
      await ext.action.setTitle({title: badge.title ?? t('actionTitle')});
    } catch (error) {
      uiWarn('badge-failed', error);
    }
  }

  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, LOCAL_KEYS.originAlerts)) void refreshBadge();
  });
  ext.permissions.onAdded.addListener(() => void refreshBadge());
  ext.permissions.onRemoved.addListener(() => void refreshBadge());
  void refreshBadge();

  return {
    async tabStateChanged(tab: number): Promise<void> {
      const view = toolbarViewFor(await readTabState(ext, tab));
      try {
        await ext.action.setIcon({tabId: tab, path: actionIconPaths(view.icon)});
        await ext.action.setTitle({tabId: tab, title: view.title});
      } catch {
        // The tab was closed.
      }
    },
  };
}
