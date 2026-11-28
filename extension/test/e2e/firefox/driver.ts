/**
 * The browser of the e2e suite: an official Firefox (tools/e2e/browsers.ts, pinned by sha256)
 * driven by geckodriver through selenium-webdriver, headless,
 * with the test package installed as a temporary add-on in a fresh profile per scenario.
 *
 * - Both binaries are passed explicitly, so Selenium Manager (which would download drivers and
 *   browsers by itself) never runs.
 * - geckodriver runs with `--allow-system-access`: current Marionette refuses every
 *   command in a privileged browsing context, and extension pages are privileged. Nothing else
 *   uses it except `consoleMessages()` (chrome context, diagnostics only).
 * - The control tab is the onboarding page the extension opens at install;
 *   `extensions.webextensions.uuids` fixes the add-on's UUID so its URLs are known. Every page →
 *   background message is sent from that extension page with `browser.runtime.sendMessage`,
 *   exactly as the extension's own pages do. State is read through those messages and
 *   `browser.storage`, never through a test hook.
 * - Vault tabs start on about:blank (an unambiguous window handle even when a page opens another
 *   tab) and then load the vault through WebDriver navigation, as typing the URL does. In a vault
 *   tab WebDriver runs page scripts only to read or set a marker or to do what the page itself
 *   would do (each helper says what it imitates).
 * - The toolbar popup and the blocked page are driven through their own buttons (`popup`,
 *   `proceedOnce`).
 * - Host permissions: Firefox MV3 lets users withhold them, so the onboarding page's "Grant" button
 *   is clicked (a WebDriver click is user input; `extensions.webextOptionalPermissionPrompts`
 *   false answers the prompt) when a required pattern is missing, and an instance's pattern
 *   (`matchPatternFor`, as the options page requests it) is requested from a click handler before
 *   UI_ADD_INSTANCE. `addInstanceInOptions` drives the options page's own form instead.
 * - Network: every non-loopback request goes through the CONNECT proxy of server/proxy.ts, which
 *   tunnels only the GitHub hosts, the payment hosts, vault.bitwarden.com and the framing site to
 *   local emulators (TLS with a throw-away certificate, accepted through `acceptInsecureCerts`) and
 *   refuses everything else.
 *   Fixture sites are on loopback, which Firefox never proxies.
 * - `alerts.useSystemBackend` false keeps notifications listed (headless Linux has no notification
 *   service); `devtools.console.stdout.content` puts the extension's console output into the
 *   per-scenario log (`logDir`). */

import {mkdirSync, openSync} from 'node:fs';
import {join} from 'node:path';
import webdriver from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import type {MessageRequest, MessageResponse, MessageType, Reply} from '../../../src/contracts.ts';
import {matchPatternFor} from '../../../src/deployments/serverAddress.ts';
import type {
  CspReport,
  E2EDriver,
  FrameState,
  PackageKind,
  PageFetchResult,
  PageWorkers,
  PopupHandle,
} from '../scenarios.ts';

/** Fixed add-on UUID of the e2e profile (prefs `extensions.webextensions.uuids`). */
export const E2E_UUID = '6f1c2a8e-9b47-4d3a-8e21-1c5b7a90e2e5';
const ADDON_ID = 'intactwarden@phawrylak';

export interface RealFirefoxOptions {
  readonly firefoxBin: string;
  readonly geckodriverBin: string;
  readonly packages: Readonly<Record<PackageKind, string>>;
  /** Port of the CONNECT proxy (server/proxy.ts). */
  readonly proxyPort: number;
  readonly headless?: boolean;
  /**
   * Where geckodriver's and Firefox's output goes (with `devtools.console.stdout.content`, the
   * extension's console calls); one file per install, named by `logName`. Default: discarded.
   */
  readonly logDir?: string;
}

/** Profile preferences of the e2e browser. */
export function e2ePrefs(proxyPort: number): Record<string, string | number | boolean> {
  return {
    'extensions.webextensions.uuids': JSON.stringify({[ADDON_ID]: E2E_UUID}),
    'extensions.webextOptionalPermissionPrompts': false,
    'extensions.update.enabled': false,
    // Every non-loopback request goes to the e2e proxy (loopback is never proxied).
    'network.proxy.type': 1,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': proxyPort,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': proxyPort,
    'network.proxy.share_proxy_settings': false,
    'network.proxy.allow_hijacking_localhost': false,
    // No background traffic: the proxy would refuse it anyway.
    'app.update.disabledForTesting': true,
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    'browser.safebrowsing.downloads.enabled': false,
    'browser.safebrowsing.blockedURIs.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.newtabpage.enabled': false,
    // No Nimbus rollouts or studies from the bundled recipes: one of them makes Firefox try to
    // install a newer newtab add-on from archive.mozilla.org (refused by the proxy), and the runs
    // where it did showed the extension's own requests stalling for tens of seconds.
    'nimbus.rollouts.enabled': false,
    'app.shield.optoutstudies.enabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    // The extension's console output (background and pages) on stdout, into the scenario log.
    'devtools.console.stdout.content': true,
    // Headless Linux has no system notification service: without the built-in alert windows a
    // notification closes at once and notifications.getAll() never lists it.
    'alerts.useSystemBackend': false,
  };
}

type Driver = webdriver.WebDriver & {
  installAddon(path: string, temporary: boolean): Promise<string>;
};

/** Runs in the control tab (an extension page): one runtime message, answered with the Reply. */
const SEND_SCRIPT = `
const message = arguments[0];
const done = arguments[arguments.length - 1];
const api = typeof browser !== 'undefined' ? browser : window.wrappedJSObject.browser;
api.runtime.sendMessage(message).then(
  reply => done({sent: true, reply}),
  error => done({sent: false, error: String(error)}),
);`;

/** Runs in the control tab: an extension API call by path, e.g. ['tabs', 'get'] with args. */
const API_SCRIPT = `
const [path, args] = [arguments[0], arguments[1]];
const done = arguments[arguments.length - 1];
const api = typeof browser !== 'undefined' ? browser : window.wrappedJSObject.browser;
let target = api;
for (const p of path.slice(0, -1)) target = target[p];
Promise.resolve()
  .then(() => target[path[path.length - 1]](...args))
  .then(value => done({ok: true, value}), error => done({ok: false, error: String(error)}));`;

/**
 * Runs in a vault tab: appends `<script src=path>` to the document, as webpack's chunk loader does
 * for a lazy chunk (a same-origin `script` request), and answers with its load or error event.
 */
const PAGE_SCRIPT = `
const done = arguments[arguments.length - 1];
const s = document.createElement('script');
s.src = arguments[0];
s.onload = () => done('load');
s.onerror = () => done('error');
document.head.appendChild(s);`;

/**
 * Runs in a vault tab: one `fetch` of a same-origin path, as the app's i18n service reads a locale
 * (`no-store`, so each call is a request the extension sees), answered with the status, the start
 * of the body (4 KiB), its length and the response headers the page sees.
 */
const PAGE_FETCH_SCRIPT = `
const done = arguments[arguments.length - 1];
fetch(arguments[0], {cache: 'no-store'}).then(
  r => {
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    r.text().then(
      body => done({status: r.status, body: body.slice(0, 4096), size: body.length, headers}),
      e => done({status: r.status, body: 'error: ' + e, size: 0, headers}),
    );
  },
  e => done({status: 0, body: 'error: ' + e, size: 0, headers: {}}),
);`;

/**
 * Runs in a vault tab: an inline `<script>` and an element with an inline event handler,
 * inserted after load as a DOM injection would (each sets its marker if it runs).
 */
const PAGE_INJECT_SCRIPT = `
const [scriptMarker, attrMarker] = [arguments[0], arguments[1]];
const s = document.createElement('script');
s.textContent = 'self.' + scriptMarker + ' = true;';
document.body.appendChild(s);
const img = document.createElement('img');
img.setAttribute('onerror', 'self.' + attrMarker + ' = true');
img.src = 'data:,';
document.body.appendChild(img);`;

/**
 * Runs in a vault tab: the vault's "Add credit → PayPal" (its `payPalForm`: a plain form,
 * `method=post`, `target=_top`) with these hidden fields, submitted.
 */
const PAGE_POST_SCRIPT = `
const [action, fields] = [arguments[0], arguments[1]];
const form = document.createElement('form');
form.method = 'post';
form.target = '_top';
form.action = action;
for (const [name, value] of Object.entries(fields)) {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = value;
  form.appendChild(input);
}
document.body.appendChild(form);
form.submit();`;

/**
 * Runs in a vault tab: the vault's `launchUri` ("Add credit → BitPay" opens the invoice with it):
 * a hidden `<a target=_blank rel="noreferrer noopener">`, clicked and removed.
 */
const PAGE_LAUNCH_SCRIPT = `
const a = document.createElement('a');
a.href = arguments[0];
a.target = '_blank';
a.rel = 'noreferrer noopener';
a.classList.add('d-none');
document.body.appendChild(a);
a.click();
document.body.removeChild(a);`;

/**
 * Runs in a vault tab: an `<iframe>` of a same-origin page appended to the document, as the app's
 * two-step login frames its WebAuthn connector; answers with the first message the frame posts to
 * its parent (null when none came within 15 s).
 */
const PAGE_FRAME_SCRIPT = `
const done = arguments[arguments.length - 1];
const timer = setTimeout(() => done(null), 15000);
window.addEventListener('message', e => {
  if (e.origin !== location.origin) return;
  clearTimeout(timer);
  done(String(e.data));
});
const f = document.createElement('iframe');
f.src = arguments[0];
document.body.appendChild(f);`;

/**
 * Runs in a vault tab: an image from another origin and an inline `<script>` (which sets its
 * marker if it runs) inserted into the page; answers with the browser's CSP reports of the next
 * 1.5 s, each with the violated directive and the policy that reported it.
 */
const PAGE_CSP_SCRIPT = `
const done = arguments[arguments.length - 1];
const reports = [];
document.addEventListener('securitypolicyviolation', e => {
  reports.push({directive: e.effectiveDirective, policy: e.originalPolicy});
});
const img = document.createElement('img');
img.src = 'https://csp-probe.invalid/x.png';
document.body.appendChild(img);
const s = document.createElement('script');
s.textContent = 'self.' + arguments[0] + ' = true;';
document.body.appendChild(s);
setTimeout(() => done(reports), 1500);`;

/** Adds a button whose click handler requests host permissions (user input, as in the UI). */
const GRANT_BUTTON_SCRIPT = `
const origins = arguments[0];
const api = typeof browser !== 'undefined' ? browser : window.wrappedJSObject.browser;
const old = document.getElementById('iw-e2e-grant');
if (old) old.remove();
const button = document.createElement('button');
button.id = 'iw-e2e-grant';
button.textContent = 'grant';
button.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;width:80px;height:40px';
window.__iwGrant = null;
button.addEventListener('click', () => {
  api.permissions.request({origins}).then(
    granted => { window.__iwGrant = granted ? 'granted' : 'refused'; },
    error => { window.__iwGrant = 'error: ' + String(error); },
  );
});
document.body.appendChild(button);`;

/**
 * Runs in the chrome context: the extension's console calls (ConsoleAPIStorage, by add-on id) and
 * script errors that mention its pages (nsIConsoleService).
 */
const CONSOLE_SCRIPT = `
const [base, addonId] = [arguments[0], arguments[1]];
const out = [];
const show = v => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
};
try {
  const storage = Cc['@mozilla.org/consoleAPI-storage;1'].getService(Ci.nsIConsoleAPIStorage);
  for (const e of storage.getEvents()) {
    if (e.addonId !== addonId && !String(e.filename || '').startsWith(base)) continue;
    out.push('[' + e.level + '] ' + (e.arguments || []).map(show).join(' ') + ' @ ' + String(e.filename || '').slice(base.length) + ':' + e.lineNumber);
  }
} catch (e) {
  out.push('ConsoleAPIStorage unavailable: ' + e);
}
for (const m of Services.console.getMessageArray() || []) {
  if (!(m instanceof Ci.nsIScriptError)) continue;
  if (!String(m.sourceName || '').startsWith(base) && !String(m.errorMessage).includes(base)) continue;
  out.push('[' + (m.flags & 1 ? 'warning' : 'error') + '] ' + m.errorMessage + ' @ ' + String(m.sourceName).slice(base.length) + ':' + m.lineNumber);
}
return out.slice(-200);`;

/**
 * Runs in the chrome context: the event page's state (Extension.backgroundState) and the number of
 * background starts so far, counted by an observer this script installs on its first call.
 */
const BACKGROUND_SCRIPT = `
const id = arguments[0];
const policy = WebExtensionPolicy.getByID(id);
const ext = policy && policy.extension;
if (!ext) return {state: 'missing', starts: 0};
if (!ext.__iwE2eStarts) {
  ext.__iwE2eStarts = {n: 1};
  ext.on('background-script-started', () => { ext.__iwE2eStarts.n++; });
}
return {state: String(ext.backgroundState), starts: ext.__iwE2eStarts.n};`;

/**
 * Runs in the chrome context: what "Clear cookies and site data" in the address bar's site panel
 * does for the site of the host given (SiteDataManager.remove); answers an error text or null.
 */
const CLEAR_SITE_DATA_SCRIPT = `
const [host, done] = arguments;
const {SiteDataManager} = ChromeUtils.importESModule('resource:///modules/SiteDataManager.sys.mjs');
SiteDataManager.remove(SiteDataManager.getBaseDomainFromHost(host)).then(
  () => done(null),
  e => done(String(e)),
);`;

/** Runs in the page: its origin's service-worker registrations and whether a worker controls it. */
const PAGE_WORKERS_SCRIPT = `
const done = arguments[arguments.length - 1];
const sw = navigator.serviceWorker;
sw.getRegistrations().then(
  r => done({registrations: r.length, controlled: sw.controller !== null}),
  e => done({error: String(e)}),
);`;

export class RealFirefox implements E2EDriver {
  readonly baseUrl = `moz-extension://${E2E_UUID}/`;
  readonly #options: RealFirefoxOptions;
  #driver: Driver | null = null;
  /** Names the next install's log file (the scenario id). */
  logName = 'run';
  /** The log file of the current install, when logDir is set. */
  logFile: string | null = null;
  #control = '';
  readonly #handles = new Map<number, string>();

  constructor(options: RealFirefoxOptions) {
    this.#options = options;
  }

  get #d(): Driver {
    if (this.#driver === null) throw new Error('firefox: not started');
    return this.#driver;
  }

  async install(
    pkg: PackageKind,
    prefs: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<void> {
    const options = new firefox.Options().setBinary(this.#options.firefoxBin);
    if (this.#options.headless !== false) options.addArguments('-headless');
    for (const [k, v] of Object.entries({...e2ePrefs(this.#options.proxyPort), ...prefs})) {
      options.setPreference(k, v);
    }
    options.setAcceptInsecureCerts(true);
    // Marionette refuses every command in a privileged browsing context (extension pages are
    // one) unless system access is allowed; the control tab is an extension page.
    const service = new firefox.ServiceBuilder(this.#options.geckodriverBin).addArguments(
      '--allow-system-access',
    );
    if (this.#options.logDir !== undefined) {
      mkdirSync(this.#options.logDir, {recursive: true});
      this.logFile = join(this.#options.logDir, `firefox-${this.logName}.log`);
      const fd = openSync(this.logFile, 'w');
      service.setStdio(['ignore', fd, fd]);
    }
    this.#driver = (await new webdriver.Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(service)
      .build()) as Driver;
    await this.#d.manage().setTimeouts({script: 120_000, pageLoad: 120_000});
    this.#handles.clear();
    const before = new Set(await this.#d.getAllWindowHandles());
    await this.#d.installAddon(this.#options.packages[pkg], true);
    // The control tab is the onboarding page the extension opens by itself at install
    // (runtime.onInstalled → tabs.create).
    this.#control = await this.#awaitOwnTab(before, 'ui/onboarding.html');
    const until = Date.now() + 30_000;
    for (;;) {
      const r = await this.#send('UI_GET_SETTINGS', {}).catch(() => null);
      if (r?.ok === true) break;
      if (Date.now() > until) throw new Error('firefox: the background never answered');
      await new Promise(res => setTimeout(res, 250));
    }
    await this.#grantRequiredHosts();
  }

  /** The new window handle that shows `page` of the extension (opened by the extension). */
  async #awaitOwnTab(before: ReadonlySet<string>, page: string): Promise<string> {
    const want = `${this.baseUrl}${page}`;
    const until = Date.now() + 30_000;
    for (;;) {
      for (const h of await this.#d.getAllWindowHandles()) {
        if (before.has(h)) continue;
        await this.#d.switchTo().window(h);
        const url = await this.#d.getCurrentUrl();
        if (url.startsWith(want)) return h;
      }
      if (Date.now() > until) throw new Error(`firefox: the extension never opened ${page}`);
      await new Promise(res => setTimeout(res, 250));
    }
  }

  async uninstall(): Promise<void> {
    const d = this.#driver;
    this.#driver = null;
    await d?.quit().catch(() => undefined);
  }

  /** Navigates the control tab (an extension page) to another page of the extension. */
  async #openControl(page: string): Promise<void> {
    await this.#d.switchTo().window(this.#control);
    const url = `${this.baseUrl}${page}`;
    await this.#d.executeScript('location.href = arguments[0];', url);
    const until = Date.now() + 30_000;
    for (;;) {
      const now = await this.#d.getCurrentUrl().catch(() => '');
      const ready = await this.#d
        .executeScript<string>('return document.readyState;')
        .catch(() => '');
      if (now === url && ready === 'complete') return;
      if (Date.now() > until) throw new Error(`firefox: the control tab never showed ${page}`);
      await new Promise(res => setTimeout(res, 100));
    }
  }

  async #inControl<T>(script: string, ...args: unknown[]): Promise<T> {
    await this.#d.switchTo().window(this.#control);
    return this.#d.executeAsyncScript<T>(script, ...args);
  }

  async #send<T extends MessageType>(type: T, payload: MessageRequest<T>): Promise<Reply<T>> {
    const r = await this.#inControl<{sent: boolean; reply?: Reply<T>; error?: string}>(
      SEND_SCRIPT,
      {iw: 1, type, payload},
    );
    if (!r.sent || r.reply === undefined) throw new Error(`${type}: ${r.error ?? 'no reply'}`);
    return r.reply;
  }

  /** An extension API call from the control tab (diagnostics and driver internals). */
  api<T>(path: readonly string[], ...args: unknown[]): Promise<T> {
    return this.#api<T>(path, ...args);
  }

  /**
   * Browser console messages that mention the extension (its warnings, errors and CSP
   * reports), read through the chrome context: diagnostics for a failed scenario.
   */
  async consoleMessages(): Promise<string[]> {
    const d = this.#d as Driver & {setContext(c: string): Promise<void>};
    await d.setContext(firefox.Context.CHROME);
    try {
      return await d.executeScript<string[]>(CONSOLE_SCRIPT, this.baseUrl, ADDON_ID);
    } finally {
      await d.setContext(firefox.Context.CONTENT);
    }
  }

  async background(): Promise<{state: string; starts: number}> {
    const d = this.#d as Driver & {setContext(c: string): Promise<void>};
    await d.setContext(firefox.Context.CHROME);
    try {
      return await d.executeScript<{state: string; starts: number}>(BACKGROUND_SCRIPT, ADDON_ID);
    } finally {
      await d.setContext(firefox.Context.CONTENT);
    }
  }

  async pageWorkers(tab: number): Promise<PageWorkers> {
    await this.#inTab(tab);
    const r = await this.#d.executeAsyncScript<PageWorkers & {error?: string}>(PAGE_WORKERS_SCRIPT);
    if (r.error !== undefined) throw new Error(`firefox: the page's service workers: ${r.error}`);
    return {registrations: r.registrations, controlled: r.controlled};
  }

  async clearSiteData(origin: string): Promise<void> {
    const d = this.#d as Driver & {setContext(c: string): Promise<void>};
    await d.setContext(firefox.Context.CHROME);
    try {
      const host = new URL(origin).hostname;
      const error = await d.executeAsyncScript<string | null>(CLEAR_SITE_DATA_SCRIPT, host);
      if (error !== null) throw new Error(`firefox: clearing the site data of ${host}: ${error}`);
    } finally {
      await d.setContext(firefox.Context.CONTENT);
    }
  }

  async #api<T>(path: readonly string[], ...args: unknown[]): Promise<T> {
    const r = await this.#inControl<{ok: boolean; value?: T; error?: string}>(
      API_SCRIPT,
      path,
      args,
    );
    if (!r.ok) throw new Error(`browser.${path.join('.')}: ${r.error}`);
    return r.value as T;
  }

  /** Requests host permissions from a click handler in the control tab (WebDriver click). */
  async #grant(origins: readonly string[]): Promise<void> {
    await this.#d.switchTo().window(this.#control);
    await this.#d.executeScript(GRANT_BUTTON_SCRIPT, origins);
    await this.#d.findElement(webdriver.By.id('iw-e2e-grant')).click();
    const until = Date.now() + 15_000;
    for (;;) {
      const r = await this.#d.executeScript<string | null>('return window.__iwGrant;');
      if (r === 'granted') return;
      if (r !== null) throw new Error(`permissions.request(${origins.join(', ')}): ${r}`);
      if (Date.now() > until) throw new Error('permissions.request never answered');
      await new Promise(res => setTimeout(res, 100));
    }
  }

  /** Onboarding: the Grant button requests every required pattern that is missing. */
  async #grantRequiredHosts(): Promise<void> {
    const status = await this.ui('UI_GET_ONBOARDING', {});
    if (status.permissions.every(p => p.granted)) return;
    const missing = await this.grantFromOnboarding();
    if (missing.length > 0) throw new Error(`onboarding could not grant: ${missing.join(', ')}`);
    await this.#openControl('ui/options.html');
  }

  async grantFromOnboarding(): Promise<readonly string[]> {
    await this.#openControl('ui/onboarding.html');
    // The page re-renders its permission list when the status arrives (and when a permission
    // changes), which can replace the button between locating and clicking it: locate it again
    // after a stale reference instead of failing the scenario.
    for (let attempt = 0; ; attempt++) {
      const button = await this.#d.wait(
        webdriver.until.elementLocated(webdriver.By.css('#permissions .actions button')),
        15_000,
      );
      try {
        await button.click();
        break;
      } catch (err) {
        if (!(err instanceof webdriver.error.StaleElementReferenceError) || attempt >= 4) throw err;
        await new Promise(res => setTimeout(res, 200));
      }
    }
    const until = Date.now() + 15_000;
    for (;;) {
      const now = await this.ui('UI_GET_ONBOARDING', {});
      const missing = now.permissions.filter(p => !p.granted).map(p => p.pattern);
      if (missing.length === 0 || Date.now() > until) return missing;
      await new Promise(res => setTimeout(res, 250));
    }
  }

  async closeTab(tab: number): Promise<void> {
    await this.#api(['tabs', 'remove'], tab);
    this.#handles.delete(tab);
  }

  async revokeHosts(patterns: readonly string[]): Promise<void> {
    const removed = await this.#api<boolean>(['permissions', 'remove'], {origins: [...patterns]});
    if (!removed) throw new Error(`permissions.remove(${patterns.join(', ')}) refused`);
  }

  async grantHosts(patterns: readonly string[]): Promise<void> {
    await this.#grant(patterns);
  }

  async addInstanceInOptions(input: string): Promise<readonly string[]> {
    await this.#openControl('ui/options.html');
    const {By, until} = webdriver;
    const field = await this.#d.wait(until.elementLocated(By.css('#instance-origin')), 15_000);
    await field.clear();
    await field.sendKeys(input);
    // "Add server": its click handler requests the origin's host permission first (no prompt in
    // the e2e profile), then adds; a look-alike host asks for a confirmation and a second click.
    const confirmed: string[] = [];
    const origin = new URL(input).origin;
    const deadline = Date.now() + 30_000;
    await this.#d.findElement(By.css('.add-instance .row .btn-primary')).click();
    for (;;) {
      const list = await this.#send('UI_LIST_INSTANCES', {});
      if (list.ok && list.value.some(i => i.record.origin === origin)) break;
      const boxes = await this.#d.findElements(By.css('.add-instance #confirm-lookalike'));
      if (boxes.length > 0 && !confirmed.includes('lookalike')) {
        confirmed.push('lookalike');
        await boxes[0]!.click();
        await this.#d.findElement(By.css('.add-instance .row .btn-primary')).click();
      } else if (boxes.length === 0) {
        const errors = await this.#d.findElements(
          By.css('.add-instance .notice-red[role="alert"]'),
        );
        if (errors.length > 0) throw new Error(`options page: ${await errors[0]!.getText()}`);
      }
      if (Date.now() > deadline) throw new Error('options page: the instance was never added');
      await new Promise(res => setTimeout(res, 100));
    }
    return confirmed;
  }

  async ui<T extends MessageType>(
    type: T,
    payload: MessageRequest<T>,
  ): Promise<MessageResponse<T>> {
    if (type === 'UI_ADD_INSTANCE') {
      // As the options page's "Add server": the click handler requests the host permission first
      // (permissions.request must be its first await), then adds.
      const input = (payload as MessageRequest<'UI_ADD_INSTANCE'>).input;
      await this.#grant([matchPatternFor(new URL(input).origin)]);
    }
    const r = await this.#send(type, payload);
    if (!r.ok) throw new Error(`${type}: ${r.error}`);
    return r.value;
  }

  /**
   * A new tab, then the URL loaded in it as a user would (WebDriver navigation, like typing it
   * into the address bar). The tab starts on about:blank so its window handle is unambiguous
   * even when a page opens another tab during the load.
   */
  async open(url: string): Promise<number> {
    const before = new Set(await this.#d.getAllWindowHandles());
    const tab = await this.#api<{id: number}>(['tabs', 'create'], {
      url: 'about:blank',
      active: true,
    });
    let handle: string | null = null;
    const until = Date.now() + 15_000;
    while (handle === null) {
      for (const h of await this.#d.getAllWindowHandles()) {
        if (before.has(h)) continue;
        await this.#d.switchTo().window(h);
        if ((await this.#d.getCurrentUrl()) === 'about:blank') handle = h;
      }
      if (handle === null && Date.now() > until) throw new Error('firefox: no handle for the tab');
      if (handle === null) await new Promise(res => setTimeout(res, 100));
    }
    this.#handles.set(tab.id, handle);
    await this.#d.switchTo().window(handle);
    // The extension may replace the document (the blocked page) while it loads.
    await this.#d.get(url).catch(() => undefined);
    const done = Date.now() + 120_000;
    for (;;) {
      const t = await this.#api<{status?: string; url?: string}>(['tabs', 'get'], tab.id);
      if (t.status === 'complete' && t.url !== 'about:blank') break;
      if (Date.now() > done) throw new Error(`firefox: ${url} never finished loading`);
      await new Promise(res => setTimeout(res, 200));
    }
    return tab.id;
  }

  async setHash(tab: number, hash: string): Promise<void> {
    const handle = this.#handles.get(tab);
    if (handle === undefined) throw new Error(`firefox: no handle for tab ${tab}`);
    await this.#d.switchTo().window(handle);
    await this.#d.executeScript('location.hash = arguments[0];', hash);
  }

  async pageScript(tab: number, path: string): Promise<'load' | 'error'> {
    const handle = this.#handles.get(tab);
    if (handle === undefined) throw new Error(`firefox: no handle for tab ${tab}`);
    await this.#d.switchTo().window(handle);
    return this.#d.executeAsyncScript<'load' | 'error'>(PAGE_SCRIPT, path);
  }

  async pageFetch(tab: number, path: string): Promise<PageFetchResult> {
    await this.#inTab(tab);
    return this.#d.executeAsyncScript<PageFetchResult>(PAGE_FETCH_SCRIPT, path);
  }

  async pageClick(tab: number, selector: string): Promise<void> {
    await this.#inTab(tab);
    const {By, until} = webdriver;
    await (await this.#d.wait(until.elementLocated(By.css(selector)), 15_000)).click();
  }

  async mark(tab: number, marker: string): Promise<void> {
    await this.#inTab(tab);
    await this.#d.executeScript('self[arguments[0]] = true;', marker);
  }

  async pageInject(tab: number, scriptMarker: string, attrMarker: string): Promise<void> {
    await this.#inTab(tab);
    await this.#d.executeScript(PAGE_INJECT_SCRIPT, scriptMarker, attrMarker);
  }

  async pageFrame(tab: number, src: string): Promise<string | null> {
    await this.#inTab(tab);
    return this.#d.executeAsyncScript<string | null>(PAGE_FRAME_SCRIPT, src);
  }

  async pageCspReports(tab: number, marker: string): Promise<readonly CspReport[]> {
    await this.#inTab(tab);
    return this.#d.executeAsyncScript<CspReport[]>(PAGE_CSP_SCRIPT, marker);
  }

  async frameState(tab: number, marker: string): Promise<FrameState> {
    // While Firefox replaces the frame's document (with its own error page, for example), the
    // script can come back with null: read the new document instead.
    for (let attempt = 1; ; attempt++) {
      await this.#inTab(tab);
      await this.#d.switchTo().frame(0);
      try {
        const state = await this.#d.executeScript<FrameState | null>(
          `return {
            ran: self[arguments[0]] === true,
            elements: document.querySelectorAll('*').length,
            error: (/^about:neterror\\?e=([^&]*)/.exec(document.documentURI) || [])[1] || null,
          };`,
          marker,
        );
        if (state !== null) return state;
      } finally {
        await this.#d.switchTo().defaultContent();
      }
      if (attempt === 20) throw new Error('frameState: the frame never returned its state');
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async frameClick(tab: number, selector: string): Promise<boolean> {
    await this.#inTab(tab);
    await this.#d.switchTo().frame(0);
    try {
      const [element] = await this.#d.findElements(webdriver.By.css(selector));
      if (element === undefined) return false;
      await element.click();
      return true;
    } finally {
      await this.#d.switchTo().defaultContent();
    }
  }

  async pagePost(tab: number, action: string, fields: Readonly<Record<string, string>>) {
    await this.#inTab(tab);
    await this.#d.executeScript(PAGE_POST_SCRIPT, action, fields);
  }

  async pageLaunch(tab: number, url: string): Promise<string> {
    const before = new Set(await this.#d.getAllWindowHandles());
    await this.#inTab(tab);
    await this.#d.executeScript(PAGE_LAUNCH_SCRIPT, url);
    // The new tab's URL as WebDriver sees it (tabs.query hides URLs without a host permission).
    const until = Date.now() + 15_000;
    for (;;) {
      for (const h of await this.#d.getAllWindowHandles()) {
        if (before.has(h)) continue;
        await this.#d.switchTo().window(h);
        const now = await this.#d.getCurrentUrl();
        if (now !== 'about:blank' && now !== '') return now;
      }
      if (Date.now() > until) throw new Error(`firefox: ${url} never opened in a new tab`);
      await new Promise(res => setTimeout(res, 200));
    }
  }

  async reload(tab: number): Promise<void> {
    await this.#inTab(tab);
    await this.#d.navigate().refresh();
    await this.#loaded(tab);
  }

  async reloadNow(tab: number): Promise<void> {
    await this.#inTab(tab);
    // After the script returns, so that WebDriver does not wait for the navigation it starts.
    await this.#d.executeScript('setTimeout(() => location.reload(), 0);');
  }

  async reloadTwice(tab: number, gapMs: number): Promise<void> {
    await this.#inTab(tab);
    // Both timers belong to the page that is shown now: the second fires only while the first
    // reload has not replaced that page.
    await this.#d.executeScript(
      'const gap = arguments[0];' +
        'setTimeout(() => location.reload(), 0); setTimeout(() => location.reload(), gap);',
      gapMs,
    );
  }

  async navigate(tab: number, url: string): Promise<void> {
    await this.#inTab(tab);
    await this.#d.get(url);
    await this.#loaded(tab);
  }

  async back(tab: number): Promise<void> {
    await this.#inTab(tab);
    await this.#d.navigate().back();
    await this.#loaded(tab);
  }

  async forward(tab: number): Promise<void> {
    await this.#inTab(tab);
    await this.#d.navigate().forward();
    await this.#loaded(tab);
  }

  async popup(tab: number): Promise<PopupHandle> {
    const url = `${this.baseUrl}ui/popup.html`;
    const before = new Set(await this.#d.getAllWindowHandles());
    // The popup in a background tab, loaded while `tab` is the active one (the tab its query
    // picks). Nothing touches WebDriver until it has rendered: switching to a window selects it.
    const created = await this.#inControl<{ok: boolean; value?: number; error?: string}>(
      `const [tab, url] = [arguments[0], arguments[1]];
const done = arguments[arguments.length - 1];
const api = typeof browser !== 'undefined' ? browser : window.wrappedJSObject.browser;
api.tabs.update(tab, {active: true})
  .then(() => api.tabs.create({url, active: false}))
  .then(t => done({ok: true, value: t.id}), e => done({ok: false, error: String(e)}));`,
      tab,
      url,
    );
    if (!created.ok || created.value === undefined) {
      throw new Error(`firefox: no popup tab: ${created.error ?? ''}`);
    }
    const popupTab = created.value;
    await new Promise(res => setTimeout(res, 2500));
    let handle: string | null = null;
    for (const h of await this.#d.getAllWindowHandles()) {
      if (before.has(h)) continue;
      await this.#d.switchTo().window(h);
      if ((await this.#d.getCurrentUrl()).startsWith(url)) handle = h;
    }
    if (handle === null) throw new Error('firefox: the popup tab has no window handle');
    const popupHandle = handle;
    const {By, until} = webdriver;
    const buttonXpath = (label: string): string =>
      `//button[normalize-space(.)=${JSON.stringify(label)}]`;
    const open = async (): Promise<boolean> =>
      (await this.#d.getAllWindowHandles()).includes(popupHandle);
    return {
      text: async () => {
        await this.#d.switchTo().window(popupHandle);
        await this.#d.wait(until.elementLocated(By.css('.state-title')), 15_000);
        return this.#d.executeScript<string>('return document.body.innerText;');
      },
      hasButton: async label => {
        await this.#d.switchTo().window(popupHandle);
        return (await this.#d.findElements(By.xpath(buttonXpath(label)))).length > 0;
      },
      click: async label => {
        await this.#d.switchTo().window(popupHandle);
        const button = await this.#d.wait(
          until.elementLocated(By.xpath(buttonXpath(label))),
          15_000,
        );
        // A button that closes the popup (window.close) may take the window with the click.
        await button.click().catch((e: unknown) => {
          if (!(e instanceof webdriver.error.NoSuchWindowError)) throw e;
        });
      },
      close: async () => {
        if (await open()) await this.#api(['tabs', 'remove'], popupTab).catch(() => undefined);
      },
    };
  }

  async proceedOnce(tab: number): Promise<void> {
    // The blocked page asks for the active tab when "Proceed once" is clicked; switching to the
    // tab's window selects it.
    await this.#inTab(tab);
    const {By, until} = webdriver;
    const box = await this.#d.wait(until.elementLocated(By.css('#confirm-proceed')), 15_000);
    await box.click();
    const button = await this.#d.wait(
      until.elementLocated(By.css('.proceed .actions button')),
      15_000,
    );
    await this.#d.wait(until.elementIsEnabled(button), 5000);
    await button.click();
  }

  /** Switches WebDriver to the tab's window (which selects the tab). */
  async #inTab(tab: number): Promise<void> {
    const handle = this.#handles.get(tab);
    if (handle === undefined) throw new Error(`firefox: no handle for tab ${tab}`);
    await this.#d.switchTo().window(handle);
  }

  /** Waits until the tab has finished loading (tabs.get status `complete`). */
  async #loaded(tab: number): Promise<void> {
    const done = Date.now() + 120_000;
    for (;;) {
      const t = await this.#api<{status?: string}>(['tabs', 'get'], tab);
      if (t.status === 'complete') return;
      if (Date.now() > done) throw new Error(`firefox: tab ${tab} never finished loading`);
      await new Promise(res => setTimeout(res, 200));
    }
  }

  async tabsWithUrl(url: string): Promise<readonly number[]> {
    const tabs = await this.#api<{id?: number; url?: string}[]>(['tabs', 'query'], {});
    return tabs.filter(t => t.url === url && t.id !== undefined).map(t => t.id!);
  }

  async ran(tab: number, marker: string): Promise<boolean> {
    const url = await this.tabUrl(tab);
    if (url === '' || url.startsWith('moz-extension:')) return false; // replaced by our page
    return this.#d.executeScript<boolean>('return self[arguments[0]] === true;', marker);
  }

  /** The tab's URL as WebDriver sees it (tabs.get hides it without a matching permission). */
  async tabUrl(tab: number): Promise<string> {
    const handle = this.#handles.get(tab);
    if (handle === undefined) return '';
    await this.#d.switchTo().window(handle);
    return this.#d.getCurrentUrl();
  }

  async notifications(): Promise<readonly {id: string; title: string}[]> {
    const all = await this.#api<Record<string, {title?: string}>>(['notifications', 'getAll']);
    return Object.entries(all).map(([id, n]) => ({id, title: n.title ?? ''}));
  }

  async extensionTabs(): Promise<readonly string[]> {
    // The control tab (onboarding or options) is the driver's, not the extension's.
    const control = [`${this.baseUrl}ui/onboarding.html`, `${this.baseUrl}ui/options.html`];
    const tabs = await this.#api<{url?: string}[]>(['tabs', 'query'], {});
    return tabs
      .map(t => t.url ?? '')
      .filter(u => u.startsWith(this.baseUrl) && !control.some(c => u.startsWith(c)));
  }

  async storageDump(): Promise<{local: Record<string, unknown>; session: Record<string, unknown>}> {
    const local = await this.#api<Record<string, unknown>>(['storage', 'local', 'get'], null);
    const session = await this.#api<Record<string, unknown>>(['storage', 'session', 'get'], null);
    return {local, session};
  }
}
