/**
 * Relative-link check for the repository's Markdown files.
 *
 * Usage: node tools/check-links.ts [repoRoot]
 *
 * Finds inline links and images `[text](target)` and reference definitions
 * `[label]: target` outside code blocks and code spans, and verifies that each
 * relative target exists inside the repository. Links with a URL scheme
 * (http:, https:, mailto:, ...) and protocol-relative links are ignored;
 * ?queries are stripped. A leading "/" is resolved against the repository
 * root, as GitHub does. A #fragment on a link to a Markdown file (or a pure
 * #anchor, which names the same file) must name a heading anchor of that file,
 * computed as GitHub does (see headingAnchors), or an explicit
 * `<a id="...">` / `<a name="...">`.
 *
 * Only node: built-ins; Node >= 22.18 runs this file directly (type stripping).
 */

import {existsSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, join, posix, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export interface MarkdownLink {
  target: string;
  /** 1-based line number. */
  line: number;
}

/**
 * Skipped while walking. node_modules and VCS data are not ours; .cache and
 * .downloads hold untrusted downloaded vendor data (see .gitignore).
 */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.cache', '.downloads', 'dist', 'coverage']);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// `](target)` or `](target "title")`; the target may be <bracketed> or contain
// one level of balanced parentheses. This also catches images and links that
// wrap images, such as [![alt](img.svg)](page.md).
const INLINE_LINK =
  /\]\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:\s*(<[^<>\n]*>|\S+)/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Replaces code spans with spaces so that links inside them are not extracted. */
function blankCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    let run = 0;
    while (line[i + run] === '`') run++;
    const ticks = '`'.repeat(run);
    let close = line.indexOf(ticks, i + run);
    // The closing run must have exactly the same length.
    while (close !== -1 && line[close + run] === '`') {
      let skip = close;
      while (line[skip] === '`') skip++;
      close = line.indexOf(ticks, skip);
    }
    if (close === -1) {
      out += ticks;
      i += run;
      continue;
    }
    out += ' '.repeat(close + run - i);
    i = close + run;
  }
  return out;
}

export function extractLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let fence: string | undefined;
  markdown.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, '');
    const fenceMatch = FENCE.exec(line);
    if (fence !== undefined) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) {
        if (line.slice(fenceMatch[0].length).trim() === '') fence = undefined;
      }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      return;
    }
    const text = blankCodeSpans(line);
    const definition = REFERENCE_DEFINITION.exec(text);
    if (definition) links.push({target: definition[1]!, line: index + 1});
    for (const match of text.matchAll(INLINE_LINK)) {
      links.push({target: match[1]!, line: index + 1});
    }
  });
  return links;
}

/**
 * GitHub's heading id: inline markup reduced to its text, lowercased, every
 * character other than letters, marks, numbers, "_", "-" and spaces removed,
 * spaces turned into "-".
 */
export function headingSlug(heading: string): string {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images → their text
    .replace(/<[^>]*>/g, '') // inline HTML
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '').replaceAll(' ', '-');
}

/**
 * Anchors of a Markdown file: the slugs of its ATX headings outside code
 * blocks (repeated slugs get "-1", "-2", ... as on GitHub) and explicit
 * `<a id>` / `<a name>` targets.
 */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let fence: string | undefined;
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const fenceMatch = FENCE.exec(line);
    if (fence !== undefined) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) {
        if (line.slice(fenceMatch[0].length).trim() === '') fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(m[1]!);
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading === null) continue;
    const base = headingSlug(heading[1]!);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

/** The decoded #fragment of a link target, or undefined if it has none. */
export function linkFragment(target: string): string | undefined {
  const value = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
  if (value.startsWith('//') || URL_SCHEME.test(value)) return undefined;
  const hash = value.indexOf('#');
  if (hash === -1 || hash === value.length - 1) return undefined;
  return decodeURIComponent(value.slice(hash + 1));
}

/**
 * Returns the decoded relative path a link points at, or undefined if the
 * link is not checked (external, anchor-only or empty). Throws on malformed
 * percent-encoding.
 */
export function localLinkPath(target: string): string | undefined {
  let value = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
  if (value === '' || value.startsWith('#') || value.startsWith('//') || URL_SCHEME.test(value)) {
    return undefined;
  }
  const cut = value.search(/[?#]/);
  if (cut !== -1) value = value.slice(0, cut);
  if (value === '') return undefined;
  return decodeURIComponent(value);
}

function listMarkdownFiles(root: string, dir: string, out: string[]): void {
  for (const dirent of readdirSync(join(root, dir), {withFileTypes: true})) {
    const rel = posix.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (!SKIPPED_DIRS.has(dirent.name)) listMarkdownFiles(root, rel, out);
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
      out.push(rel);
    }
  }
}

/** Checks all Markdown files under `root`. Returns "file:line: message" strings. */
export function checkRepositoryLinks(root: string): string[] {
  const absoluteRoot = resolve(root);
  const files: string[] = [];
  listMarkdownFiles(absoluteRoot, '', files);
  const problems: string[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (absolute: string): Set<string> => {
    let anchors = anchorCache.get(absolute);
    if (anchors === undefined) {
      anchors = headingAnchors(readFileSync(absolute, 'utf8'));
      anchorCache.set(absolute, anchors);
    }
    return anchors;
  };
  for (const file of files.sort()) {
    const markdown = readFileSync(join(absoluteRoot, file), 'utf8');
    for (const {target, line} of extractLinks(markdown)) {
      const where = `${file}:${line}`;
      let path: string | undefined;
      let fragment: string | undefined;
      try {
        path = localLinkPath(target);
        fragment = linkFragment(target);
      } catch {
        problems.push(`${where}: malformed link target ${JSON.stringify(target)}`);
        continue;
      }
      let resolved: string;
      if (path === undefined) {
        // A pure "#anchor" names the file itself; other skipped links are external.
        const bare = target.startsWith('<') ? target.slice(1) : target;
        if (!bare.startsWith('#') || fragment === undefined) continue;
        resolved = join(absoluteRoot, file);
      } else {
        resolved = path.startsWith('/')
          ? join(absoluteRoot, path)
          : resolve(absoluteRoot, dirname(file), path);
        const fromRoot = relative(absoluteRoot, resolved);
        if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
          problems.push(`${where}: link ${JSON.stringify(target)} points outside the repository`);
          continue;
        }
        if (!existsSync(resolved)) {
          problems.push(`${where}: broken link ${JSON.stringify(target)}`);
          continue;
        }
      }
      if (fragment === undefined || !resolved.toLowerCase().endsWith('.md')) continue;
      if (!anchorsOf(resolved).has(fragment)) {
        problems.push(`${where}: broken anchor ${JSON.stringify(target)}`);
      }
    }
  }
  return problems;
}

function main(): void {
  const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
  const problems = checkRepositoryLinks(root);
  if (problems.length > 0) {
    for (const message of problems) console.error(`check-links: ${message}`);
    console.error(`check-links: FAILED with ${problems.length} broken link(s)`);
    process.exitCode = 1;
    return;
  }
  console.log('check-links: OK');
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
