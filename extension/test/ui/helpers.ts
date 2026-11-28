/**
 * Test helpers for the UI unit tests: the bundled catalogues, a
 * minimal memory-backed Ext with only the members the UI's background code
 * uses, and TabStateRecord fixtures.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DocSummary, OriginAlert, TabStateRecord} from '../../src/contracts.ts';
import type {Lang} from '../../src/i18n/t.ts';
import type {Ext} from '../../src/platform/webext.ts';

export const LOCALES_DIR = join(import.meta.dirname, '..', '..', '_locales');

type Catalogue = Record<
  string,
  {message: string; placeholders?: Record<string, {content: string}>}
>;

export function loadCatalogue(lang: Lang): Catalogue {
  return JSON.parse(readFileSync(join(LOCALES_DIR, lang, 'messages.json'), 'utf8')) as Catalogue;
}

/** Firefox's getMessage rules: `$NAME$` → placeholder content, whose `$1`..`$9` are substitutions. */
export function formatMessage(
  catalogue: Catalogue,
  name: string,
  subs?: string | readonly string[],
): string {
  const e = catalogue[name];
  if (!e) return '';
  const list = subs === undefined ? [] : typeof subs === 'string' ? [subs] : subs;
  const positional = (text: string): string =>
    text.replace(/\$(\$|[1-9])/g, (_m, d: string) =>
      d === '$' ? '$' : (list[Number(d) - 1] ?? ''),
    );
  return e.message.replace(/\$([A-Za-z0-9_@]+)\$|\$(\$|[1-9])/g, (m, ph?: string) =>
    ph === undefined
      ? positional(m)
      : positional(e.placeholders?.[ph.toLowerCase()]?.content ?? ''),
  );
}

/**
 * `t()` asks `browser.i18n` (src/i18n/t.ts). The UI tests install one stub `browser` global whose
 * getMessage formats the bundled catalogue chosen by useLang(); resetI18n() unsets it (every key
 * then resolves to itself, as without a browser).
 */
const active: {catalogue: Catalogue | null; lang: Lang} = {catalogue: null, lang: 'en'};

function installI18n(): void {
  const g = globalThis as {browser?: unknown};
  g.browser ??= {
    i18n: {
      getMessage: (name: string, subs?: string | readonly string[]) =>
        active.catalogue ? formatMessage(active.catalogue, name, subs) : '',
      getUILanguage: () => active.lang,
    },
  };
}

/** Forgets the catalogue: every key resolves to itself. */
export function resetI18n(): void {
  installI18n();
  active.catalogue = null;
  active.lang = 'en';
}

/** Makes `t` format messages from `catalogue`, as Firefox in `lang`. */
export function useCatalogue(catalogue: Catalogue, lang: Lang): void {
  installI18n();
  active.catalogue = catalogue;
  active.lang = lang;
}

/** Makes `t` format messages from the bundled catalogue of `lang`, as Firefox in that language. */
export function useLang(lang: Lang): void {
  useCatalogue(loadCatalogue(lang), lang);
}

type Listener = (...args: never[]) => unknown;

function event<L extends Listener>(): {
  addListener(l: L): void;
  removeListener(l: L): void;
  fire(...args: Parameters<L>): void;
  readonly listeners: Set<L>;
} {
  const listeners = new Set<L>();
  return {
    listeners,
    addListener: l => void listeners.add(l),
    removeListener: l => void listeners.delete(l),
    fire: (...args) => {
      for (const l of listeners) (l as (...a: Parameters<L>) => unknown)(...args);
    },
  };
}

function area(
  onChange: (changes: Record<string, {oldValue?: unknown; newValue?: unknown}>) => void,
) {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>> {
      const list =
        keys === undefined || keys === null
          ? [...data.keys()]
          : typeof keys === 'string'
            ? [keys]
            : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, {oldValue?: unknown; newValue?: unknown}> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = {oldValue: data.get(k), newValue: v};
        data.set(k, structuredClone(v));
      }
      onChange(changes);
    },
    async remove(keys: string | readonly string[]): Promise<void> {
      for (const k of typeof keys === 'string' ? [keys] : keys) data.delete(k);
    },
    async clear(): Promise<void> {
      data.clear();
    },
  };
}

export interface MiniExt {
  readonly ext: Ext;
  readonly calls: {method: string; args: unknown}[];
  readonly local: Map<string, unknown>;
  readonly session: Map<string, unknown>;
  readonly granted: Set<string>;
  readonly events: {
    storageChanged: ReturnType<typeof event>;
    installed: ReturnType<typeof event>;
    startup: ReturnType<typeof event>;
    notificationClicked: ReturnType<typeof event>;
    permissionsAdded: ReturnType<typeof event>;
    permissionsRemoved: ReturnType<typeof event>;
  };
  tabs: {id: number; url?: string}[];
  onToolbar: boolean | undefined;
  incognito: boolean;
}

export const HOST_PERMISSIONS = [
  'https://vault.bitwarden.com/*',
  'https://vault.bitwarden.eu/*',
  'https://api.github.com/*',
  'https://release-assets.githubusercontent.com/*',
];

/** A memory-backed Ext with the members the UI background code calls; every call is recorded. */
export function miniExt(options: {grantAll?: boolean} = {}): MiniExt {
  const calls: {method: string; args: unknown}[] = [];
  const storageChanged = event<(changes: Record<string, unknown>, areaName: string) => void>();
  const local = area(changes => storageChanged.fire(changes, 'local'));
  const session = area(changes => storageChanged.fire(changes, 'session'));
  const granted = new Set<string>(options.grantAll === false ? [] : HOST_PERMISSIONS);
  granted.add('notifications');
  const events = {
    storageChanged,
    installed: event(),
    startup: event(),
    notificationClicked: event(),
    permissionsAdded: event(),
    permissionsRemoved: event(),
  };
  const state: MiniExt = {
    calls,
    local: local.data,
    session: session.data,
    granted,
    events: events as MiniExt['events'],
    tabs: [],
    onToolbar: true,
    incognito: false,
    ext: undefined as unknown as Ext,
  };
  const record =
    (method: string) =>
    async (args: unknown): Promise<void> => {
      calls.push({method, args});
    };
  const ext = {
    runtime: {
      id: 'test-id',
      getURL: (path: string) => `ext://test-id/${path}`,
      getManifest: () => ({
        version: '0.1.0',
        manifest_version: 3,
        host_permissions: HOST_PERMISSIONS,
      }),
      onInstalled: events.installed,
      onStartup: events.startup,
    },
    storage: {local, session, onChanged: storageChanged},
    tabs: {
      query: async () => state.tabs,
      create: async (props: unknown) => {
        calls.push({method: 'tabs.create', args: props});
        return {id: 999};
      },
    },
    permissions: {
      contains: async (p: {origins?: string[]; permissions?: string[]}) =>
        [...(p.origins ?? []), ...(p.permissions ?? [])].every(x => granted.has(x)),
      request: async (p: {origins?: string[]}) => {
        calls.push({method: 'permissions.request', args: p});
        for (const o of p.origins ?? []) granted.add(o);
        return true;
      },
      remove: async (p: {origins?: string[]}) => {
        calls.push({method: 'permissions.remove', args: p});
        return true;
      },
      onAdded: events.permissionsAdded,
      onRemoved: events.permissionsRemoved,
    },
    action: {
      setIcon: record('action.setIcon'),
      setBadgeText: record('action.setBadgeText'),
      setBadgeBackgroundColor: record('action.setBadgeBackgroundColor'),
      setTitle: record('action.setTitle'),
      getUserSettings: async () => ({isOnToolbar: state.onToolbar}),
    },
    notifications: {
      create: async (id: string, opts: unknown) => {
        calls.push({method: 'notifications.create', args: {id, opts}});
        return id;
      },
      clear: async () => true,
      onClicked: events.notificationClicked,
    },
    extension: {isAllowedIncognitoAccess: async () => state.incognito},
    i18n: {getMessage: () => '', getUILanguage: () => 'en'},
  };
  (state as {ext: Ext}).ext = ext as unknown as Ext;
  return state;
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

export function counts(partial: Partial<DocSummary['counts']> = {}): DocSummary['counts'] {
  return {
    document: {ok: 1, total: 1},
    scripts: {ok: 41, total: 41},
    wasm: {ok: 1, total: 1},
    styles: {ok: 1, total: 1},
    data: {ok: 3, total: 3},
    fonts: {ok: 0, total: 0},
    unverifiable: 0,
    thirdParty: [],
    ...partial,
  };
}

export function topDoc(partial: Partial<DocSummary> = {}): DocSummary {
  return {
    doc: 'doc-1',
    frame: 0,
    path: '/',
    docClass: 'manifest',
    state: 'VERIFIED',
    reasons: [],
    flags: [],
    counts: counts(),
    binding: {
      buildId: 'bitwarden-web@2026.10.1+cloud-us',
      app: 'bitwarden-web',
      variant: 'cloud-us',
      version: '2026.10.1',
      assurance: 'release-derived',
      source: 'bundled',
      repo: 'https://github.com/bitwarden/clients',
      tag: 'web-v2026.10.1',
      commit: '0123456789abcdef0123456789abcdef01234567',
      artifactSha256: 'a'.repeat(64),
      retroAt: null,
    },
    serverStyle: null,
    coResident: null,
    thirdPartyBlocked: [],
    ...partial,
  };
}

export function tabRecord(partial: Partial<TabStateRecord> = {}): TabStateRecord {
  return {
    v: 1,
    tab: 7,
    updatedAt: Date.UTC(2026, 10, 6, 10, 0),
    origin: 'https://vault.bitwarden.com',
    app: 'bitwarden-web',
    deploymentId: 'cloud-us',
    kind: 'official',
    instance: null,
    state: 'VERIFIED',
    reasons: [],
    flags: [],
    top: topDoc(),
    frames: [],
    hint: null,
    unknownBuild: null,
    alert: null,
    incidentId: null,
    allowances: null,
    permissionMissing: false,
    ...partial,
  };
}

export function alert(partial: Partial<OriginAlert> = {}): OriginAlert {
  return {
    origin: 'https://vault.bitwarden.com',
    at: Date.UTC(2026, 10, 6, 9, 30),
    state: 'MISMATCH',
    reasons: ['bytes'],
    incident_id: '0123456789abcdef',
    acknowledged: false,
    ...partial,
  };
}
