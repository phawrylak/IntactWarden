/**
 * Notifications: a
 * browser notification for every new red state (setting `notifications`, on by
 * default; the permission is required). Clicking it opens the incident. The
 * click listener is added synchronously when the sink is created (MV3 listener
 * rule).
 */

import {stateRow} from '@intactwarden/core/verdict/states.ts';
import {PAGES, type AlertSink, type RedAlertEvent, type Settings} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import type {Ext} from '../../platform/webext.ts';
import {uiWarn} from '../shared/log.ts';
import {reasonText, stateDescription, stateTitle} from '../shared/stateText.ts';

export const NOTIFICATION_PREFIX = 'iw-alert:';
const INCIDENT_ID = /^[0-9a-f]{16}$/;

/** Whether a red alert notifies; pure (exported for tests). */
export function notifies(event: RedAlertEvent, settings: Settings): boolean {
  return stateRow(event.state).colour === 'red' && settings.notifications;
}

/** Notification text; pure. Origins are shown as data. */
export function notificationText(event: RedAlertEvent): {
  readonly title: string;
  readonly message: string;
} {
  const reasons = event.reasons
    .map(r => reasonText(event.state, r))
    .filter((x): x is string => x !== null);
  return {
    title: t('notify_title', [stateTitle(event.state)]),
    message: t('notify_message', [
      event.origin,
      [stateDescription(event.state), ...reasons].join(' '),
    ]),
  };
}

export function incidentPageUrl(ext: Ext, incidentId: string): string {
  const id = INCIDENT_ID.test(incidentId) ? incidentId : '';
  return ext.runtime.getURL(`${PAGES.incidents}${id ? `#${id}` : ''}`);
}

export function createAlertSink(ext: Ext, getSettings: () => Settings): AlertSink {
  ext.notifications.onClicked.addListener(id => {
    if (!id.startsWith(NOTIFICATION_PREFIX)) return;
    const incident = id.slice(NOTIFICATION_PREFIX.length);
    void (async () => {
      try {
        await ext.tabs.create({url: incidentPageUrl(ext, incident), active: true});
        await ext.notifications.clear(id);
      } catch (error) {
        uiWarn('notification-click-failed', error);
      }
    })();
  });

  return {
    async redAlert(event: RedAlertEvent): Promise<void> {
      if (!notifies(event, getSettings())) return;
      try {
        const text = notificationText(event);
        await ext.notifications.create(`${NOTIFICATION_PREFIX}${event.incidentId}`, {
          type: 'basic',
          iconUrl: ext.runtime.getURL('assets/icons/icon-128.png'),
          title: text.title,
          message: text.message,
          priority: 2,
        });
      } catch (error) {
        uiWarn('notify-failed', error);
      }
    },
  };
}
