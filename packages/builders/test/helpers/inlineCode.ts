/**
 * The maintainer's check of the inline-code fact behind the CSP floor on the
 * pinned releases (corpus tests): no HTML document has an inline script (a `<script>` without `src`
 * or with content) or an `on*` attribute, so the enforced `script-src-attr 'none'` and `script-src`
 * floors break nothing. A crude scan over the lower-cased text: a hit only makes a human look. The
 * extension does not run it; inline code on a protected page is caught by the DOM sentinel
 * (extension/src/content/sentinel.ts) and blocked by the CSP floor.
 */

const decoder = new TextDecoder();

/** The HTML documents among `files` and what the scan found in them (empty: none). */
export function inlineCodeIn(files: ReadonlyMap<string, {readonly bytes?: Uint8Array}>): {
  documents: string[];
  findings: string[];
} {
  const documents: string[] = [];
  const findings: string[] = [];
  for (const [path, file] of files) {
    if (!path.endsWith('.html')) continue;
    documents.push(path);
    const text = decoder.decode(file.bytes).toLowerCase();
    for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script/g)) {
      if (!/\ssrc\s*=/.test(m[1]!) || m[2]!.trim() !== '')
        findings.push(`${path}: inline <script>`);
    }
    if (/<[^>]*\son[a-z]+\s*=/.test(text)) findings.push(`${path}: on* attribute`);
  }
  return {documents: documents.sort(), findings};
}
