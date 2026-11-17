/**
 * The builder fingerprint: a SHA-256 over the sources that decide a core's bytes and how the
 * extension reads a stored core (FINGERPRINT_SOURCES). build.ts bundles it in place of
 * extension/src/trust/fingerprint.ts, and the trust store drops the cores built in the browser
 * when it changes (store.ts). A pure function of those files, so the double build stays
 * byte-identical; any change to them, a comment included, gives a new fingerprint.
 */

import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {listFiles} from './files.ts';
import {REPO_ROOT} from './paths.ts';

/** Repository paths (directories or files) whose `.ts` sources, tests excluded, are hashed. */
export const FINGERPRINT_SOURCES: readonly string[] = Object.freeze([
  // The core modules the builders and coresDb.ts load at run time. They import the other core
  // directories (privacy, style, verdict) as types at most, so those cannot change a core.
  'packages/core/src/archive',
  'packages/core/src/derive',
  'packages/core/src/hash',
  'packages/core/src/jcs',
  'packages/core/src/routing',
  'packages/core/src/schema',
  'packages/core/src/template',
  'packages/builders/src',
  // The builders take repositories, assets and paths from the profiles.
  'packages/profiles',
  // Parses and checks a stored core.
  'extension/src/trust/coresDb.ts',
]);

const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

/** The fingerprint of `files` (repository path → bytes); independent of their order. */
export function builderFingerprint(files: ReadonlyMap<string, Uint8Array>): string {
  const lines = [...files]
    .map(([path, bytes]) => `${path}\u0000${sha256(bytes)}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(lines.join(''));
}

/** Reads the FINGERPRINT_SOURCES files below `root`, keyed by repository path. */
export async function readFingerprintSources(root = REPO_ROOT): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const source of FINGERPRINT_SOURCES) {
    const abs = join(root, ...source.split('/'));
    const paths = (await stat(abs)).isDirectory()
      ? (await listFiles(abs)).map(p => `${source}/${p}`)
      : [source];
    for (const path of paths) {
      const segments = path.split('/');
      if (!path.endsWith('.ts') || segments.includes('test') || segments.includes('node_modules'))
        continue;
      out.set(path, new Uint8Array(await readFile(join(root, ...segments))));
    }
  }
  return out;
}

export async function computeBuilderFingerprint(root = REPO_ROOT): Promise<string> {
  return builderFingerprint(await readFingerprintSources(root));
}
