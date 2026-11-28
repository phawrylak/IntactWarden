/**
 * Background-side UI: the toolbar controller reads only the
 * persisted TabStateRecord (R10) and fails closed on malformed records; the
 * badge counts unacknowledged alerts or shows "!" for missing permissions;
 * the alert sink notifies every new red state; the
 * onboarding handlers report status and open the page on install, and later
 * only while required access is missing.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  DEFAULT_SETTINGS,
  LOCAL_KEYS,
  SESSION_KEYS,
  type MessageType,
  type RedAlertEvent,
} from '../../src/contracts.ts';
import {actionIconPaths} from '../../src/platform/iconPaths.ts';
import type {Handler, Router} from '../../src/platform/messaging.ts';
import {badgeFor, createActionController, toolbarViewFor} from '../../src/ui/action/index.ts';
import {registerUiHandlers} from '../../src/ui/background.ts';
import {createAlertSink, notificationText, notifies} from '../../src/ui/notify/index.ts';
import {toolbarIconFor} from '../../src/ui/shared/stateText.ts';
import type {ProfileRegistry} from '../../src/contracts.ts';
import {alert, flush, miniExt, resetI18n, tabRecord, useLang} from './helpers.ts';

beforeEach(() => useLang('en'));
afterEach(() => resetI18n());

describe('toolbar icon paths', () => {
  it('uses the build-time SVG icon files of the package', () => {
    expect(actionIconPaths('red-bang')).toEqual({
      16: 'assets/icons/state/red-bang.svg',
      32: 'assets/icons/state/red-bang.svg',
    });
    expect(actionIconPaths(toolbarIconFor('VERIFIED', ['CHECKING']))['16']).toBe(
      'assets/icons/state/grey-spinner.svg',
    );
  });
});

/** The registry's permission status, the one source of the "!" badge. */
function statusOf(granted: boolean | 'fails'): Pick<ProfileRegistry, 'permissionStatus'> {
  return {
    permissionStatus: async () => {
      if (granted === 'fails') throw new Error('not ready');
      return [
        {
          pattern: 'https://release-assets.githubusercontent.com/*',
          origin: 'https://release-assets.githubusercontent.com',
          purpose: 'deep-verify',
          required: true,
          granted,
        },
        {
          pattern: 'https://vault.example.org/*',
          origin: 'https://vault.example.org',
          purpose: 'instance',
          required: false,
          granted: false,
        },
      ];
    },
  };
}

describe('createActionController', () => {
  it('sets the icon and title from the persisted tab state', async () => {
    const m = miniExt();
    const controller = createActionController(m.ext, statusOf(true));
    m.session.set(
      SESSION_KEYS.tab(7),
      tabRecord({state: 'MISMATCH', reasons: ['bytes'], top: null}),
    );
    await controller.tabStateChanged(7);
    const icon = m.calls.find(c => c.method === 'action.setIcon');
    expect(icon?.args).toEqual({tabId: 7, path: actionIconPaths('red-bang')});
    const title = m.calls
      .filter(c => c.method === 'action.setTitle' && (c.args as {tabId?: number}).tabId === 7)
      .at(-1);
    expect((title?.args as {title: string}).title).toMatch(/^IntactWarden: Mismatch\. /);
  });

  it('shows the default icon for a tab without state', async () => {
    const m = miniExt();
    await createActionController(m.ext, statusOf(true)).tabStateChanged(3);
    expect(m.calls.find(c => c.method === 'action.setIcon')?.args).toEqual({
      tabId: 3,
      path: actionIconPaths('default'),
    });
  });

  it('fails closed on a malformed or foreign record (never green)', async () => {
    const m = miniExt();
    const controller = createActionController(m.ext, statusOf(true));
    m.session.set(SESSION_KEYS.tab(4), {...tabRecord({tab: 4}), state: 'TOTALLY_FINE'});
    await controller.tabStateChanged(4);
    m.session.set(SESSION_KEYS.tab(5), tabRecord({tab: 6}));
    await controller.tabStateChanged(5);
    const icons = m.calls.filter(c => c.method === 'action.setIcon').map(c => c.args);
    expect(icons).toEqual([
      {tabId: 4, path: actionIconPaths('red-outline')},
      {tabId: 5, path: actionIconPaths('red-outline')},
    ]);
    expect(toolbarViewFor({ok: false}).title).toBe(
      'IntactWarden cannot read its state for this tab. Reload the page.',
    );
  });

  it('badges unacknowledged alerts and updates when they change', async () => {
    const m = miniExt();
    createActionController(m.ext, statusOf(true));
    await flush();
    expect(m.calls.filter(c => c.method === 'action.setBadgeText').at(-1)?.args).toEqual({
      text: '',
    });
    await m.ext.storage.local.set({
      [LOCAL_KEYS.originAlerts]: {
        'https://a.example': alert({origin: 'https://a.example'}),
        'https://b.example': alert({origin: 'https://b.example', acknowledged: true}),
        'https://c.example': {broken: true},
      },
    });
    await flush();
    expect(m.calls.filter(c => c.method === 'action.setBadgeText').at(-1)?.args).toEqual({
      text: '2',
    });
  });

  it('shows "!" and "Grant access" while a required host permission is missing', async () => {
    const m = miniExt();
    createActionController(m.ext, statusOf(false));
    await flush();
    expect(m.calls.filter(c => c.method === 'action.setBadgeText').at(-1)?.args).toEqual({
      text: '!',
    });
    expect(
      (m.calls.filter(c => c.method === 'action.setTitle').at(-1)?.args as {title: string}).title,
    ).toMatch(/^IntactWarden: Grant access/);
    expect(badgeFor(150, false).text).toBe('99+');
  });

  it('takes the badge from the registry status and fails visible when it cannot be read', async () => {
    // The registry's status is the badge's one source, not the manifest.
    const m = miniExt({grantAll: false}); // the manifest check alone would say "missing"
    createActionController(m.ext, statusOf(true));
    await flush();
    expect(m.calls.filter(c => c.method === 'action.setBadgeText').at(-1)?.args).toEqual({
      text: '',
    });
    const failing = miniExt();
    createActionController(failing.ext, statusOf('fails'));
    await flush();
    expect(failing.calls.filter(c => c.method === 'action.setBadgeText').at(-1)?.args).toEqual({
      text: '!',
    });
  });
});

describe('alert sink', () => {
  const event: RedAlertEvent = {
    origin: 'https://vault.bitwarden.com',
    state: 'MISMATCH',
    reasons: ['bytes'],
    incidentId: '0123456789abcdef',
  };

  it('notifies on every red state, unless notifications are off', () => {
    expect(notifies(event, DEFAULT_SETTINGS)).toBe(true);
    expect(notifies({...event, state: 'PROTECTION_LOST'}, DEFAULT_SETTINGS)).toBe(true);
    expect(notifies({...event, state: 'BUILD_UNVERIFIED'}, DEFAULT_SETTINGS)).toBe(false);
    expect(notifies(event, {...DEFAULT_SETTINGS, notifications: false})).toBe(false);
  });

  it('notifies with localised text and opens no tab by itself', async () => {
    const m = miniExt();
    await createAlertSink(m.ext, () => DEFAULT_SETTINGS).redAlert(event);
    const n = m.calls.find(c => c.method === 'notifications.create')?.args as {
      id: string;
      opts: {title: string; message: string};
    };
    expect(n.id).toBe('iw-alert:0123456789abcdef');
    expect(n.opts.title).toBe('IntactWarden: Mismatch');
    expect(n.opts.message).toMatch(
      /^https:\/\/vault\.bitwarden\.com — Code on this page does not match its GitHub release\. Do not type secrets\./,
    );
    expect(m.calls.find(c => c.method === 'tabs.create')).toBeUndefined();
    expect(notificationText(event).message).toContain(
      "A file's bytes differ from the GitHub release.",
    );
  });

  it('opens the incident when the notification is clicked', async () => {
    const m = miniExt();
    createAlertSink(m.ext, () => DEFAULT_SETTINGS);
    m.events.notificationClicked.fire('iw-alert:0123456789abcdef' as never);
    await flush();
    expect(m.calls.find(c => c.method === 'tabs.create')?.args).toEqual({
      url: 'ext://test-id/ui/incidents.html#0123456789abcdef',
      active: true,
    });
  });
});

function fakeRouter(): Router & {readonly handlers: Map<string, Handler<MessageType>>} {
  const handlers = new Map<string, Handler<MessageType>>();
  return {
    handlers,
    handle(type, handler) {
      if (handlers.has(type)) throw new Error(`twice: ${type}`);
      handlers.set(type, handler as unknown as Handler<MessageType>);
    },
    start() {},
  };
}

function fakeRegistry(
  githubGranted: boolean | 'fails' = true,
  protectedOrigins: string[] = ['https://vault.bitwarden.com'],
): ProfileRegistry {
  return {
    lookup: (origin: string) => (protectedOrigins.includes(origin) ? ({origin} as never) : null),
    permissionStatus: async () => {
      if (githubGranted === 'fails') throw new Error('not ready');
      return [
        {
          pattern: 'https://vault.bitwarden.com/*',
          origin: 'https://vault.bitwarden.com',
          purpose: 'official',
          required: true,
          granted: true,
        },
        {
          pattern: 'https://release-assets.githubusercontent.com/*',
          origin: 'https://release-assets.githubusercontent.com',
          purpose: 'deep-verify',
          required: true,
          granted: githubGranted,
        },
      ];
    },
  } as unknown as ProfileRegistry;
}

const PAGE = {
  kind: 'page',
  tab: null,
  frame: null,
  documentId: null,
  url: null,
} as const;

describe('registerUiHandlers', () => {
  it('reports onboarding status: registry permissions, pin state, tabs to reload', async () => {
    const m = miniExt();
    // Tab 1 has no record yet; the engine marked tab 4, open before it started, `untracked`.
    m.tabs = [
      {id: 1, url: 'https://vault.bitwarden.com/#/vault'},
      {id: 2, url: 'https://example.org/'},
      {id: 3, url: 'https://vault.bitwarden.com/'},
      {id: 4, url: 'https://vault.bitwarden.com/'},
      {id: 5, url: 'https://vault.bitwarden.com/'},
    ];
    m.session.set(SESSION_KEYS.tab(3), tabRecord({tab: 3}));
    m.session.set(
      SESSION_KEYS.tab(4),
      tabRecord({tab: 4, state: 'PROTECTION_LOST', reasons: ['untracked'], top: null}),
    );
    m.session.set(
      SESSION_KEYS.tab(5),
      tabRecord({tab: 5, state: 'PROTECTION_LOST', reasons: ['verifier-restarted'], top: null}),
    );
    m.onToolbar = false;
    const router = fakeRouter();
    registerUiHandlers(router, m.ext, fakeRegistry(false));
    const status = (await router.handlers.get('UI_GET_ONBOARDING')!(
      {} as never,
      PAGE,
    )) as unknown as {
      permissions: {pattern: string; granted: boolean; purpose: string}[];
      pinned: boolean | null;
      openProtectedTabs: number;
    };
    expect(
      status.permissions.find(p => p.pattern === 'https://vault.bitwarden.com/*'),
    ).toMatchObject({granted: true, purpose: 'official'});
    expect(
      status.permissions.find(p => p.pattern === 'https://release-assets.githubusercontent.com/*'),
    ).toMatchObject({
      granted: false,
      purpose: 'deep-verify',
    });
    expect(status.pinned).toBe(false);
    expect(status.openProtectedTabs).toBe(2);
    // Onboarding stores nothing.
    expect([...m.local.keys()]).toEqual([]);
  });

  it('opens onboarding on install', async () => {
    const m = miniExt();
    registerUiHandlers(fakeRouter(), m.ext, fakeRegistry());
    m.events.installed.fire({reason: 'install'} as never);
    await flush();
    expect(m.calls.find(c => c.method === 'tabs.create')?.args).toEqual({
      url: 'ext://test-id/ui/onboarding.html',
      active: true,
    });
  });

  it('reopens onboarding after an update only while required access is missing', async () => {
    for (const [granted, opened] of [
      [true, false],
      [false, true],
    ] as const) {
      const m = miniExt();
      registerUiHandlers(fakeRouter(), m.ext, fakeRegistry(granted));
      m.events.installed.fire({reason: 'update'} as never);
      await flush();
      expect(
        m.calls.some(c => c.method === 'tabs.create'),
        String(granted),
      ).toBe(opened);
    }
  });

  it('reopens onboarding at browser start while required access is missing or unreadable', async () => {
    for (const granted of [false, 'fails'] as const) {
      const m = miniExt();
      registerUiHandlers(fakeRouter(), m.ext, fakeRegistry(granted));
      m.events.startup.fire();
      await flush();
      expect(m.calls.find(c => c.method === 'tabs.create')?.args, String(granted)).toEqual({
        url: 'ext://test-id/ui/onboarding.html#permissions',
        active: true,
      });
    }
    const m = miniExt();
    registerUiHandlers(fakeRouter(), m.ext, fakeRegistry(true));
    m.events.startup.fire();
    await flush();
    expect(m.calls.some(c => c.method === 'tabs.create')).toBe(false);
  });
});
