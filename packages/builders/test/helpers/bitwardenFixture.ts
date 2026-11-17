/**
 * A synthetic Bitwarden web vault release, shaped like web-v2026.10.1: the
 * same file layout under build/, and the six files the cloud derivation derives
 * carry every needle in the same minified context as the real bundles. All
 * bytes are made up here; no vendor bytes are used.
 */

import {createHash} from 'node:crypto';
import type {BuilderVariant, BuildRequest} from '../../src/api.ts';
import {writeZip, type ZipSpec} from './zipWriter.ts';

export const VERSION = '2026.10.1';
export const TAG = `web-v${VERSION}`;
export const COMMIT = '91214c3b978edb5496a32a946451960fe7d44531';
export const COMMERCIAL_ASSET = `web-${VERSION}-selfhosted-COMMERCIAL.zip`;

/** Content hashes of the self-hosted scripts in file names. */
export const SELF = {
  cacheTag: 'i9gaj5',
  main: '0a0a0a0a0a0a0a0a0a0a',
  duo: '0b0b0b0b0b0b0b0b0b0b',
  webauthn: '0c0c0c0c0c0c0c0c0c0c',
} as const;

/** Secrets Manager's chunk, and the chunk it shares with organisation integrations. */
export const SM_CHUNK = '/541.f38c2a08966cd91bbade.js';
export const SHARED_CHUNK = '/195.d4ed0c5d550e92c646e9.js';
export const INTEGRATIONS_CHUNK = '/359.4a5c0e2f6b1d3a7c9e8f.js';

export const BASE_CONFIG = {
  urls: {},
  stripeKey: 'pk_test_KEY',
  braintreeKey: 'sandbox_KEY',
  paypal: {businessId: 'SANDBOXBIZ', buttonAction: 'https://www.sandbox.paypal.com/cgi-bin/webscr'},
  dev: {port: 8080, allowedHosts: 'auto'},
  flags: {sdk: true},
  devFlags: {},
};

export const CLOUD_CONFIG = {
  urls: {icons: 'https://icons.example.net', notifications: 'https://notifications.example.com'},
  stripeKey: 'pk_live_KEY',
  braintreeKey: 'production_KEY',
  paypal: {businessId: 'LIVEBIZ', buttonAction: 'https://www.paypal.com/cgi-bin/webscr'},
  dev: {proxyApi: 'https://api.example.com'},
  flags: {},
};

export const EUPRD_CONFIG = {
  urls: {icons: 'https://icons.example.eu', notifications: 'https://notifications.example.eu'},
  stripeKey: 'pk_live_KEY',
  braintreeKey: 'production_KEY',
  paypal: {businessId: 'LIVEBIZ', buttonAction: 'https://www.paypal.com/cgi-bin/webscr'},
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export const configBytes = (value: unknown): Uint8Array =>
  enc(JSON.stringify(value, null, 2) + '\n');

export const BASE = 'apps/web/config/base.json';
export const CLOUD = 'apps/web/config/cloud.json';
export const EUPRD = 'apps/web/config/euprd.json';

/** The three config files a cloud deep verify fetches, by repository path. */
export const CONFIGS: Readonly<Record<string, Uint8Array>> = {
  [BASE]: configBytes(BASE_CONFIG),
  [CLOUD]: configBytes(CLOUD_CONFIG),
  [EUPRD]: configBytes(EUPRD_CONFIG),
};

export function mainJs(cacheTag: string = SELF.cacheTag, hash: string = SELF.main): string {
  return (
    '(()=>{"use strict";var se={F:function(o){return o}},$y={};' +
    'class Loader{constructor(d){this.localesDirectory=d}' +
    `*load(e){const t=this.localesDirectory+"/"+e+"/messages.json?cache=${cacheTag}",n=yield fetch(t);return n}}` +
    'class Env{static isSelfHost(){return"selfhosted"==="selfhosted".toString()}}' +
    'var providers=[(0,se.F)({provide:$y,useValue:{}})];' +
    'function billing(n,i){this.payPalConfig={businessId:"SANDBOXBIZ",buttonAction:"https://www.sandbox.paypal.com/cgi-bin/webscr"};' +
    'window.braintree.dropin.create({authorization:"sandbox_KEY",container:this.c});' +
    `i.src="scripts/dropin.js?cache=${cacheTag}";this.stripe=n.Stripe("pk_test_KEY")}` +
    '/* Zürich: config loaded */globalThis.intactwarden=[Loader,Env,providers,billing];})();' +
    `\n//# sourceMappingURL=main.${hash}.js.map`
  );
}

export function connectorJs(stem: string, hash: string, cacheTag: string = SELF.cacheTag): string {
  return (
    '(()=>{"use strict";const l=navigator.language||"en";' +
    `fetch("locales/"+l+"/messages.json?cache=${cacheTag}").then(r=>r.json())})();` +
    `\n//# sourceMappingURL=${stem}.${hash}.js.map`
  );
}

export function indexHtml(mainHash: string = SELF.main): string {
  return (
    '<!doctype html><html class="theme_light"><head><meta charset="utf-8"/>' +
    '<title>Bitwarden Web vault</title><link href="styles.7993c0193ec4dde2a2a5.css" rel="stylesheet">' +
    '</head><body><app-root><!-- loading --></app-root>' +
    '<script defer="defer" src="theme_head.6991036cc6ce1ab5eee1.js"></script>' +
    '<script defer="defer" src="app/vendor.9515864ec4d3ce1acf45.js"></script>' +
    `<script defer="defer" src="app/main.${mainHash}.js"></script></body></html>`
  );
}

export function connectorHtml(stem: string, hash: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"/><title>Connector</title></head>' +
    `<body><img src="images/logo.svg" alt="Bitwarden"/><script defer="defer" src="connectors/${stem}.${hash}.js"></script></body></html>`
  );
}

const sourceMap = (file: string, sources: string[]): string =>
  JSON.stringify({version: 3, file, mappings: 'AAAA', sources, names: []});

/** Member name below build/ → contents. */
export function releaseFiles(): Map<string, string | Uint8Array> {
  return new Map<string, string | Uint8Array>([
    ['index.html', indexHtml()],
    [
      '404.html',
      '<!doctype html><html><head><title>Not found</title></head><body>404</body></html>',
    ],
    ['duo-redirect-connector.html', connectorHtml('duo-redirect', SELF.duo)],
    ['webauthn-fallback-connector.html', connectorHtml('webauthn-fallback', SELF.webauthn)],
    ['sso-connector.html', connectorHtml('sso', 'b9116a340807ff18cc2d')],
    [`app/main.${SELF.main}.js`, mainJs()],
    [
      `app/main.${SELF.main}.js.map`,
      sourceMap(`main.${SELF.main}.js`, ['webpack://web/src/main.ts']),
    ],
    ['app/vendor.9515864ec4d3ce1acf45.js', '(()=>{var v=1;})();'],
    ['app/vendor.9515864ec4d3ce1acf45.js.LICENSE.txt', 'MIT'],
    [`connectors/duo-redirect.${SELF.duo}.js`, connectorJs('duo-redirect', SELF.duo)],
    [
      `connectors/duo-redirect.${SELF.duo}.js.map`,
      sourceMap('duo-redirect.js', ['webpack://web/src/duo.ts']),
    ],
    [
      `connectors/webauthn-fallback.${SELF.webauthn}.js`,
      connectorJs('webauthn-fallback', SELF.webauthn),
    ],
    [
      `connectors/webauthn-fallback.${SELF.webauthn}.js.map`,
      sourceMap('wf.js', ['webpack://web/src/wf.ts']),
    ],
    ['connectors/sso.b9116a340807ff18cc2d.js', '(()=>{location.href="/";})();'],
    ['theme_head.6991036cc6ce1ab5eee1.js', '(()=>{})();'],
    [SM_CHUNK.slice(1), '(self.webpackChunk=self.webpackChunk||[]).push([[541],{}]);'],
    [`${SM_CHUNK.slice(1)}.map`, sourceMap('541.js', ['webpack://web/src/sm.ts'])],
    [SHARED_CHUNK.slice(1), '(self.webpackChunk=self.webpackChunk||[]).push([[195],{}]);'],
    [`${SHARED_CHUNK.slice(1)}.map`, sourceMap('195.js', ['webpack://web/src/integrations.ts'])],
    [INTEGRATIONS_CHUNK.slice(1), '(self.webpackChunk=self.webpackChunk||[]).push([[359],{}]);'],
    ['edbccabf45fa994a91dc.module.wasm', new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])],
    ['styles.7993c0193ec4dde2a2a5.css', 'body{margin:0}'],
    ['fonts/bwi-font.9ae6e12297499bbf04d1.woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32])],
    ['images/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['favicon.ico', new Uint8Array([0, 0, 1, 0])],
    ['videos/intro.mp4', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])],
    ['locales/en/messages.json', '{"appName":{"message":"Bitwarden"}}'],
    ['version.json', `{"version":"${VERSION}"}`],
    ['app-id.json', '{"trustedFacets":[]}'],
    ['browserconfig.xml', '<?xml version="1.0"?><browserconfig/>'],
    ['.nojekyll', ''],
  ]);
}

export interface FixtureOptions {
  /** Member contents to replace (or remove, with null). */
  readonly override?: Readonly<Record<string, string | Uint8Array | null>>;
  /** Reverse the member order (central directory order). */
  readonly reverse?: boolean;
  /** Use stored instead of deflate entries. */
  readonly stored?: boolean;
}

export function buildReleaseZip(options: FixtureOptions = {}): Uint8Array {
  const files = releaseFiles();
  for (const [name, data] of Object.entries(options.override ?? {})) {
    if (data === null) files.delete(name);
    else files.set(name, data);
  }
  const dirs = new Set<string>(['build/']);
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`build/${parts.slice(0, i).join('/')}/`);
  }
  const specs: ZipSpec[] = [
    ...[...dirs].sort().map(name => ({name})),
    ...[...files].map(([name, data]) => ({
      name: `build/${name}`,
      data,
      ...(options.stored ? {method: 0 as const} : {}),
    })),
  ];
  return writeZip(options.reverse ? specs.reverse() : specs);
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A CoreBuilder request for one variant of the release in `zip`, with the three config files. */
export function bitwardenRequest(
  zip: Uint8Array,
  variant: BuilderVariant = 'selfhosted-commercial',
  over: Partial<BuildRequest> = {},
): BuildRequest {
  return {
    app: 'bitwarden-web',
    variant,
    version: VERSION,
    release: {tag: TAG, commit: COMMIT},
    asset: {name: COMMERCIAL_ASSET, sha256: sha256(zip), size: zip.length, bytes: zip},
    configs: CONFIGS,
    ...over,
  };
}
