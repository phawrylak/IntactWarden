/**
 * Filesystem locations shared by the extension build scripts. Absolute paths, derived from this
 * file's location so the scripts work from any working directory.
 */

import {readFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

/** Repository root (esbuild `absWorkingDir`, so output comments carry stable relative paths). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The `@intactwarden/extension` workspace. */
export const EXTENSION_DIR = join(REPO_ROOT, 'extension');
export const SRC_DIR = join(EXTENSION_DIR, 'src');
/** The reviewed Firefox manifest (manifest.ts). */
export const MANIFEST_PATH = join(EXTENSION_DIR, 'manifest.json');
/** The one i18n catalogue. */
export const LOCALES_DIR = join(EXTENSION_DIR, '_locales');
/** Production builds: `dist/firefox/`, the zip and SHA256SUMS. */
export const DIST_DIR = join(EXTENSION_DIR, 'dist');
/** Test builds (`--test`): `dist-test/firefox/`. Never packaged. */
export const DIST_TEST_DIR = join(EXTENSION_DIR, 'dist-test');

/**
 * The one package IntactWarden ships: desktop Firefox. Names the build directory
 * (`dist/firefox/`) and the zip (`intactwarden-<version>-firefox.zip`).
 */
export const PACKAGE_NAME = 'firefox';

/** Store versions are plain MAJOR.MINOR.PATCH (AMO accepts it; docs/release.md). */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** The extension version: `version` of extension/package.json, checked to be MAJOR.MINOR.PATCH. */
export function extensionVersion(): string {
  const pkg = JSON.parse(readFileSync(join(EXTENSION_DIR, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) {
    throw new Error(`extension/package.json: version must be MAJOR.MINOR.PATCH`);
  }
  return pkg.version;
}

/** Forward-slash path of `abs` relative to the repository root (for messages). */
export function repoRelative(abs: string): string {
  const rel = abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length) : abs;
  return rel.split('\\').join('/');
}

/** True when the module at `moduleUrl` is the script Node was started with (CLI entry check). */
export function isMain(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}
