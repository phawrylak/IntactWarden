/**
 * Background handlers owned by the UI:
 *
 * - UI_GET_ONBOARDING: host-permission status (from the registry),
 *   private-window access, toolbar pin state, and protected tabs that were
 *   open before IntactWarden watched them ("Reload to verify");
 * - onInstalled (install, or an update while a required host permission is
 *   missing) and browser start while one is missing: open onboarding;
 * - every background start removes the GitHub host permissions 1.0.0 needed
 *   (an update installed while IntactWarden was disabled fires no onInstalled).
 *
 * Every listener is added synchronously inside registerUiHandlers, so
 * background/main.ts must call it before its first await (MV3 listener rule).
 */

import {PAGES, SESSION_KEYS, type OnboardingStatus, type ProfileRegistry} from '../contracts.ts';
import type {Router} from '../platform/messaging.ts';
import type {Ext} from '../platform/webext.ts';
import {requiredMissing} from './action/index.ts';
import {uiWarn} from './shared/log.ts';
import {isTabStateRecord} from './shared/records.ts';

/**
 * Protected tabs whose page was open before IntactWarden watched it: a tab without a state record
 * (the engine has not marked it yet, or it is discarded), or one the engine marked `untracked`.
 */
async function countUnverifiedProtectedTabs(ext: Ext, registry: ProfileRegistry): Promise<number> {
  try {
    const tabs = await ext.tabs.query({});
    const candidates: number[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined || typeof tab.url !== 'string') continue;
      let origin: string;
      try {
        origin = new URL(tab.url).origin;
      } catch {
        continue;
      }
      if (registry.lookup(origin) !== null) candidates.push(tab.id);
    }
    if (candidates.length === 0) return 0;
    const got = await ext.storage.session.get(candidates.map(id => SESSION_KEYS.tab(id)));
    return candidates.filter(id => {
      const r = got[SESSION_KEYS.tab(id)];
      return r === undefined || (isTabStateRecord(r) && r.reasons.includes('untracked'));
    }).length;
  } catch (error) {
    uiWarn('open-tabs-failed', error);
    return 0;
  }
}

export async function onboardingStatus(
  ext: Ext,
  registry: ProfileRegistry,
): Promise<OnboardingStatus> {
  const [permissions, incognitoAllowed, pinned, openProtectedTabs] = await Promise.all([
    registry.permissionStatus(),
    ext.extension.isAllowedIncognitoAccess().catch(() => false),
    (async (): Promise<boolean | null> => {
      if (!ext.action.getUserSettings) return null;
      try {
        const s = await ext.action.getUserSettings();
        return typeof s.isOnToolbar === 'boolean' ? s.isOnToolbar : null;
      } catch {
        return null;
      }
    })(),
    countUnverifiedProtectedTabs(ext, registry),
  ]);
  return {permissions, incognitoAllowed, pinned, openProtectedTabs};
}

async function openOnboarding(ext: Ext, fragment = ''): Promise<void> {
  try {
    await ext.tabs.create({
      url: ext.runtime.getURL(`${PAGES.onboarding}${fragment}`),
      active: true,
    });
  } catch (error) {
    uiWarn('open-onboarding-failed', error);
  }
}

export function registerUiHandlers(router: Router, ext: Ext, registry: ProfileRegistry): void {
  router.handle('UI_GET_ONBOARDING', async () => onboardingStatus(ext, registry));

  // 1.0.0 required these hosts and Firefox keeps them across an update. An update installed while
  // IntactWarden was disabled fires no onInstalled when it is enabled again, so this runs at every
  // start; removing hosts that are already gone does nothing. No server can be a GitHub host
  // (serverAddress.ts), so this removes no server's access.
  void ext.permissions
    .remove({
      origins: [
        'https://github.com/*',
        'https://objects.githubusercontent.com/*',
        'https://raw.githubusercontent.com/*',
      ],
    })
    .catch(() => false);

  ext.runtime.onInstalled.addListener(details => {
    void (async () => {
      if (details.reason === 'install') await openOnboarding(ext);
      else if (details.reason === 'update' && (await requiredMissing(registry))) {
        await openOnboarding(ext, '#permissions');
      }
    })();
  });

  ext.runtime.onStartup.addListener(() => {
    void (async () => {
      if (await requiredMissing(registry)) await openOnboarding(ext, '#permissions');
    })();
  });
}
