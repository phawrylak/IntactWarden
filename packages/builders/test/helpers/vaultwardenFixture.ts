/**
 * Synthetic bw_web_builds release tarballs for the builders' Vaultwarden tests:
 * the layout of bw_web_v<version>.tar.gz (one gzip member, GNU tar, a single
 * `web-vault/` root with directory entries), in miniature.
 */

import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import type {BuildRequest} from '../../src/api.ts';
import {writeTar, type TarSpec} from '../../../core/test/helpers/tarWriter.ts';

export const VW_REPO = 'dani-garcia/bw_web_builds';
export const VW_VERSION = '2026.10.1';
export const VW_TAG = `v${VW_VERSION}`;
export const VW_COMMIT = 'f35c1cbb7b582781243d1166f5cad21f6988ab5f';
export const VW_TAG_OBJECT = '878e7d7a00f5989f1d743cd0c2d7b9aa460107c5';
export const VW_ASSET = `bw_web_v${VW_VERSION}.tar.gz`;
export const VW_MAIN = '1176a28a68b7b4809391';

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** File contents below `web-vault/`, by relative path. */
export type VwFiles = Record<string, string | Uint8Array>;

export function vwFiles(): VwFiles {
  return {
    'index.html':
      '<!doctype html><html><head><link rel="stylesheet" href="styles.7b4e836b041b0b1d10ae.css" />' +
      '<link rel="stylesheet" href="css/vaultwarden.css" /><title>Vaultwarden Web</title></head>' +
      `<body><app-root></app-root><script src="app/main.${VW_MAIN}.js"></script></body></html>`,
    '404.html': '<!doctype html><title>Page not found | Bitwarden Web vault</title>',
    'sso-connector.html':
      '<!doctype html><script src="connectors/sso.0123456789abcdef0123.js"></script>',
    'connectors/sso.0123456789abcdef0123.js': '(()=>{})();',
    [`app/main.${VW_MAIN}.js`]: `(()=>{"use strict";globalThis.vw=1;})();\n//# sourceMappingURL=main.${VW_MAIN}.js.map`,
    [`app/main.${VW_MAIN}.js.map`]:
      '{"version":3,"sources":["webpack:///./src/app/oss.module.ts"],"mappings":""}',
    'app/vendor.55e794a42a5fe0d2e9eb.js': 'var vendor=1;',
    '40.80a680f52f0517790fe9.js': '(self.webpackChunk=self.webpackChunk||[]).push([[40],{}]);',
    '466839efc4da38d60ce3.module.wasm': Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0),
    'styles.7b4e836b041b0b1d10ae.css': 'body{margin:0}',
    'vw-version.json': `{"version":"${VW_VERSION}"}`,
    'version.json': `{ "version": "${VW_VERSION}" }`,
    'app-id.json': '﻿{"trustedFacets":[{"version":{"major":1,"minor":0},"ids":[]}]}',
    'images/icon-white.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'locales/en/messages.json': '{"appName":{"message":"Vaultwarden"}}',
    '.nojekyll': '',
  };
}

export interface TarballOptions {
  /** Default 'web-vault/'. */
  readonly root?: string;
  /** Reverse the entry order (directories still precede their files). */
  readonly reverse?: boolean;
  readonly mtime?: number;
  readonly level?: number;
  /** Extra raw entries appended as they are (names are not prefixed). */
  readonly extra?: readonly TarSpec[];
}

/** A release tarball: directory entries for every parent, then the files, gzipped. */
export function vwTarball(files: VwFiles = vwFiles(), opts: TarballOptions = {}): Uint8Array {
  const root = opts.root ?? 'web-vault/';
  const names = Object.keys(files).sort();
  if (opts.reverse === true) names.reverse();
  const specs: TarSpec[] = [];
  const dirs = new Set<string>();
  const common = {
    ...(opts.mtime === undefined ? {} : {mtime: opts.mtime}),
  };
  const addDir = (dir: string): void => {
    if (dir === '' || dirs.has(dir)) return;
    addDir(dir.slice(0, dir.lastIndexOf('/', dir.length - 2) + 1));
    dirs.add(dir);
    specs.push({name: dir, ...common});
  };
  if (root !== '') addDir(root);
  for (const name of names) {
    const full = root + name;
    addDir(full.slice(0, full.lastIndexOf('/') + 1));
    specs.push({name: full, data: files[name]!, ...common});
  }
  specs.push(...(opts.extra ?? []));
  return new Uint8Array(gzipSync(writeTar(specs, {recordSize: 10240}), {level: opts.level ?? 6}));
}

/** A CoreBuilder request for the release in `tarball`. */
export function vwRequest(tarball: Uint8Array, over: Partial<BuildRequest> = {}): BuildRequest {
  return {
    app: 'vaultwarden-web',
    variant: 'release',
    version: VW_VERSION,
    release: {tag: VW_TAG, commit: VW_COMMIT, tagObject: VW_TAG_OBJECT},
    asset: {name: VW_ASSET, sha256: sha256(tarball), size: tarball.length, bytes: tarball},
    ...over,
  };
}
