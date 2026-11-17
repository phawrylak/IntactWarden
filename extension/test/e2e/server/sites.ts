/**
 * Hosting emulators for self-hosted web vaults on http://127.0.0.1:<port> (plain http is accepted
 * for loopback hosts only), replaying real release files:
 *
 * - `bitwarden-selfhost`: the release zip below `build/`, `/` and
 *   directory indexes, a 301 for a directory without its slash (ASP.NET Core DefaultFiles; server
 *   realism only: the header guard cancels such a redirect unless it targets the base path), the
 *   build's `404.html` for anything else, `/api/config` with `server: null`, and the headers of the
 *   self-host nginx template (CSP, X-Frame-Options, nosniff). Variants: the main script gets one
 *   appended statement (`tamper: 'main-js'`; `'sm-chunk'` does the same to the Secrets Manager chunk
 *   541), or `index.html` an injected inline script and inline
 *   event handler (`tamper: 'inline-script'`), served without the server's CSP as a compromised
 *   server would, so only IntactWarden's CSP floor stands in the way. `revalidate` answers a
 *   request whose `If-None-Match` names the file's ETag with 304.
 * - `vaultwarden-rocket`: the tarball below `web-vault/` at a base path, `/` → index.html
 *   (`public, max-age=600`), `<base>index.html` → 303 to the base path, static files
 *   `public, immutable, max-age=604800` without ETag, dotfile and unknown paths → a server-rendered
 *   404, a generated stock `/css/vaultwarden.css` (`public, no-cache`, ETag = sha256), `/api/config`
 *   with `server.name: "Vaultwarden"` and `environment.vault`, `/vw-version.json` and `/alive`. The
 *   `inline-script` variant drops the CSP header, like the Bitwarden one; at a sub-path, the base
 *   path without its slash gets the 301 of the reverse proxy in front; `bitwardenSmChunk` also
 *   serves Bitwarden's Secrets Manager chunk 541 (with a marker statement appended);
 *   `forged-pagehide` and `blob-trampoline` serve an attacker page at ATTACKER_PAGE (one forges
 *   `pagehide` and frames the vault, one moves its tab to a `blob:` page it made, with a link to the
 *   vault); `localeStatus` answers the listed `/locales/en/messages.json` with that status and other bytes;
 *   `holdWasm` holds each `.wasm` response halfway for 4 s (`'gzip'`: gzip-coded); `link` adds a `Link` header (a script on
 *   another origin and a listed file, both `rel=preload`) to every response; `framed` answers a
 *   frame's load of the vault document with an attacker document; `serviceWorker` serves a page
 *   that registers a service worker, which then answers the vault document or its main script.
 * - the framing site (`framingSite`): another site whose page frames the URL it is given.
 */

import {createHash} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {gzipSync} from 'node:zlib';
import {VAULTWARDEN_STOCK_HIDE_SELECTORS} from '@intactwarden/core/style/serverStyle.ts';
import {deriveCloudFiles} from '../../../../packages/builders/test/helpers/cloudFiles.ts';
import {fetchPinned} from '../../../../tools/corpus.ts';
import {contentTypeOf, listen, pathOf, send, type Handler, type Listening} from './http.ts';
import {
  bitwardenRelease,
  chunkPath,
  injectInlineScript,
  SM_TAMPER_MARKER,
  tamperScript,
  vaultwardenRelease,
  type SiteFiles,
} from './releases.ts';

export type BitwardenTamper =
  | 'none'
  | 'main-js'
  | 'inline-script'
  /** The main script answers 302 to another origin (an attacker's copy). */
  | 'script-redirect'
  /** index.html carries `Refresh: 0; url=<another origin>`. */
  | 'refresh'
  /** The Secrets Manager chunk 541 gets one appended statement (setting SM_TAMPER_MARKER). */
  | 'sm-chunk';

export interface Site extends Listening {
  /** Files the site serves (after tampering). */
  readonly files: SiteFiles;
  /** Path of the main script (`/app/main.<hash>.js`) named by index.html. */
  readonly mainScript: string;
  readonly basePath: string;
  /** The request handler (also mounted behind the TLS endpoint for an official origin). */
  readonly handler: Handler;
  /** The attacker origin a `script-redirect` or `refresh` variant points to. */
  readonly evilOrigin?: string;
  /** The identity provider the `blob-trampoline` variant's OIDC sign-in path redirects to. */
  readonly idpOrigin?: string;
  /** `holdWasm`, `holdDocument`: how many held responses have started (each is held halfway). */
  readonly heldResponses?: () => number;
  /** `holdDocument`: how many held responses the browser cut off before they ended. */
  readonly abortedResponses?: () => number;
  /** `framed`: how many frame loads of the vault document got an attacker document. */
  readonly framedLoads?: () => number;
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** `app/main.<20 hex>.js` named by a release index.html. */
export function mainScriptOf(indexHtml: Uint8Array): string {
  const html = new TextDecoder().decode(indexHtml);
  const marker = 'src="app/main.';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('index.html names no app/main.<hash>.js');
  const end = html.indexOf('"', at + 5);
  return `/${html.slice(at + 5, end)}`;
}

const BITWARDEN_SELFHOST_HEADERS = (origin: string): Record<string, string> => ({
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-xss-protection': '1; mode=block',
  'x-frame-options': 'SAMEORIGIN',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https://haveibeenpwned.com; media-src 'self' https://assets.bitwarden.com; " +
    "child-src 'self' https://*.duosecurity.com https://*.duofederal.com; " +
    "frame-src 'self' https://*.duosecurity.com https://*.duofederal.com; " +
    `connect-src 'self' ${origin.replace(/^http/, 'ws')} https://api.pwnedpasswords.com https://api.2fa.directory; ` +
    "object-src 'self' blob:;",
});

function isHashed(path: string): boolean {
  return /\.[0-9a-f]{20}\.(js|css|json|wasm)$/.test(path) || /\/[0-9a-f]{20}\./.test(path);
}

/** A Bitwarden self-hosted web vault at `/` (release zip, optionally tampered). */
export async function startBitwardenSelfhost(
  options: {
    tamper?: BitwardenTamper;
    /**
     * Answers a request whose `If-None-Match` names the file's ETag with 304: the validator and
     * `Cache-Control`, no body and none of the other headers (RFC 9110, 15.4.5).
     */
    revalidate?: boolean;
  } = {},
): Promise<Site> {
  const release = await bitwardenRelease();
  const files = new Map(release.files);
  const mainScript = mainScriptOf(files.get('/index.html')!);
  if (mainScript !== `/${release.lock.selfhosted.main_name}`) {
    throw new Error(
      `index.html names ${mainScript}, the lock ${release.lock.selfhosted.main_name}`,
    );
  }
  if (options.tamper === 'main-js') files.set(mainScript, tamperScript(files.get(mainScript)!));
  if (options.tamper === 'sm-chunk') {
    const sm = chunkPath(files, 541);
    files.set(sm, tamperScript(files.get(sm)!, SM_TAMPER_MARKER));
  }
  if (options.tamper === 'inline-script') {
    files.set('/index.html', injectInlineScript(files.get('/index.html')!));
  }
  const evil =
    options.tamper === 'script-redirect' || options.tamper === 'refresh'
      ? await startEvilOrigin()
      : null;
  let origin = '';
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = pathOf(req);
    const common = BITWARDEN_SELFHOST_HEADERS(origin);
    if (options.tamper === 'inline-script') delete common['content-security-policy'];
    if (evil !== null && options.tamper === 'script-redirect' && path === mainScript) {
      send(res, 302, {...common, location: `${evil.origin}/main.js`});
      return;
    }
    if (evil !== null && options.tamper === 'refresh' && (path === '/' || path === '/index.html')) {
      common['refresh'] = `0; url=${evil.origin}/`;
    }
    if (path === '/api/config') {
      send(
        res,
        200,
        {...common, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'},
        JSON.stringify({
          version: '2026.10.0',
          gitHash: '0000000',
          server: null,
          environment: {
            cloudRegion: null,
            vault: origin,
            api: `${origin}/api`,
            identity: `${origin}/identity`,
            notifications: `${origin}/notifications`,
            sso: `${origin}/sso`,
          },
          featureStates: {},
          object: 'config',
        }),
      );
      return;
    }
    if (path.startsWith('/api/') || path.startsWith('/identity/')) {
      send(res, 404, {...common, 'content-type': 'application/json'}, '{"message":"Not found"}');
      return;
    }
    // The admin portal (a server-rendered page of its own) sends a visitor without a session to its
    // login page, as the Bitwarden server's admin does.
    if (path === '/admin' || path === '/admin/') {
      send(res, 302, {...common, location: '/admin/login', 'cache-control': 'no-store'});
      return;
    }
    if (path === '/admin/login') {
      send(
        res,
        200,
        {...common, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
        BITWARDEN_ADMIN_LOGIN,
      );
      return;
    }
    let file = path.endsWith('/') ? `${path}index.html` : path;
    if (!files.has(file) && files.has(`${path}/index.html`)) {
      send(res, 301, {...common, location: `${path}/`});
      return;
    }
    const bytes = files.get(file);
    if (bytes === undefined) {
      file = '/404.html';
      send(
        res,
        404,
        {...common, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache'},
        files.get(file)!,
      );
      return;
    }
    const etag = `"${sha256(bytes).slice(0, 32)}"`;
    const cacheControl = isHashed(file) ? 'public, max-age=604800' : 'no-cache';
    if (options.revalidate === true && req.headers['if-none-match'] === etag) {
      send(res, 304, {'cache-control': cacheControl, etag});
      return;
    }
    send(
      res,
      200,
      {...common, 'content-type': contentTypeOf(file), 'cache-control': cacheControl, etag},
      bytes,
    );
  };
  const site = await listen(handler);
  origin = site.origin;
  return {
    ...site,
    files,
    mainScript,
    basePath: '/',
    handler,
    ...(evil !== null ? {evilOrigin: evil.origin} : {}),
    close: async () => {
      await site.close();
      await evil?.close();
    },
  };
}

/** The Bitwarden server's admin login page (server-rendered, in no web vault release). */
const BITWARDEN_ADMIN_LOGIN =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Bitwarden System Administration Portal</title>' +
  '</head><body><main><h1>Log in</h1><form method="post" action="/admin/login">' +
  '<input type="email" name="email"><button type="submit">Continue</button></form></main></body></html>';

/** Marker the attacker origin's script sets when it runs. */
export const EVIL_MARKER = '__iwEvil';

/** Another loopback origin (another port) standing in for an attacker's server. */
async function startEvilOrigin(): Promise<Listening> {
  return listen((req, res) => {
    const path = pathOf(req);
    if (path.endsWith('.js')) {
      send(res, 200, {'content-type': 'text/javascript'}, `self.${EVIL_MARKER} = true;`);
      return;
    }
    send(
      res,
      200,
      {'content-type': 'text/html; charset=utf-8'},
      `<!doctype html><title>phish</title><script>self.${EVIL_MARKER} = true;</script>`,
    );
  });
}

/** The stock `/css/vaultwarden.css`: every stock hiding selector, then the template's icon rule. */
export function stockVaultwardenCss(): string {
  return (
    `${VAULTWARDEN_STOCK_HIDE_SELECTORS.join(',')}{display:none !important}` +
    'bit-nav-logo bit-nav-item a:before{content:"";background-image:url("../images/icon-white.svg");' +
    'background-repeat:no-repeat;background-position:center center;height:32px;display:block}'
  );
}

const VAULTWARDEN_HEADERS = (path: string): Record<string, string> => ({
  'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), usb=()',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'cross-origin-resource-policy': 'same-origin',
  ...(path.endsWith('connector.html')
    ? {}
    : {
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy':
          "default-src 'none'; font-src 'self'; manifest-src 'self'; base-uri 'self'; " +
          "form-action 'self'; object-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; child-src 'self' https://*.duosecurity.com " +
          "https://*.duofederal.com; frame-src 'self' https://*.duosecurity.com " +
          "https://*.duofederal.com; frame-ancestors 'self' moz-extension://*; " +
          "img-src 'self' data: https://haveibeenpwned.com; " +
          "connect-src 'self' https://api.pwnedpasswords.com https://api.2fa.directory; " +
          "worker-src 'self';",
      }),
});

const ROCKET_404 =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page not found!</title></head>' +
  '<body><h1>Page not found!</h1><p>Sorry, but the page you were looking for could not be found.</p>' +
  '</body></html>';

/** The server-rendered admin login page (its own assets live under /vw_static/). */
const ADMIN_PAGE =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Vaultwarden Admin Panel</title>' +
  '</head><body><main><h1>Authentication key needed to continue</h1><form method="post">' +
  '<input type="password" name="token"><button type="submit">Enter</button></form></main></body></html>';

function rocketRefuses(rel: string): boolean {
  return rel
    .split('/')
    .filter(s => s !== '')
    .some(s => s.startsWith('.') || s.startsWith('*') || /[:<>]$/.test(s));
}

/**
 * The attacker script of the `forged-pagehide` variant: a forged `pagehide` (which must not end
 * the page's origin taint: a document ends only when Firefox says its frame shows another one),
 * then, 7 s later, a full-window frame of the vault whose DOM the page can read.
 */
const FORGED_PAGEHIDE_JS = `(function () {
  setTimeout(function () {
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
    self.__iwForged = true;
  }, 300);
  setTimeout(function () {
    var f = document.createElement('iframe');
    f.src = '/';
    f.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;border:0';
    f.onload = function () {
      try { self.__iwFramed = !!f.contentDocument.documentElement; } catch (e) { self.__iwFramed = false; }
    };
    document.body.appendChild(f);
  }, 7000);
})();`;

/**
 * The attacker script of the `blob-trampoline` variant. It waits for `#go` in
 * the address (so a scenario can first see the page tainting), then makes a same-origin `blob:`
 * document and moves its own tab there. A `blob:` document has the origin of the page that made it
 * and inherits its CSP (here IntactWarden's floor: no inline script), so it names an external
 * same-origin script by an absolute URL (a relative one does not resolve against a `blob:` URL),
 * which would open the vault in a window it can script; no document owns that request, so
 * IntactWarden denies it. The page also has a link to the vault (`#iw-open`, `target=_blank`), which
 * opens it from the blob page when clicked.
 */
const BLOB_TRAMPOLINE_JS = `(function () {
  window.addEventListener('hashchange', function () {
    if (location.hash !== '#go') return;
    var opener = new URL('/blob-open.js', location.href).href;
    var vault = new URL('/', location.href).href;
    var html = '<!doctype html><html><head><title>blob</title><script src="' + opener +
      '"></' + 'script></head><body><p>blob</p><a id="iw-open" href="' + vault +
      '" target="_blank">vault</a></body></html>';
    location.href = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
  });
  self.__iwTrampoline = true;
})();`;

const BLOB_OPEN_JS = `(function () {
  var vault = new URL('/', document.currentScript.src).href;
  self.__iwBlobOpened = window.open(vault, '_blank') !== null;
})();`;

/**
 * The document path the `forged-pagehide` and `blob-trampoline` variants serve their attacker page
 * at (a listed connector page of the release, here with other bytes).
 */
export const ATTACKER_PAGE = '/sso-connector.html';

/** The script on another origin the `link` variant's `Link` header names. */
export const LINK_EVIL_SCRIPT = 'https://link.invalid/evil.js';

/** The key the tampered locale of the `localeStatus` variant adds (checked in what the page read). */
export const LOCALE_MARKER = 'iwE2eTamperedLocale';
/** The listed locale the `localeStatus` variant answers with another status and other bytes. */
export const LOCALE_PATH = '/locales/en/messages.json';

/** The host name of the framing site behind the TLS endpoint: no host permission covers it. */
export const FRAMING_HOST = 'framer.example';
/** Marker the script of a `framed` attacker document sets when it runs. */
export const FRAMED_MARKER = '__iwFramedRan';
/** Marker that script sets once it has read the vault window it opened. */
export const FRAMED_READ_MARKER = '__iwFramedRead';
/** The id of the button in a `framed` attacker document. */
export const FRAMED_BUTTON = 'open';
/** Marker the framing site's page sets when a frame posts it a message. */
export const FRAMING_HEARD_MARKER = '__iwFramingHeard';

/**
 * The script of a `framed` attacker document: its marker, a message to the framing page, and at a
 * click on the document's button the vault (`#/login`) in a new window, whose DOM it then reads.
 */
const FRAMED_JS = `(function () {
  self.${FRAMED_MARKER} = true;
  try { parent.postMessage('ran', '*'); } catch (e) {}
  document.getElementById('${FRAMED_BUTTON}').addEventListener('click', function () {
    var w = window.open(location.origin + location.pathname + '#/login', '_blank');
    setInterval(function () {
      try { if (w.document.querySelector('app-root')) self.${FRAMED_READ_MARKER} = true; } catch (e) {}
    }, 200);
  });
})();`;

/**
 * The attacker documents of the `framed` variant, by the query string of the frame's load: where
 * the document's script comes from (the framing site, the vault's own origin, or inline).
 */
const FRAMED_ATTACKS = ['framing-site', 'same-origin', 'inline'] as const;
export type FramedAttack = (typeof FRAMED_ATTACKS)[number];

function framedDocument(attack: FramedAttack, basePath: string): string {
  const script = {
    'framing-site': `<script src="https://${FRAMING_HOST}/framed.js"></script>`,
    'same-origin': `<script src="${basePath}framed.js"></script>`,
    inline: `<script>${FRAMED_JS}</script>`,
  }[attack];
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>vault</title></head><body>' +
    `<p>attacker HTML on the protected origin</p><button id="${FRAMED_BUTTON}">Continue</button>` +
    `${script}</body></html>`
  );
}

/** The page of the `serviceWorker` variant that registers its worker (`?mode=<WorkerMode>`). */
export const WORKER_INSTALL_PAGE = '/install-worker.html';
/** Marker that page sets once the worker controls it. */
export const WORKER_READY_MARKER = '__iwWorkerReady';
/** Marker the worker's own document sets when its inline script runs. */
export const WORKER_DOCUMENT_MARKER = '__iwWorkerDocument';
/** Marker the worker's own main script sets when it runs. */
export const WORKER_SCRIPT_MARKER = '__iwWorkerScript';

/**
 * What the worker of the `serviceWorker` variant does: `document` answers the vault document with
 * its own HTML (an inline script); `script` leaves the document to the network and answers the
 * main script with its own bytes; `script-unregistered` does the same after it has unregistered
 * itself at the document's request (it goes on controlling that page); `script-fetched` unregisters
 * itself too and answers the main script with a response it fetched from another address of the
 * site (WORKER_SCRIPT_SOURCE).
 */
export type WorkerMode = 'document' | 'script' | 'script-unregistered' | 'script-fetched';

/** The address (below the base path) the `script-fetched` worker fetches its script from. */
const WORKER_SCRIPT_SOURCE = 'api/worker-script';

const WORKER_INSTALL_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>install</title></head><body><script>' +
  "navigator.serviceWorker.register('sw.js?mode=' + new URLSearchParams(location.search).get('mode'))" +
  '.then(function () { return navigator.serviceWorker.ready; }).then(function () {' +
  'var t = setInterval(function () { if (navigator.serviceWorker.controller) {' +
  `clearInterval(t); self.${WORKER_READY_MARKER} = true; } }, 50); });` +
  '</script></body></html>';

/** The script the worker serves in place of the main script. */
const WORKER_SCRIPT_JS = `self.${WORKER_SCRIPT_MARKER} = true;`;

/** The worker script: it claims open pages at once; its mode is in its own address. */
function workerScript(basePath: string, mainScript: string): string {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>vault</title></head><body>' +
    `<p>a service worker's HTML on the protected origin</p>` +
    `<script>self.${WORKER_DOCUMENT_MARKER} = true;</script></body></html>`;
  return `const mode = new URL(self.location.href).searchParams.get('mode');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const path = new URL(e.request.url).pathname;
  if (e.request.mode === 'navigate') {
    if (path !== ${JSON.stringify(basePath)}) return;
    if (mode === 'document') {
      e.respondWith(new Response(${JSON.stringify(html)}, {headers: {'content-type': 'text/html; charset=utf-8'}}));
    } else if (mode !== 'script') {
      e.waitUntil(self.registration.unregister());
    }
    return;
  }
  if (mode === 'document' || path !== ${JSON.stringify(basePath + mainScript.slice(1))}) return;
  if (mode === 'script-fetched') {
    e.respondWith(fetch(${JSON.stringify(basePath + WORKER_SCRIPT_SOURCE)}));
  } else {
    e.respondWith(new Response(${JSON.stringify(WORKER_SCRIPT_JS)}, {headers: {'content-type': 'text/javascript; charset=utf-8'}}));
  }
});
`;
}

/** A Vaultwarden instance (release tarball) at `basePath` (`/` or `/<segment>/`). */
export async function startVaultwarden(
  options: {
    basePath?: string;
    /**
     * `forged-pagehide`: a compromised server's `/sso-connector.html` (a document path of the
     * profile, served with other bytes: with `versionHint` naming an image-only release it is
     * BUILD_UNVERIFIED, which "Proceed once" lets through) whose script dispatches a forged
     * `pagehide` and then frames the vault. `blob-trampoline`: the same attacker page moves its
     * tab to a same-origin `blob:` page it made, which opens the vault;
     * `/identity/connect/authorize` serves a page with that script too, and
     * `/identity/connect/oidc-signin` answers 302 to an identity provider on another origin (an SSO
     * sign-in redirect).
     */
    tamper?: 'none' | 'inline-script' | 'forged-pagehide' | 'blob-trampoline';
    /** `custom`: the stock stylesheet plus one admin rule (UNVERIFIED_STYLE custom-rules). */
    css?: 'stock' | 'custom';
    /** Overrides the version `/vw-version.json` names (the build stays 2026.10.1). */
    versionHint?: string;
    /**
     * Also serves Bitwarden's Secrets Manager chunk 541 (from the COMMERCIAL zip, at its own path):
     * code that no Vaultwarden release contains. One statement is appended that sets
     * SM_TAMPER_MARKER, so a scenario can tell whether the page ran it.
     */
    bitwardenSmChunk?: boolean;
    /**
     * Answers the listed `/locales/en/messages.json` with this status (a 2xx other than 200, say)
     * and other bytes: one key (LOCALE_MARKER) added, still valid JSON.
     */
    localeStatus?: number;
    /**
     * Sends the first half of each `.wasm` file at once and the rest 4 s later (`no-store`), so a
     * scenario can close or reload the tab while a listed file is still loading, or just as it
     * ends. `'gzip'`: the response is gzip-coded (`Content-Encoding: gzip`), split the same way.
     */
    holdWasm?: boolean | 'gzip';
    /**
     * Holds each vault document (`/`, `no-store`) for 3 s, so a scenario can start another load
     * while one is still loading: `body` sends the first half at once and the rest then, `headers`
     * sends the whole response then.
     */
    holdDocument?: 'body' | 'headers';
    /**
     * The public origin a front server serves the site at (encodings.ts), as Vaultwarden's
     * `DOMAIN` names it (with the base path appended); default: the loopback origin.
     */
    publicOrigin?: string;
    /**
     * Adds `Link: <LINK_EVIL_SCRIPT>; rel=preload; as=script, </main script>; rel=preload;
     * as=script` to every response, as a proxy or a hostile server might.
     */
    link?: boolean;
    /**
     * Answers a frame's load of the vault document (`Sec-Fetch-Dest: iframe`) with an attacker
     * document instead (FRAMED_ATTACKS, chosen by the query string; no CSP, no X-Frame-Options), as
     * a compromised server can; `framed.js` is that document's script as a file of the origin. Any
     * other load gets the release.
     */
    framed?: boolean;
    /**
     * Serves WORKER_INSTALL_PAGE, which registers `sw.js?mode=<WorkerMode>` for the whole site, as
     * a compromised server can before the user protects the origin. The worker then answers the
     * vault document or its main script itself (WorkerMode); `api/worker-script` is the script one
     * of its modes fetches.
     */
    serviceWorker?: boolean;
  } = {},
): Promise<Site> {
  const basePath = options.basePath ?? '/';
  const files = new Map((await vaultwardenRelease()).files);
  if (options.bitwardenSmChunk === true) {
    const bw = (await bitwardenRelease()).files;
    const sm = chunkPath(bw, 541);
    if (files.has(sm)) throw new Error(`the Vaultwarden release already has ${sm}`);
    files.set(sm, tamperScript(bw.get(sm)!, SM_TAMPER_MARKER));
  }
  if (options.tamper === 'inline-script') {
    files.set('/index.html', injectInlineScript(files.get('/index.html')!));
  }
  if (options.versionHint !== undefined) {
    files.set('/vw-version.json', new TextEncoder().encode(`{"version":"${options.versionHint}"}`));
  }
  const css =
    stockVaultwardenCss() + (options.css === 'custom' ? '.vault-filters{display:none}' : '');
  const idp = options.tamper === 'blob-trampoline' ? await startIdentityProvider() : null;
  let held = 0;
  /** The gzip-coded `.wasm` files (`holdWasm: 'gzip'`), coded once. */
  const gzipped = new Map<string, Uint8Array>();
  let aborted = 0;
  let framedLoads = 0;
  let locale: string | null = null;
  if (options.localeStatus !== undefined) {
    const genuine = files.get(LOCALE_PATH);
    if (genuine === undefined) throw new Error(`the release has no ${LOCALE_PATH}`);
    const text = new TextDecoder().decode(genuine);
    const open = text.indexOf('{');
    if (open < 0) throw new Error(`${LOCALE_PATH} is not a JSON object`);
    locale =
      `${text.slice(0, open + 1)}"${LOCALE_MARKER}":{"message":"IntactWarden e2e: other bytes"},` +
      text.slice(open + 1);
  }
  const mainScript = mainScriptOf(files.get('/index.html')!);
  let origin = '';
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = pathOf(req);
    const h = VAULTWARDEN_HEADERS(path);
    if (options.tamper === 'inline-script') delete h['content-security-policy'];
    if (options.link === true) {
      h['link'] =
        `<${LINK_EVIL_SCRIPT}>; rel=preload; as=script, ` +
        `<${basePath}${mainScript.slice(1)}>; rel=preload; as=script`;
    }
    const json = (status: number, value: unknown): void =>
      send(res, status, {...h, 'content-type': 'application/json'}, JSON.stringify(value));
    const notFound = (): void =>
      send(res, 404, {...h, 'content-type': 'text/html; charset=utf-8'}, ROCKET_404);
    const domain = `${origin}${basePath === '/' ? '' : basePath.slice(0, -1)}`;
    // The reverse proxy in front of a sub-path instance (nginx `location /vw/ { proxy_pass … }`)
    // answers the base path without its slash with a 301 to the base path.
    if (basePath !== '/' && path === basePath.slice(0, -1)) {
      return send(res, 301, {location: basePath, 'content-type': 'text/html'}, '');
    }
    // Server routes live below the base path too (DOMAIN with a path mounts everything there).
    if (!path.startsWith(basePath)) return notFound();
    const rel = `/${path.slice(basePath.length)}`;
    switch (rel) {
      case '/api/config':
        return json(200, {
          version: '2025.12.0',
          gitHash: 'e2e00000',
          server: {name: 'Vaultwarden', url: 'https://github.com/dani-garcia/vaultwarden'},
          settings: {disableUserRegistration: false},
          environment: {
            vault: domain,
            api: `${domain}/api`,
            identity: `${domain}/identity`,
            notifications: `${domain}/notifications`,
            sso: '',
            cloudRegion: null,
          },
          featureStates: {},
          object: 'config',
        });
      case '/alive':
        return json(200, '2026-11-06T00:00:00.000Z');
      case '/app-id.json':
        return json(200, {trustedFacets: [{version: {major: 1, minor: 0}, ids: [domain]}]});
      case '/css/vaultwarden.css':
        return send(
          res,
          200,
          {
            ...h,
            'content-type': 'text/css; charset=utf-8',
            'cache-control': 'public, no-cache',
            etag: `"${sha256(css)}"`,
          },
          css,
        );
      case '/': {
        if (options.framed === true && req.headers['sec-fetch-dest'] === 'iframe') {
          const query = (req.url ?? '').split('?')[1] ?? '';
          const attack = FRAMED_ATTACKS.find(a => a === query) ?? 'inline';
          framedLoads++;
          return send(
            res,
            200,
            {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
            framedDocument(attack, basePath),
          );
        }
        const index = files.get('/index.html')!;
        if (options.holdDocument !== undefined) {
          held++;
          res.on('close', () => {
            if (!res.writableFinished) aborted++;
          });
          const hd = {
            ...h,
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          };
          if (options.holdDocument === 'headers') {
            setTimeout(() => {
              if (!res.destroyed) send(res, 200, hd, index);
            }, 3000);
            return;
          }
          res.writeHead(200, {...hd, 'content-length': String(index.length)});
          res.write(index.subarray(0, index.length >> 1));
          setTimeout(() => {
            if (!res.destroyed) res.end(index.subarray(index.length >> 1));
          }, 3000);
          return;
        }
        return send(
          res,
          200,
          {
            ...h,
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=600',
          },
          index,
        );
      }
      case '/index.html':
        return send(res, 303, {...h, location: basePath});
      case '/admin':
      case '/admin/':
        return send(
          res,
          200,
          {...h, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
          ADMIN_PAGE,
        );
    }
    if (options.tamper === 'forged-pagehide' && rel === ATTACKER_PAGE) {
      return send(
        res,
        200,
        {...h, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
        '<!doctype html><html><head><script src="/forged-pagehide.js"></script></head>' +
          '<body><p>Signing in</p></body></html>',
      );
    }
    if (options.tamper === 'forged-pagehide' && rel === '/forged-pagehide.js') {
      return send(
        res,
        200,
        {...h, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store'},
        FORGED_PAGEHIDE_JS,
      );
    }
    if (options.tamper === 'blob-trampoline') {
      const trampoline: readonly [string, string] = [
        'text/html; charset=utf-8',
        '<!doctype html><html><head><script src="/blob-trampoline.js"></script></head>' +
          '<body><p>Signing in</p></body></html>',
      ];
      const page: Readonly<Record<string, readonly [string, string]>> = {
        [ATTACKER_PAGE]: trampoline,
        '/identity/connect/authorize': trampoline,
        '/blob-trampoline.js': ['text/javascript; charset=utf-8', BLOB_TRAMPOLINE_JS],
        '/blob-open.js': ['text/javascript; charset=utf-8', BLOB_OPEN_JS],
      };
      const hit = page[rel];
      if (hit !== undefined) {
        return send(res, 200, {...h, 'content-type': hit[0], 'cache-control': 'no-store'}, hit[1]);
      }
      if (idp !== null && rel === '/identity/connect/oidc-signin') {
        return send(res, 302, {
          ...h,
          location: `${idp.origin}/authorize`,
          'cache-control': 'no-store',
        });
      }
    }
    if (options.serviceWorker === true) {
      const js = 'text/javascript; charset=utf-8';
      const page: Readonly<Record<string, readonly [string, string]>> = {
        [WORKER_INSTALL_PAGE]: ['text/html; charset=utf-8', WORKER_INSTALL_HTML],
        '/sw.js': [js, workerScript(basePath, mainScript)],
        [`/${WORKER_SCRIPT_SOURCE}`]: [js, WORKER_SCRIPT_JS],
      };
      const hit = page[rel];
      if (hit !== undefined) {
        return send(res, 200, {'content-type': hit[0], 'cache-control': 'no-store'}, hit[1]);
      }
    }
    if (options.framed === true && rel === '/framed.js') {
      return send(
        res,
        200,
        {'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store'},
        FRAMED_JS,
      );
    }
    if (options.localeStatus !== undefined && rel === LOCALE_PATH && locale !== null) {
      return send(
        res,
        options.localeStatus,
        {...h, 'content-type': 'application/json', 'cache-control': 'no-store'},
        locale,
      );
    }
    if (rel.startsWith('/api/') || rel.startsWith('/identity/')) return json(404, {});
    if (rocketRefuses(rel)) return notFound();
    const bytes = files.get(rel);
    if (bytes === undefined) return notFound();
    if (options.holdWasm !== undefined && options.holdWasm !== false && rel.endsWith('.wasm')) {
      const coded = options.holdWasm === 'gzip';
      let body = bytes;
      if (coded) {
        body = gzipped.get(rel) ?? gzipSync(bytes, {level: 1});
        gzipped.set(rel, body);
      }
      held++;
      res.writeHead(200, {
        ...h,
        'content-type': contentTypeOf(rel),
        'cache-control': 'no-store',
        'content-length': String(body.length),
        ...(coded ? {'content-encoding': 'gzip'} : {}),
      });
      res.write(body.subarray(0, body.length >> 1));
      setTimeout(() => res.end(body.subarray(body.length >> 1)), 4000);
      return;
    }
    send(
      res,
      200,
      {
        ...h,
        'content-type': contentTypeOf(rel),
        'cache-control': 'public, immutable, max-age=604800',
      },
      bytes,
    );
  };
  const site = await listen(handler);
  origin = options.publicOrigin ?? site.origin;
  return {
    ...site,
    files,
    mainScript,
    basePath,
    handler,
    ...(idp !== null ? {idpOrigin: idp.origin} : {}),
    ...((options.holdWasm !== undefined && options.holdWasm !== false) ||
    options.holdDocument !== undefined
      ? {heldResponses: () => held}
      : {}),
    ...(options.holdDocument !== undefined ? {abortedResponses: () => aborted} : {}),
    ...(options.framed === true ? {framedLoads: () => framedLoads} : {}),
    close: async () => {
      await site.close();
      await idp?.close();
    },
  };
}

/**
 * Another site whose page frames a vault, mounted behind the TLS endpoint as FRAMING_HOST:
 * `/?frame=<url>` answers a page with an `<iframe>` of that URL that sets FRAMING_HEARD_MARKER when
 * a frame posts it a message; `/framed.js` is the script of a `framed` attacker document.
 */
export function framingSite(req: IncomingMessage, res: ServerResponse): void {
  if (pathOf(req) === '/framed.js') {
    send(res, 200, {'content-type': 'text/javascript', 'cache-control': 'no-store'}, FRAMED_JS);
    return;
  }
  const frame = new URL(req.url ?? '/', `https://${FRAMING_HOST}`).searchParams.get('frame') ?? '';
  send(
    res,
    200,
    {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
    '<!doctype html><html><head><meta charset="utf-8"><title>another site</title><script>' +
      `addEventListener('message', function () { self.${FRAMING_HEARD_MARKER} = true; });` +
      '</script></head><body><iframe id="frame" width="600" height="300" src="' +
      `${frame.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></body></html>`,
  );
}

/** Another loopback origin standing in for an SSO identity provider (a sign-in page, no script). */
async function startIdentityProvider(): Promise<Listening> {
  return listen((_req, res) => {
    send(
      res,
      200,
      {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
      '<!doctype html><title>Identity provider</title><p>Sign in</p>',
    );
  });
}

/** The official origin the cloud emulator stands in for (reached through the proxy in Firefox). */
export const CLOUD_US_ORIGIN = 'https://vault.bitwarden.com';

/**
 * `azure-blob` (Bitwarden cloud, cloud-us): the release zip's files with the six files the cloud
 * build changes, derived with @intactwarden/core's cloud derivation. The first deployment uses the
 * CACHE_TAG and script names the corpus lock observed on vault.bitwarden.com, and the derived bytes
 * must equal the live digests recorded in the lock, so this is what the origin served.
 * `redeploy(tag)` swaps in another deployment of the same release: a new CACHE_TAG and new
 * content-hashed script names (any 20 hex; here derived from the tag), as a cloud redeploy without
 * a new release produces. Blob-storage headers: HTML `public, max-age=0, must-revalidate`, scripts
 * without Cache-Control, Content-MD5 and an ETag.
 */
export interface CloudSite extends Site {
  /** CACHE_TAG of the deployment being served. */
  readonly cacheTag: () => string;
  /** Serves another deployment of the same release (new CACHE_TAG and script names). */
  redeploy(cacheTag: string): Promise<{mainScript: string}>;
  /**
   * Serves an unknown build (index.html with one appended comment, so it matches no core)
   * whose /version.json names `version`; null goes back to the deployment.
   */
  hotfix(version: string | null): void;
}

async function cloudDeployment(cacheTag: string): Promise<{files: SiteFiles; mainScript: string}> {
  const release = await bitwardenRelease();
  const {lock} = release;
  const region = lock.regions['cloud-us'];
  if (region === undefined) throw new Error('the lock has no cloud-us region');
  const live = cacheTag === region.cache_tag;
  const name = (prefix: string, what: string): string =>
    `${prefix}${sha256(`intactwarden-e2e:${cacheTag}:${what}`).slice(0, 20)}.js`;
  const deployment = live
    ? {
        cacheTag,
        mainName: region.main_name,
        duoJsName: region.duo_js_name,
        webauthnFbJsName: region.webauthn_fb_js_name,
      }
    : {
        cacheTag,
        mainName: name('app/main.', 'main'),
        duoJsName: name('connectors/duo-redirect.', 'duo'),
        webauthnFbJsName: name('connectors/webauthn-fallback.', 'webauthn'),
      };
  const derived = deriveCloudFiles(
    release.files,
    {
      base: await fetchPinned(lock.config.base.url, lock.config.base.sha256),
      env: await fetchPinned(lock.config.cloud.url, lock.config.cloud.sha256),
      envName: 'cloud',
    },
    deployment,
  );
  const files = new Map(release.files);
  for (const d of derived) {
    if (live) {
      const seen = region.expected[d.path];
      const sha = sha256(d.bytes);
      if (seen === undefined || seen.sha256 !== sha) {
        throw new Error(`derived ${d.path} (${sha}) is not what the lock observed live`);
      }
    }
    files.set(d.path, d.bytes);
  }
  return {files, mainScript: `/${deployment.mainName}`};
}

export async function startBitwardenCloud(): Promise<CloudSite> {
  const release = await bitwardenRelease();
  const region = release.lock.regions['cloud-us'];
  if (region === undefined) throw new Error('the lock has no cloud-us region');
  let tag = region.cache_tag;
  let current = await cloudDeployment(tag);
  let hotfix: string | null = null;
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = pathOf(req);
    const file = path === '/' ? '/index.html' : path;
    let bytes = current.files.get(file);
    if (hotfix !== null && bytes !== undefined && file === '/index.html') {
      bytes = new TextEncoder().encode(
        `${new TextDecoder().decode(bytes)}<!-- IntactWarden e2e: unknown build -->\n`,
      );
    } else if (hotfix !== null && file === '/version.json') {
      bytes = new TextEncoder().encode(`{ "version": "${hotfix}" }`);
    }
    if (bytes === undefined) {
      send(
        res,
        404,
        {'content-type': 'application/xml', 'x-ms-error-code': 'BlobNotFound'},
        '<?xml version="1.0" encoding="utf-8"?><Error><Code>BlobNotFound</Code></Error>',
      );
      return;
    }
    const isHtml = file.endsWith('.html');
    send(
      res,
      200,
      {
        'content-type': contentTypeOf(file),
        ...(isHtml || file.endsWith('.wasm')
          ? {'cache-control': 'public, max-age=0, must-revalidate'}
          : {}),
        'content-md5': createHash('md5').update(bytes).digest('base64'),
        etag: `"0x8DE${sha256(bytes).slice(0, 12).toUpperCase()}"`,
        'x-ms-version': '2009-09-19',
        'x-ms-blob-type': 'BlockBlob',
        'last-modified': 'Thu, 05 Nov 2026 10:00:00 GMT',
      },
      bytes,
    );
  };
  const site = await listen(handler);
  return {
    ...site,
    origin: CLOUD_US_ORIGIN,
    get files() {
      return current.files;
    },
    get mainScript() {
      return current.mainScript;
    },
    basePath: '/',
    handler,
    cacheTag: () => tag,
    async redeploy(cacheTag: string) {
      current = await cloudDeployment(cacheTag);
      tag = cacheTag;
      return {mainScript: current.mainScript};
    },
    hotfix(version: string | null) {
      hotfix = version;
    },
  };
}
