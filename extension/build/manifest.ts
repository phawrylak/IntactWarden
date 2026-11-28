/**
 * The Firefox manifest (docs/security.md). `extension/manifest.json` is the reviewed manifest
 * in its final form; the build checks that its `version` is the version of extension/package.json
 * and, for a test build, appends the loopback hosts of `TEST_HOST_PERMISSIONS` to
 * `host_permissions`.
 *
 * The expected host-permission set is computed independently by `generatedHostPermissions()`
 * (official origins of the bundled profiles + `GITHUB_PERMISSION_PATTERNS`), and bundle-lint
 * requires `host_permissions` to equal it exactly; the static content script matches only the
 * official origins.
 */

import {readFile} from 'node:fs/promises';
import {OFFICIAL_ORIGINS} from '@intactwarden/profiles';
import {GITHUB_PERMISSION_PATTERNS} from '../src/contracts.ts';
import {MANIFEST_PATH} from './paths.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Loopback hosts of test builds; never in a production build. */
export const TEST_HOST_PERMISSIONS = Object.freeze(['http://127.0.0.1/*', 'http://localhost/*']);

/** `https://host` → `https://host/*`. An origin with a port is refused. */
export function originMatchPattern(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.port !== '') {
    throw new Error(`not a canonical https origin without a port: ${origin}`);
  }
  return `https://${url.hostname}/*`;
}

/** Match patterns of the official origins (sorted, as `OFFICIAL_ORIGINS`). */
export function officialMatchPatterns(origins: readonly string[] = OFFICIAL_ORIGINS): string[] {
  return origins.map(originMatchPattern);
}

/**
 * The generated required host-permission set (docs/security.md):
 * official origins, then the two GitHub hosts, then (test builds) the loopback hosts.
 */
export function generatedHostPermissions(options: {readonly test: boolean}): string[] {
  return [
    ...officialMatchPatterns(),
    ...GITHUB_PERMISSION_PATTERNS,
    ...(options.test ? TEST_HOST_PERMISSIONS : []),
  ];
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The manifest as the build writes it. */
export async function buildManifest(options: {
  readonly test: boolean;
  readonly version: string;
}): Promise<JsonObject> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as JsonObject;
  if (manifest['version'] !== options.version) {
    throw new Error(`extension/manifest.json: version must be ${options.version}`);
  }
  const hosts = manifest['host_permissions'];
  if (options.test && Array.isArray(hosts)) {
    manifest['host_permissions'] = [...hosts, ...TEST_HOST_PERMISSIONS];
  }
  return manifest;
}

/**
 * Serialisation written to `manifest.json`, in the encoding AMO writes it in when it signs a package
 * (Python's `json.dumps(manifest, indent=2)`): key order of extension/manifest.json, two-space
 * indent, every character outside printable ASCII as a `\u` escape, no final newline. The package
 * AMO serves then holds the same bytes as the release zip, file for file.
 */
export function serializeManifest(manifest: JsonObject): string {
  return JSON.stringify(manifest, null, 2).replace(
    /[\u007f-\uffff]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** esbuild's syntax target: the manifest's minimum Firefox version, so the bundle never needs more. */
export function esbuildTargets(manifest: JsonObject): string[] {
  const bss = manifest['browser_specific_settings'];
  const gecko = isObject(bss) ? bss['gecko'] : undefined;
  const v = isObject(gecko) ? gecko['strict_min_version'] : undefined;
  if (typeof v !== 'string' || !/^\d+(\.0)?$/.test(v)) {
    throw new Error('browser_specific_settings.gecko.strict_min_version');
  }
  return [`firefox${Number.parseInt(v, 10)}`];
}
