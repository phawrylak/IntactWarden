/**
 * File-level helpers of the builders: archive member name → manifest key, and
 * file extension → resource class.
 *
 * The extension table is closed. A file type that is not listed fails the
 * build, so a new kind of file in an upstream release is reviewed by a human
 * instead of being classified silently (a script taken for passive data would
 * escape the active-content rules).
 */

import {normalizePath} from '@intactwarden/core/routing/normalizePath.ts';
import {pathProblem} from '@intactwarden/core/schema/validate.ts';
import type {ResourceClass} from '@intactwarden/core/schema/manifest.ts';
import type {BuildRefusal} from './api.ts';

/**
 * A release or core the builders refuse. `refusal` is the stable code that
 * CoreBuilder.build reports as BuildError.code (src/api.ts). The message is
 * for logs only.
 */
export class RefusalError extends Error {
  override name = 'RefusalError';
  readonly refusal: BuildRefusal;
  constructor(message: string, refusal: BuildRefusal) {
    super(message);
    this.refusal = refusal;
  }
}

/** Resource class by lowercase file extension. */
const KINDS: ReadonlyMap<string, ResourceClass> = new Map<string, ResourceClass>([
  ['html', 'document'],
  ['htm', 'document'],
  ['js', 'script'],
  ['mjs', 'script'],
  ['css', 'style'],
  ['wasm', 'wasm'],
  ['map', 'sourcemap'],
  ['json', 'data'],
  ['webmanifest', 'data'],
  ['txt', 'data'],
  ['xml', 'data'],
  ['woff', 'font'],
  ['woff2', 'font'],
  ['ttf', 'font'],
  ['otf', 'font'],
  ['svg', 'image'],
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['gif', 'image'],
  ['webp', 'image'],
  ['avif', 'image'],
  ['ico', 'image'],
  ['mp4', 'media'],
  ['webm', 'media'],
  ['mp3', 'media'],
  ['ogg', 'media'],
  ['wav', 'media'],
]);

/**
 * Resource class of a manifest path, by its lowercase extension. A file without an
 * extension (`/.nojekyll`; a leading dot does not start one) is passive data.
 * Throws RefusalError for an extension that is not in the closed table.
 */
export function classifyPath(path: string): ResourceClass {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'data';
  const ext = name.slice(dot + 1).toLowerCase();
  const kind = KINDS.get(ext);
  if (kind === undefined) {
    throw new RefusalError(
      `unknown file type ".${ext}" (${path}); add it to builders/src/files.ts`,
      'unsupported',
    );
  }
  return kind;
}

/**
 * Manifest key for an archive member path ("/" + name below the archive
 * root): the normalised URL path a browser requests for that file. Literal
 * "%", "?" and "#" in a member name are percent-encoded first, because a
 * static server maps the decoded request path to the file name.
 */
export function manifestKey(memberPath: string): string {
  let key: string;
  try {
    key = normalizePath(
      memberPath.replaceAll('%', '%25').replaceAll('?', '%3F').replaceAll('#', '%23'),
    );
  } catch (e) {
    throw new RefusalError(
      `unservable file name ${JSON.stringify(memberPath)}: ${String(e)}`,
      'archive-invalid',
    );
  }
  const problem = pathProblem(key);
  if (problem !== null) {
    throw new RefusalError(
      `unservable file name ${JSON.stringify(memberPath)}: ${problem}`,
      'archive-invalid',
    );
  }
  return key;
}

/** Code-unit order, so that output never depends on the locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
