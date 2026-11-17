/**
 * Entry-name rules shared by the strict archive readers (zip.ts, tar.ts).
 *
 * Both readers must agree on what a safe entry name is and on when two names
 * collide, so the rules live here once:
 * - a name is a relative path of non-empty segments other than '.' and '..',
 *   without control characters, '\' or ':'; a trailing '/' marks a directory;
 * - two names collide when they are equal after NFC normalisation and case
 *   folding (macOS and Windows file systems would merge them), and no path
 *   may be both a file and a directory (explicitly or as an implicit parent).
 */

/** Minimal view of an archive entry for the collision checks. */
export interface NamedEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export type NameConflict =
  | {readonly code: 'duplicate-name'; readonly message: string}
  | {readonly code: 'path-conflict'; readonly message: string};

/** Returns why `name` is not a safe relative path, or undefined. */
export function entryNameProblem(name: string): string | undefined {
  if (name === '') return 'empty name';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return 'control character in name';
    if (c === 0x5c) return 'backslash in name';
    if (c === 0x3a) return 'colon in name';
  }
  if (name.startsWith('/')) return 'absolute path';
  const body = name.endsWith('/') ? name.slice(0, -1) : name;
  for (const segment of body.split('/')) {
    if (segment === '') return 'empty path segment';
    if (segment === '.' || segment === '..') return 'dot segment in path';
  }
  return undefined;
}

/**
 * Collision key: NFC plus upper- then lower-casing, so names that collide on
 * case-insensitive or normalising file systems (macOS, Windows) are caught.
 * Over-folding only causes extra rejections.
 */
export function foldKey(path: string): string {
  return path.normalize('NFC').toUpperCase().toLowerCase();
}

/**
 * The first duplicate (after folding) or file/directory conflict among
 * `entries`, in entry order, or undefined when the names are consistent.
 */
export function findNameConflict(entries: readonly NamedEntry[]): NameConflict | undefined {
  const seen = new Map<string, NamedEntry>();
  const dirs = new Set<string>();
  const files: Array<[string, NamedEntry]> = [];
  for (const entry of entries) {
    const key = foldKey(entry.isDirectory ? entry.name.slice(0, -1) : entry.name);
    const prev = seen.get(key);
    if (prev !== undefined) {
      if (prev.isDirectory !== entry.isDirectory) {
        return {
          code: 'path-conflict',
          message: `${describeName(entry.name)} is both a file and a directory`,
        };
      }
      return {
        code: 'duplicate-name',
        message:
          prev.name === entry.name
            ? `duplicate entry ${describeName(entry.name)}`
            : `${describeName(prev.name)} and ${describeName(entry.name)} differ only by case or normalisation`,
      };
    }
    seen.set(key, entry);
    if (entry.isDirectory) dirs.add(key);
    else files.push([key, entry]);
    // Every ancestor of an entry is an (implicit) directory.
    for (let i = key.lastIndexOf('/'); i > 0; i = key.lastIndexOf('/', i - 1)) {
      dirs.add(key.slice(0, i));
    }
  }
  for (const [key, entry] of files) {
    if (dirs.has(key)) {
      return {
        code: 'path-conflict',
        message: `${describeName(entry.name)} is both a file and a directory`,
      };
    }
  }
  return undefined;
}

/**
 * True when `name` lies inside `prefix` for iteration with a stripped prefix:
 * below it, or (for a directory entry) the prefix itself or one of its
 * ancestors. An empty prefix contains everything.
 */
export function insidePrefix(entry: NamedEntry, prefix: string): boolean {
  return entry.name.startsWith(prefix) || (entry.isDirectory && prefix.startsWith(entry.name));
}

/** True for a usable stripPrefix: empty, or a safe directory name ending in '/'. */
export function isValidStripPrefix(prefix: string): boolean {
  return prefix === '' || (prefix.endsWith('/') && entryNameProblem(prefix) === undefined);
}

/** Quotes a name for error messages; JSON escaping neutralises control characters. */
export function describeName(name: string): string {
  return JSON.stringify(name);
}

/** True when two raw names are the same bytes. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
