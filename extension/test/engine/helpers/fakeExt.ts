/**
 * A small, memory-backed WebExtension fake for the engine and backend tests: event emitters you
 * can fire, a fake StreamFilter, storage areas with keys, tabs with a reload log, and manual timers
 * on a fake clock.
 */

import type {
  Ext,
  ExtEvent,
  StorageArea,
  StreamFilter,
  Tab,
  WebRequestDetails,
} from '../../../src/platform/webext.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

export class Emitter<L extends AnyFn> implements ExtEvent<L> {
  readonly listeners: {fn: L; filter?: unknown; extra?: readonly string[]}[] = [];
  addListener(fn: L, filter?: unknown, extra?: readonly string[]): void {
    this.listeners.push({fn, filter, extra});
  }
  removeListener(fn: L): void {
    const i = this.listeners.findIndex(l => l.fn === fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  /** Calls every listener; returns their (possibly promised) results. */
  emit(...args: Parameters<L>): ReturnType<L>[] {
    return this.listeners.map(l => l.fn(...args));
  }
  /** Calls every listener and awaits their results. */
  async fire(...args: Parameters<L>): Promise<Awaited<ReturnType<L>>[]> {
    return Promise.all(this.emit(...args)) as Promise<Awaited<ReturnType<L>>[]>;
  }
}

/** Manual timers on a fake clock: nothing fires until advance() passes its time. */
export class FakeTimers {
  now = 1_700_000_000_000;
  #seq = 0;
  readonly #timers = new Map<number, {at: number; fn: () => void}>();

  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.#timers.set(id, {at: this.now + Math.max(0, ms), fn});
    return id;
  };

  clear = (h: unknown): void => {
    this.#timers.delete(h as number);
  };

  clock = (): number => this.now;

  /** Advances the clock, firing due timers in time order (including ones they schedule). */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, {at: number; fn: () => void}] | undefined;
      for (const e of this.#timers)
        if (e[1].at <= end && (next === undefined || e[1].at < next[1].at)) next = e;
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
    }
    this.now = end;
  }

  get pending(): number {
    return this.#timers.size;
  }
}

export class FakeStreamFilter implements StreamFilter {
  ondata: ((event: {readonly data: ArrayBuffer}) => void) | null = null;
  onstart: ((event: unknown) => void) | null = null;
  onstop: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  status = 'transferringdata';
  error = '';
  readonly written: Uint8Array[] = [];
  closed = false;
  disconnected = false;
  readonly done: Promise<void>;
  /** Reports the end of the network response (webRequest.onCompleted), set by the fake env. */
  networkEnd: (() => void) | null = null;
  #resolve!: () => void;

  constructor() {
    this.done = new Promise(r => (this.#resolve = r));
  }

  write(data: ArrayBuffer | Uint8Array): void {
    if (this.closed) throw new Error('write after close');
    this.written.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data));
  }
  close(): void {
    this.closed = true;
    this.#resolve();
  }
  disconnect(): void {
    this.disconnected = true;
    this.#resolve();
  }
  resume(): void {}

  /**
   * The network sends a body (in chunks) and ends. Firefox reports the request completed
   * (webRequest.onCompleted) when the network response ends, before the filter stops;
   * `complete: false` leaves that report to the test.
   */
  respond(bytes: Uint8Array, chunk = 7, complete = true): void {
    for (let i = 0; i < bytes.length; i += chunk) {
      const part = bytes.slice(i, i + chunk);
      this.ondata?.({data: part.buffer});
    }
    if (complete) this.networkEnd?.();
    this.onstop?.({});
  }

  /** Everything written to the page, concatenated. */
  get output(): Uint8Array {
    const size = this.written.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of this.written) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

export class FakeArea implements StorageArea {
  readonly data = new Map<string, unknown>();
  readonly onChanged = new Emitter<
    (changes: Record<string, {oldValue?: unknown; newValue?: unknown}>) => void
  >();
  async get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const list =
      keys === undefined || keys === null
        ? [...this.data.keys()]
        : typeof keys === 'string'
          ? [keys]
          : keys;
    for (const k of list) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string | readonly string[]): Promise<void> {
    for (const k of typeof keys === 'string' ? [keys] : keys) this.data.delete(k);
  }
  async clear(): Promise<void> {
    this.data.clear();
  }
}

export interface FakeEnv {
  readonly ext: Ext;
  readonly local: FakeArea;
  readonly session: FakeArea;
  readonly filters: Map<string, FakeStreamFilter>;
  /** Make filterResponseData throw for a request id. */
  filterError: ((requestId: string) => Error | null) | null;
  readonly tabsUpdated: {tab: number; url: string}[];
  readonly tabs: Tab[];
  /** Tabs reloaded by tabs.reload, in order. */
  readonly tabsReloaded: number[];
  readonly webRequest: {
    onBeforeRequest: Emitter<AnyFn>;
    onHeadersReceived: Emitter<AnyFn>;
    onBeforeRedirect: Emitter<AnyFn>;
    onCompleted: Emitter<AnyFn>;
    onErrorOccurred: Emitter<AnyFn>;
  };
  readonly onCommitted: Emitter<AnyFn>;
  readonly onBeforeNavigate: Emitter<AnyFn>;
  readonly onCreatedNavigationTarget: Emitter<AnyFn>;
  /**
   * Removed frames ("<tab>:<frame>"): webNavigation.getFrame rejects for them as Firefox does;
   * every other frame exists. It resolves null for a tab in `discardedTabs`. Tabs in
   * `removedTabs` make getFrame and tabs.get reject.
   */
  readonly goneFrames: Set<string>;
  readonly discardedTabs: Set<number>;
  readonly removedTabs: Set<number>;
  readonly tabsOnRemoved: Emitter<AnyFn>;
  readonly onMessage: Emitter<AnyFn>;
}

export function createFakeEnv(options: {session?: FakeArea; local?: FakeArea} = {}): FakeEnv {
  const local = options.local ?? new FakeArea();
  const session = options.session ?? new FakeArea();
  const filters = new Map<string, FakeStreamFilter>();
  /** Each request's response status, from the headers the test fired (for onCompleted). */
  const statuses = new Map<string, number>();
  const onHeadersReceived = new (class extends Emitter<AnyFn> {
    override emit(...args: Parameters<AnyFn>): ReturnType<AnyFn>[] {
      const d = args[0] as {requestId?: string; statusCode?: number} | undefined;
      if (d?.requestId !== undefined && typeof d.statusCode === 'number') {
        statuses.set(d.requestId, d.statusCode);
      }
      return super.emit(...args);
    }
  })();
  const env: FakeEnv = {
    local,
    session,
    filters,
    filterError: null,
    tabsUpdated: [],
    tabs: [],
    tabsReloaded: [],
    webRequest: {
      onBeforeRequest: new Emitter(),
      onHeadersReceived,
      onBeforeRedirect: new Emitter(),
      onCompleted: new Emitter(),
      onErrorOccurred: new Emitter(),
    },
    onCommitted: new Emitter(),
    onBeforeNavigate: new Emitter(),
    onCreatedNavigationTarget: new Emitter(),
    goneFrames: new Set(),
    discardedTabs: new Set(),
    removedTabs: new Set(),
    tabsOnRemoved: new Emitter(),
    onMessage: new Emitter(),
    ext: undefined as unknown as Ext,
  };
  const ext = {
    runtime: {
      id: 'test-extension-id',
      getURL: (p: string) => `moz-extension://test-extension-id/${p}`,
      getManifest: () => ({version: '0.1.0', manifest_version: 3}),
      sendMessage: async () => undefined,
      openOptionsPage: async () => undefined,
      getPlatformInfo: async () => ({os: 'linux', arch: 'x86-64'}),
      onMessage: env.onMessage,
      onInstalled: new Emitter(),
      onStartup: new Emitter(),
    },
    storage: {local, session, onChanged: new Emitter()},
    tabs: {
      query: async () => env.tabs,
      get: async (id: number) => {
        if (env.removedTabs.has(id)) throw new Error(`Invalid tab ID: ${id}`);
        return env.tabs.find(t => t.id === id) ?? {id};
      },
      create: async (p: {url: string}) => ({id: 999, url: p.url}),
      update: async (tab: number, p: {url?: string}) => {
        env.tabsUpdated.push({tab, url: p.url ?? ''});
        return {id: tab};
      },
      reload: async (tab: number) => {
        env.tabsReloaded.push(tab);
      },
      onRemoved: env.tabsOnRemoved,
    },
    webRequest: {
      ...env.webRequest,
      filterResponseData: (requestId: string): StreamFilter => {
        const e = env.filterError?.(requestId) ?? null;
        if (e !== null) throw e;
        const f = new FakeStreamFilter();
        f.networkEnd = () =>
          void env.webRequest.onCompleted.emit({
            requestId,
            statusCode: statuses.get(requestId) ?? 200,
          });
        filters.set(requestId, f);
        return f;
      },
    },
    scripting: {
      registerContentScripts: async () => undefined,
      unregisterContentScripts: async () => undefined,
      getRegisteredContentScripts: async () => [],
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
      remove: async () => true,
      onAdded: new Emitter(),
      onRemoved: new Emitter(),
    },
    action: {
      setIcon: async () => undefined,
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async () => undefined,
    },
    notifications: {
      create: async (id: string) => id,
      clear: async () => true,
      onClicked: new Emitter(),
    },
    i18n: {getMessage: (n: string) => n, getUILanguage: () => 'en'},
    extension: {isAllowedIncognitoAccess: async () => false},
    webNavigation: {
      onCommitted: env.onCommitted,
      onBeforeNavigate: env.onBeforeNavigate,
      onCreatedNavigationTarget: env.onCreatedNavigationTarget,
      getFrame: async ({tabId, frameId}: {tabId: number; frameId: number}) => {
        if (env.removedTabs.has(tabId)) throw new Error(`Invalid tab ID: ${tabId}`);
        if (env.discardedTabs.has(tabId)) return null;
        if (env.goneFrames.has(`${tabId}:${frameId}`))
          throw new Error(`No frame found with frameId: ${frameId}`);
        return {url: '', parentFrameId: frameId === 0 ? -1 : 0};
      },
    },
  };
  (env as {ext: Ext}).ext = ext as unknown as Ext;
  return env;
}

/** A webRequest details object with defaults. */
export function details(
  d: Partial<WebRequestDetails> & {requestId: string; url: string; type: string},
): WebRequestDetails {
  return {
    method: 'GET',
    frameId: 0,
    parentFrameId: -1,
    tabId: 1,
    timeStamp: 0,
    ...d,
  };
}
