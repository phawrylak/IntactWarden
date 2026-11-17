import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {checkRepositoryLinks, headingAnchors, headingSlug, linkFragment} from './check-links.ts';

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, {recursive: true, force: true});
  root = undefined;
});

function repo(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'intactwarden-links-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('heading anchors (GitHub slugs)', () => {
  it('slugs headings as GitHub does', () => {
    expect(headingSlug('6. Fail-closed rules (R1–R14)')).toBe('6-fail-closed-rules-r1r14');
    expect(headingSlug('`bitwarden-cloud/v1` recipe (normative)')).toBe(
      'bitwarden-cloudv1-recipe-normative',
    );
    expect(headingSlug('Files and entries')).toBe('files-and-entries');
    expect(headingSlug('See [routing](routing.md) §4.5')).toBe('see-routing-45');
    expect(headingSlug('snake_case Ünïcode')).toBe('snake_case-ünïcode');
  });

  it('numbers repeated headings and skips code blocks', () => {
    const md = ['# A', '## A', '```', '# B', '```', '### A #', '<a id="custom"></a>'].join('\n');
    expect([...headingAnchors(md)].sort()).toEqual(['a', 'a-1', 'a-2', 'custom']);
  });

  it('extracts and decodes fragments', () => {
    expect(linkFragment('x.md#a-b')).toBe('a-b');
    expect(linkFragment('#%C3%BC')).toBe('ü');
    expect(linkFragment('x.md')).toBeUndefined();
    expect(linkFragment('https://example.com/#x')).toBeUndefined();
  });
});

describe('checkRepositoryLinks anchors', () => {
  it('reports anchors that name no heading, in other files and in the same file', () => {
    const r = repo({
      'a.md': '# Top\n\n## 4. Paths\n\n[ok](b.md#files-and-entries) [same](#4-paths) [dir](d/)\n',
      'b.md': '# B\n\n## Files and entries\n\n[bad](a.md#5-origins) [self](#nope) [ok](a.md#top)\n',
      'd/x.txt': 'x',
      'c.md': '[ext](https://example.com/#anything) [file](d/x.txt#L3)\n',
    });
    expect(checkRepositoryLinks(r)).toEqual([
      'b.md:5: broken anchor "a.md#5-origins"',
      'b.md:5: broken anchor "#nope"',
    ]);
  });
});

describe('check-links as a script', () => {
  it('checks the given root, also when started through a symlinked path', () => {
    const r = repo({'a.md': '# Top\n\n[ok](#top)\n'});
    const script = fileURLToPath(new URL('./check-links.ts', import.meta.url));
    const link = join(r, 'linked-check-links.ts');
    symlinkSync(script, link);
    for (const path of [script, link]) {
      expect(execFileSync(process.execPath, [path, r], {encoding: 'utf8'}), path).toBe(
        'check-links: OK\n',
      );
    }
  });
});
