/**
 * Platform layer: sender validation and the router's error replies, settings
 * validation and patch merge, storage key listing, error names in logs,
 * and the deferred IndexedDB handle.
 */

import {describe, expect, it} from 'vitest';
import {DEFAULT_SETTINGS} from '../../src/contracts.ts';
import {errorName} from '../../src/platform/guard.ts';
import {deferredExtensionDb} from '../../src/platform/idb.ts';
import {memoryExtensionDb} from '../helpers/memoryDb.ts';
import {createRouter, MessageError, validateSender} from '../../src/platform/messaging.ts';
import {
  applySettingsPatch,
  createSettingsStore,
  normalizeSettings,
} from '../../src/platform/settings.ts';
import {createLocalStore, createSessionStore} from '../../src/platform/storage.ts';
import {createFakeEnv} from '../engine/helpers/fakeExt.ts';

describe('validateSender', () => {
  const env = createFakeEnv();
  const base = 'moz-extension://test-extension-id/';
  it('classifies content scripts and pages from sender only', () => {
    expect(
      validateSender(env.ext, {
        id: 'test-extension-id',
        url: 'https://vault.bitwarden.com/?q=1#k',
        tab: {id: 4},
        frameId: 0,
      }),
    ).toEqual({
      kind: 'content',
      tab: 4,
      frame: 0,
      url: 'https://vault.bitwarden.com/',
    });
    expect(
      validateSender(env.ext, {id: 'test-extension-id', url: `${base}ui/popup.html`})?.kind,
    ).toBe('page');
    expect(validateSender(env.ext, {id: 'other', url: `${base}ui/popup.html`})).toBeNull();
    expect(validateSender(env.ext, {id: 'test-extension-id'})).toBeNull();
  });
  it('the router refuses a sender of the wrong kind and maps handler errors', async () => {
    const env2 = createFakeEnv();
    const router = createRouter(env2.ext);
    router.handle('UI_GET_STATE', async () => {
      throw new MessageError('not-ready');
    });
    router.handle('UI_LIST_ALERTS', async () => {
      throw new Error('boom https://secret.example/?token');
    });
    router.start();
    // Firefox: the listener's returned Promise is the reply; undefined means "not mine".
    const call = async (message: unknown, sender: object): Promise<unknown> => {
      const r = env2.onMessage.emit(message, sender) as unknown[];
      return r[0] === undefined ? 'no-async-reply' : await r[0];
    };
    const page = {id: 'test-extension-id', url: `${base}ui/popup.html`};
    const content = {id: 'test-extension-id', url: 'https://vault.bitwarden.com/', tab: {id: 1}};
    expect(await call({iw: 1, type: 'UI_GET_STATE', payload: {tab: 1}}, content)).toEqual({
      ok: false,
      error: 'bad-sender',
    });
    expect(await call({iw: 1, type: 'UI_GET_STATE', payload: {tab: 1}}, page)).toEqual({
      ok: false,
      error: 'not-ready',
    });
    expect(await call({iw: 1, type: 'UI_LIST_ALERTS', payload: {}}, page)).toEqual({
      ok: false,
      error: 'internal-error',
    });
    expect(await call({something: 'else'}, page)).toBe('no-async-reply');
    expect(() => router.handle('UI_GET_STATE', async () => null)).toThrow();
  });
});

describe('settings', () => {
  it('malformed values fall back to defaults; a patch sets the fields it names', () => {
    expect(normalizeSettings({notifications: 'chaos'})).toEqual(DEFAULT_SETTINGS);
    const s = applySettingsPatch(DEFAULT_SETTINGS, {notifications: false});
    expect(s).toEqual({...DEFAULT_SETTINGS, notifications: false});
  });
  it('drops unknown keys from stored settings', () => {
    const s = normalizeSettings({
      unknown: 'x',
      nested: {flag: true},
      list: [1, 2],
    });
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(s).sort()).toEqual(['notifications', 'v']);
  });
  it('ignores the deepVerify setting that earlier builds stored', () => {
    expect(normalizeSettings({v: 1, notifications: false, deepVerify: {auto: false}})).toEqual({
      v: 1,
      notifications: false,
    });
  });
  it('the store persists and broadcasts an update', async () => {
    const env = createFakeEnv();
    const sent: unknown[] = [];
    (env.ext.runtime as {sendMessage: (m: unknown) => Promise<void>}).sendMessage = async m =>
      void sent.push(m);
    const store = createSettingsStore(env.ext);
    await store.ready();
    await store.update({notifications: false});
    expect(store.get().notifications).toBe(false);
    expect((env.local.data.get('l:v1:settings') as {notifications: boolean}).notifications).toBe(
      false,
    );
    expect(sent).toMatchObject([{broadcast: 'SETTINGS_UPDATED'}]);
  });
});

describe('storage', () => {
  it('session keys by prefix; local values validated on read', async () => {
    const env = createFakeEnv();
    const session = createSessionStore(env.ext);
    await session.set({'s:v1:doc:a': 1, 's:v1:doc:b': 2, 's:v1:tab:1': 3});
    expect((await session.keys('s:v1:doc:')).sort()).toEqual(['s:v1:doc:a', 's:v1:doc:b']);
    const local = createLocalStore(env.ext);
    env.local.data.set('l:v1:instances', 'not an array');
    expect(await local.get('l:v1:instances')).toBeUndefined();
  });
});

describe('error names and IndexedDB', () => {
  it('errorName() logs the constructor name, never the message', () => {
    expect(errorName(new TypeError('secret'))).toBe('TypeError');
  });
  it('a deferred database answers once the real one is there', async () => {
    const mem = memoryExtensionDb();
    const db = deferredExtensionDb(Promise.resolve(mem));
    const core = {sha256: 'a'.repeat(64), bytes: new Uint8Array([1]), buildId: 'b', addedAt: 0};
    await db.cores.put(core.sha256, core);
    expect(await mem.cores.keys()).toEqual([core.sha256]);
  });
  it('a database that cannot be opened fails each call, not the background', async () => {
    const db = deferredExtensionDb(Promise.reject(new Error('no IndexedDB')));
    await expect(db.cores.get('x')).rejects.toThrow('no IndexedDB');
  });
});
