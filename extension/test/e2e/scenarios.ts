/**
 * The end-to-end scenarios, written against the E2EDriver interface (firefox/driver.ts) and run by
 * firefox.e2e.test.ts: the test package installed as a temporary add-on in an official Firefox,
 * driven by geckodriver through selenium-webdriver.
 *
 * Every scenario installs the package into a fresh profile, adds its fixture origin as a
 * self-hosted instance through the options flow (one UI_ADD_INSTANCE, as the options page's "Add
 * server" sends it) and ends with the storage privacy check. Code that does not match its release
 * is never released, so a tampered document shows the blocked page and a tampered subresource is
 * closed empty.
 */

import {expect} from 'vitest';
import type {
  BlockedView,
  InstanceRecord,
  ItemRecord,
  MessageRequest,
  MessageResponse,
  MessageType,
  TabStateRecord,
  VerdictState,
} from '../../src/contracts.ts';
import {matchPatternFor} from '../../src/deployments/serverAddress.ts';
import {GOLDEN_CORES} from '../../../packages/builders/test/helpers/golden.ts';
import type {GitHubMirror, MirrorRequest} from './server/github.ts';
import {
  BITPAY_INVOICE,
  PAYPAL_ACTION,
  STRIPE_JS,
  STRIPE_MARKER,
  type PaymentHosts,
} from './server/payments.ts';
import {
  ATTR_MARKER,
  chunkPath,
  INLINE_MARKER,
  SM_TAMPER_MARKER,
  TAMPER_MARKER,
} from './server/releases.ts';
import {
  ATTACKER_PAGE,
  EVIL_MARKER,
  FRAMED_BUTTON,
  FRAMED_MARKER,
  FRAMED_READ_MARKER,
  FRAMING_HEARD_MARKER,
  FRAMING_HOST,
  LOCALE_MARKER,
  LOCALE_PATH,
  WORKER_DOCUMENT_MARKER,
  WORKER_INSTALL_PAGE,
  WORKER_READY_MARKER,
  WORKER_SCRIPT_MARKER,
  type CloudSite,
  type FramedAttack,
  type Site,
  type WorkerMode,
} from './server/sites.ts';

/**
 * Which package a scenario installs: the test build with every bundled core, the test build with
 * only Bitwarden's, or the shipping (production) build, which has no loopback host permissions and
 * no bundled cores.
 */
export type PackageKind = 'full' | 'bitwarden-only' | 'release';

export interface E2EDriver {
  /**
   * A fresh profile with the test package installed and the background ready. `prefs`: extra
   * Firefox preferences of the profile.
   */
  install(
    pkg: PackageKind,
    prefs?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void>;
  /** A page → background message, as an extension page sends it; throws on an error reply. */
  ui<T extends MessageType>(type: T, payload: MessageRequest<T>): Promise<MessageResponse<T>>;
  /** Opens `url` in a new tab and waits for the load to finish; returns the tab id. */
  open(url: string): Promise<number>;
  /**
   * Whether the page ran the code that sets `self[marker]` (the page's own global, so the
   * browser's CSP, the server's and IntactWarden's floor, applies).
   */
  ran(tab: number, marker: string): Promise<boolean>;
  /** The URL the tab shows now (the blocked page after a denied document). */
  tabUrl(tab: number): Promise<string>;
  /**
   * Moves the tab's current document to `hash` (no new document): `location.hash = hash` in the
   * page, as a link to the route does. The app's hash router navigates on the `hashchange` and
   * requests the route's lazy chunks itself.
   */
  setHash(tab: number, hash: string): Promise<void>;
  /**
   * A `<script src=path>` the page appends, as webpack's chunk loader does for a lazy chunk: a
   * same-origin `script` request of the tab's document (the element is appended from WebDriver).
   * Answers the element's load or error event.
   */
  pageScript(tab: number, path: string): Promise<'load' | 'error'>;
  /** The notifications the extension shows (id and title). */
  notifications(): Promise<readonly {readonly id: string; readonly title: string}[]>;
  /** URLs of the tabs showing one of the extension's own pages (other than the control tab). */
  extensionTabs(): Promise<readonly string[]>;
  /** storage.local and storage.session of the extension. */
  storageDump(): Promise<{local: Record<string, unknown>; session: Record<string, unknown>}>;
  /** The extension's base URL (`moz-extension://<uuid>/`). */
  readonly baseUrl: string;
  /**
   * Firefox only: the options page's own UI (type the address, "Add server"; a look-alike host
   * asks for a confirmation and a second click); returns the confirmations given.
   */
  addInstanceInOptions?(input: string): Promise<readonly string[]>;
  /** Firefox only: `permissions.remove` of host patterns, as the user does in about:addons. */
  revokeHosts?(patterns: readonly string[]): Promise<void>;
  /** Firefox only: `permissions.request` from a click handler (as the popup's "Grant" does). */
  grantHosts?(patterns: readonly string[]): Promise<void>;
  /** Firefox only: the onboarding page's "Grant" button; returns the patterns still missing. */
  grantFromOnboarding?(): Promise<readonly string[]>;
  /**
   * Firefox only: the text the toolbar popup (`ui/popup.html`) renders for `tab`: the page runs
   * in an inactive tab while `tab` is the active one, which is the tab its query picks.
   */
  popupText?(tab: number): Promise<string>;
  /**
   * Firefox only: the event page's state (`running`, `stopped`, `starting`, `suspending`) and how
   * many times it has started in this profile, read in the chrome context.
   */
  background?(): Promise<{readonly state: string; readonly starts: number}>;
  /** Firefox only: closes a tab. */
  closeTab?(tab: number): Promise<void>;
  /** Firefox only: the ids of the tabs whose URL is `url` (a window a page opened, say). */
  tabsWithUrl?(url: string): Promise<readonly number[]>;
  /**
   * Firefox only: one `fetch` of a same-origin path from the tab's document, as the app's i18n
   * service reads a locale (`cache: 'no-store'`); the response's status, the start of its body
   * text, its length and the headers the page sees.
   */
  pageFetch?(tab: number, path: string): Promise<PageFetchResult>;
  /** Firefox only: a click (user input) on the element `selector` names in the tab's page. */
  pageClick?(tab: number, selector: string): Promise<void>;
  /** Firefox only: sets `self[marker] = true` in the tab's page (read back with `ran`). */
  mark?(tab: number, marker: string): Promise<void>;
  /**
   * Firefox only: inserts an inline `<script>` that sets `scriptMarker` and an element whose
   * inline event handler sets `attrMarker` into the tab's page, as a DOM injection would.
   */
  pageInject?(tab: number, scriptMarker: string, attrMarker: string): Promise<void>;
  /**
   * Firefox only: appends an `<iframe>` of the same-origin page `src` to the tab's document, as
   * the app's two-step login frames its WebAuthn connector; answers the first message the frame
   * posts to its parent, or null when none came within 15 s.
   */
  pageFrame?(tab: number, src: string): Promise<string | null>;
  /**
   * Firefox only: inserts an image from another origin and an inline `<script>` that would set
   * `marker` into the tab's page; answers the browser's CSP reports of the next 1.5 s.
   */
  pageCspReports?(tab: number, marker: string): Promise<readonly CspReport[]>;
  /** Firefox only: the first frame of the tab's page. */
  frameState?(tab: number, marker: string): Promise<FrameState>;
  /**
   * Firefox only: a click (user input) on the element `selector` names in the first frame of the
   * tab's page; false when the frame has no such element.
   */
  frameClick?(tab: number, selector: string): Promise<boolean>;
  /**
   * Firefox only: the vault's "Add credit → PayPal" form (`method=post`, `target=_top`) with
   * these hidden fields, submitted from the tab's page.
   */
  pagePost?(tab: number, action: string, fields: Readonly<Record<string, string>>): Promise<void>;
  /**
   * Firefox only: the vault's `launchUri` (a `target=_blank` link, clicked) from the tab's page;
   * answers the URL the new tab shows.
   */
  pageLaunch?(tab: number, url: string): Promise<string>;
  /** Firefox only: reloads the tab (as F5 does) and waits for the load to finish. */
  reload?(tab: number): Promise<void>;
  /**
   * Firefox only: `location.reload()` from the tab's page, as a page script calls it; returns at
   * once, without waiting for the load.
   */
  reloadNow?(tab: number): Promise<void>;
  /**
   * Firefox only: `location.reload()` twice from one script of the tab's page, the second call
   * `gapMs` after the first; returns at once, without waiting for a load.
   */
  reloadTwice?(tab: number, gapMs: number): Promise<void>;
  /** Firefox only: loads `url` in the tab (as typing it) and waits for the load to finish. */
  navigate?(tab: number, url: string): Promise<void>;
  /** Firefox only: the tab goes back one history entry ("Back"). */
  back?(tab: number): Promise<void>;
  /** Firefox only: the tab goes forward one history entry ("Forward"). */
  forward?(tab: number): Promise<void>;
  /**
   * Firefox only: the toolbar popup for `tab`, in a background tab that loaded while `tab` was
   * the active one; driven through its own buttons.
   */
  popup?(tab: number): Promise<PopupHandle>;
  /**
   * Firefox only: clears the cookies and site data of `origin`'s site, as "Clear cookies and site
   * data" in the address bar's site panel does (its service workers go with them).
   */
  clearSiteData?(origin: string): Promise<void>;
  /**
   * Firefox only: the service workers the tab's page sees: how many registrations its origin
   * lists, and whether a worker controls the page.
   */
  pageWorkers?(tab: number): Promise<PageWorkers>;
  /** Firefox only: on the blocked page in `tab`, ticks the confirmation and clicks "Proceed once". */
  proceedOnce?(tab: number): Promise<void>;
  uninstall(): Promise<void>;
}

/** The toolbar popup of one tab (`popup`). */
export interface PopupHandle {
  /** The popup's text as shown. */
  text(): Promise<string>;
  /** Whether a button with exactly this label is shown. */
  hasButton(label: string): Promise<boolean>;
  /** Clicks the button with exactly this label (waits for it). */
  click(label: string): Promise<void>;
  /** Closes the popup's tab if it is still open. */
  close(): Promise<void>;
}

/** One CSP report of the browser (`pageCspReports`). */
export interface CspReport {
  /** The violated directive (`effectiveDirective`). */
  readonly directive: string;
  /** The whole policy that reported it (`originalPolicy`). */
  readonly policy: string;
}

/** The first frame of a page (`frameState`). */
export interface FrameState {
  /** Whether the frame's page ran the code that sets `self[marker]`. */
  readonly ran: boolean;
  /** How many elements the frame's document has. */
  readonly elements: number;
  /**
   * The error of the page Firefox shows in the frame in place of a document it did not render
   * (`cspBlocked` for frame-ancestors, `xfoBlocked` for X-Frame-Options), or null.
   */
  readonly error: string | null;
}

/** The service workers a page sees (`pageWorkers`). */
export interface PageWorkers {
  readonly registrations: number;
  readonly controlled: boolean;
}

/** What a page's `fetch` read (`pageFetch`). */
export interface PageFetchResult {
  readonly status: number;
  /** The first 4 KiB of the body text. */
  readonly body: string;
  /** The length of the body text. */
  readonly size: number;
  /** The response headers the page sees (lowercase names). */
  readonly headers: Readonly<Record<string, string>>;
}

export interface Fixtures {
  readonly bitwarden: Site;
  readonly bitwardenTampered: Site;
  readonly bitwardenInline: Site;
  /** The main script answers 302 to another origin. */
  readonly bitwardenScriptRedirect: Site;
  /** index.html carries a Refresh header to another origin. */
  readonly bitwardenRefresh: Site;
  /** The Secrets Manager chunk 541 gets one appended statement (SM_TAMPER_MARKER). */
  readonly bitwardenSmTampered: Site;
  /** Answers a request whose `If-None-Match` names the file's ETag with 304. */
  readonly bitwardenRevalidating: Site;
  readonly vaultwarden: Site;
  readonly vaultwardenInline: Site;
  /** The same release with DOMAIN https://h/vw: base path /vw/. */
  readonly vaultwardenSubpath: Site;
  /** The stock stylesheet plus one admin rule. */
  readonly vaultwardenCustomCss: Site;
  /** /vw-version.json names 2026.8.0, a release published without its tarball. */
  readonly vaultwardenImageOnly: Site;
  /**
   * An attacker page at ATTACKER_PAGE (BUILD_UNVERIFIED, let through with "Proceed once") that
   * forges `pagehide` and frames the vault.
   */
  readonly vaultwardenForgedPagehide: Site;
  /**
   * Also serves Bitwarden's Secrets Manager chunk 541 (code no Vaultwarden release contains), with
   * one appended statement that sets SM_TAMPER_MARKER when it runs.
   */
  readonly vaultwardenSmChunk: Site;
  /**
   * An attacker page at ATTACKER_PAGE (BUILD_UNVERIFIED, let through with "Proceed once") that
   * moves its tab to a same-origin `blob:` page it made (after `#go`), which opens the vault in a
   * new window; an identity page with the same script, and an OIDC sign-in path that answers 302
   * to an identity provider on another origin (`idpOrigin`).
   */
  readonly vaultwardenBlob: Site;
  /** Answers the listed /locales/en/messages.json with status 203 and other bytes. */
  readonly vaultwardenLocale203: Site;
  /** Holds each `.wasm` response halfway for 4 s (`heldResponses` counts them). */
  readonly vaultwardenHeldWasm: Site;
  /** The same, with the `.wasm` response gzip-coded. */
  readonly vaultwardenHeldWasmGzip: Site;
  /**
   * Holds each vault document (`/`) for 3 s before its response starts (`heldResponses` counts
   * them, `abortedResponses` those the browser cut off).
   */
  readonly vaultwardenHeldHeaders: Site;
  /** Holds each vault document (`/`) halfway for 3 s (counted as above). */
  readonly vaultwardenHeldDocument: Site;
  /**
   * Adds a `Link` header naming a script on another origin (`rel=preload`) and one naming a
   * listed file to every response, as a proxy or a hostile server might.
   */
  readonly vaultwardenLink: Site;
  /**
   * Answers a frame's load of the vault document with an attacker document (a `FramedAttack`, by
   * the query string); `framedLoads` counts them.
   */
  readonly vaultwardenFramed: Site;
  /**
   * Serves a page (WORKER_INSTALL_PAGE) that registers a service worker for the site; the worker
   * answers the vault document or its main script itself (a `WorkerMode`).
   */
  readonly vaultwardenServiceWorker: Site;
  /** Stands in for https://vault.bitwarden.com (cloud-us); can be redeployed. */
  readonly bitwardenCloud: CloudSite;
  readonly github: GitHubMirror;
  /** js.stripe.com, www.paypal.com and bitpay.com, through the proxy. */
  readonly payments: PaymentHosts;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly pkg: PackageKind;
  /** Extra Firefox preferences for this scenario's profile. */
  readonly prefs?: Readonly<Record<string, string | number | boolean>>;
  /** Runs the scenario; returns evidence lines for the report. */
  run(driver: E2EDriver, fx: Fixtures): Promise<string[]>;
}

const BW_BUILD = 'bitwarden-web@2026.10.1+selfhosted-commercial';
const BW_CLOUD_US = 'bitwarden-web@2026.10.1+cloud-us';
const VW_BUILD = 'vaultwarden-web@2026.10.1+release';

export async function poll<T>(
  what: string,
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
    }
    await new Promise(r => setTimeout(r, 100));
    last = await read();
  }
  return last;
}

export function tabState(d: E2EDriver, tab: number): Promise<TabStateRecord | null> {
  return d.ui('UI_GET_STATE', {tab});
}

/**
 * Closes tabs, then waits until the engine has handled their removal: it drops a tab's stored state
 * last, after ending the tab's documents and their taint. A tab opened sooner can still meet a live
 * taint source of a closed tab, and its co-resident flag never clears.
 */
async function closeTabs(d: E2EDriver, ...tabs: number[]): Promise<void> {
  for (const tab of tabs) await d.closeTab!(tab);
  await poll(
    `the engine to handle the removal of tabs ${tabs.join(', ')}`,
    () => Promise.all(tabs.map(t => tabState(d, t))),
    states => states.every(s => s === null),
  );
}

export function waitForState(
  d: E2EDriver,
  tab: number,
  state: VerdictState,
  extra: (t: TabStateRecord) => boolean = () => true,
  timeoutMs = 30_000,
): Promise<TabStateRecord> {
  return poll(
    `tab ${tab} in ${state}`,
    () => tabState(d, tab),
    t => t !== null && t.state === state && extra(t),
    timeoutMs,
  ) as Promise<TabStateRecord>;
}

/** No request of the tab's documents is still being checked (the CHECKING flag is gone). */
export const settled = (t: TabStateRecord): boolean => !t.flags.includes('CHECKING');

/** Settled, with the top document's scripts observed and every one of them verified. */
export const allScriptsOk = (t: TabStateRecord): boolean =>
  settled(t) &&
  t.top !== null &&
  t.top.counts.scripts.total > 0 &&
  t.top.counts.scripts.ok === t.top.counts.scripts.total;

function notes(n: readonly {id: string; title: string}[]): string {
  return `notifications: ${n.length} (${n.map(x => JSON.stringify(x.title)).join(', ')})`;
}

/** The options flow: one message (the background reads `{base}api/config` and stores the server). */
export async function addInstance(d: E2EDriver, site: Site): Promise<{instance: InstanceRecord}> {
  const added = await d.ui('UI_ADD_INSTANCE', {
    input: `${site.origin}${site.basePath === '/' ? '/' : site.basePath}`,
  });
  if (!added.ok) throw new Error(`adding ${site.origin} refused: ${added.code}`);
  return {instance: added.instance};
}

/** No URL-like string in storage keeps a query string or a fragment. */
export async function expectPrivateStorage(d: E2EDriver): Promise<string> {
  const dump = await d.storageDump();
  const leaks: string[] = [];
  let urls = 0;
  const walk = (v: unknown, at: string): void => {
    if (typeof v === 'string') {
      if (/^(https?|moz-extension):\/\//.test(v)) {
        urls++;
        if (v.includes('?') || v.includes('#')) leaks.push(`${at}: ${v}`);
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    }
  };
  walk(dump.local, 'local');
  walk(dump.session, 'session');
  expect(leaks, 'URLs with a query string or fragment in storage').toEqual([]);
  return `privacy: ${urls} stored URL values, none with '?' or '#'`;
}

function summary(t: TabStateRecord): string {
  const top = t.top;
  return (
    `state ${t.state}${t.reasons.length ? ` (${t.reasons.join(', ')})` : ''}` +
    `${t.flags.length ? ` flags ${t.flags.join(',')}` : ''}` +
    (top === null
      ? ''
      : `; top ${top.path} ${top.state}, binding ${top.binding?.buildId ?? 'none'}` +
        ` (${top.binding?.assurance ?? '-'}), scripts ${top.counts.scripts.ok}/${top.counts.scripts.total}` +
        `, styles ${top.counts.styles.ok}/${top.counts.styles.total}`)
  );
}

/**
 * The deep-verify requests the GitHub mirror answered carry nothing about the user or the vault:
 * no Cookie, no Referer, an Origin that is the extension's own, `null` (after a redirect) or none,
 * and no vault host or page path in any URL or header. They are only the requests of local deep
 * verify (release, asset and tag JSON by repository id, the release download, config files by
 * commit), to api.github.com, release-assets and raw only (never github.com): no release
 * signature, no signed data. Returns an evidence line.
 */
const DEEP_VERIFY_HOSTS = [
  'api.github.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
];

function expectPrivateGitHub(
  requests: readonly MirrorRequest[],
  vaults: readonly string[],
): string {
  const hosts = vaults.map(v => new URL(v).host);
  for (const r of requests) {
    const where = `${r.method} ${r.host}${r.path}`;
    expect(r.cookie, `${where}: Cookie`).toBeNull();
    expect(r.referer, `${where}: Referer`).toBeNull();
    expect(DEEP_VERIFY_HOSTS, `${where}: host`).toContain(r.host);
    if (r.origin !== null)
      expect(r.origin, `${where}: Origin`).toMatch(/^(moz-extension:\/\/|null$)/);
    for (const value of [r.path, r.origin ?? '']) {
      for (const h of [...hosts, '127.0.0.1', 'localhost', 'vault.bitwarden']) {
        expect(value, `${where}: names ${h}`).not.toContain(h);
      }
    }
    expect(r.path, `${where}: a release signature`).not.toMatch(/\.asc$/);
    expect(r.path, `${where}: signed data`).not.toMatch(/\/contents\/|\/data\/v1\//);
  }
  const origins = DEEP_VERIFY_HOSTS.flatMap(host => {
    const seen = requests.filter(r => r.host === host);
    if (seen.length === 0) return [];
    const values = new Set(seen.map(r => r.origin?.replace(/[0-9a-f-]{36}/, '<uuid>') ?? 'none'));
    return [`${host} ${[...values].join(' / ')}`];
  });
  return (
    `GitHub privacy: ${requests.length} requests, no Cookie, no Referer, Origin ` +
    `(${origins.join('; ')}), no vault host or page path, no signature or signed-data request`
  );
}

// ---------------------------------------------------------------------------
// Secrets Manager: its files are verified like any other release file. A swapped chunk is
// MISMATCH; Bitwarden's Secrets Manager chunk on a Vaultwarden server is MISMATCH `unknown-path`.

/** An SM route with an organisation id (any id: the fixtures have no backend). */
const SM_ROUTE = '#/sm/2f6a1d6e-5f3c-4b8e-9a51-0c7d3e2b4a10';
/** The popup's reason line for MISMATCH unknown-path (reason_MISMATCH__unknown_path). */
const UNKNOWN_PATH_SENTENCE =
  'A script or other active file that is not in the release was loaded.';

/** The items of the tab's top document (UI_GET_DETAILS), by path. */
async function topItems(d: E2EDriver, tab: number): Promise<Map<string, ItemRecord>> {
  const view = await d.ui('UI_GET_DETAILS', {tab});
  const top = view?.docs.find(x => x.summary.frame === 0);
  return new Map((top?.items ?? []).map(i => [i.path, i]));
}

/** Waits until each of `paths` is an item of the tab's top document with a final outcome. */
function waitForItems(
  d: E2EDriver,
  tab: number,
  paths: readonly string[],
  timeoutMs = 30_000,
): Promise<Map<string, ItemRecord>> {
  return poll(
    `the items ${paths.join(', ')} of tab ${tab}`,
    () => topItems(d, tab),
    m => paths.every(p => m.has(p)),
    timeoutMs,
  );
}

function itemLine(i: ItemRecord): string {
  const o = i.outcome;
  const how = o.r === 'ok' ? ` ${o.how}` : 'reason' in o ? ` (${o.reason})` : '';
  return `${i.path}: ${o.r}${how}`;
}

/** `ok` holds on every read for `ms` (a negative check needs a window; the first miss fails). */
async function holds<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (!ok(v)) throw new Error(`${what} broke: ${JSON.stringify(v)}`);
    if (Date.now() > until) return v;
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Red: MISMATCH, DISPUTED or PROTECTION_LOST. */
const isRed = (t: TabStateRecord | null): boolean =>
  t !== null && ['MISMATCH', 'DISPUTED', 'PROTECTION_LOST'].includes(t.state);

/**
 * The fixture site registers its service worker (in `mode`) while the origin is not protected: a
 * page of the site is opened, the worker takes control of it, the tab is closed. Then the server is
 * added.
 */
async function workerBeforeAdd(d: E2EDriver, site: Site, mode: WorkerMode): Promise<void> {
  const tab = await d.open(`${site.origin}${WORKER_INSTALL_PAGE}?mode=${mode}`);
  await poll(
    'the worker to control its page',
    () => d.ran(tab, WORKER_READY_MARKER),
    x => x,
  );
  expect(await tabState(d, tab)).toBeNull();
  await d.closeTab!(tab);
  await addInstance(d, site);
}

/**
 * Waits for the first state of a vault tab that a worker controls. The engine stores a tab's state
 * in storage.session asynchronously, and with a worker in the path the page can finish loading
 * before that write lands (seen on CI runners).
 */
async function firstState(d: E2EDriver, tab: number): Promise<void> {
  await poll(
    'a state for the vault tab',
    () => tabState(d, tab),
    s => s !== null,
  );
}

/** The one open alert of the site's origin, raised by a red state; returns it as text. */
async function expectWorkerAlert(d: E2EDriver, site: Site): Promise<string> {
  const alerts = await d.ui('UI_LIST_ALERTS', {});
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({origin: site.origin, acknowledged: false});
  expect(['MISMATCH', 'PROTECTION_LOST']).toContain(alerts[0]!.state);
  return `${alerts[0]!.state} (${alerts[0]!.reasons.join(', ')})`;
}

/**
 * The item `path` of the document the tab shows, once it is there, with that document. The tab
 * also lists the load the worker was first asked for, which ended when Firefox reported the request
 * again: the item is looked up in the document the tab shows.
 */
async function shownItem(
  d: E2EDriver,
  tab: number,
  path: string,
): Promise<{top: NonNullable<TabStateRecord['top']>; script: ItemRecord}> {
  const found = await poll(
    `${path} of tab ${tab}`,
    async () => {
      const top = (await tabState(d, tab))?.top ?? null;
      const view = await d.ui('UI_GET_DETAILS', {tab});
      const doc = view?.docs.find(x => x.summary.doc === top?.doc);
      return {top, script: doc?.items.find(i => i.path === path) ?? null};
    },
    x => x.top !== null && x.script !== null,
  );
  return {top: found.top!, script: found.script!};
}

/**
 * The vault document came from the network and verified, while the main script, which the worker
 * answered, was withheld: its item is unverifiable and not delivered, and its marker is not set.
 * Returns the two as text.
 */
async function workerScriptWithheld(d: E2EDriver, site: Site, tab: number): Promise<string> {
  const {top, script} = await shownItem(d, tab, site.mainScript);
  expect(top.counts.document).toEqual({ok: 1, total: 1});
  expect(top.binding).toMatchObject({buildId: VW_BUILD, assurance: 'release-exact'});
  expect(script.outcome).toEqual({r: 'unverifiable', reason: 'internal-error'});
  expect(await d.ran(tab, WORKER_SCRIPT_MARKER)).toBe(false);
  return (
    `document from the network: verified, binding ${top.binding!.buildId}; ` +
    `the worker's script: ${itemLine(script)}, withheld, it never ran`
  );
}

/**
 * An in-app navigation to a lazy route: `location.hash` changes in the page; the real app routes
 * and requests the route's chunks itself (nothing is emulated).
 */
async function navigateToLazyRoute(d: E2EDriver, tab: number, hash: string): Promise<void> {
  await d.setHash(tab, hash);
}

/** The popup text for `tab`, checked to contain each of `want` and none of `absent`. */
async function popupHas(
  d: E2EDriver,
  tab: number,
  want: readonly string[],
  absent: readonly string[] = [],
): Promise<string> {
  if (d.popupText === undefined) return '';
  const text = await d.popupText(tab);
  for (const w of want) expect(text, 'popup text').toContain(w);
  for (const a of absent) expect(text, 'popup text').not.toContain(a);
  return (
    `popup: ${want.map(w => JSON.stringify(w)).join(', ')}` +
    (absent.length > 0 ? `; not ${absent.map(a => JSON.stringify(a)).join(', ')}` : '')
  );
}

/**
 * Bitwarden's Secrets Manager on its lazy route, genuine (self-hosted COMMERCIAL or cloud-us):
 * the chunks are not loaded before the route; the route loads 195 and 541, both ordinary files of
 * the release, both verified; the tab stays VERIFIED.
 */
async function smGenuine(
  d: E2EDriver,
  site: Site,
  binding: {buildId: string; assurance: string},
): Promise<string[]> {
  const sm = chunkPath(site.files, 541);
  const shared = chunkPath(site.files, 195);
  const tab = await d.open(`${site.origin}/#/login`);
  await waitForState(d, tab, 'VERIFIED', s => s.top?.binding !== null && allScriptsOk(s));
  // Lazy: neither chunk is requested while the page stays off the route.
  const before = await holds(
    'no Secrets Manager chunk before the route',
    () => topItems(d, tab),
    m => !m.has(sm) && !m.has(shared),
    1500,
  );
  await navigateToLazyRoute(d, tab, SM_ROUTE);
  const items = await waitForItems(d, tab, [shared, sm]);
  for (const p of [shared, sm]) {
    expect(items.get(p)).toMatchObject({type: 'script', outcome: {r: 'ok', how: 'exact'}});
  }
  const t = await waitForState(d, tab, 'VERIFIED', s => settled(s) && allScriptsOk(s));
  expect(t.top!.binding).toMatchObject(binding);
  const lines = [
    `before the route (1.5 s): no SM chunk requested (${before.size} items)`,
    `${SM_ROUTE.slice(0, 5)}… in the same document: the app requested the chunks itself`,
    itemLine(items.get(shared)!),
    itemLine(items.get(sm)!),
    `after the lazy load: ${summary(t)}`,
  ];
  const popup = await popupHas(d, tab, ['Verified']);
  if (popup !== '') lines.push(popup);
  // The deep link: the app starts on the route in a fresh tab.
  const deep = await d.open(`${site.origin}/${SM_ROUTE}`);
  const deepItems = await waitForItems(d, deep, [shared, sm]);
  for (const p of [shared, sm]) {
    expect(deepItems.get(p)).toMatchObject({outcome: {r: 'ok'}});
  }
  const dt = await waitForState(
    d,
    deep,
    'VERIFIED',
    s => s.top?.binding !== null && allScriptsOk(s),
  );
  lines.push(
    `deep link ${SM_ROUTE.slice(0, 5)}… in a fresh tab: ${summary(dt)}; ${[shared, sm].map(p => `${p} ${deepItems.get(p)!.outcome.r}`).join(', ')}`,
    await expectPrivateStorage(d),
  );
  return lines;
}

/**
 * The Vaultwarden fixture answers the listed `/locales/en/messages.json` with status 203 and other
 * bytes (one added key), and the page reads it with `fetch`, as the app's i18n service does. Every
 * 2xx is a content status, so the file needs its listed bytes: MISMATCH (bytes), and the bytes are
 * withheld (the page reads an empty body).
 */
async function locale203(d: E2EDriver, fx: Fixtures): Promise<string[]> {
  const site = fx.vaultwardenLocale203;
  await addInstance(d, site);
  const tab = await d.open(`${site.origin}/#/login`);
  await poll(
    'the vault document to be bound',
    () => tabState(d, tab),
    s => s?.top?.binding?.buildId === VW_BUILD,
  );
  const read = await d.pageFetch!(tab, LOCALE_PATH);
  const items = await waitForItems(d, tab, [LOCALE_PATH]);
  const item = items.get(LOCALE_PATH)!;
  expect(item).toMatchObject({outcome: {r: 'mismatch', reason: 'bytes'}});
  const t = await waitForState(d, tab, 'MISMATCH', settled);
  expect(t.reasons).toContain('bytes');
  expect(t.top).toMatchObject({path: '/', binding: {buildId: VW_BUILD}});
  expect(t.alert).toMatchObject({origin: site.origin, state: 'MISMATCH', acknowledged: false});
  expect(read.status).toBe(203);
  expect(read.body).toBe('');
  expect(read.body).not.toContain(LOCALE_MARKER);
  const n = await poll(
    'a notification',
    () => d.notifications(),
    x => x.length > 0,
  );
  // The app reads the locale while it starts, so the fixture usually answers it twice.
  const served = site.log.filter(r => r.path === LOCALE_PATH).map(r => r.status);
  return [
    `${LOCALE_PATH} answered ${served.join(', ')} (${served.length} requests, other bytes)`,
    itemLine(item),
    summary(t),
    notes(n),
    `the page's fetch read status ${read.status} and an empty body (the bytes are withheld)`,
    await expectPrivateStorage(d),
  ];
}

/**
 * Opens `url`, a document IntactWarden cannot check (BUILD_UNVERIFIED): it is denied with "Proceed
 * once", which this takes, and the page loads once. The unknown-build check may first show the
 * NEW_BUILD page, which turns into BUILD_UNVERIFIED by itself once its deep verify failed; while it
 * still shows NEW_BUILD with a finished job, the page is loaded again (as its "Check now" does).
 * Answers the BUILD_UNVERIFIED view.
 */
async function proceedPastUnverified(d: E2EDriver, tab: number, url: string): Promise<BlockedView> {
  const view = await poll(
    'the BUILD_UNVERIFIED blocked page',
    async () => {
      const now = await d.tabUrl(tab);
      if (!now.startsWith(`${d.baseUrl}ui/blocked.html#`)) return null;
      const incidentId = decodeURIComponent(now.slice(now.indexOf('#') + 1));
      const v = await d.ui('UI_GET_BLOCKED', {incidentId});
      if (v?.state === 'NEW_BUILD' && v.job?.finishedAt !== undefined) await d.navigate!(tab, url);
      return v;
    },
    v => v?.state === 'BUILD_UNVERIFIED',
    60_000,
  );
  expect(view).toMatchObject({retry: false, canProceedOnce: true});
  await d.proceedOnce!(tab);
  await poll(
    'the page to load after "Proceed once"',
    () => d.tabUrl(tab),
    u => u === url,
  );
  return view!;
}

/** A directive only the Bitwarden self-hosted server's own CSP has (server/sites.ts). */
const SERVER_IMG_SRC = "img-src 'self' data: https://haveibeenpwned.com";
/** A directive only IntactWarden's CSP floor has. */
const FLOOR_SCRIPT_ATTR = "script-src-attr 'none'";

/** The framing site's page that frames the vault document of `site` with this attack. */
const framingUrl = (site: Site, attack: FramedAttack): string =>
  `https://${FRAMING_HOST}/?frame=${encodeURIComponent(`${site.origin}/?${attack}`)}`;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'bw-genuine',
    title: 'Bitwarden self-hosted COMMERCIAL 2026.10.1 (bundled core) → VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const {instance} = await addInstance(d, fx.bitwarden);
      expect(instance).toMatchObject({app: 'bitwarden-web', base_path: '/'});
      // A query string and a fragment on the page URL exercise the redaction.
      const tab = await d.open(`${fx.bitwarden.origin}/?e2e=1#/login`);
      const t = await waitForState(d, tab, 'VERIFIED', s => s.top?.binding !== null && settled(s));
      expect(t).toMatchObject({
        origin: fx.bitwarden.origin,
        app: 'bitwarden-web',
        kind: 'instance',
        top: {binding: {buildId: BW_BUILD, assurance: 'release-exact', source: 'bundled'}},
      });
      expect(t.top!.counts.scripts.ok).toBe(t.top!.counts.scripts.total);
      expect(t.top!.counts.scripts.total).toBeGreaterThanOrEqual(5);
      expect(t.alert).toBeNull();
      expect(await d.notifications()).toEqual([]);
      expect(await d.extensionTabs()).toEqual([]);
      return [summary(t), 'no notification, no extension tab', await expectPrivateStorage(d)];
    },
  },
  {
    id: 'bw-cloud-us',
    title:
      'Bitwarden cloud https://vault.bitwarden.com, CACHE_TAG w4e0z (bundled cloud-us core, ' +
      'release-derived template) → VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const tab = await d.open(`${fx.bitwardenCloud.origin}/#/vault`);
      const t = await waitForState(d, tab, 'VERIFIED', s => s.top?.binding !== null && settled(s));
      expect(t).toMatchObject({
        origin: fx.bitwardenCloud.origin,
        app: 'bitwarden-web',
        kind: 'official',
        top: {binding: {buildId: BW_CLOUD_US, assurance: 'release-derived', source: 'bundled'}},
      });
      expect(t.top!.counts.scripts.ok).toBe(t.top!.counts.scripts.total);
      return [summary(t), await expectPrivateStorage(d)];
    },
  },
  {
    id: 'bw-cloud-redeploy',
    title:
      'Bitwarden cloud redeployed without a new release (CACHE_TAG w4e0z → e2e7q, new script ' +
      'names) → VERIFIED both times through the release-derived template',
    pkg: 'full',
    async run(d, fx) {
      const cloud = fx.bitwardenCloud;
      const first = await d.open(`${cloud.origin}/`);
      const a = await waitForState(
        d,
        first,
        'VERIFIED',
        s => s.top?.binding !== null && settled(s),
      );
      const before = {tag: cloud.cacheTag(), main: cloud.mainScript};
      try {
        const {mainScript} = await cloud.redeploy('e2e7q');
        expect(mainScript).not.toBe(before.main);
        const second = await d.open(`${cloud.origin}/`);
        const b = await waitForState(
          d,
          second,
          'VERIFIED',
          s => s.top?.binding !== null && settled(s),
        );
        expect(b.top!.binding).toMatchObject({buildId: BW_CLOUD_US, assurance: 'release-derived'});
        expect(b.top!.counts.scripts.ok).toBe(b.top!.counts.scripts.total);
        return [
          `CACHE_TAG ${before.tag}, ${before.main}: ${summary(a)}`,
          `CACHE_TAG e2e7q, ${mainScript}: ${summary(b)}`,
          await expectPrivateStorage(d),
        ];
      } finally {
        await cloud.redeploy(before.tag);
      }
    },
  },
  {
    id: 'bw-cloud-unknown-build',
    title:
      'Bitwarden cloud serves a hotfix build that GitHub does not have → the blocked page waits ' +
      '(NEW_BUILD catching-up) while deep verify looks for the release; afterwards the page is ' +
      'BUILD_UNVERIFIED (not-derivable), denied with "Proceed once", which loads it: amber, ' +
      'never red, no notification, and nothing about the user in the GitHub requests',
    pkg: 'full',
    async run(d, fx) {
      const cloud = fx.bitwardenCloud;
      const seen = fx.github.requests.length;
      cloud.hotfix('2026.11.0');
      // Keep the release lookup on api.github.com waiting, so the amber phase is observable.
      fx.github.hold({hosts: ['api.github.com']});
      try {
        const tab = await d.open(`${cloud.origin}/`);
        const waiting = await poll(
          'the blocked page',
          () => d.tabUrl(tab),
          u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
        );
        const incidentId = decodeURIComponent(waiting.slice(waiting.indexOf('#') + 1));
        const amber = await d.ui('UI_GET_BLOCKED', {incidentId});
        expect(amber).toMatchObject({state: 'NEW_BUILD', retry: true, canProceedOnce: false});
        expect(amber!.reasons).toContain('catching-up');
        await holds(
          'NEW_BUILD while GitHub answers nothing',
          () => d.ui('UI_GET_BLOCKED', {incidentId}),
          v => v?.state === 'NEW_BUILD' && v.job?.finishedAt === undefined,
          2000,
        );
        fx.github.release();
        const failed = await poll(
          'the deep verify to find no release',
          () => d.ui('UI_GET_BLOCKED', {incidentId}),
          v => v?.job?.finishedAt !== undefined,
          60_000,
        );
        expect(failed!.job).toMatchObject({phase: 'failed', failure: 'release-not-found'});
        // The build is now known to be unexplained: the page loads again as BUILD_UNVERIFIED,
        // which is denied with "Proceed once" (scoped to this document's hash and tab).
        const again = await d.open(`${cloud.origin}/`);
        const view = await proceedPastUnverified(d, again, `${cloud.origin}/`);
        expect(view.reasons).toEqual(['not-derivable']);
        const t = await waitForState(
          d,
          again,
          'BUILD_UNVERIFIED',
          s => s.unknownBuild?.phase === 'final' && settled(s),
          60_000,
        );
        expect(t.reasons).toEqual(['not-derivable']);
        expect(t.alert).toBeNull();
        expect(t.top?.binding ?? null).toBeNull();
        expect(await d.notifications()).toEqual([]);
        const incidents = await d.ui('UI_LIST_INCIDENTS', {limit: 20});
        expect(incidents.map(i => i.kind)).toContain('proceed-once');
        const mine = fx.github.requests.slice(seen);
        expect(
          mine.some(
            r => r.host === 'api.github.com' && r.path.endsWith('/releases/tags/web-v2026.11.0'),
          ),
        ).toBe(true);
        return [
          `while resolving: blocked page ${amber!.state} (${amber!.reasons.join(', ')}), retry`,
          `deep verify: ${failed!.job!.phase} (${failed!.job!.failure})`,
          `loaded again: blocked page ${view.state} (${view.reasons.join(', ')}) with "Proceed once"`,
          `after "Proceed once": ${summary(t)}; incidents ${incidents.map(i => i.kind).join(', ')}`,
          `GitHub mirror requests: ${mine.map(r => `${r.method} ${r.host}${r.path} ${r.status}`).join(' | ')}`,
          expectPrivateGitHub(mine, [cloud.origin]),
          await expectPrivateStorage(d),
        ];
      } finally {
        fx.github.release();
      }
    },
  },
  {
    id: 'bw-cloud-inline-floor',
    title:
      'Bitwarden cloud (the server sends no CSP): an inline <script> and an inline event handler ' +
      "injected into the VERIFIED page after load → neither runs (IntactWarden's enforced CSP " +
      'floor), the tab turns MISMATCH (inline-code), notification; the document stays',
    pkg: 'full',
    async run(d, fx) {
      const cloud = fx.bitwardenCloud;
      const tab = await d.open(`${cloud.origin}/#/login`);
      await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      await d.pageInject!(tab, INLINE_MARKER, ATTR_MARKER);
      const t = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('inline-code'));
      expect(await d.ran(tab, INLINE_MARKER)).toBe(false);
      expect(await d.ran(tab, ATTR_MARKER)).toBe(false);
      const n = await poll(
        'a notification',
        () => d.notifications(),
        x => x.length > 0,
      );
      const url = await d.tabUrl(tab);
      expect(url.startsWith(`${cloud.origin}/`), `tab shows ${url}`).toBe(true);
      return [
        'inline <script> and handler inserted after load: neither ran (the enforced floor)',
        summary(t),
        notes(n),
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'bw-payment-one-page',
    title:
      'Payment scripts on https://vault.bitwarden.com: Stripe.js is denied by the CSP floor; the ' +
      'popup consent allows it for one page load: the tab reloads, the script runs, the page is ' +
      'THIRD_PARTY_CODE and a second vault tab CO_RESIDENT_UNVERIFIED (third-party-code); a ' +
      'further reload denies it again; "Add credit" (PayPal form post, BitPay new tab) works ' +
      'with the payment scripts denied',
    pkg: 'full',
    // launchUri clicks a target=_blank link from script (after the user's click in the real app).
    prefs: {'dom.disable_open_during_load': false},
    async run(d, fx) {
      const cloud = fx.bitwardenCloud;
      const stripeLoads = (): number =>
        fx.payments.requests.filter(r => r.host === 'js.stripe.com').length;
      // A second vault tab of the origin, open the whole time.
      const other = await d.open(`${cloud.origin}/#/login`);
      await waitForState(d, other, 'VERIFIED', allScriptsOk);
      const tab = await d.open(`${cloud.origin}/#/login`);
      const green = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      // The billing page loads Stripe.js as the app's Stripe loader does (a <script src> the page
      // appends); the fixtures have no backend, so the app itself never reaches that page.
      const first = await d.pageScript(tab, STRIPE_JS);
      expect(first).toBe('error');
      expect(await d.ran(tab, STRIPE_MARKER)).toBe(false);
      const denied = await waitForState(
        d,
        tab,
        'THIRD_PARTY_CODE',
        s => s.top?.thirdPartyBlocked.includes('stripe') === true,
      );
      expect(denied.top!.doc).toBe(green.top!.doc);
      expect(stripeLoads()).toBe(0);
      // A denied payment script taints nothing.
      expect((await tabState(d, other))?.state).toBe('VERIFIED');
      // The popup: "Allow Stripe for one page load…", the consent text, "Allow Stripe and reload".
      const popup = await d.popup!(tab);
      await popup.click('Allow Stripe for one page load…');
      const consent = await popup.text();
      await popup.click('Allow Stripe and reload');
      await popup.close();
      for (const line of [
        'Allow Stripe for one page load?',
        'This code comes from Stripe, not from the Bitwarden release. IntactWarden cannot check it.',
        'Safest: pay in a private window',
        'only if IntactWarden may run there',
        'Allow Stripe and reload',
        'Cancel',
      ]) {
        expect(consent, 'consent panel').toContain(line);
      }
      // Confirming reloaded the tab: its next document took the grant.
      const allowed = await waitForState(
        d,
        tab,
        'THIRD_PARTY_CODE',
        s => s.top !== null && s.top.doc !== green.top!.doc && allScriptsOk(s),
      );
      expect(allowed.reasons).toEqual(['js.stripe.com']);
      expect(allowed.alert).toBeNull();
      const second = await d.pageScript(tab, STRIPE_JS);
      expect(second).toBe('load');
      expect(await d.ran(tab, STRIPE_MARKER)).toBe(true);
      expect(stripeLoads()).toBe(1);
      // While it lives, every other vault document of the origin is amber.
      const co = await waitForState(
        d,
        other,
        'CO_RESIDENT_UNVERIFIED',
        s => s.top?.coResident?.class === 'third-party-code',
      );
      expect(co.reasons).toEqual(['third-party-code']);
      expect(co.alert).toBeNull();
      const popupOther = await popupHas(d, other, ['A page that runs a payment script is open.']);
      expect(await d.notifications()).toEqual([]);
      // A further reload: the grant was for one page load, so the script is denied again.
      await d.reload!(tab);
      const third = await d.pageScript(tab, STRIPE_JS);
      expect(third).toBe('error');
      expect(await d.ran(tab, STRIPE_MARKER)).toBe(false);
      const again = await waitForState(
        d,
        tab,
        'THIRD_PARTY_CODE',
        s =>
          s.top !== null &&
          s.top.doc !== allowed.top!.doc &&
          s.top.thirdPartyBlocked.includes('stripe'),
      );
      expect(stripeLoads()).toBe(1);
      // The page that ran it is gone: a new vault tab is VERIFIED (the open one stays amber for
      // its lifetime).
      const fresh = await d.open(`${cloud.origin}/#/login`);
      const f = await waitForState(d, fresh, 'VERIFIED', allScriptsOk);
      expect(f.top?.coResident ?? null).toBeNull();
      expect((await tabState(d, other))?.state).toBe('CO_RESIDENT_UNVERIFIED');
      // "Add credit" needs no payment script: BitPay opens its invoice in a new tab (launchUri),
      // PayPal is a plain form post that leaves the vault page.
      const bitpay = await d.pageLaunch!(fresh, BITPAY_INVOICE);
      expect(bitpay).toBe(BITPAY_INVOICE);
      expect((await tabState(d, fresh))?.state).toBe('VERIFIED');
      await d.pagePost!(fresh, PAYPAL_ACTION, {
        cmd: '_xclick',
        business: 'e2e',
        item_name: 'Bitwarden Account Credit',
        amount: '10.00',
        custom: 'account_credit:1',
      });
      const paypal = await poll(
        'the tab to reach PayPal',
        () => d.tabUrl(fresh),
        u => u.startsWith(PAYPAL_ACTION),
      );
      const post = fx.payments.requests.find(r => r.host === 'www.paypal.com');
      expect(post).toMatchObject({method: 'POST', path: '/cgi-bin/webscr'});
      expect(post!.fields).toEqual(expect.arrayContaining(['cmd', 'item_name', 'amount']));
      expect(stripeLoads()).toBe(1);
      return [
        `first page: Stripe.js denied by the floor (script ${first}, not requested): ${summary(denied)}; the other tab stays VERIFIED`,
        'popup: "Allow Stripe for one page load…" → consent panel (heading, source, reach, scope, private window) → "Allow Stripe and reload"',
        `reloaded page (new document): Stripe.js ${second}, ran: ${summary(allowed)}`,
        `other tab: ${summary(co)}; no alert, no notification`,
        ...(popupOther !== '' ? [popupOther] : []),
        `further reload: Stripe.js ${third} again: ${summary(again)}`,
        `a new vault tab: ${summary(f)}; the other tab stays CO_RESIDENT_UNVERIFIED`,
        `Add credit with the payment scripts denied: BitPay invoice opened in a new tab (${bitpay}); PayPal form posted (${post!.fields.length} fields), the tab left for ${paypal}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'bw-tampered-block',
    title:
      'Bitwarden, one statement appended to app/main.<hash>.js → the script is denied (closed ' +
      'empty), MISMATCH, origin alert, notification, no extension tab opens',
    pkg: 'full',
    async run(d, fx) {
      await addInstance(d, fx.bitwardenTampered);
      const tab = await d.open(`${fx.bitwardenTampered.origin}/`);
      const t = await waitForState(d, tab, 'MISMATCH');
      expect(t.reasons).toContain('bytes');
      expect(t.alert).toMatchObject({origin: fx.bitwardenTampered.origin, acknowledged: false});
      expect(await d.ran(tab, TAMPER_MARKER)).toBe(false);
      const n = await poll(
        'a notification',
        () => d.notifications(),
        x => x.length > 0,
      );
      // A denied subresource never replaces the document, and no incidents tab opens by itself.
      const url = await d.tabUrl(tab);
      expect(url.startsWith(`${fx.bitwardenTampered.origin}/`), `tab shows ${url}`).toBe(true);
      expect(await d.extensionTabs()).toEqual([]);
      return [
        summary(t),
        notes(n),
        `tampered main script denied: it never ran; the vault document stays, no extension tab`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'bw-inline-block',
    title:
      'Bitwarden, inline <script> and handler injected into index.html, server CSP removed → ' +
      'document denied at once as MISMATCH (release-differs), no deep verify (the self-hosted ' +
      'release has one variant)',
    pkg: 'full',
    async run(d, fx) {
      await addInstance(d, fx.bitwardenInline);
      const seen = fx.github.requests.length;
      const tab = await d.open(`${fx.bitwardenInline.origin}/`);
      // /version.json names 2026.10.1: the bundled COMMERCIAL core (the only self-hosted variant)
      // lists `/` with other bytes, so the document is MISMATCH at once.
      const url = await poll(
        'the document to be denied',
        () => d.tabUrl(tab),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
      );
      expect(await d.ran(tab, INLINE_MARKER)).toBe(false);
      expect(await d.ran(tab, ATTR_MARKER)).toBe(false);
      const view = await d.ui('UI_GET_BLOCKED', {
        incidentId: decodeURIComponent(url.slice(url.indexOf('#') + 1)),
      });
      expect(view).toMatchObject({
        state: 'MISMATCH',
        reasons: ['release-differs'],
        path: '/',
        retry: false,
        canProceedOnce: false,
      });
      expect(fx.github.requests.slice(seen)).toEqual([]);
      return [
        `denied: ${url.slice(0, url.indexOf('#'))}#<incident> (${view!.state}, ${view!.reasons.join(',')})`,
        'no GitHub request (no deep verify)',
        'injected inline script never ran',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-inline-block',
    title:
      'Vaultwarden, inline <script> and handler injected into index.html, server CSP removed → ' +
      'blocked page with MISMATCH (release-differs), no way past it, red alert and notification',
    pkg: 'full',
    async run(d, fx) {
      await addInstance(d, fx.vaultwardenInline);
      const tab = await d.open(`${fx.vaultwardenInline.origin}/`);
      const url = await poll(
        'the blocked page',
        () => d.tabUrl(tab),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
      );
      expect(await d.ran(tab, INLINE_MARKER)).toBe(false);
      const view = await d.ui('UI_GET_BLOCKED', {
        incidentId: decodeURIComponent(url.slice(url.indexOf('#') + 1)),
      });
      // The blocked page tells a denial from a NEW_BUILD wait by the view, not by its URL. A red
      // denial has no "Proceed once": only turning IntactWarden off gets past it.
      expect(view).toMatchObject({
        state: 'MISMATCH',
        reasons: ['release-differs'],
        path: '/',
        retry: false,
        canProceedOnce: false,
      });
      expect(await d.ran(tab, ATTR_MARKER)).toBe(false);
      const alerts = await d.ui('UI_LIST_ALERTS', {});
      expect(alerts.map(a => a.origin)).toContain(fx.vaultwardenInline.origin);
      const n = await poll(
        'a notification',
        () => d.notifications(),
        x => x.length > 0,
      );
      return [
        `denied: ${url.slice(0, url.indexOf('#'))}#<incident> (${view!.state}, ${view!.reasons.join(',')})`,
        `origin alerts: ${alerts.length}, ${notes(n)}`,
        'injected inline script never ran',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-genuine',
    title:
      'Vaultwarden 2026.10.1 (bundled core), stock /css/vaultwarden.css → VERIFIED + server style',
    pkg: 'full',
    async run(d, fx) {
      const {instance} = await addInstance(d, fx.vaultwarden);
      expect(instance).toMatchObject({app: 'vaultwarden-web', base_path: '/'});
      const tab = await d.open(`${fx.vaultwarden.origin}/#/login`);
      const t = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => s.top?.serverStyle !== null && settled(s),
      );
      expect(t.top).toMatchObject({
        binding: {buildId: VW_BUILD, assurance: 'release-exact', source: 'bundled'},
        serverStyle: {path: '/css/vaultwarden.css', accepted: true},
      });
      expect(t.top!.serverStyle!.hiddenCount).toBeGreaterThan(0);
      const lines = [
        summary(t),
        `server style ${t.top!.serverStyle!.path} accepted, hides ${t.top!.serverStyle!.hiddenCount} selectors`,
      ];
      if (d.popupText !== undefined) {
        // The popup shows the verdict, the stylesheet line and the Vaultwarden note (en catalogue).
        const text = await d.popupText(tab);
        expect(text).toContain('Verified');
        expect(text).toContain(
          `Server stylesheet: accepted, hides ${t.top!.serverStyle!.hiddenCount} element types.`,
        );
        expect(text).toContain('Vaultwarden servers add their own stylesheet.');
        lines.push(
          'popup: "Verified", "Server stylesheet: accepted, hides … element types.", "Vaultwarden servers add their own stylesheet. …"',
        );
      }
      lines.push(await expectPrivateStorage(d));
      return lines;
    },
  },
  {
    id: 'vw-unknown-build',
    title:
      'Vaultwarden 2026.10.1 not bundled (package with Bitwarden cores only) → the blocked page ' +
      'waits (NEW_BUILD) while GitHub downloads are held, local deep verify from the GitHub ' +
      'mirror, the blocked page reloads the vault → VERIFIED; nothing about the user in the ' +
      'GitHub requests',
    pkg: 'bitwarden-only',
    async run(d, fx) {
      const before = await d.ui('UI_GET_TRUST', {});
      expect(before.cores.map(c => c.buildId)).not.toContain(VW_BUILD);
      const seen = fx.github.requests.length;
      fx.github.hold();
      try {
        await addInstance(d, fx.vaultwarden);
        const url = `${fx.vaultwarden.origin}/`;
        const tab = await d.open(url);
        // The unknown document waits a few seconds for the version hint, then is denied with
        // the auto-retry blocked page (a new build is never released while it is checked).
        const retry = await poll(
          'the blocked page',
          () => d.tabUrl(tab),
          u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
        );
        const incidentId = decodeURIComponent(retry.slice(retry.indexOf('#') + 1));
        const first = await d.ui('UI_GET_BLOCKED', {incidentId});
        expect(first).toMatchObject({state: 'NEW_BUILD', retry: true, canProceedOnce: false});
        expect(await d.notifications()).toEqual([]);
        fx.github.release();
        // What the blocked page waits for before it reloads (shouldReload: the job is done).
        const done = await poll(
          'the deep-verify job behind the blocked page to finish',
          () => d.ui('UI_GET_BLOCKED', {incidentId}),
          v => v?.job?.phase === 'done',
          120_000,
        );
        await poll(
          'the blocked page to reload the vault',
          () => d.tabUrl(tab),
          u => u === url,
          90_000,
        );
        const t = await waitForState(
          d,
          tab,
          'VERIFIED',
          s => s.top?.binding?.buildId === VW_BUILD && allScriptsOk(s),
        );
        expect(t.top!.binding).toMatchObject({source: 'deep-verify', assurance: 'release-exact'});
        const trust = await d.ui('UI_GET_TRUST', {});
        const core = trust.cores.find(c => c.buildId === VW_BUILD);
        expect(core?.sha256).toBe(GOLDEN_CORES[VW_BUILD]);
        const mine = fx.github.requests.slice(seen);
        const downloads = mine.filter(
          r => r.host === 'release-assets.githubusercontent.com' && r.status === 200,
        );
        expect(downloads.length).toBeGreaterThanOrEqual(1);
        // Only the release JSON, the tag by repository id (its ref, then the annotated tag
        // object), CORS preflights and the tarball's download through the API; never sha256sums.txt, which
        // the mirror's release lists with another digest, and no git-upload-pack.
        const allowed = [
          /^(OPTIONS|GET) api\.github\.com\/repositories\/\d+\/releases\/tags\/v2026\.10\.1$/,
          /^(OPTIONS|GET) api\.github\.com\/repositories\/\d+\/git\/ref\/tags\/v2026\.10\.1$/,
          /^(OPTIONS|GET) api\.github\.com\/repositories\/\d+\/git\/tags\/[0-9a-f]{40}$/,
          /^GET api\.github\.com\/repositories\/\d+\/releases\/assets\/\d+$/,
          /^GET release-assets\.githubusercontent\.com\/\S*bw_web_v2026\.10\.1\.tar\.gz$/,
        ];
        for (const r of mine) {
          const line = `${r.method} ${r.host}${r.path}`;
          expect(
            allowed.some(a => a.test(line)),
            `${line}: not a deep-verify request`,
          ).toBe(true);
        }
        expect(mine.some(r => /\/git\/ref\/tags\//.test(r.path) && r.method === 'GET')).toBe(true);
        return [
          `denied: ${retry.slice(0, retry.indexOf('#'))}#<incident> (${first!.state}, retry)`,
          `job ${done!.job!.phase}; reloaded: ${summary(t)}`,
          `stored core ${VW_BUILD} sha256 ${core!.sha256} (= golden)`,
          `GitHub mirror requests: ${mine.map(r => `${r.method} ${r.host}${r.path} ${r.status}`).join(' | ')}`,
          expectPrivateGitHub(mine, [fx.vaultwarden.origin]),
          await expectPrivateStorage(d),
        ];
      } finally {
        fx.github.release();
      }
    },
  },
  {
    id: 'blocked-retry',
    title:
      'Deep verify of Vaultwarden 2026.10.1 fails (the download does not match the digest GitHub ' +
      'lists) → the blocked page turns Build not verified and names the release; once the ' +
      'download is good again, its "Retry" asks GitHub again at once (a user deep verify, past ' +
      'the stored failure) and loads the vault → VERIFIED',
    pkg: 'bitwarden-only',
    async run(d, fx) {
      const [repo, tag, asset] = [
        'dani-garcia/bw_web_builds',
        'v2026.10.1',
        'bw_web_v2026.10.1.tar.gz',
      ];
      const seen = fx.github.requests.length;
      fx.github.emulator.serveInstead(
        repo,
        tag,
        asset,
        new TextEncoder().encode('not the release'),
      );
      try {
        await addInstance(d, fx.vaultwarden);
        const url = `${fx.vaultwarden.origin}/`;
        const tab = await d.open(url);
        const blocked = await poll(
          'the blocked page',
          () => d.tabUrl(tab),
          u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
        );
        const incidentId = decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1));
        const failed = await poll(
          'the deep verify to fail and the page to turn Build not verified',
          () => d.ui('UI_GET_BLOCKED', {incidentId}),
          v => v?.state === 'BUILD_UNVERIFIED',
          120_000,
        );
        expect(failed).toMatchObject({
          retry: false,
          canProceedOnce: true,
          release: {app: 'vaultwarden-web', variant: 'release', version: '2026.10.1'},
          job: {phase: 'failed', failure: 'digest-mismatch'},
        });
        fx.github.emulator.serveInstead(repo, tag, asset, null);
        // "Retry", the second button next to "Go back" (the "Proceed once" card has one button).
        await d.pageClick!(tab, '.actions > button:nth-child(2)');
        await poll(
          'the vault to load after "Retry"',
          () => d.tabUrl(tab),
          u => u === url,
          120_000,
        );
        const t = await waitForState(
          d,
          tab,
          'VERIFIED',
          s => s.top?.binding?.buildId === VW_BUILD && allScriptsOk(s),
        );
        expect(t.top!.binding).toMatchObject({source: 'deep-verify', assurance: 'release-exact'});
        const jobs = (await d.ui('UI_GET_TRUST', {})).jobs.filter(j => j.version === '2026.10.1');
        expect(jobs.map(j => `${j.trigger} ${j.phase}`)).toEqual(
          expect.arrayContaining(['unknown-build failed', 'user done']),
        );
        const mine = fx.github.requests.slice(seen);
        const downloads = mine.filter(
          r => r.host === 'release-assets.githubusercontent.com' && r.status === 200,
        );
        expect(downloads.length).toBe(2);
        return [
          `blocked page: ${failed!.state}, release ${failed!.release!.version} named, job ${failed!.job!.phase} (${failed!.job!.failure})`,
          `"Retry": jobs ${jobs.map(j => `${j.trigger} ${j.phase}`).join(', ')}; ${downloads.length} downloads`,
          `vault tab: ${summary(t)}`,
          expectPrivateGitHub(mine, [fx.vaultwarden.origin]),
          await expectPrivateStorage(d),
        ];
      } finally {
        fx.github.emulator.serveInstead(repo, tag, asset, null);
      }
    },
  },
  {
    id: 'vw-subpath',
    title:
      'Vaultwarden at the sub-path /vw/ (DOMAIN with a path) → VERIFIED; /vw, which the reverse ' +
      'proxy answers with a 301 to /vw/, follows the redirect to the base path → VERIFIED, no alert',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenSubpath;
      const {instance} = await addInstance(d, site);
      expect(instance).toMatchObject({app: 'vaultwarden-web', base_path: '/vw/'});
      const tab = await d.open(`${site.origin}/vw/`);
      const t = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => s.top?.binding !== null && allScriptsOk(s),
      );
      expect(t.top).toMatchObject({path: '/vw/', binding: {buildId: VW_BUILD}});
      // The header guard lets a same-origin navigation redirect to exactly the base path through;
      // the landing document is verified like any other.
      const slash = await d.open(`${site.origin}/vw`);
      const r = await waitForState(
        d,
        slash,
        'VERIFIED',
        s => s.top?.binding !== null && allScriptsOk(s),
      );
      expect(r.top).toMatchObject({path: '/vw/', binding: {buildId: VW_BUILD}});
      // The app's router may already have added its own fragment (#/login).
      expect((await d.tabUrl(slash)).split('#')[0]).toBe(`${site.origin}/vw/`);
      const kept = await holds(
        'VERIFIED after the redirect',
        () => tabState(d, slash),
        s => s?.state === 'VERIFIED',
        3000,
      );
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      return [
        summary(t),
        `/vw → 301 → /vw/: ${summary(kept ?? r)}; no alert, no notification`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-index-redirect',
    title:
      'Vaultwarden /index.html answers 303 to / (a declared redirect) → one VERIFIED document, ' +
      'no stale session, no alert',
    pkg: 'full',
    async run(d, fx) {
      // Firefox drops the first hop's StreamFilter and fires onBeforeRequest again with the same
      // request id; the first hop must leave no session that turns the tab PROTECTION_LOST
      // (filter-failed) with an origin alert.
      await addInstance(d, fx.vaultwarden);
      const tab = await d.open(`${fx.vaultwarden.origin}/index.html`);
      const t = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => s.top?.binding !== null && allScriptsOk(s),
      );
      expect(t.top).toMatchObject({path: '/', binding: {buildId: VW_BUILD}});
      expect(t.frames).toEqual([]);
      // Nothing turns it later (the old hop's timeout was 60 s; filter-failed was immediate).
      await new Promise(r => setTimeout(r, 3000));
      const again = await tabState(d, tab);
      expect(again?.state).toBe('VERIFIED');
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      return [summary(again ?? t), 'no stale session, no alert', await expectPrivateStorage(d)];
    },
  },
  {
    id: 'vw-custom-style',
    title:
      'Vaultwarden with an admin rule in /css/vaultwarden.css → UNVERIFIED_STYLE (custom-rules)',
    pkg: 'full',
    async run(d, fx) {
      await addInstance(d, fx.vaultwardenCustomCss);
      const tab = await d.open(`${fx.vaultwardenCustomCss.origin}/`);
      const t = await waitForState(d, tab, 'UNVERIFIED_STYLE', allScriptsOk);
      expect(t.top).toMatchObject({
        binding: {buildId: VW_BUILD},
        serverStyle: {path: '/css/vaultwarden.css', accepted: false, reason: 'custom-rules'},
      });
      return [summary(t), await expectPrivateStorage(d)];
    },
  },
  {
    id: 'vw-locale-203-block',
    title:
      'The listed /locales/en/messages.json answered 203 with other bytes and ' +
      'read by the page with fetch → MISMATCH (bytes), red alert, notification, the bytes are ' +
      'withheld (the page reads an empty body)',
    pkg: 'full',
    run: (d, fx) => locale203(d, fx),
  },
  {
    id: 'vw-link-header',
    title:
      'Vaultwarden behind a server that adds Link headers (a preload of a script on another ' +
      'origin and of a listed file) to every response → removed, never parsed: VERIFIED, no ' +
      'alert, no incident, no notification; the page never sees a Link header',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenLink;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/`);
      const t = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => s.top?.binding?.buildId === VW_BUILD && allScriptsOk(s),
      );
      // The same responses the page reads with fetch: the document path and a listed file.
      const doc = await d.pageFetch!(tab, '/');
      const locale = await d.pageFetch!(tab, LOCALE_PATH);
      for (const r of [doc, locale]) {
        expect(r.status).toBe(200);
        expect(r.headers['link'], JSON.stringify(r.headers)).toBeUndefined();
      }
      const after = await holds(
        'VERIFIED with the Link headers removed',
        () => tabState(d, tab),
        s => s?.state === 'VERIFIED',
        2000,
      );
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.ui('UI_LIST_INCIDENTS', {limit: 20})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      return [
        summary(after ?? t),
        `the page's fetch of / and ${LOCALE_PATH}: status ${doc.status}/${locale.status}, no Link header`,
        'no alert, no incident, no notification',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-back-forward',
    title:
      'A VERIFIED Vaultwarden page left for another site, then "Back" → never restored from the ' +
      'back/forward cache (IntactWarden makes protected documents no-store): loaded again as a ' +
      'new document, VERIFIED, no alert; then "Forward" ends that document (never a stale green)',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwarden;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/#/login`);
      const t = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      const doc = t.top!.doc;
      await d.mark!(tab, '__iwVault');
      // Another site (not protected, no no-store: Firefox may keep it in the back/forward cache)
      // in the same tab, then "Back".
      const away = `${fx.bitwardenScriptRedirect.evilOrigin!}/`;
      await d.navigate!(tab, away);
      expect(await d.tabUrl(tab)).toBe(away);
      await d.mark!(tab, '__iwAway');
      await d.back!(tab);
      await poll(
        'the vault to come back',
        () => d.tabUrl(tab),
        u => u.startsWith(`${site.origin}/`),
      );
      // Firefox keeps no `Cache-Control: no-store` document in the back/forward cache: the
      // page global is new, and the vault is loaded and verified again under a new document key.
      expect(await d.ran(tab, '__iwVault')).toBe(false);
      const back = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => s.top !== null && s.top.doc !== doc && allScriptsOk(s),
      );
      expect(back.top!.binding).toMatchObject({buildId: VW_BUILD});
      expect(back.frames).toEqual([]);
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      // "Forward" to the other site. Firefox usually restores it from the back/forward cache and
      // reports the restore as a commit; it may also load it again. Either way the vault's
      // document must end (the tab is no longer protected). The restore-as-commit path itself
      // is covered by the engine test "a document restored from the back/forward cache".
      await d.forward!(tab);
      await poll(
        'the other site to come back',
        () => d.tabUrl(tab),
        u => u === away,
      );
      const restored = await d.ran(tab, '__iwAway');
      await poll(
        'the vault document to end',
        () => tabState(d, tab),
        s => s === null,
      );
      return [
        `before: ${summary(t)}`,
        'left for another site, then Back: loaded again (no-store keeps it out of the back/forward cache)',
        `after: ${summary(back)} (a new document key)`,
        `Forward: the other site ${restored ? 'restored from the back/forward cache' : 'loaded again'}; the vault document ended (not protected)`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-tab-closed-while-loading',
    title:
      'The vault tab is closed while its listed .wasm file is still loading (half sent, the rest ' +
      'held) → no MISMATCH, no incident, no origin alert, no notification; a new vault tab is ' +
      'VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenHeldWasm;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/#/login`);
      await poll(
        'the app to request its .wasm file',
        async () => site.heldResponses!(),
        n => n > 0,
      );
      // Firefox ends the response's filter with the bytes that had arrived: a prefix of the file.
      await d.closeTab!(tab);
      await new Promise(r => setTimeout(r, 6000));
      expect(await d.ui('UI_LIST_INCIDENTS', {limit: 20})).toEqual([]);
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      const again = await d.open(`${site.origin}/#/login`);
      const t = await waitForState(
        d,
        again,
        'VERIFIED',
        s => allScriptsOk(s) && (s.top?.counts.wasm.ok ?? 0) === 1,
      );
      return [
        'tab closed while the .wasm file was half sent: no incident, no origin alert, no notification',
        `a new vault tab: ${summary(t)}, wasm ${t.top!.counts.wasm.ok}/${t.top!.counts.wasm.total}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-image-only-local',
    title:
      'Vaultwarden naming 2026.8.0, a release without a tarball (package without the ' +
      'Vaultwarden core) → denied as BUILD_UNVERIFIED (image-only-release) with "Proceed once", ' +
      'which loads the page once: amber, never red',
    pkg: 'bitwarden-only',
    async run(d, fx) {
      const site = fx.vaultwardenImageOnly;
      await addInstance(d, site);
      const url = `${site.origin}/`;
      const tab = await d.open(url);
      const denied = await proceedPastUnverified(d, tab, url);
      expect(denied.reasons).toEqual(['image-only-release']);
      // An unbound document: its scripts are recorded (observed, not verified).
      const t = await waitForState(
        d,
        tab,
        'BUILD_UNVERIFIED',
        s => settled(s) && (s.top?.counts.scripts.total ?? 0) > 0,
        60_000,
      );
      expect(t.reasons).toEqual(['image-only-release']);
      expect(await d.notifications()).toEqual([]);
      // "Proceed once" is spent: a reload of the same document in the same tab is denied again.
      await d.reload!(tab);
      await poll(
        'the reload to be denied again',
        () => d.tabUrl(tab),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
        60_000,
      );
      return [
        `denied: ${denied.state} (${denied.reasons.join(', ')}) with "Proceed once"`,
        `after "Proceed once": ${summary(t)}`,
        'a reload of the same page in the same tab is denied again (the allowance was spent)',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-forged-pagehide',
    title:
      'A compromised server page the user let through with "Proceed once" (BUILD_UNVERIFIED) ' +
      'forges pagehide, then frames the vault and reads it → never VERIFIED: the page keeps ' +
      'tainting, the framed vault is CO_RESIDENT_UNVERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenForgedPagehide;
      await addInstance(d, site);
      const url = `${site.origin}${ATTACKER_PAGE}`;
      const tab = await d.open(url);
      const denied = await proceedPastUnverified(d, tab, url);
      await poll(
        'the forged pagehide',
        () => d.ran(tab, '__iwForged'),
        x => x,
        15_000,
      );
      await poll(
        'the framed vault to load',
        () => d.ran(tab, '__iwFramed'),
        x => x,
        30_000,
      );
      const t = await waitForState(
        d,
        tab,
        'BUILD_UNVERIFIED',
        s =>
          s.top?.path === ATTACKER_PAGE &&
          s.frames.some(
            f => f.path === '/' && f.state === 'CO_RESIDENT_UNVERIFIED' && f.binding !== null,
          ),
      );
      // It stays so (a document ends only when Firefox says its frame shows another one).
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const now = await tabState(d, tab);
        expect(now?.state).not.toBe('VERIFIED');
        expect(now?.frames.find(f => f.path === '/')?.state).toBe('CO_RESIDENT_UNVERIFIED');
      }
      return [
        `${ATTACKER_PAGE}: denied as ${denied.state} (${denied.reasons.join(', ')}), let through with "Proceed once"`,
        `forged pagehide dispatched; the page framed the vault and reads its DOM`,
        summary(t),
        `frames: ${t.frames.map(f => `${f.path} ${f.state}`).join(', ')}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-blob-trampoline',
    title:
      'A compromised server page the user let through with "Proceed once" ' +
      "(BUILD_UNVERIFIED) moves its tab to a same-origin blob: page it made; the blob page's " +
      'script request is denied (no document owns it), and the vault opened from its link is ' +
      'CO_RESIDENT_UNVERIFIED, never VERIFIED, until the blob tab and that window are closed',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenBlob;
      await addInstance(d, site);
      const url = `${site.origin}${ATTACKER_PAGE}`;
      const tab = await d.open(url);
      await proceedPastUnverified(d, tab, url);
      await poll(
        'the attacker page script',
        () => d.ran(tab, '__iwTrampoline'),
        x => x,
        15_000,
      );
      // A document nobody could check that runs: a taint source of its origin while it lives.
      const source = await waitForState(d, tab, 'BUILD_UNVERIFIED', s =>
        s.reasons.includes('image-only-release'),
      );
      // The page moves its own tab to a blob: document it made (no request, no content script,
      // no session).
      await d.setHash(tab, '#go');
      const blob = await poll(
        'the tab to show the blob: page',
        () => d.tabUrl(tab),
        u => u.startsWith(`blob:${site.origin}/`),
        15_000,
      );
      // Its same-origin script (which would open the vault in a window it can script) is a
      // request no document owns: denied. The floor it inherited allows no inline script.
      await holds(
        'the blob page script never running',
        () => d.ran(tab, '__iwBlobOpened'),
        x => !x,
        2000,
      );
      // A click on its link opens the vault from the blob page.
      await d.pageClick!(tab, '#iw-open');
      const [vault] = await poll(
        'the window the blob: page opened',
        () => d.tabsWithUrl!(`${site.origin}/`),
        ids => ids.length === 1,
      );
      const t = await waitForState(d, vault!, 'CO_RESIDENT_UNVERIFIED', allScriptsOk);
      expect(t.top).toMatchObject({
        binding: {buildId: VW_BUILD},
        coResident: {class: 'unverifiable', sourcePath: 'blob:'},
      });
      await holds(
        'the opened vault CO_RESIDENT_UNVERIFIED',
        () => tabState(d, vault!),
        x => x?.state === 'CO_RESIDENT_UNVERIFIED',
        3000,
      );
      // The hold lasts until the blob tab and the window it opened are closed, and no longer.
      await closeTabs(d, tab, vault!);
      const fresh = await d.open(`${site.origin}/`);
      const f = await waitForState(d, fresh, 'VERIFIED', allScriptsOk);
      expect(f.top?.coResident ?? null).toBeNull();
      expect(f.alert).toBeNull();
      return [
        `attacker page after "Proceed once": ${summary(source)}`,
        `its tab moved to ${blob.replace(site.origin, '<origin>').replace(/[0-9a-f-]{36}$/, '<uuid>')}; its script was denied (it never ran)`,
        `vault opened from its link: ${summary(t)}; co-resident ${t.top!.coResident!.class} ${t.top!.coResident!.sourcePath}, held 3 s`,
        `both tabs closed, a new vault tab: ${summary(f)}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-framed-other-site',
    title:
      "A compromised Vaultwarden server answers a frame's load of the vault with a document of " +
      'its own, and a page of another site frames it. Firefox reports no request of a frame ' +
      'whose framing page IntactWarden may not access, so that document is not held and gets no ' +
      'CSP floor: its script from the framing site runs. It is reported all the same → the tab ' +
      "is PROTECTION_LOST (untracked), a script of the vault's own origin is denied, and a vault " +
      'window the frame opens at a click is CO_RESIDENT_UNVERIFIED, never VERIFIED, although the ' +
      'frame reads it; with those tabs closed a new vault tab is VERIFIED; an inline script in ' +
      'such a frame is MISMATCH (inline-code) with an origin alert',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenFramed;
      await addInstance(d, site);
      /** A tab of the framing site whose frame the server has answered with this attack. */
      const framed = async (attack: FramedAttack): Promise<number> => {
        const loads = site.framedLoads!();
        const tab = await d.open(framingUrl(site, attack));
        await poll(
          'the frame load at the server',
          async () => site.framedLoads!(),
          n => n > loads,
        );
        return tab;
      };
      const frameAndPage = async (tab: number): Promise<FrameState & {heard: boolean}> => ({
        ...(await d.frameState!(tab, FRAMED_MARKER)),
        heard: await d.ran(tab, FRAMING_HEARD_MARKER),
      });
      // The attacker document's script comes from the framing site: nothing holds or denies it.
      const outside = await framed('framing-site');
      await poll(
        'the framed document to run',
        () => frameAndPage(outside),
        x => x.ran && x.heard,
        15_000,
      );
      const lost = await waitForState(d, outside, 'PROTECTION_LOST', s =>
        s.reasons.includes('untracked'),
      );
      // The document was never held or hashed: no denial is logged for it.
      const incidents = await d.ui('UI_LIST_INCIDENTS', {limit: 20});
      expect(incidents.map(i => i.reasons.join(','))).not.toContain('release-differs');
      // At a click the frame opens the vault and reads it: that window is never green.
      expect(await d.frameClick!(outside, `#${FRAMED_BUTTON}`)).toBe(true);
      const [opened] = await poll(
        'the vault window the frame opened',
        () => d.tabsWithUrl!(`${site.origin}/#/login`),
        ids => ids.length === 1,
      );
      const co = await waitForState(d, opened!, 'CO_RESIDENT_UNVERIFIED', allScriptsOk);
      await poll(
        'the frame to read the window it opened',
        () => d.frameState!(outside, FRAMED_READ_MARKER),
        x => x.ran,
        15_000,
      );
      await holds(
        'the opened vault CO_RESIDENT_UNVERIFIED',
        () => tabState(d, opened!),
        s => s?.state === 'CO_RESIDENT_UNVERIFIED',
        3000,
      );
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      // The same document with its script as a file of the vault's origin: that request is
      // reported (its document is the frame's), and denied: before the content script has
      // announced the frame's document no document owns it (R2), afterwards that document is
      // bound to no build (`unbound`).
      const own = await framed('same-origin');
      const denied = await waitForState(d, own, 'PROTECTION_LOST', s =>
        s.reasons.includes('untracked'),
      );
      await holds(
        'the same-origin script denied',
        () => frameAndPage(own),
        x => !x.ran && !x.heard,
        2000,
      );
      const n = await d.notifications();
      // The taint lasts as long as those documents.
      await closeTabs(d, outside, opened!, own);
      const fresh = await d.open(`${site.origin}/`);
      const f = await waitForState(d, fresh, 'VERIFIED', allScriptsOk);
      expect(f.alert).toBeNull();
      await d.closeTab!(fresh);
      // An inline script runs too (no CSP floor); the content script reports it.
      const inline = await framed('inline');
      const m = await waitForState(d, inline, 'MISMATCH', s => s.reasons.includes('inline-code'));
      expect(m.alert).toMatchObject({origin: site.origin, state: 'MISMATCH'});
      expect((await frameAndPage(inline)).ran).toBe(true);
      return [
        `script from the framing site: it ran and the framing page heard it; ${lost.state} (${lost.reasons.join(', ')}); incidents ${incidents.map(i => `${i.kind} (${i.reasons.join(', ')})`).join(', ')}`,
        `a click in the frame opened the vault, which the frame read: ${summary(co)}, held 3 s; no origin alert`,
        `script of the vault's origin: denied, it never ran; ${denied.state} (${denied.reasons.join(', ')}); ${notes(n)}`,
        `those tabs closed, a new vault tab: ${summary(f)}`,
        `inline script: it ran; ${m.state} (${m.reasons.join(', ')}), origin alert ${m.alert!.state}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-framed-accessible-site',
    title:
      'The same frame once IntactWarden may access the framing page (its host permission ' +
      "granted): Firefox reports the frame's request, the attacker document is held and denied " +
      '→ MISMATCH (release-differs), nothing of it runs, the framing page hears nothing',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenFramed;
      await addInstance(d, site);
      await d.grantHosts!([`https://${FRAMING_HOST}/*`]);
      const loads = site.framedLoads!();
      const tab = await d.open(framingUrl(site, 'inline'));
      const t = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('release-differs'));
      expect(t.flags).toContain('BLOCKED');
      expect(site.framedLoads!()).toBeGreaterThan(loads);
      const frame = await holds(
        'the denied frame empty',
        async () => ({
          ...(await d.frameState!(tab, FRAMED_MARKER)),
          heard: await d.ran(tab, FRAMING_HEARD_MARKER),
        }),
        f => !f.ran && !f.heard,
        2000,
      );
      const incidents = await d.ui('UI_LIST_INCIDENTS', {limit: 20});
      expect(incidents.map(i => i.reasons.join(','))).toContain('release-differs');
      return [
        `the framing site's host permission granted: ${summary(t)}`,
        `the frame: ${frame.elements} elements, its script never ran, the framing page heard nothing`,
        `incidents ${incidents.map(i => `${i.kind} (${i.reasons.join(', ')})`).join(', ')}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'framed-refused',
    title:
      'A page of another site frames a stock vault, whose headers forbid that (Vaultwarden: ' +
      'frame-ancestors; Bitwarden self-hosted: X-Frame-Options). Firefox requests the document ' +
      'and shows its own error page in the frame → nothing is reported for that tab: no state, ' +
      'no incident, no origin alert, no notification, and the open vault tab stays VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      // Firefox reports no request of this frame and a commit of the vault's address, as for a
      // framed document that renders: the commit alone must not make the tab PROTECTION_LOST.
      const lines: string[] = [];
      for (const [app, site, refusal] of [
        ['Vaultwarden', fx.vaultwarden, 'cspBlocked'],
        ['Bitwarden', fx.bitwarden, 'xfoBlocked'],
      ] as const) {
        await addInstance(d, site);
        const vault = await d.open(`${site.origin}/#/login`);
        await waitForState(d, vault, 'VERIFIED', allScriptsOk);
        const documents = (): number => site.log.filter(r => r.path === '/').length;
        const loads = documents();
        const tab = await d.open(
          `https://${FRAMING_HOST}/?frame=${encodeURIComponent(`${site.origin}/`)}`,
        );
        await poll(
          "the frame's load at the server",
          async () => documents(),
          n => n > loads,
        );
        const frame = await poll(
          "Firefox's error page in the frame",
          () => d.frameState!(tab, FRAMED_MARKER),
          f => f.error !== null,
          15_000,
        );
        expect(frame.error).toBe(refusal);
        const seen = await holds(
          'nothing reported for the framing tab',
          async () => ({
            framing: (await tabState(d, tab))?.state ?? null,
            vault: (await tabState(d, vault))?.state ?? null,
            incidents: (await d.ui('UI_LIST_INCIDENTS', {limit: 20})).length,
            alerts: (await d.ui('UI_LIST_ALERTS', {})).length,
            notifications: (await d.notifications()).length,
          }),
          x =>
            (x.framing === null || x.framing === 'NOT_PROTECTED') &&
            x.vault === 'VERIFIED' &&
            x.incidents + x.alerts + x.notifications === 0,
          3000,
        );
        lines.push(
          `${app}: the server answered the frame's load, Firefox shows its ${frame.error} page ` +
            `in the frame; for 3 s the framing tab has ${seen.framing ?? 'no state'}, the vault ` +
            `tab is ${seen.vault}, no incident, no origin alert, no notification`,
        );
        for (const t of [tab, vault]) await d.closeTab!(t);
      }
      lines.push(await expectPrivateStorage(d));
      return lines;
    },
  },
  {
    id: 'vw-connector-frame',
    title:
      'A VERIFIED Vaultwarden page frames its own WebAuthn connector page (same origin), as ' +
      "two-step login does → the frame is verified and runs (the page gets the connector's " +
      'message), the tab stays VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwarden;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/#/login`);
      await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      // The connector's address as the app builds it, here without a WebAuthn challenge.
      const params = new URLSearchParams({
        data: Buffer.from('{}').toString('base64'),
        parent: encodeURIComponent(`${site.origin}/`),
        btnText: encodeURIComponent('Read security key'),
        v: '1',
      });
      const said = await d.pageFrame!(tab, `webauthn-connector.html?${params.toString()}`);
      expect(said).toBe('error|Cannot parse webauthn data.');
      const t = await waitForState(
        d,
        tab,
        'VERIFIED',
        s =>
          settled(s) &&
          s.frames.some(f => f.path === '/webauthn-connector.html' && f.state === 'VERIFIED'),
      );
      expect(t.alert).toBeNull();
      expect(await d.notifications()).toEqual([]);
      return [
        `the framed connector told the page: ${JSON.stringify(said)}`,
        summary(t),
        `frames: ${t.frames.map(f => `${f.path} ${f.state}`).join(', ')}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-auth-flow-block',
    title:
      'A self-hosted SSO sign-in path answers 302 to an identity ' +
      'provider → followed; an identity page with content of its own → denied (blocked page, ' +
      'NOT_COVERED auth-flow), its script never requested',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenBlob;
      await addInstance(d, site);
      // A 302 has no body: the header guard's auth-flow exception lets it go to the provider.
      const sso = await d.open(`${site.origin}/identity/connect/oidc-signin`);
      const idp = await poll(
        'the tab to reach the identity provider',
        () => d.tabUrl(sso),
        u => u.startsWith(`${site.idpOrigin!}/`),
      );
      // A page with content on an auth-flow path is denied like /admin: no auth-flow exception.
      const scripts = (): number => site.log.filter(r => r.path === '/blob-trampoline.js').length;
      const before = scripts();
      const tab = await d.open(`${site.origin}/identity/connect/authorize`);
      const blocked = await poll(
        'the blocked page',
        () => d.tabUrl(tab),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
      );
      const view = await d.ui('UI_GET_BLOCKED', {
        incidentId: decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1)),
      });
      expect(view).toMatchObject({
        state: 'NOT_COVERED',
        reasons: ['auth-flow'],
        path: '/identity/connect/authorize',
        retry: false,
      });
      expect(scripts()).toBe(before);
      return [
        `/identity/connect/oidc-signin → 302 followed to ${idp.replace(site.idpOrigin!, '<identity provider>')}`,
        `/identity/connect/authorize denied: ${blocked.slice(0, blocked.indexOf('#'))}#<incident> (${view!.state}, ${view!.reasons.join(',')}); its script was never requested`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-admin-denied',
    title:
      'Vaultwarden vault open, then /admin in a second tab → the admin page is denied (blocked ' +
      'page, NOT_COVERED admin-portal, no way past it); a denied page never ran, so the vault ' +
      'stays VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      await addInstance(d, fx.vaultwarden);
      const vault = await d.open(`${fx.vaultwarden.origin}/`);
      await waitForState(d, vault, 'VERIFIED', allScriptsOk);
      const admin = await d.open(`${fx.vaultwarden.origin}/admin`);
      const blocked = await poll(
        'the blocked page',
        () => d.tabUrl(admin),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
      );
      const view = await d.ui('UI_GET_BLOCKED', {
        incidentId: decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1)),
      });
      expect(view).toMatchObject({
        state: 'NOT_COVERED',
        reasons: ['admin-portal'],
        path: '/admin',
        canProceedOnce: false,
      });
      // A denied document never taints the origin (it never ran).
      const t = await holds(
        'the vault VERIFIED next to the denied /admin',
        () => tabState(d, vault),
        s => s?.state === 'VERIFIED' && (s.top?.coResident ?? null) === null,
        3000,
      );
      expect(await d.notifications()).toEqual([]);
      return [
        `/admin denied: ${view!.state} (${view!.reasons.join(', ')}), no "Proceed once"`,
        `vault tab: ${summary(t!)} (held 3 s)`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'bw-admin-redirect',
    title:
      'Self-hosted Bitwarden vault open, then /admin in a second tab: the server answers 302 to ' +
      '/admin/login (an ordinary same-origin redirect of a server-rendered page) → followed; the ' +
      'login page is denied (blocked page, NOT_COVERED admin-portal); no alert, the vault stays ' +
      'VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.bitwarden;
      await addInstance(d, site);
      const vault = await d.open(`${site.origin}/`);
      await waitForState(d, vault, 'VERIFIED', s => s.top?.binding !== null && allScriptsOk(s));
      const admin = await d.open(`${site.origin}/admin`);
      const blocked = await poll(
        'the blocked page',
        () => d.tabUrl(admin),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
      );
      const view = await d.ui('UI_GET_BLOCKED', {
        incidentId: decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1)),
      });
      // The redirect's target is judged on its own: a server-rendered page, denied quietly.
      expect(view).toMatchObject({
        state: 'NOT_COVERED',
        reasons: ['admin-portal'],
        path: '/admin/login',
        canProceedOnce: false,
      });
      expect(site.log.filter(r => r.path === '/admin/login').length).toBeGreaterThan(0);
      const t = await holds(
        'the vault VERIFIED next to the denied admin portal',
        () => tabState(d, vault),
        s => s?.state === 'VERIFIED' && s.alert === null && (s.top?.coResident ?? null) === null,
        3000,
      );
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      return [
        `/admin → 302 → /admin/login followed; denied: ${view!.state} (${view!.reasons.join(', ')})`,
        `vault tab: ${summary(t!)} (held 3 s); no alert, no notification`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-not-found-denied',
    title:
      'Vaultwarden vault open, then a mistyped address in a second tab: the server answers its own ' +
      '404 page (an unknown document) → denied (blocked page, PROTECTION_LOST), but nothing ran: ' +
      'no alert, no incident, no notification, and the vault stays VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwarden;
      await addInstance(d, site);
      const vault = await d.open(`${site.origin}/`);
      await waitForState(d, vault, 'VERIFIED', allScriptsOk);
      const typo = await d.open(`${site.origin}/no-such-page`);
      const blocked = await poll(
        'the blocked page',
        () => d.tabUrl(typo),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
      );
      expect(site.log.some(r => r.path === '/no-such-page' && r.status === 404)).toBe(true);
      const view = await d.ui('UI_GET_BLOCKED', {
        incidentId: decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1)),
      });
      expect(view).toMatchObject({
        state: 'PROTECTION_LOST',
        reasons: ['unverifiable-active'],
        path: '/no-such-page',
        canProceedOnce: false,
      });
      const t = await holds(
        'the vault VERIFIED next to the denied 404 page',
        () => tabState(d, vault),
        s => s?.state === 'VERIFIED' && s.alert === null && (s.top?.coResident ?? null) === null,
        3000,
      );
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.ui('UI_LIST_INCIDENTS', {limit: 20})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      return [
        `/no-such-page (404) denied: ${view!.state} (${view!.reasons.join(', ')})`,
        `vault tab: ${summary(t!)} (held 3 s); no alert, no incident, no notification`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-double-reload',
    title:
      'A VERIFIED Vaultwarden page reloaded twice in a row, the second reload cancelling the first ' +
      'before its response starts (Firefox fails its filter; the load never commits) and once ' +
      'more in the middle of its held body (the load commits, its request reports the abort, its ' +
      'filter stops with a prefix) → the cancelled load ends quietly: no alert, no incident, no ' +
      'notification; the final load VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const lines: string[] = [];
      for (const [site, when] of [
        [fx.vaultwardenHeldHeaders, 'before its response starts'],
        [fx.vaultwardenHeldDocument, 'in the middle of its body'],
      ] as const) {
        await addInstance(d, site);
        const tab = await d.open(`${site.origin}/`);
        const first = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
        const held = site.heldResponses!();
        // A page script reloads, and reloads again while the first reload's document is held:
        // the filter has written nothing of it.
        await d.reloadNow!(tab);
        await poll(
          'the first reload at the server',
          async () => site.heldResponses!(),
          n => n > held,
        );
        if (site === fx.vaultwardenHeldDocument) {
          // Its response has started; the second reload must find it committed.
          await poll(
            'the first reload to commit',
            () => tabState(d, tab),
            s => s !== null && s.top !== null && s.top.doc !== first.top!.doc,
          );
        }
        await d.reloadNow!(tab);
        await poll(
          'Firefox to cut off the first reload',
          async () => site.abortedResponses!(),
          n => n > 0,
        );
        const t = await waitForState(
          d,
          tab,
          'VERIFIED',
          s => s.top !== null && s.top.doc !== first.top!.doc && allScriptsOk(s),
        );
        const kept = await holds(
          'VERIFIED after the double reload',
          () => tabState(d, tab),
          s => s?.state === 'VERIFIED' && s.alert === null,
          3000,
        );
        expect(await d.tabUrl(tab)).toMatch(new RegExp(`^${site.origin}/`));
        expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
        expect(await d.ui('UI_LIST_INCIDENTS', {limit: 20})).toEqual([]);
        expect(await d.notifications()).toEqual([]);
        lines.push(
          `cancelled ${when}: ${site.heldResponses!() - held} document requests, ` +
            `${site.abortedResponses!()} cut off by Firefox; ${summary(kept ?? t)}`,
        );
        await d.closeTab!(tab);
      }
      lines.push('no alert, no incident, no notification', await expectPrivateStorage(d));
      return lines;
    },
  },
  {
    id: 'vw-reload-cuts-response',
    title:
      'A VERIFIED Vaultwarden page reloaded just as its 7.9 MB .wasm response ends, sent plain and ' +
      'gzip-coded, seven times each from 10 ms before the end to 8 ms after it (Firefox cuts the ' +
      'response off and can still report its request completed, with a prefix in the filter) → ' +
      'never MISMATCH: no alert, no incident, no notification; the reloaded page VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const lines: string[] = [];
      for (const [site, coding] of [
        [fx.vaultwardenHeldWasm, 'plain'],
        [fx.vaultwardenHeldWasmGzip, 'gzip'],
      ] as const) {
        await addInstance(d, site);
        let last = '';
        for (const offset of [-10, -7, -4, -1, 2, 5, 8]) {
          const before = site.heldResponses!();
          const tab = await d.open(`${site.origin}/`);
          const until = Date.now() + 30_000;
          while (site.heldResponses!() === before && Date.now() < until) {
            await new Promise(r => setTimeout(r, 1));
          }
          expect(site.heldResponses!(), 'the app requested its .wasm file').toBeGreaterThan(before);
          // The server sends the second half of the file 4 s after the request reached it.
          const end = Date.now() + 4000 + offset;
          const first = await tabState(d, tab);
          await new Promise(r => setTimeout(r, Math.max(0, end - Date.now())));
          await d.reloadNow!(tab);
          // The reloaded document verified: the response the reload cut off was decided before.
          const t = await waitForState(
            d,
            tab,
            'VERIFIED',
            s => s.top !== null && s.top.doc !== first?.top?.doc && allScriptsOk(s),
          );
          expect(await d.ui('UI_LIST_ALERTS', {}), `${coding}, ${offset} ms`).toEqual([]);
          expect(await d.ui('UI_LIST_INCIDENTS', {limit: 20}), `${coding}, ${offset} ms`).toEqual(
            [],
          );
          expect(await d.notifications()).toEqual([]);
          last = summary(t);
          await d.closeTab!(tab);
        }
        lines.push(`${coding}: 7 reloads at the end of the .wasm response; the last page ${last}`);
      }
      lines.push('no alert, no incident, no notification', await expectPrivateStorage(d));
      return lines;
    },
  },
  {
    id: 'vw-double-reload-script',
    title:
      'A VERIFIED Vaultwarden page whose script reloads it twice, 20 to 30 ms apart, so that the ' +
      'second reload can cancel the first after its response started and before its commit ' +
      '(Firefox fails its filter and its request; the load never commits) → the final load is ' +
      'VERIFIED, or (a known false alarm: the commit that follows is taken for the cancelled ' +
      'load) the tab is PROTECTION_LOST filter-failed with an alert; one more reload then shows ' +
      'the page RECOVERING, and VERIFIED once the alert is acknowledged',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenHeldDocument;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/`);
      let shown = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      const lines: string[] = [];
      let alarms = 0;
      for (const gap of [20, 22, 24, 26, 28, 30]) {
        const held = site.heldResponses!();
        const aborted = site.abortedResponses!();
        const before = shown.top!.doc;
        await d.reloadTwice!(tab, gap);
        // Either way the second reload's document is checked and shown; in the false alarm the tab
        // holds the cancelled reload's document as well.
        const t = (await poll(
          `tab ${tab} VERIFIED or PROTECTION_LOST after reloads ${gap} ms apart`,
          () => tabState(d, tab),
          s =>
            s !== null &&
            s.top !== null &&
            s.top.doc !== before &&
            (s.state === 'VERIFIED'
              ? allScriptsOk(s)
              : s.state === 'PROTECTION_LOST' &&
                settled(s) &&
                [s.top, ...s.frames].some(f => f.counts.document.ok === 1)),
        ))!;
        const requests = site.heldResponses!() - held;
        const cut = site.abortedResponses!() - aborted;
        if (t.state === 'VERIFIED') {
          // An alert acknowledged after an earlier false alarm stays on the record, closed.
          if (alarms === 0) expect(t.alert).toBeNull();
          shown = t;
        } else {
          // The tab holds the cancelled reload, which is never judged and owns the page's
          // requests, and the second reload; the record lists first the one whose session the
          // engine created first. No script of the page shown is released.
          alarms++;
          const both = [t.top!, ...t.frames];
          expect(t.reasons).toContain('filter-failed');
          expect(both.map(f => f.state).sort()).toEqual([
            'CO_RESIDENT_UNVERIFIED',
            'PROTECTION_LOST',
          ]);
          expect(both.map(f => f.counts.scripts.ok)).toEqual([0, 0]);
          expect(t.alert).toMatchObject({
            origin: site.origin,
            state: 'PROTECTION_LOST',
            reasons: ['filter-failed'],
            acknowledged: false,
          });
          await d.reload!(tab);
          const again = await waitForState(
            d,
            tab,
            'RECOVERING',
            s => s.top !== null && both.every(f => f.doc !== s.top!.doc) && allScriptsOk(s),
          );
          expect(again.frames).toEqual([]);
          await d.ui('UI_ACK_ALERT', {origin: site.origin});
          shown = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
        }
        lines.push(
          `reloads ${gap} ms apart: ${requests} document requests, ${cut} cut off by Firefox; ` +
            (t.state === 'VERIFIED'
              ? 'state VERIFIED'
              : `state PROTECTION_LOST (${t.reasons.join(', ')}); after one more reload ` +
                'RECOVERING, acknowledged: VERIFIED'),
        );
      }
      const kept = await holds(
        'VERIFIED after the double reloads',
        () => tabState(d, tab),
        s => s?.state === 'VERIFIED',
        3000,
      );
      expect(await d.tabUrl(tab)).toMatch(new RegExp(`^${site.origin}/`));
      const alerts = await d.ui('UI_LIST_ALERTS', {});
      expect(alerts.map(a => a.acknowledged)).toEqual(alarms > 0 ? [true] : []);
      const incidents = await d.ui('UI_LIST_INCIDENTS', {limit: 20});
      expect(incidents.map(i => i.kind)).toEqual(Array(alarms).fill('protection-lost'));
      if (alarms === 0) expect(await d.notifications()).toEqual([]);
      lines.push(
        summary(kept ?? shown),
        alarms === 0
          ? 'no false alarm: no alert, no incident, no notification'
          : `false alarms: ${alarms} of 6, each with an alert and an incident`,
        await expectPrivateStorage(d),
      );
      return lines;
    },
  },
  {
    id: 'bw-script-redirect',
    title:
      'Bitwarden, app/main.<hash>.js answers 302 to another origin → the redirect is cancelled, ' +
      'MISMATCH (header), the vault document stays',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.bitwardenScriptRedirect;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/`);
      const t = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('header'));
      expect(await d.ran(tab, EVIL_MARKER)).toBe(false);
      const url = await d.tabUrl(tab);
      expect(url.startsWith(`${site.origin}/`), `tab shows ${url}`).toBe(true);
      const n = await poll(
        'a notification',
        () => d.notifications(),
        x => x.length > 0,
      );
      return [
        summary(t),
        notes(n),
        `the attacker script never ran (redirect to ${site.evilOrigin} cancelled)`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'bw-refresh',
    title:
      'Bitwarden, index.html with "Refresh: 0; url=<another origin>" → the document is cancelled, ' +
      'blocked page with MISMATCH (header), the tab never reaches the other origin',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.bitwardenRefresh;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/`);
      // The cancelled document never commits, so its session ends: the blocked page and its
      // incident carry the verdict, not the tab state.
      const blocked = await poll(
        'the blocked page',
        () => d.tabUrl(tab),
        u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
      );
      const view = await d.ui('UI_GET_BLOCKED', {
        incidentId: decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1)),
      });
      expect(view).toMatchObject({state: 'MISMATCH', reasons: expect.arrayContaining(['header'])});
      // Give a Refresh that slipped through time to fire.
      await new Promise(r => setTimeout(r, 1500));
      const url = await d.tabUrl(tab);
      expect(url.startsWith(site.evilOrigin!)).toBe(false);
      expect(await d.ran(tab, EVIL_MARKER)).toBe(false);
      return [
        `blocked: ${view!.state} (${view!.reasons.join(',')})`,
        `tab stays off ${site.evilOrigin} (now ${url.replace(d.baseUrl, '<ext>/').replace(/#.*$/, '#<incident>')})`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'bw-304-revisit',
    title:
      'A VERIFIED self-hosted Bitwarden vault left for another site and visited again by ' +
      'navigation: the document is fetched in full (no-store) and the server answers the ' +
      'revalidated logo with 304 → VERIFIED again, no alert, no incident, no notification',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.bitwardenRevalidating;
      await addInstance(d, site);
      const url = `${site.origin}/#/login`;
      const tab = await d.open(url);
      const first = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      await d.navigate!(tab, `${fx.bitwardenScriptRedirect.evilOrigin!}/`);
      const seen = site.log.length;
      await d.navigate!(tab, url);
      const again = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => s.top !== null && s.top.doc !== first.top!.doc && allScriptsOk(s),
      );
      // Images are never made no-store, so Firefox revalidates the ones it cached.
      const notModified = await poll(
        'a 304 answer',
        async () =>
          site.log
            .slice(seen)
            .filter(r => r.status === 304)
            .map(r => r.path),
        paths => paths.length > 0,
      );
      const kept = await holds(
        'VERIFIED after the 304',
        () => tabState(d, tab),
        s => s?.state === 'VERIFIED' && s.alert === null,
        2000,
      );
      const documents = site.log.slice(seen).filter(r => r.path === '/');
      expect(documents.map(r => r.status)).toEqual([200]);
      expect(await d.ui('UI_LIST_ALERTS', {})).toEqual([]);
      expect(await d.ui('UI_LIST_INCIDENTS', {limit: 20})).toEqual([]);
      expect(await d.notifications()).toEqual([]);
      return [
        `first visit: ${summary(first)}`,
        `visited again: the document answered 200, 304 for ${notModified.join(', ')}`,
        `after the 304: ${summary(kept ?? again)}`,
        'no alert, no incident, no notification',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'bw-304-cached-before-add',
    title:
      'A self-hosted Bitwarden vault that Firefox cached before its server was added: the next ' +
      'visit revalidates the document (304) → VERIFIED from the cached bytes, with the ' +
      "server's CSP and IntactWarden's floor both in force; the visit after that fetches the " +
      'document in full (the no-store written on the 304 reached the cached response)',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.bitwardenRevalidating;
      const url = `${site.origin}/#/login`;
      const away = `${fx.bitwardenScriptRedirect.evilOrigin!}/`;
      const answers = (from: number, status: number): string[] =>
        site.log
          .slice(from)
          .filter(r => r.status === status)
          .map(r => r.path);
      // Not protected yet: nothing is held or rewritten, and Firefox caches what it loads.
      const tab = await d.open(url);
      expect(await tabState(d, tab)).toBeNull();
      await d.navigate!(tab, away);
      await addInstance(d, site);
      const first = site.log.length;
      await d.navigate!(tab, url);
      const t = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      expect(t.top!.binding).toMatchObject({buildId: BW_BUILD, assurance: 'release-exact'});
      expect(answers(first, 304)).toContain('/');
      expect(answers(first, 200)).not.toContain('/');
      const notModified = answers(first, 304);
      // The policies in force on the revalidated document: an image from another origin breaks
      // only the server's, and an inline script is reported by the floor as well.
      const reports = await d.pageCspReports!(tab, INLINE_MARKER);
      const by = (directive: string, part: string): boolean =>
        reports.some(r => r.directive === directive && r.policy.includes(part));
      expect(by('img-src', SERVER_IMG_SRC), JSON.stringify(reports)).toBe(true);
      expect(by('script-src-elem', FLOOR_SCRIPT_ATTR), JSON.stringify(reports)).toBe(true);
      expect(await d.ran(tab, INLINE_MARKER)).toBe(false);
      const m = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('inline-code'));
      await d.navigate!(tab, away);
      const second = site.log.length;
      await d.navigate!(tab, url);
      await poll(
        'the document of the second visit',
        async () => site.log.slice(second).filter(r => r.path === '/'),
        r => r.length > 0,
      );
      expect(answers(second, 200)).toContain('/');
      expect(answers(second, 304)).not.toContain('/');
      return [
        'before the server was added: not protected, cached by Firefox',
        `first visit after: 304 for ${notModified.join(', ')}; ${summary(t)}`,
        `CSP reports on that document: ${reports.map(r => `${r.directive} by "${r.policy.slice(0, 40)}…"`).join(', ')}`,
        `the probe's inline script never ran; the floor's report: ${summary(m)}`,
        'second visit: the document answered 200',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-service-worker-document',
    title:
      'A compromised Vaultwarden server registered a service worker before its origin was added, ' +
      "and the worker answers the vault document with its own HTML. Firefox fails the document's " +
      'filter, so nothing holds that HTML and its inline script runs → the tab is MISMATCH ' +
      '(service-worker, inline-code) with the document PROTECTION_LOST filter-failed, an origin ' +
      'alert is raised, and the vault in another tab, which the worker answers too, is red as well',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenServiceWorker;
      await workerBeforeAdd(d, site, 'document');
      const tab = await d.open(`${site.origin}/`);
      await firstState(d, tab);
      // From its first state on, the tab is never without a state and never VERIFIED.
      const red = await poll(
        `tab ${tab} in MISMATCH (service-worker, inline-code)`,
        async () => {
          const s = await tabState(d, tab);
          expect(s, 'a protected tab has a state').not.toBeNull();
          expect(s!.state).not.toBe('VERIFIED');
          return s!;
        },
        s =>
          s.state === 'MISMATCH' &&
          s.reasons.includes('service-worker') &&
          s.reasons.includes('inline-code'),
      );
      await poll(
        "the worker's document to run",
        () => d.ran(tab, WORKER_DOCUMENT_MARKER),
        x => x,
      );
      const own = (await waitForItems(d, tab, ['/'])).get('/')!;
      expect(own.outcome).toEqual({r: 'unverifiable', reason: 'filter-failed', delivered: true});
      const alert = await expectWorkerAlert(d, site);
      const other = await d.open(`${site.origin}/`);
      const o = await waitForState(d, other, 'MISMATCH', s => s.reasons.includes('service-worker'));
      await holds('the first tab red', () => tabState(d, tab), isRed, 3000);
      const n = await d.notifications();
      expect(n.map(x => x.title)).toContain('IntactWarden: Mismatch');
      return [
        `the worker's HTML ran in the vault tab: ${summary(red)}; its document: ${itemLine(own)}`,
        `origin alert ${alert}; ${notes(n)}`,
        `the vault in another tab: ${summary(o)}; the first tab stayed red for 3 s`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-service-worker-script',
    title:
      'The same worker leaves the vault document to the network and answers the main script ' +
      'with its own bytes. Firefox reports the document request again, and its second filter ' +
      "holds it: the document verifies on its own bytes. The script's filter receives the " +
      "worker's bytes, for which no response headers are reported → the script is withheld and " +
      'never runs, the tab is MISMATCH (service-worker) with an origin alert, and another vault ' +
      'tab is red too',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenServiceWorker;
      await workerBeforeAdd(d, site, 'script');
      const tab = await d.open(`${site.origin}/`);
      await firstState(d, tab);
      const red = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('service-worker'));
      const withheld = await workerScriptWithheld(d, site, tab);
      const workers = await d.pageWorkers!(tab);
      expect(workers).toEqual({registrations: 1, controlled: true});
      const alert = await expectWorkerAlert(d, site);
      const other = await d.open(`${site.origin}/`);
      const o = await waitForState(d, other, 'MISMATCH', s => s.reasons.includes('service-worker'));
      await holds('the first tab red', () => tabState(d, tab), isRed, 3000);
      expect(await d.ran(tab, WORKER_SCRIPT_MARKER)).toBe(false);
      return [
        withheld,
        `${summary(red)}; origin alert ${alert}`,
        `the vault in another tab: ${summary(o)}; the first tab stayed red for 3 s`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-service-worker-unregistered',
    title:
      'The worker unregisters itself when the vault document is requested and goes on ' +
      'controlling that page: the page lists no registration, but it has a controller → the tab ' +
      "is MISMATCH (service-worker) all the same, the worker's main script is withheld, an " +
      'origin alert is raised, and the vault in another tab, which no worker controls any more, ' +
      'is CO_RESIDENT_UNVERIFIED, never VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenServiceWorker;
      await workerBeforeAdd(d, site, 'script-unregistered');
      const tab = await d.open(`${site.origin}/`);
      await firstState(d, tab);
      const red = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('service-worker'));
      const workers = await d.pageWorkers!(tab);
      expect(workers).toEqual({registrations: 0, controlled: true});
      const withheld = await workerScriptWithheld(d, site, tab);
      const alert = await expectWorkerAlert(d, site);
      const other = await d.open(`${site.origin}/`);
      const o = await waitForState(d, other, 'CO_RESIDENT_UNVERIFIED', allScriptsOk);
      expect(await d.pageWorkers!(other)).toEqual({registrations: 0, controlled: false});
      await holds(
        'the other tab CO_RESIDENT_UNVERIFIED',
        () => tabState(d, other),
        s => s?.state === 'CO_RESIDENT_UNVERIFIED',
        3000,
      );
      expect(isRed(await tabState(d, tab))).toBe(true);
      expect(await d.ran(tab, WORKER_SCRIPT_MARKER)).toBe(false);
      return [
        `the page lists ${workers.registrations} registrations and has a controller: ${summary(red)}`,
        withheld,
        `origin alert ${alert}`,
        `the vault in another tab (no worker): ${summary(o)}, held 3 s; the first tab is still red`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-service-worker-fetched-script',
    title:
      'The worker unregisters itself and answers the main script with a response it fetched ' +
      'from another address of the site. Firefox then drops the script\'s filter ("Channel ' +
      'redirected") and the page runs those bytes → the script counts as run unverified ' +
      '(PROTECTION_LOST filter-failed evidence), the tab is MISMATCH (service-worker), an origin ' +
      'alert is raised, and the vault in another tab is CO_RESIDENT_UNVERIFIED, never VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenServiceWorker;
      await workerBeforeAdd(d, site, 'script-fetched');
      const tab = await d.open(`${site.origin}/`);
      await firstState(d, tab);
      const red = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('service-worker'));
      await poll(
        "the worker's script to run",
        () => d.ran(tab, WORKER_SCRIPT_MARKER),
        x => x,
      );
      const {top, script} = await shownItem(d, tab, site.mainScript);
      expect(top.counts.document).toEqual({ok: 1, total: 1});
      expect(script.outcome).toEqual({r: 'unverifiable', reason: 'filter-failed', delivered: true});
      expect(await d.pageWorkers!(tab)).toEqual({registrations: 0, controlled: true});
      const alert = await expectWorkerAlert(d, site);
      const other = await d.open(`${site.origin}/`);
      const o = await waitForState(d, other, 'CO_RESIDENT_UNVERIFIED', allScriptsOk);
      await holds(
        'the other tab CO_RESIDENT_UNVERIFIED',
        () => tabState(d, other),
        s => s?.state === 'CO_RESIDENT_UNVERIFIED',
        3000,
      );
      expect(isRed(await tabState(d, tab))).toBe(true);
      return [
        `document from the network: verified; the worker's script ran: ${itemLine(script)}, delivered`,
        `${summary(red)}; origin alert ${alert}`,
        `the vault in another tab (no worker): ${summary(o)}, held 3 s; the first tab is still red`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-service-worker-cleared',
    title:
      'After such a worker answered the vault document, the site\'s data is cleared ("Clear ' +
      'cookies and site data"): the worker is gone, the vault loads from the network and ' +
      'verifies → RECOVERING while the alert is open, VERIFIED once it is acknowledged',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenServiceWorker;
      await workerBeforeAdd(d, site, 'document');
      const tab = await d.open(`${site.origin}/`);
      const red = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('service-worker'));
      // Loaded again, the vault is the worker's document again.
      await d.navigate!(tab, `${site.origin}/`);
      const again = await waitForState(
        d,
        tab,
        'MISMATCH',
        s => s.reasons.includes('service-worker') && s.top!.doc !== red.top!.doc,
      );
      expect(await d.ran(tab, WORKER_DOCUMENT_MARKER)).toBe(true);
      await d.clearSiteData!(site.origin);
      await d.navigate!(tab, `${site.origin}/`);
      const recovering = await waitForState(d, tab, 'RECOVERING', allScriptsOk);
      expect(recovering.top!.binding).toMatchObject({buildId: VW_BUILD});
      expect(await d.pageWorkers!(tab)).toEqual({registrations: 0, controlled: false});
      expect(await d.ran(tab, WORKER_DOCUMENT_MARKER)).toBe(false);
      await d.ui('UI_ACK_ALERT', {origin: site.origin});
      const verified = await waitForState(d, tab, 'VERIFIED', allScriptsOk);
      await d.navigate!(tab, `${site.origin}/`);
      const reloaded = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => allScriptsOk(s) && s.top!.doc !== verified.top!.doc,
      );
      await holds(
        'the vault VERIFIED',
        () => tabState(d, tab),
        s => s?.state === 'VERIFIED',
        3000,
      );
      return [
        `with the worker: ${summary(red)}; loaded again: ${summary(again)}`,
        `site data cleared, loaded again: no worker, ${summary(recovering)}`,
        `alert acknowledged: ${summary(verified)}; loaded again: ${summary(reloaded)}, held 3 s`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'sm-genuine',
    title:
      'Secrets Manager, Bitwarden self-hosted COMMERCIAL: #/sm/<org> after a VERIFIED load, and as ' +
      'a deep link → the lazy chunks 541 and 195 verified like any release file, VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      await addInstance(d, fx.bitwarden);
      return smGenuine(d, fx.bitwarden, {buildId: BW_BUILD, assurance: 'release-exact'});
    },
  },
  {
    id: 'sm-cloud-us',
    title:
      'Secrets Manager on https://vault.bitwarden.com (cloud-us, release-derived): #/sm/<org> → ' +
      'chunks 541 and 195 verified like any release file, VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      return smGenuine(d, fx.bitwardenCloud, {buildId: BW_CLOUD_US, assurance: 'release-derived'});
    },
  },
  {
    id: 'sm-tampered-block',
    title:
      'Secrets Manager chunk 541 with one appended statement, loaded only on #/sm → ' +
      'denied (nothing written), MISMATCH (bytes), origin alert, notification; its code never ' +
      'runs, the vault document stays (no blocked page)',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.bitwardenSmTampered;
      const sm = chunkPath(site.files, 541);
      const shared = chunkPath(site.files, 195);
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/#/login`);
      await waitForState(d, tab, 'VERIFIED', s => s.top?.binding !== null && allScriptsOk(s));
      await navigateToLazyRoute(d, tab, SM_ROUTE);
      const items = await waitForItems(d, tab, [shared, sm]);
      expect(items.get(sm)).toMatchObject({outcome: {r: 'mismatch', reason: 'bytes'}});
      expect(items.get(shared)).toMatchObject({outcome: {r: 'ok'}});
      const t = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('bytes'));
      expect(t.alert).toMatchObject({origin: site.origin, acknowledged: false});
      expect(await d.ran(tab, SM_TAMPER_MARKER)).toBe(false);
      const n = await poll(
        'a notification',
        () => d.notifications(),
        x => x.length > 0,
      );
      // A denied subresource never replaces the document: the vault stays, with an empty chunk.
      // firefox: the empty chunk registers no module, so the app's lazy route fails and the app
      // leaves #/sm (observed, not assumed).
      const url = await poll(
        'the app to leave #/sm once its lazy route failed',
        () => d.tabUrl(tab),
        u => !u.includes('#/sm'),
        15_000,
      );
      expect(url.startsWith(`${site.origin}/`), `tab shows ${url}`).toBe(true);
      expect(t.top).toMatchObject({path: '/', state: 'MISMATCH'});
      const after = await tabState(d, tab);
      expect(after?.flags).not.toContain('BLOCKED');
      return [
        itemLine(items.get(shared)!),
        itemLine(items.get(sm)!),
        summary(t),
        notes(n),
        `tampered chunk 541 denied: it never ran`,
        `the vault document stays (no blocked page, no BLOCKED flag): the app's lazy route failed and the app went to ${url.slice(url.indexOf('#'))}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'vw-sm-block',
    title:
      "A Vaultwarden server also serves Bitwarden's Secrets Manager chunk 541 and the " +
      'page loads it → MISMATCH unknown-path (the chunk is not in the Vaultwarden core), denied ' +
      '(nothing written), never runs, the vault stays',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwardenSmChunk;
      const sm = chunkPath(site.files, 541);
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/#/login`);
      await waitForState(d, tab, 'VERIFIED', s => s.top?.binding !== null && allScriptsOk(s));
      // Denied before the page can run it.
      const event = await d.pageScript(tab, sm);
      const items = await waitForItems(d, tab, [sm]);
      expect(items.get(sm)).toMatchObject({
        type: 'script',
        outcome: {r: 'mismatch', reason: 'unknown-path'},
      });
      expect(await d.ran(tab, SM_TAMPER_MARKER)).toBe(false);
      const after = await waitForState(d, tab, 'MISMATCH', settled);
      expect(after.reasons).toEqual(['unknown-path']);
      const n = await poll(
        'a notification',
        () => d.notifications(),
        x => x.length > 0,
      );
      // A denied subresource never replaces the document: no blocked page.
      expect(after.top).toMatchObject({path: '/', state: 'MISMATCH'});
      const url = await d.tabUrl(tab);
      expect(url.startsWith(`${site.origin}/`), `tab shows ${url}`).toBe(true);
      const popup2 = await popupHas(d, tab, [UNKNOWN_PATH_SENTENCE]);
      return [
        `<script src="${sm}"> appended (${event}): ${itemLine(items.get(sm)!)}`,
        `chunk denied: it never ran`,
        summary(after),
        notes(n),
        `the vault document stays (${url.replace(site.origin, '<origin>')}): no blocked page`,
        ...(popup2 !== '' ? [popup2] : []),
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'options-ui-add',
    title:
      'Vaultwarden instance added through the options page itself (type the address, ' +
      '"Add server": one request to {base}api/config) → listed, then VERIFIED',
    pkg: 'full',
    async run(d, fx) {
      const configs = (): number => fx.vaultwarden.log.filter(r => r.path === '/api/config').length;
      const before = configs();
      const confirmed = await d.addInstanceInOptions!(`${fx.vaultwarden.origin}/`);
      // The extension asks the server one thing: its /api/config (the app's own reads come later).
      expect(configs() - before).toBe(1);
      expect(confirmed).toEqual([]);
      const list = await d.ui('UI_LIST_INSTANCES', {});
      const mine = list.find(i => i.record.origin === fx.vaultwarden.origin);
      expect(mine?.record).toMatchObject({app: 'vaultwarden-web', base_path: '/'});
      expect(mine?.permission.granted).toBe(true);
      const tab = await d.open(`${fx.vaultwarden.origin}/`);
      const t = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => settled(s) && s.top?.binding?.buildId === VW_BUILD,
      );
      return [
        `options page: one GET /api/config, no confirmation asked, instance ${mine!.record.origin} listed with its host permission`,
        summary(t),
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'permission-revoked',
    title:
      'Host permission of an open vault revoked → PROTECTION_LOST (permission-revoked), ' +
      'also after a reload; granted again → VERIFIED; a revoked required host is granted again ' +
      'from onboarding',
    pkg: 'full',
    async run(d, fx) {
      const site = fx.vaultwarden;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/`);
      // Wait for the app's last lazy load, its .wasm file, too. Revoking while that request is in
      // flight leaves an active item without response headers, which the engine cannot judge: it
      // is denied, PROTECTION_LOST unverifiable-active, which is not what this scenario looks at.
      await waitForState(d, tab, 'VERIFIED', s => settled(s) && (s.top?.counts.wasm.ok ?? 0) === 1);
      // The pattern the options page requests for the instance (ports are not part of patterns).
      const pattern = matchPatternFor(site.origin);
      await d.revokeHosts!([pattern]);
      const lost = await waitForState(d, tab, 'PROTECTION_LOST', s =>
        s.reasons.includes('permission-revoked'),
      );
      expect(lost.permissionMissing).toBe(true);
      // A reload while the permission is missing: webRequest reports nothing, only the commit
      // (webNavigation needs no host permission), and the page that ran unchecked stays red.
      await d.reload!(tab);
      const reloaded = await waitForState(
        d,
        tab,
        'PROTECTION_LOST',
        s => s.reasons.includes('permission-revoked') && s.reasons.includes('untracked'),
      );
      expect(reloaded.permissionMissing).toBe(true);
      await d.grantHosts!([pattern]);
      // The first tab may have run code nobody verified while the permission was missing: it is a
      // taint source, so a vault opened next to it is CO_RESIDENT_UNVERIFIED.
      const beside = await d.open(`${site.origin}/`);
      const co = await waitForState(d, beside, 'CO_RESIDENT_UNVERIFIED', allScriptsOk);
      expect(co.top?.coResident).toMatchObject({class: 'unverifiable', sourcePath: '/'});
      await closeTabs(d, tab, beside);
      const again = await d.open(`${site.origin}/`);
      const t = await waitForState(d, again, 'VERIFIED', allScriptsOk);
      await d.revokeHosts!(['https://api.github.com/*']);
      const before = await d.ui('UI_GET_ONBOARDING', {});
      expect(before.permissions.filter(p => !p.granted).map(p => p.pattern)).toEqual([
        'https://api.github.com/*',
      ]);
      const missing = await d.grantFromOnboarding!();
      expect(missing).toEqual([]);
      return [
        `revoked: ${summary(lost)}; permissionMissing ${lost.permissionMissing}`,
        `reloaded while revoked: ${summary(reloaded)}`,
        `granted again, next to the revoked tab: ${summary(co)}`,
        `granted again, revoked tab closed, new tab: ${summary(t)}`,
        'api.github.com revoked → onboarding "Grant" → every required host granted',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'event-page-idle',
    title:
      'Event page idle (idle timeout 2 s): it stops with a VERIFIED vault open and stays stopped ' +
      '(no port, no alarm wakes it); a popup state request wakes it and the vault is still ' +
      'VERIFIED (rehydrated); with no vault open a vault load that wakes it is filtered → VERIFIED',
    pkg: 'full',
    prefs: {'extensions.background.idle.timeout': 2000},
    async run(d, fx) {
      const site = fx.vaultwarden;
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/`);
      await waitForState(d, tab, 'VERIFIED', settled);
      // Nothing keeps it alive while it is idle, and nothing in the page restarts it.
      const idle = await poll(
        'the event page to stop with the vault open',
        () => d.background!(),
        b => b.state === 'stopped',
        30_000,
      );
      const asleep = await holds(
        'the event page stopped with the vault open',
        () => d.background!(),
        b => b.state === 'stopped' && b.starts === idle.starts,
        5000,
      );
      // The popup's state request wakes it: the tab is rehydrated from storage.session.
      const kept = await tabState(d, tab);
      expect(kept?.state, JSON.stringify(kept?.reasons)).toBe('VERIFIED');
      const woke = await d.background!();
      expect(woke.starts).toBeGreaterThan(idle.starts);
      await d.closeTab!(tab);
      const stopped = await poll(
        'the event page to stop with no vault open',
        () => d.background!(),
        b => b.state === 'stopped' && b.starts === woke.starts,
        30_000,
      );
      // The vault's main_frame request wakes the event page: the listener creates the
      // StreamFilter after awaiting the engine's start (rehydration, cores).
      const again = await d.open(`${site.origin}/`);
      const t = await waitForState(d, again, 'VERIFIED', allScriptsOk);
      const after = await d.background!();
      expect(after.starts).toBeGreaterThan(stopped.starts);
      return [
        `vault open: event page ${asleep.state} for 5 s (starts ${asleep.starts}), no restart`,
        `a state request woke it (starts ${woke.starts}): the vault is still ${kept!.state}`,
        `no vault open: event page ${stopped.state} (starts ${stopped.starts}); the vault load woke it (starts ${after.starts})`,
        `after the wake-up: ${summary(t)}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'event-page-wake-block',
    title:
      'Event page stopped: the tampered main script of a vault load that wakes it is still ' +
      'denied → MISMATCH, the script never runs',
    pkg: 'full',
    prefs: {'extensions.background.idle.timeout': 2000},
    async run(d, fx) {
      await addInstance(d, fx.bitwardenTampered);
      const stopped = await poll(
        'the event page to stop',
        () => d.background!(),
        b => b.state === 'stopped',
        30_000,
      );
      const tab = await d.open(`${fx.bitwardenTampered.origin}/`);
      const t = await waitForState(d, tab, 'MISMATCH');
      expect(t.reasons).toContain('bytes');
      expect(await d.ran(tab, TAMPER_MARKER)).toBe(false);
      const after = await d.background!();
      expect(after.starts).toBeGreaterThan(stopped.starts);
      return [
        `event page ${stopped.state} (starts ${stopped.starts}) → woken by the vault load (starts ${after.starts})`,
        summary(t),
        'tampered main script denied on wake-up: it never ran',
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'event-page-lazy-chunk',
    title:
      'The event page stops while a VERIFIED vault is open (idle timeout ' +
      '2 s); a tampered lazy chunk the page loads afterwards wakes it and is denied → MISMATCH, ' +
      'notification, the chunk never runs, although the document said hello only to the earlier ' +
      'event page',
    pkg: 'full',
    prefs: {'extensions.background.idle.timeout': 2000},
    async run(d, fx) {
      const site = fx.bitwardenSmTampered;
      const sm = chunkPath(site.files, 541);
      await addInstance(d, site);
      const tab = await d.open(`${site.origin}/#/login`);
      await waitForState(d, tab, 'VERIFIED', s => s.top?.binding !== null && allScriptsOk(s));
      // The document said hello to the event page that is about to stop; it never says hello
      // again, and nothing in the page restarts the event page.
      const stopped = await poll(
        'the event page to stop with the vault open',
        () => d.background!(),
        b => b.state === 'stopped',
        30_000,
      );
      // The page loads chunk 541 (one appended statement), as webpack's loader does: the request
      // wakes the event page, which still knows the document (rehydrated) and denies the chunk.
      const event = await d.pageScript(tab, sm);
      const t = await waitForState(d, tab, 'MISMATCH', s => s.reasons.includes('bytes'));
      expect(await d.ran(tab, SM_TAMPER_MARKER)).toBe(false);
      const items = await waitForItems(d, tab, [sm]);
      expect(items.get(sm)).toMatchObject({outcome: {r: 'mismatch', reason: 'bytes'}});
      const n = await poll(
        'a notification',
        () => d.notifications(),
        x => x.length > 0,
      );
      const after = await d.background!();
      expect(after.starts).toBeGreaterThan(stopped.starts);
      const url = await d.tabUrl(tab);
      expect(url.startsWith(`${site.origin}/`), `tab shows ${url}`).toBe(true);
      return [
        `event page ${stopped.state} (starts ${stopped.starts}) with the VERIFIED vault open`,
        `<script src="${sm}"> appended (${event}): woke it (starts ${after.starts}); ${summary(t)}`,
        `${itemLine(items.get(sm)!)}; the chunk never ran; ${notes(n)}`,
        await expectPrivateStorage(d),
      ];
    },
  },
  {
    id: 'deep-verify-idle',
    title:
      'Local deep verify of an unknown build while GitHub downloads are held for 35 s, ' +
      'idle timeout 15 s → the event page stays alive through the job; the blocked page then ' +
      'reloads the vault → VERIFIED; once the event page has stopped, the vault in a second tab ' +
      'wakes it → VERIFIED from the stored manifest',
    pkg: 'bitwarden-only',
    // Above the job keepalive period (trust/jobHost.ts KEEPALIVE_MS, 10 s), below the hold.
    prefs: {'extensions.background.idle.timeout': 15_000},
    async run(d, fx) {
      fx.github.hold();
      try {
        await addInstance(d, fx.vaultwarden);
        const url = `${fx.vaultwarden.origin}/`;
        const tab = await d.open(url);
        const blocked = await poll(
          'the blocked page (NEW_BUILD)',
          () => d.tabUrl(tab),
          u => u.startsWith(`${d.baseUrl}ui/blocked.html#`),
        );
        const incidentId = decodeURIComponent(blocked.slice(blocked.indexOf('#') + 1));
        expect(await d.ui('UI_GET_BLOCKED', {incidentId})).toMatchObject({state: 'NEW_BUILD'});
        const before = await d.background!();
        await new Promise(r => setTimeout(r, 35_000));
        const during = await d.background!();
        // Terminated mid-job, the event page loses the job (listed as failed at the next start)
        // instead of finishing it.
        expect(during.starts, 'the event page restarted during the job').toBe(before.starts);
        fx.github.release();
        await poll(
          'the blocked page to reload the vault',
          () => d.tabUrl(tab),
          u => u === url,
          120_000,
        );
        const t = await waitForState(
          d,
          tab,
          'VERIFIED',
          s => s.top?.binding?.buildId === VW_BUILD && allScriptsOk(s),
          60_000,
        );
        expect(t.top!.binding).toMatchObject({source: 'deep-verify'});
        // The manifest is stored, not bundled: an event page that starts again reads it back
        // from IndexedDB while it holds the response that woke it.
        const stopped = await poll(
          'the event page to stop after the job',
          () => d.background!(),
          b => b.state === 'stopped',
          60_000,
        );
        const second = await d.open(url);
        const s = await waitForState(
          d,
          second,
          'VERIFIED',
          x => x.top?.binding?.buildId === VW_BUILD && allScriptsOk(x),
          60_000,
        );
        expect(s.top!.binding).toMatchObject({source: 'deep-verify'});
        const woken = await d.background!();
        expect(woken.starts).toBeGreaterThan(stopped.starts);
        return [
          `event page during the 35 s held download: ${before.state} (starts ${before.starts}) → ${during.state} (starts ${during.starts})`,
          `after the download, reloaded by the blocked page: ${summary(t)}`,
          `event page ${stopped.state} (starts ${stopped.starts}); the vault in a second tab woke it (starts ${woken.starts}): ${summary(s)}`,
          await expectPrivateStorage(d),
        ];
      } finally {
        fx.github.release();
      }
    },
  },
  {
    id: 'release-package',
    title:
      'The shipping package (production build, no test overlay, no bundled cores): its toolbar ' +
      'button is pinned after the install; Vaultwarden instance added through the options page ' +
      '→ deep verify from the GitHub mirror → VERIFIED; Bitwarden cloud → deep verify with the ' +
      'config files from raw.githubusercontent.com (no host permission) → VERIFIED; the ' +
      'tampered Bitwarden main script is denied after its release is deep-verified',
    pkg: 'release',
    async run(d, fx) {
      const status = await d.ui('UI_GET_ONBOARDING', {});
      expect(status.permissions.map(p => p.pattern)).not.toContain('http://127.0.0.1/*');
      // The manifest's `default_area`: a fresh install has the state icon on the toolbar.
      expect(status.pinned).toBe(true);
      expect((await d.ui('UI_GET_TRUST', {})).cores).toEqual([]);
      const confirmed = await d.addInstanceInOptions!(`${fx.vaultwarden.origin}/`);
      const tab = await d.open(`${fx.vaultwarden.origin}/`);
      const t = await waitForState(
        d,
        tab,
        'VERIFIED',
        s => settled(s) && s.top?.binding?.buildId === VW_BUILD,
        180_000,
      );
      expect(t.top!.binding).toMatchObject({source: 'deep-verify', assurance: 'release-exact'});
      const core = (await d.ui('UI_GET_TRUST', {})).cores.find(c => c.buildId === VW_BUILD);
      expect(core?.sha256).toBe(GOLDEN_CORES[VW_BUILD]);
      // Bitwarden cloud: both regions are derived from the release zip and the config files on
      // raw, which the shipping package reads without a host permission (raw sends CORS headers).
      const rawSeen = fx.github.requests.length;
      const cloudTab = await d.open(`${fx.bitwardenCloud.origin}/`);
      const c = await waitForState(
        d,
        cloudTab,
        'VERIFIED',
        s => settled(s) && s.top?.binding?.buildId === BW_CLOUD_US,
        180_000,
      );
      expect(c.top!.binding).toMatchObject({source: 'deep-verify', assurance: 'release-derived'});
      const cloudCore = (await d.ui('UI_GET_TRUST', {})).cores.find(x => x.buildId === BW_CLOUD_US);
      expect(cloudCore?.sha256).toBe(GOLDEN_CORES[BW_CLOUD_US]);
      const raw = fx.github.requests
        .slice(rawSeen)
        .filter(r => r.host === 'raw.githubusercontent.com');
      expect(raw.map(r => `${r.status} ${r.path.split('/').pop()}`).sort()).toEqual([
        '200 base.json',
        '200 cloud.json',
        '200 euprd.json',
      ]);
      await addInstance(d, fx.bitwardenTampered);
      const bad = await d.open(`${fx.bitwardenTampered.origin}/`);
      const m = await waitForState(d, bad, 'MISMATCH', () => true, 180_000);
      expect(m.reasons).toContain('bytes');
      expect(m.top!.binding).toMatchObject({buildId: BW_BUILD, source: 'deep-verify'});
      expect(await d.ran(bad, TAMPER_MARKER)).toBe(false);
      return [
        'fresh install: the toolbar button is pinned',
        `options page: confirmations [${confirmed.join(', ')}]; ${summary(t)}`,
        `deep-verified core ${VW_BUILD} sha256 ${core!.sha256} (= golden)`,
        `Bitwarden cloud: ${summary(c)}; core sha256 ${cloudCore!.sha256} (= golden); raw: ${raw.map(r => `${r.status} ${r.path}`).join(', ')}`,
        expectPrivateGitHub(fx.github.requests.slice(rawSeen), [fx.bitwardenCloud.origin]),
        `tampered Bitwarden: ${summary(m)}; the script never ran`,
        await expectPrivateStorage(d),
      ];
    },
  },
];
