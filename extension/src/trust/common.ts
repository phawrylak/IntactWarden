/**
 * Shared helpers of the trust modules: the key-value view of storage.local, logging, validators,
 * version ordering and the hosts deep verify may contact. No I/O of its own.
 */

import type {AppId, ReleaseKey, Sha256Hex, VariantId} from '../contracts.ts';
import {GITHUB_HOSTS} from '../contracts.ts';

/** The subset of a storage area the trust store needs (storage.local in production). */
export interface Kv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** Diagnostics without URLs (only redactUrl output) and without page content. */
export type TrustLog = (
  code: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
) => void;

export const noLog: TrustLog = () => undefined;

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const GIT_SHA1 = /^[0-9a-f]{40}$/;
/**
 * A release version "x.y.z", for version hints, release keys and version order. It accepts
 * exactly what the builders' VERSION accepts (packages/builders/src/release.ts), so the builder
 * has a plan for every version that passes here.
 */
export const VERSION_XYZ = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
/** "<owner>/<repo>" as GitHub spells it. */
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
/** Release tags of the bundled profiles ("web-v2026.10.1", "v2026.10.1"). */
export const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Release asset and config file names / repository paths. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
export const REPO_PATH = /^(?![/.])(?!.*\/\/)(?!.*\/\.)[A-Za-z0-9._\-/]{1,300}$/;

export const APPS: readonly AppId[] = Object.freeze(['bitwarden-web', 'vaultwarden-web']);
export const VARIANTS: readonly VariantId[] = Object.freeze([
  'selfhosted-commercial',
  'cloud-us',
  'cloud-eu',
  'release',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSha256(value: unknown): value is Sha256Hex {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isReleaseKey(value: unknown): value is ReleaseKey {
  return (
    isRecord(value) &&
    typeof value['app'] === 'string' &&
    (APPS as readonly string[]).includes(value['app']) &&
    typeof value['variant'] === 'string' &&
    (VARIANTS as readonly string[]).includes(value['variant']) &&
    typeof value['version'] === 'string' &&
    VERSION_XYZ.test(value['version'])
  );
}

/** Compares "x.y.z" versions numerically (malformed versions sort first). */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_XYZ.exec(a);
  const pb = VERSION_XYZ.exec(b);
  if (pa === null || pb === null) return (pa === null ? 0 : 1) - (pb === null ? 0 : 1);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** 16 random lowercase hex characters (job and instance ids). */
export function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Hosts a release download may end on: the API redirects to release-assets (it could also answer
 * with the bytes itself).
 */
export const DOWNLOAD_HOSTS: readonly string[] = Object.freeze([
  new URL(GITHUB_HOSTS.releaseAssets).host,
  new URL(GITHUB_HOSTS.api).host,
]);

export const RAW_HOST = new URL(GITHUB_HOSTS.raw).host;

/**
 * `https://github.com/<repo>/releases/download/<tag>/<asset>`: the address GitHub lists for an
 * asset. Compared with the listing, never fetched.
 */
export function releaseDownloadUrl(repo: string, tag: string, asset: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

/**
 * `https://api.github.com/repositories/<repoId>/releases/assets/<assetId>`: fetched with
 * `Accept: application/octet-stream`, it redirects to the file on release-assets.
 */
export function releaseAssetApiUrl(repoId: number, assetId: number): string {
  return `${GITHUB_HOSTS.api}/repositories/${repoId}/releases/assets/${assetId}`;
}

/** `https://raw.githubusercontent.com/<repo>/<commit>/<path>` (by commit, never by tag). */
export function rawFileUrl(repo: string, commit: string, path: string): string {
  return `${GITHUB_HOSTS.raw}/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function errorName(e: unknown): string {
  if (e instanceof Error) return e.name;
  return typeof e;
}
