/**
 * Shared helpers for corpus tests (`*.corpus.test.ts`, opt-in with
 * INTACTWARDEN_CORPUS=1): pinned downloads of upstream release assets and the corpus
 * lock files in fixtures/corpora/.
 *
 * Vendor bytes are never committed. They are fetched at test time, checked
 * against the size and sha256 pinned in a lock file before any use, and
 * cached only in the git-ignored fixtures/corpora/.downloads/, under their
 * digest. Behind an HTTPS proxy, run Node with NODE_USE_ENV_PROXY=1.
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';

/**
 * True when corpus tests are enabled: under `npm run test:corpus` (npm sets npm_lifecycle_event on
 * every platform, cmd.exe included) or with INTACTWARDEN_CORPUS=1.
 */
export const CORPUS_ENABLED =
  process.env['INTACTWARDEN_CORPUS'] === '1' ||
  process.env['npm_lifecycle_event'] === 'test:corpus';

export const REPO_ROOT = new URL('../', import.meta.url);
export const DOWNLOADS = new URL('fixtures/corpora/.downloads/', REPO_ROOT);

const DIGEST = /^[0-9a-f]{64}$/;

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Returns the bytes at `url` (redirects followed), from the digest-addressed
 * cache when present. Size and digest are checked before the bytes are used
 * or cached; a cached file that fails the check is an error, never refetched.
 */
export async function fetchPinned(url: string, digest: string, size?: number): Promise<Uint8Array> {
  if (!DIGEST.test(digest)) throw new Error(`bad pinned digest for ${url}`);
  const cached = new URL(`${digest}-${basename(new URL(url).pathname)}`, DOWNLOADS);
  const check = (bytes: Uint8Array, where: string): Uint8Array => {
    if (size !== undefined && bytes.length !== size) {
      throw new Error(`${where}: size ${bytes.length}, pinned ${size}`);
    }
    const actual = sha256(bytes);
    if (actual !== digest) throw new Error(`${where}: sha256 ${actual}, pinned ${digest}`);
    return bytes;
  };
  try {
    return check(new Uint8Array(await readFile(cached)), cached.pathname);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const bytes = check(new Uint8Array(await res.arrayBuffer()), url);
  await mkdir(DOWNLOADS, {recursive: true});
  const tmp = new URL(`${basename(cached.pathname)}.${process.pid}.tmp`, DOWNLOADS);
  await writeFile(tmp, bytes);
  await rename(tmp, cached);
  return bytes;
}

// ---------------------------------------------------------------------------
// fixtures/corpora/bitwarden-web-<version>.lock.json

export interface PinnedConfigFile {
  path: string;
  commit: string;
  url: string;
  sha256: string;
}

export interface BitwardenScriptNames {
  cache_tag: string;
  main_name: string;
  duo_js_name: string;
  webauthn_fb_js_name: string;
}

export interface BitwardenRegionLock extends BitwardenScriptNames {
  env: 'cloud' | 'euprd';
  origin: string;
  observed_at: string;
  /** Live files by path: sha256 and size of the decoded body. */
  expected: Record<string, {sha256: string; size: number}>;
}

export interface BitwardenLock {
  release: {
    repo: string;
    tag: string;
    commit: string;
    asset: string;
    url: string;
    sha256: string;
    size: number;
    root: string;
  };
  config: Record<'base' | 'cloud' | 'euprd', PinnedConfigFile>;
  selfhosted: BitwardenScriptNames;
  regions: Record<string, BitwardenRegionLock>;
  unchanged: {
    non_map_files: number;
    derived_files: number;
    files: number;
    set_sha256: string;
    sample: Record<string, string>;
  };
}

export function loadBitwardenLock(version = '2026.10.1'): BitwardenLock {
  const url = new URL(`fixtures/corpora/bitwarden-web-${version}.lock.json`, REPO_ROOT);
  return JSON.parse(readFileSync(url, 'utf8')) as BitwardenLock;
}

/** Raw URL of a config file at its pinned commit (never a branch). */
export function configUrl(lock: BitwardenLock, file: PinnedConfigFile): string {
  return `https://raw.githubusercontent.com/${lock.release.repo}/${file.commit}/${file.path}`;
}

/** The release zip of a lock, fetched and checked against its pinned size and digest. */
export async function fetchBitwardenZip(lock: BitwardenLock): Promise<Uint8Array> {
  const {release} = lock;
  const expectedUrl = `https://github.com/${release.repo}/releases/download/${release.tag}/${release.asset}`;
  if (release.url !== expectedUrl) throw new Error(`lock: release url must be ${expectedUrl}`);
  return fetchPinned(release.url, release.sha256, release.size);
}

/** The config files of a lock (raw bytes), each checked against its pinned digest. */
export async function fetchBitwardenConfigs(
  lock: BitwardenLock,
): Promise<Record<'base' | 'cloud' | 'euprd', Uint8Array>> {
  const out = {} as Record<'base' | 'cloud' | 'euprd', Uint8Array>;
  for (const name of ['base', 'cloud', 'euprd'] as const) {
    const file = lock.config[name];
    if (file.commit !== lock.release.commit) throw new Error(`lock: ${name} not at the tag commit`);
    if (file.url !== configUrl(lock, file)) throw new Error(`lock: ${name} url mismatch`);
    out[name] = await fetchPinned(file.url, file.sha256);
  }
  return out;
}

// ---------------------------------------------------------------------------
// fixtures/corpora/vaultwarden-web-<version>.lock.json

export interface PinnedReleaseAsset {
  asset: string;
  url: string;
  sha256: string;
  size: number;
}

export interface VaultwardenLock {
  release: PinnedReleaseAsset & {
    repo: string;
    repo_id: number;
    tag: string;
    commit: string;
    tag_object: string;
    root: string;
  };
  files: {
    count: number;
    total_size: number;
    non_map_files: number;
    sourcemaps: number;
    documents: number;
    set_sha256: string;
    sample: Record<string, string>;
  };
}

export function loadVaultwardenLock(version = '2026.10.1'): VaultwardenLock {
  const url = new URL(`fixtures/corpora/vaultwarden-web-${version}.lock.json`, REPO_ROOT);
  return JSON.parse(readFileSync(url, 'utf8')) as VaultwardenLock;
}

/** Download URL of a release asset (never a redirect target or a mirror). */
function releaseAssetUrl(lock: VaultwardenLock, asset: string): string {
  const {repo, tag} = lock.release;
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

async function fetchVaultwardenAsset(lock: VaultwardenLock, pin: PinnedReleaseAsset) {
  const expectedUrl = releaseAssetUrl(lock, pin.asset);
  if (pin.url !== expectedUrl) throw new Error(`lock: ${pin.asset} url must be ${expectedUrl}`);
  return fetchPinned(pin.url, pin.sha256, pin.size);
}

/** The release tarball of a lock, fetched and checked against its pinned size and digest. */
export async function fetchVaultwardenTarball(lock: VaultwardenLock): Promise<Uint8Array> {
  return fetchVaultwardenAsset(lock, lock.release);
}
