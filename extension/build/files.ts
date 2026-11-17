/**
 * Package file listing shared by bundle-lint and packaging. A package directory holds
 * regular files only: a symbolic link, device or other special file is an error (fail closed), so
 * a zip can never pick up something outside the build output.
 */

import {lstat, readdir} from 'node:fs/promises';
import {join} from 'node:path';

/** Package paths: ASCII letters, digits, `.`, `_`, `-`, `@` and `/` separators, no dot segments. */
const PACKAGE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/;

export function isPackagePath(path: string): boolean {
  return PACKAGE_PATH.test(path);
}

/** Sorted forward-slash relative paths of every regular file below `dir` (byte order). */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel === '' ? dir : join(dir, rel);
    const entries = await readdir(abs, {withFileTypes: true});
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const st = await lstat(join(dir, childRel));
      if (st.isDirectory()) await walk(childRel);
      else if (st.isFile()) out.push(childRel);
      else throw new Error(`${childRel}: not a regular file or directory`);
    }
  };
  await walk('');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
