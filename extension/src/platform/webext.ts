/**
 * The typed, promise-only subset of the WebExtension APIs IntactWarden uses. Every module reaches
 * the browser only through an `Ext` value (production: `getExt()` from ./api.ts; unit tests:
 * fakes). An optional member is one the code checks for instead of assuming it. Add a member here
 * (and to the fakes) before using a new API.
 *
 * Types only: no runtime code, no dependency on @types/firefox-webext-browser.
 */

export interface ExtEvent<L extends (...args: never[]) => unknown> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
}

/** webRequest events take a filter and extra-info flags. */
export interface WebRequestEvent<L extends (...args: never[]) => unknown, X extends string> {
  addListener(listener: L, filter: RequestFilter, extraInfoSpec?: readonly X[]): void;
  removeListener(listener: L): void;
}

export interface MessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: Tab;
  readonly frameId?: number;
}

export interface InstalledDetails {
  readonly reason: 'install' | 'update' | 'browser_update';
  readonly previousVersion?: string;
}

/**
 * Raw onMessage listener. Firefox takes a returned Promise as the answer;
 * `undefined` means "not mine" (another listener may answer). Use the typed
 * router in ./messaging.ts instead of registering these directly.
 */
export type RawMessageListener = (
  message: unknown,
  sender: MessageSender,
) => Promise<unknown> | undefined;

export interface Runtime {
  readonly id: string;
  getURL(path: string): string;
  getManifest(): {
    readonly version: string;
    readonly manifest_version: number;
    readonly [k: string]: unknown;
  };
  sendMessage(message: unknown): Promise<unknown>;
  openOptionsPage(): Promise<void>;
  getPlatformInfo(): Promise<{readonly os: string; readonly arch: string}>;
  readonly onMessage: ExtEvent<RawMessageListener>;
  readonly onInstalled: ExtEvent<(details: InstalledDetails) => void>;
  readonly onStartup: ExtEvent<() => void>;
}

export interface StorageChange {
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
}

export interface StorageArea {
  get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  clear(): Promise<void>;
  readonly onChanged?: ExtEvent<(changes: Record<string, StorageChange>) => void>;
}

export interface Storage {
  readonly local: StorageArea;
  readonly session: StorageArea;
  readonly onChanged: ExtEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
}

export interface Tab {
  readonly id?: number;
  readonly active?: boolean;
  readonly incognito?: boolean;
  /** Only with host permission for the tab's origin; never persisted unredacted. */
  readonly url?: string;
  /** `loading` or `complete`. */
  readonly status?: string;
  /** The tab's content was unloaded (or never loaded after a session restore). */
  readonly discarded?: boolean;
}

export interface Tabs {
  query(query: {
    active?: boolean;
    currentWindow?: boolean;
    lastFocusedWindow?: boolean;
  }): Promise<Tab[]>;
  get(tabId: number): Promise<Tab>;
  create(props: {
    url: string;
    active?: boolean;
    index?: number;
    openerTabId?: number;
  }): Promise<Tab>;
  update(tabId: number, props: {url?: string; active?: boolean}): Promise<Tab>;
  reload(tabId: number, props?: {bypassCache?: boolean}): Promise<void>;
  readonly onRemoved: ExtEvent<
    (tabId: number, info: {windowId: number; isWindowClosing: boolean}) => void
  >;
}

export interface RequestFilter {
  readonly urls: readonly string[];
  readonly types?: readonly string[];
  readonly tabId?: number;
}

export interface HttpHeader {
  readonly name: string;
  readonly value?: string;
  /** Firefox may deliver binary values. */
  readonly binaryValue?: readonly number[];
}

export interface WebRequestDetails {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly tabId: number;
  readonly type: string;
  readonly timeStamp: number;
  readonly originUrl?: string;
  readonly documentUrl?: string;
  readonly frameAncestors?: readonly {readonly url: string; readonly frameId: number}[];
  readonly incognito?: boolean;
}

export interface WebRequestResponseDetails extends WebRequestDetails {
  readonly statusCode: number;
  readonly responseHeaders?: readonly HttpHeader[];
}

export interface WebRequestRedirectDetails extends WebRequestResponseDetails {
  readonly redirectUrl: string;
}

export interface WebRequestErrorDetails extends WebRequestDetails {
  readonly error: string;
}

/** Return value of the blocking listeners (webRequestBlocking). */
export interface BlockingResponse {
  readonly cancel?: boolean;
  readonly redirectUrl?: string;
  readonly responseHeaders?: readonly HttpHeader[];
}

/** webRequest.filterResponseData. */
export interface StreamFilter {
  ondata: ((event: {readonly data: ArrayBuffer}) => void) | null;
  onstart: ((event: unknown) => void) | null;
  onstop: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  readonly status: string;
  readonly error: string;
  write(data: ArrayBuffer | Uint8Array): void;
  close(): void;
  disconnect(): void;
  resume(): void;
}

export interface WebRequest {
  readonly onBeforeRequest: WebRequestEvent<
    (
      details: WebRequestDetails,
    ) => BlockingResponse | undefined | Promise<BlockingResponse | undefined>,
    'blocking' | 'requestBody' | 'extraHeaders'
  >;
  readonly onHeadersReceived: WebRequestEvent<
    (
      details: WebRequestResponseDetails,
    ) => BlockingResponse | undefined | Promise<BlockingResponse | undefined>,
    'blocking' | 'responseHeaders' | 'extraHeaders'
  >;
  readonly onBeforeRedirect: WebRequestEvent<
    (details: WebRequestRedirectDetails) => void,
    'responseHeaders' | 'extraHeaders'
  >;
  readonly onCompleted: WebRequestEvent<
    (details: WebRequestResponseDetails) => void,
    'responseHeaders' | 'extraHeaders'
  >;
  readonly onErrorOccurred: WebRequestEvent<
    (details: WebRequestErrorDetails) => void,
    'extraHeaders'
  >;
  /** Optional so a missing API gives `unverifiable 'filter-failed'` per request instead of a crash. */
  filterResponseData?(requestId: string): StreamFilter;
}

export interface WebNavigation {
  readonly onCommitted: ExtEvent<
    (details: {
      readonly tabId: number;
      readonly frameId: number;
      readonly parentFrameId: number;
      readonly url: string;
      readonly timeStamp: number;
    }) => void
  >;
  /**
   * A frame starts a navigation, to any address (no host permission needed). Optional so a missing
   * event degrades instead of crashing.
   */
  readonly onBeforeNavigate?: ExtEvent<
    (details: {
      readonly tabId: number;
      readonly frameId: number;
      readonly parentFrameId: number;
      readonly url: string;
      readonly timeStamp: number;
    }) => void
  >;
  /**
   * A document opened a new tab or window (`window.open`, a `target` link). Optional so a missing
   * event degrades instead of crashing.
   */
  readonly onCreatedNavigationTarget?: ExtEvent<
    (details: {
      readonly sourceTabId: number;
      readonly sourceFrameId: number;
      readonly tabId: number;
      readonly url: string;
      readonly timeStamp: number;
    }) => void
  >;
  /**
   * The frame's details; resolves null for a discarded tab, and rejects ("No frame found …") when
   * the tab has no such frame and for a tab that does not exist.
   */
  getFrame?(details: {readonly tabId: number; readonly frameId: number}): Promise<{
    readonly url?: string;
    readonly parentFrameId?: number;
  } | null>;
}

export interface RegisteredContentScript {
  readonly id: string;
  readonly matches: readonly string[];
  readonly js?: readonly string[];
  readonly allFrames?: boolean;
  readonly runAt?: 'document_start' | 'document_end' | 'document_idle';
  readonly persistAcrossSessions?: boolean;
}

export interface Scripting {
  registerContentScripts(scripts: readonly RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: {ids?: readonly string[]}): Promise<void>;
  getRegisteredContentScripts(filter?: {
    ids?: readonly string[];
  }): Promise<RegisteredContentScript[]>;
}

export interface PermissionSet {
  readonly permissions?: readonly string[];
  readonly origins?: readonly string[];
}

export interface Permissions {
  contains(permissions: PermissionSet): Promise<boolean>;
  /** Must run inside a user gesture (click handler). */
  request(permissions: PermissionSet): Promise<boolean>;
  remove(permissions: PermissionSet): Promise<boolean>;
  readonly onAdded: ExtEvent<(permissions: PermissionSet) => void>;
  readonly onRemoved: ExtEvent<(permissions: PermissionSet) => void>;
}

export interface Action {
  setIcon(details: {tabId?: number; path?: Record<string, string>}): Promise<void>;
  setBadgeText(details: {tabId?: number; text: string}): Promise<void>;
  setBadgeBackgroundColor(details: {tabId?: number; color: string}): Promise<void>;
  setTitle(details: {tabId?: number; title: string}): Promise<void>;
  /** Pin detection, which may not be reliable; absent where unsupported. */
  getUserSettings?(): Promise<{readonly isOnToolbar?: boolean}>;
}

export interface Notifications {
  create(
    id: string,
    options: {type: 'basic'; iconUrl: string; title: string; message: string; priority?: number},
  ): Promise<string>;
  clear(id: string): Promise<boolean>;
  readonly onClicked: ExtEvent<(id: string) => void>;
}

export interface I18n {
  getMessage(name: string, substitutions?: string | readonly string[]): string;
  getUILanguage(): string;
}

export interface ExtensionNs {
  isAllowedIncognitoAccess(): Promise<boolean>;
}

/**
 * Everything IntactWarden may call. Content scripts and extension pages see the subset their
 * context allows.
 */
export interface Ext {
  readonly runtime: Runtime;
  readonly storage: Storage;
  readonly tabs: Tabs;
  readonly webRequest: WebRequest;
  readonly scripting: Scripting;
  readonly permissions: Permissions;
  readonly action: Action;
  readonly notifications: Notifications;
  readonly i18n: I18n;
  readonly extension: ExtensionNs;
  /** Optional so a missing API degrades instead of crashing. */
  readonly webNavigation?: WebNavigation;
}
