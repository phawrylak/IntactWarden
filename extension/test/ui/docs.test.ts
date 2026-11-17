/**
 * Links to the user documentation (src/ui/shared/docs.ts): every linked file exists in the
 * repository, every #anchor names a heading of that file (as tools/check-links.ts computes it), and
 * the URLs are plain https links that the DOM helpers accept.
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {headingAnchors} from '../../../tools/check-links.ts';
import {USER_DOCS, USER_DOCS_BASE, userDocUrl, type UserDocPage} from '../../src/ui/shared/docs.ts';
import {isSafeHref} from '../../src/ui/shared/dom.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');

describe('user documentation links', () => {
  it('point at docs/ on the default branch of this repository on GitHub', () => {
    expect(USER_DOCS_BASE).toBe('https://github.com/phawrylak/IntactWarden/blob/main/docs/');
    expect(userDocUrl('guide')).toBe(`${USER_DOCS_BASE}guide.md`);
  });

  it('name files that exist in docs/ and anchors that match a heading', () => {
    const pages = Object.keys(USER_DOCS) as UserDocPage[];
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const url = userDocUrl(page);
      expect(isSafeHref(url), url).toBe(true);
      const [file, anchor] = url.slice(USER_DOCS_BASE.length).split('#') as [string, string?];
      const path = join(REPO, 'docs', file);
      expect(existsSync(path), path).toBe(true);
      if (anchor !== undefined) {
        expect(headingAnchors(readFileSync(path, 'utf8')).has(anchor), url).toBe(true);
      }
    }
  });
});
