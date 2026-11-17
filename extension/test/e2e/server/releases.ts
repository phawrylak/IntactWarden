/**
 * The real release files the fixture servers replay: Bitwarden `web-v2026.10.1` selfhosted
 * COMMERCIAL (zip) and Vaultwarden `bw_web_v2026.10.1` (tarball), fetched once through the
 * digest-addressed cache of tools/corpus.ts (fixtures/corpora/.downloads/, size and sha256 checked
 * against the corpus locks before any use). Vendor bytes never leave the git-ignored cache.
 */

import {iterateTarGzFiles} from '@intactwarden/core/archive/tar.ts';
import {iterateZipFiles} from '@intactwarden/core/archive/zip.ts';
import {
  fetchBitwardenZip,
  fetchVaultwardenTarball,
  loadBitwardenLock,
  loadVaultwardenLock,
  type BitwardenLock,
  type VaultwardenLock,
} from '../../../../tools/corpus.ts';

/** Files by path ('/' + path below the archive root). */
export type SiteFiles = ReadonlyMap<string, Uint8Array>;

export interface BitwardenRelease {
  readonly lock: BitwardenLock;
  readonly zip: Uint8Array;
  readonly files: SiteFiles;
}

export interface VaultwardenRelease {
  readonly lock: VaultwardenLock;
  readonly tarball: Uint8Array;
  readonly files: SiteFiles;
}

let bw: Promise<BitwardenRelease> | null = null;
let vw: Promise<VaultwardenRelease> | null = null;

export function bitwardenRelease(): Promise<BitwardenRelease> {
  bw ??= (async () => {
    const lock = loadBitwardenLock('2026.10.1');
    const zip = await fetchBitwardenZip(lock);
    const files = new Map<string, Uint8Array>();
    for await (const f of iterateZipFiles(zip, {stripPrefix: lock.release.root})) {
      files.set(f.path, f.bytes);
    }
    return {lock, zip, files};
  })();
  return bw;
}

export function vaultwardenRelease(): Promise<VaultwardenRelease> {
  vw ??= (async () => {
    const lock = loadVaultwardenLock('2026.10.1');
    const tarball = await fetchVaultwardenTarball(lock);
    const files = new Map<string, Uint8Array>();
    for await (const f of iterateTarGzFiles(tarball, {stripPrefix: lock.release.root})) {
      files.set(f.path, new Uint8Array(f.bytes));
    }
    return {lock, tarball, files};
  })();
  return vw;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Marker the tampered Bitwarden main script sets when it runs (checked in the page). */
export const TAMPER_MARKER = '__iwTampered';
/** Marker the injected inline script sets when it runs. */
export const INLINE_MARKER = '__iwInline';
/** Marker the injected inline event-handler attribute sets when it runs. */
export const ATTR_MARKER = '__iwAttr';

/** Marker the tampered Secrets Manager chunk 541 sets when it runs. */
export const SM_TAMPER_MARKER = '__iwSmTampered';

/**
 * The path of webpack chunk `id` of a Bitwarden release (`/<id>.<20 hex>.js`): 541 is the Secrets
 * Manager module, 195 its shared chunk (also loaded by the organisation integrations route).
 */
export function chunkPath(files: SiteFiles, id: number): string {
  const found = [...files.keys()].filter(
    p => p.startsWith(`/${id}.`) && /^\/[0-9]+\.[0-9a-f]{20}\.js$/.test(p),
  );
  if (found.length !== 1) throw new Error(`chunk ${id}: ${found.length} files`);
  return found[0]!;
}

/** The script with one statement appended: the smallest change that is observable when it runs. */
export function tamperScript(js: Uint8Array, marker = TAMPER_MARKER): Uint8Array {
  const suffix = enc.encode(
    `\n;self.${marker} = true; /* appended by the IntactWarden e2e fixture */\n`,
  );
  const out = new Uint8Array(js.length + suffix.length);
  out.set(js, 0);
  out.set(suffix, js.length);
  return out;
}

/**
 * The document with an inline script and an inline event handler (on an image that fails to
 * load) injected before `</head>`: CSP treats the two separately (`script-src` and
 * `script-src-attr`), and IntactWarden's floor enforces `script-src-attr 'none'` everywhere.
 */
export function injectInlineScript(html: Uint8Array): Uint8Array {
  const text = dec.decode(html);
  const at = text.indexOf('</head>');
  if (at < 0) throw new Error('index.html has no </head>');
  const injected =
    `<script>self.${INLINE_MARKER} = true;</script>` +
    `<img src="data:," alt="" onerror="self.${ATTR_MARKER} = true">`;
  return enc.encode(`${text.slice(0, at)}${injected}${text.slice(at)}`);
}
