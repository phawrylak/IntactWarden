/**
 * Settings store: storage.local `l:v1:settings`, with DEFAULT_SETTINGS for anything missing or
 * malformed; changes are broadcast to the extension pages (SETTINGS_UPDATED). The background is the
 * only writer.
 */

import {DEFAULT_SETTINGS, LOCAL_KEYS, type Settings, type SettingsPatch} from '../contracts.ts';
import {errorName, logWarn} from './guard.ts';
import {broadcast, type Router} from './messaging.ts';
import {createLocalStore} from './storage.ts';
import type {Ext} from './webext.ts';

export interface SettingsStore {
  ready(): Promise<Settings>;
  /** Current settings (DEFAULT_SETTINGS before ready() resolves). */
  get(): Settings;
  update(patch: SettingsPatch): Promise<Settings>;
}

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Validates anything into Settings: bad fields fall back to defaults; unknown keys are dropped. */
export function normalizeSettings(raw: unknown): Settings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS;
  return {
    v: 1,
    notifications: bool(r.notifications, d.notifications),
  };
}

export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  return normalizeSettings({...current, ...obj(patch)});
}

export function createSettingsStore(ext: Ext): SettingsStore {
  const local = createLocalStore(ext);
  let current: Settings = DEFAULT_SETTINGS;
  let chain: Promise<unknown> = Promise.resolve();
  const loaded = (async () => {
    try {
      current = normalizeSettings(await local.get(LOCAL_KEYS.settings));
    } catch (e) {
      logWarn('settings-load', {error: errorName(e)});
      current = DEFAULT_SETTINGS;
    }
    return current;
  })();
  return {
    ready: () => loaded,
    get: () => current,
    update(patch) {
      const run = chain.then(async () => {
        await loaded;
        const next = applySettingsPatch(current, patch);
        current = next;
        await local.set(LOCAL_KEYS.settings, next);
        broadcast(ext, 'SETTINGS_UPDATED', {settings: next});
        return next;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

export function registerSettingsHandlers(router: Router, store: SettingsStore): void {
  // The current settings, not the ones `ready()` loaded at start (they change with every update).
  router.handle('UI_GET_SETTINGS', async () => {
    await store.ready();
    return store.get();
  });
  router.handle('UI_SET_SETTINGS', async ({patch}) => store.update(patch));
}
