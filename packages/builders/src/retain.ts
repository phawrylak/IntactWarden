/**
 * Which file bytes the release loader keeps. A core needs every file's SHA-256 and size, but the
 * version checks and the cloud derivation read the bytes of only a few files:
 *
 * - every HTML document (the cloud HTML templates);
 * - `/version.json` (Bitwarden, Vaultwarden) and `/vw-version.json` (Vaultwarden);
 * - main (`/app/main.<20 hex>.js`, the cloud main template);
 * - the two connector scripts the cloud derivation templates
 *   (`/connectors/duo-redirect.<20 hex>.js`, `/connectors/webauthn-fallback.<20 hex>.js`).
 *
 * The loader keeps exactly these bytes and drops the rest after hashing, so a deep verify holds a
 * few MB instead of the whole release. A file whose bytes a check needs but the loader did not keep
 * fails the build (`bytesOf`); it is never skipped.
 */

import {classifyPath, RefusalError} from './files.ts';

const CHECKED_FILES: ReadonlySet<string> = new Set(['/version.json', '/vw-version.json']);
/** Main and the cloud derivation's connector scripts (bitwarden/cloudCore.ts `SCRIPTS`). */
const CHECKED_SCRIPT =
  /^\/(?:app\/main|connectors\/duo-redirect|connectors\/webauthn-fallback)\.[0-9a-f]{20}\.js$/;

/** True for a manifest path whose bytes a check or the cloud derivation reads. */
export function isCheckedPath(path: string): boolean {
  return CHECKED_FILES.has(path) || CHECKED_SCRIPT.test(path) || classifyPath(path) === 'document';
}

/** The bytes of a file the loader kept; a missing one is a builder bug and fails the build. */
export function bytesOf(file: {readonly bytes?: Uint8Array} | undefined, path: string): Uint8Array {
  if (file?.bytes === undefined) {
    throw new RefusalError(`${path}: its bytes were not retained by the loader`, 'unsupported');
  }
  return file.bytes;
}
