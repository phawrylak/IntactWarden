import {describe, expect, it} from 'vitest';
import type {SlotOccurrence} from '@intactwarden/core/template/build.ts';
import {checkHtmlSlots, checkJsSlots, ContextError} from '../src/contexts.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Occurrence of the `nth` `needle` in `text`, by byte offset. */
function at(text: string, needle = 'abc123', slot = 'CACHE_TAG', nth = 0): SlotOccurrence {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`no ${needle} in test input`);
  const offset = enc(text.slice(0, i)).length;
  return {offset, length: enc(needle).length, slot};
}

function js(text: string, occurrences = [at(text)]): void {
  checkJsSlots(enc(text), occurrences);
}

function html(text: string, occurrences = [at(text)]): void {
  checkHtmlSlots(enc(text), occurrences);
}

const HASH = '0123456789abcdef0123';
const TAIL = `\n//# sourceMappingURL=main.${HASH}.js.map`;

describe('checkJsSlots: the lexical rule of the derivation', () => {
  it('accepts CACHE_TAG at a ?cache= site and a hash in the final sourceMappingURL line', () => {
    const text = `const t="x/messages.json?cache=abc123",u="scripts/dropin.js?cache=abc123";${TAIL}`;
    expect(() =>
      js(text, [at(text), at(text, 'abc123', 'CACHE_TAG', 1), at(text, HASH, 'MAIN')]),
    ).not.toThrow();
  });

  it('accepts a connector map name (letters, digits, ".", "-" and "_")', () => {
    const text = `f();\n//# sourceMappingURL=duo-redirect.${HASH}.js.map`;
    expect(() => js(text, [at(text, HASH, 'DUO_JS')])).not.toThrow();
  });

  it('maps byte offsets through multi-byte characters and a BOM', () => {
    const text = `\uFEFFvar z="Zürich €𝄞";var a="?cache=abc123";${TAIL}`;
    expect(() => js(text)).not.toThrow();
    const o = at(text);
    // The same slot shifted by one byte no longer follows ?cache= and ends before the quote.
    expect(() => checkJsSlots(enc(text), [{...o, offset: o.offset + 1}])).toThrow(ContextError);
  });

  it('refuses a CACHE_TAG not directly between ?cache= and a double quote', () => {
    for (const text of [
      'var abc123=1;',
      'var a="abc123";',
      'var a="?cache=abc123x";',
      "var a='?cache=abc123';",
      'var a=`?cache=abc123`;',
      'var a="?cache=abc123\\"',
      'var a="cache=abc123";',
    ]) {
      expect(() => js(text), text).toThrow(ContextError);
    }
  });

  it('refuses a hash slot outside the final sourceMappingURL line', () => {
    const cases = [
      `var a="${HASH}";${TAIL}`,
      // The last line starts with // but closes a block comment or a template literal that an
      // earlier line opened, so the slot after it would be code.
      `var v=1;/*\n// */ v=0x${HASH};`,
      'var v=`\n//` ;v=0x' + HASH + ';',
      `var v=1;/*\n//# sourceMappingURL=*/v=0x${HASH};`,
      `var v="\\\n//# sourceMappingURL=main.";v=0x${HASH};`,
      // A // line that is not exactly the sourceMappingURL site.
      `f();\n// ${HASH}`,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map;`,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map `,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map\``,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map'`,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map"`,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map*/`,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map\\`,
      `f();\n //# sourceMappingURL=main.${HASH}.js.map`,
      `//# sourceMappingURL=main.${HASH}.js.map\nf();`,
      `f();\n/*# sourceMappingURL=main.${HASH}.js.map */`,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map\rg();`,
      `f();\n//# sourceMappingURL=main.${HASH}.js.map\u2028g();`,
    ];
    for (const text of cases) {
      expect(() => js(text, [at(text, HASH, 'MAIN')]), JSON.stringify(text)).toThrow(ContextError);
    }
    // A CACHE_TAG is never accepted in the comment line.
    const tail = `f();\n//# abc123`;
    expect(() => js(tail)).toThrow(ContextError);
  });

  it('refuses bad occurrences', () => {
    const b = enc('var a="?cache=abc123";');
    expect(() => checkJsSlots(b, [{offset: 0, length: 3, slot: 'X'}])).toThrow(/out of bounds/);
    expect(() => checkJsSlots(b, [{offset: 10, length: 99, slot: 'X'}])).toThrow(/out of bounds/);
    const u = enc('var a="?cache=é";');
    expect(() => checkJsSlots(u, [{offset: 14, length: 1, slot: 'CACHE_TAG'}])).toThrow(
      /non-ASCII/,
    );
  });
});

describe('checkHtmlSlots', () => {
  it('accepts double-quoted src and href values', () => {
    expect(() => html('<script defer="defer" src="app/main.abc123.js"></script>')).not.toThrow();
    expect(() => html('<LINK REL=stylesheet HREF="styles.abc123.css">')).not.toThrow();
    expect(() => html('<img\nsrc = "abc123.png"/>')).not.toThrow();
  });

  it('rejects other attributes and other quoting', () => {
    for (const text of [
      '<a onclick="go(abc123)">x</a>',
      '<a style="x:abc123">x</a>',
      '<iframe srcdoc="abc123"></iframe>',
      "<script src='abc123.js'></script>",
      '<script src=abc123.js></script>',
    ]) {
      expect(() => html(text), text).toThrow(ContextError);
    }
  });

  it('rejects text, comments, raw text and end-tag attributes', () => {
    for (const text of [
      '<p>abc123</p>',
      '<!-- <script src="abc123.js"></script> -->',
      '<script>var s="<img src=\\"abc123\\">"</script>',
      '<style>a[src="abc123"]{}</style>',
      '<textarea><img src="abc123"></textarea>',
      '<title><img src="abc123"></title>',
      '<noscript><img src="abc123"></noscript>',
      '<p></p src="abc123">',
      '<!doctype html src="abc123">',
    ]) {
      expect(() => html(text), text).toThrow(ContextError);
    }
  });

  it('ends raw text only at the matching end tag', () => {
    const text = '<script>a="</scripty>";</SCRIPT ><img src="abc123">';
    expect(() => html(text)).not.toThrow();
  });

  it('fails closed on constructs the scanner does not model', () => {
    for (const [text, reason] of [
      ['<!--> <img src="abc123">', /abruptly closed comment/],
      ['<!---> <img src="abc123">', /abruptly closed comment/],
      ['<!-- a --!> <img src="abc123"> -->', /--!>/],
      ['<svg><![CDATA[ x ]]></svg><img src="abc123">', /CDATA/],
      ['<script><!-- </script> --></script><img src="abc123">', /inside a script element/],
      ['<img src="abc123"', /end of file inside <img>/],
      ['<img src="abc123', /end of file inside <img>/],
      ['<!-- <img src="abc123">', /unterminated comment/],
    ] as const) {
      expect(() => html(text), text).toThrow(reason);
    }
  });
});
