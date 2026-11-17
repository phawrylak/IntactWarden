// The purity rule for packages/core, packages/builders and extension/src/policy (no DOM, Node or
// extension globals), checked against the repository's ESLint config.
import {fileURLToPath} from 'node:url';
import {ESLint} from 'eslint';
import {describe, expect, it} from 'vitest';

const eslint = new ESLint({cwd: fileURLToPath(new URL('..', import.meta.url))});

async function problems(code: string, file = 'packages/core/src/__purity_probe__.ts') {
  const [result] = await eslint.lintText(code, {filePath: file});
  return (result?.messages ?? []).map(m => `${m.ruleId ?? 'parse'}: ${m.message}`);
}

describe('packages/core purity (eslint)', () => {
  it.each([
    'fetch("https://example.com");',
    'setTimeout(() => 0, 1);',
    'navigator.userAgent;',
    'self.postMessage(1);',
    'location.href;',
    'indexedDB.open("x");',
    'globalThis.process;',
    'window.alert(1);',
    'process.exit(1);',
    'Buffer.from("x");',
    'chrome.runtime.id;',
  ])('rejects %s', async code => {
    const found = await problems(`export const x = () => {\n  ${code}\n};\n`);
    expect(
      found.some(m => /^(?:no-undef|no-restricted-globals):/.test(m)),
      found.join(),
    ).toBe(true);
  });

  it('rejects Node built-in imports', async () => {
    expect(
      await problems("import {readFileSync} from 'node:fs';\nexport {readFileSync};\n"),
    ).toEqual([expect.stringContaining('no-restricted-imports')]);
  });

  it.each(['crypto', 'fs', 'path', 'zlib', 'buffer', 'node:crypto', 'fs/promises', 'path/posix'])(
    'rejects the bare built-in import %s',
    async name => {
      expect(
        await problems(
          `import * as m from '${name}';\nexport {m};\n`,
          'packages/builders/src/__purity_probe__.ts',
        ),
      ).toEqual([expect.stringContaining('no-restricted-imports')]);
    },
  );

  it('allows relative imports whose path contains a built-in name', async () => {
    // A gitignore-style pattern 'crypto' would match '../crypto/webcrypto.ts'.
    const code = "import {sha256} from '../crypto/webcrypto.ts';\nexport {sha256};\n";
    expect(await problems(code, 'packages/core/src/hash/__purity_probe__.ts')).toEqual([]);
    expect(await problems(code, 'extension/src/trust/__purity_probe__.ts')).toEqual([]);
  });

  it('allows the listed globals and ECMAScript built-ins', async () => {
    const code = [
      'export async function f(b: Uint8Array): Promise<string> {',
      "  const d = await crypto.subtle.digest('SHA-256', b);",
      "  const u = new URL('https://example.com/');",
      '  const t = new TextDecoder().decode(new TextEncoder().encode(u.href));',
      "  const s = new ReadableStream<BufferSource>().pipeThrough(new DecompressionStream('deflate-raw'));",
      '  const r = new Response(s);',
      '  return JSON.stringify([d.byteLength, t, r.ok, new Map(), Math.max(1)]);',
      '}',
      '',
    ].join('\n');
    expect(await problems(code)).toEqual([]);
  });

  it.each([
    'packages/builders/src/__purity_probe__.ts',
    'packages/builders/src/bitwarden/__purity_probe__.ts',
    'extension/src/policy/__purity_probe__.ts',
  ])('applies to the other pure code too (%s)', async file => {
    for (const code of [
      'Buffer.from("x");',
      'fetch("https://example.com");',
      'chrome.runtime.id;',
    ]) {
      const found = await problems(`export const x = () => {\n  ${code}\n};\n`, file);
      expect(
        found.some(m => /^(?:no-undef|no-restricted-globals):/.test(m)),
        found.join(),
      ).toBe(true);
    }
  });
});
