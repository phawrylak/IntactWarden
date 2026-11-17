// verify-store-package (docs/security.md): synthetic
// expected zips written by the extension's own deterministic zip writer, store
// packages written like AMO's (deflate, META-INF signature files) and checksum
// files. The real package is checked in extension/test/build/build.test.ts.
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {createZip} from '../extension/build/zip.ts';
import {writeZip, type ZipSpec} from '../packages/builders/test/helpers/zipWriter.ts';
import {
  compareFileSets,
  EXIT,
  main,
  parseSha256Sums,
  printable,
  RELEASE_WORKFLOW,
  REPO,
  USAGE,
  InputError,
} from './verify-store-package.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'intactwarden-vsp-'));
afterAll(() => rmSync(dir, {recursive: true, force: true}));

const enc = new TextEncoder();
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The files of a small synthetic extension package. */
const FILES: Readonly<Record<string, string>> = {
  'manifest.json': '{"manifest_version":3,"name":"IntactWarden","version":"0.1.0"}',
  'background/main.js': 'console.log("background");\n',
  'content/sensor.js': 'void 0;\n',
  '_locales/en/messages.json': '{"name":{"message":"IntactWarden"}}',
  '_locales/pl/messages.json': '{"name":{"message":"IntactWarden"}}',
  'ui/popup.html': '<!doctype html>\n',
};

/** AMO's signature files (manifest.mf / mozilla.sf / mozilla.rsa, plus COSE). */
const AMO_SIGNATURES = [
  'META-INF/cose.manifest',
  'META-INF/cose.sig',
  'META-INF/manifest.mf',
  'META-INF/mozilla.rsa',
  'META-INF/mozilla.sf',
];

function expectedZip(files: Readonly<Record<string, string>> = FILES): Uint8Array {
  return createZip(Object.entries(files).map(([path, text]) => ({path, bytes: enc.encode(text)})));
}

/** A store package: deflate entries in another order, directory entries, optional signatures. */
function storeXpi(
  files: Readonly<Record<string, string>> = FILES,
  extra: readonly ZipSpec[] = AMO_SIGNATURES.map(name => ({name, data: `sig ${name}`})),
): Uint8Array {
  const specs: ZipSpec[] = [
    {name: 'META-INF/'},
    ...extra,
    ...Object.entries(files)
      .reverse()
      .map(([name, data]) => ({name, data})),
  ];
  // Directory entries for the parents of nested files.
  const dirs = new Set<string>();
  for (const name of Object.keys(files)) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  return writeZip([
    ...[...dirs].sort().map(name => ({name})),
    ...specs.filter(s => !dirs.has(s.name)),
  ]);
}

let n = 0;
function file(name: string, bytes: Uint8Array | string): string {
  const p = join(dir, String(n++), name);
  mkdirSync(dirname(p), {recursive: true});
  writeFileSync(p, bytes);
  return p;
}

async function run(
  args: readonly string[],
): Promise<{code: number; stdout: string; stderr: string}> {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {stdout: s => (stdout += s), stderr: s => (stderr += s)});
  return {code, stdout, stderr};
}

describe('verify-store-package: packages', () => {
  const expected = file('intactwarden-0.1.0-firefox.zip', expectedZip());

  it('identical: AMO signature files are stripped, everything else matches', async () => {
    const r = await run(['--expected', expected, '--package', file('store.xpi', storeXpi())]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(EXIT.identical);
    expect(r.stdout).toContain(`files: identical (${Object.keys(FILES).length} files)`);
    expect(r.stdout).toContain('stripped 5 store signature files: META-INF/cose.manifest');
    expect(r.stdout).toContain('result: PASS');
    expect(r.stdout).toContain(
      `gh attestation verify ${expected} --repo ${REPO} --signer-workflow ${RELEASE_WORKFLOW} --source-ref refs/tags/v0.1.0`,
    );
  });

  it('identical without any signature files too', async () => {
    const r = await run([
      '--expected',
      expected,
      '--package',
      file('plain.zip', storeXpi(FILES, [])),
    ]);
    expect(r.code).toBe(EXIT.identical);
    expect(r.stdout).toContain('no store signature files');
  });

  it('one changed byte is a difference with both digests', async () => {
    const changed = {...FILES, 'background/main.js': 'console.log("backgrounD");\n'};
    const r = await run([
      '--expected',
      expected,
      '--package',
      file('changed.xpi', storeXpi(changed)),
    ]);
    expect(r.code).toBe(EXIT.different);
    expect(r.stdout).toContain(
      `differs background/main.js expected ${sha256(enc.encode(FILES['background/main.js']!))} actual ${sha256(enc.encode(changed['background/main.js']))}`,
    );
    expect(r.stdout).toContain('files: 1 difference');
    expect(r.stdout).toContain('result: FAIL');
  });

  it('an extra file is a difference', async () => {
    const extra = {...FILES, 'injected.js': 'steal();\n'};
    const r = await run(['--expected', expected, '--package', file('extra.xpi', storeXpi(extra))]);
    expect(r.code).toBe(EXIT.different);
    expect(r.stdout).toMatch(/^extra injected\.js$/m);
  });

  it('a missing file is a difference', async () => {
    const missing: Record<string, string> = {...FILES};
    delete missing['content/sensor.js'];
    const r = await run([
      '--expected',
      expected,
      '--package',
      file('missing.xpi', storeXpi(missing)),
    ]);
    expect(r.code).toBe(EXIT.different);
    expect(r.stdout).toMatch(/^missing content\/sensor\.js$/m);
  });

  it('only META-INF/ at the top is stripped: a nested or differently cased one is extra', async () => {
    const r = await run([
      '--expected',
      expected,
      '--package',
      file(
        'sneaky.xpi',
        storeXpi(FILES, [
          {name: 'content/META-INF/x.js', data: 'x'},
          {name: 'meta-inf/y', data: 'y'},
        ]),
      ),
    ]);
    expect(r.code).toBe(EXIT.different);
    expect(r.stdout).toMatch(/^extra content\/META-INF\/x\.js$/m);
    expect(r.stdout).toMatch(/^extra meta-inf\/y$/m);
  });

  it("only AMO's five signature files are stripped: another META-INF/ file is extra", async () => {
    const r = await run([
      '--expected',
      expected,
      '--package',
      file(
        'added.xpi',
        storeXpi(FILES, [
          ...AMO_SIGNATURES.map(name => ({name, data: `sig ${name}`})),
          {name: 'META-INF/injected.js', data: 'fetch("https://evil.example/")'},
        ]),
      ),
    ]);
    expect(r.code).toBe(EXIT.different);
    expect(r.stdout).toMatch(/^extra META-INF\/injected\.js$/m);
    expect(r.stdout).toContain('stripped 5 store signature files');
  });

  it('META-INF/ in the expected zip is an input error', async () => {
    const bad = file(
      'bad-expected.zip',
      createZip([
        ...Object.entries(FILES).map(([path, text]) => ({path, bytes: enc.encode(text)})),
        {path: 'META-INF/manifest.mf', bytes: enc.encode('x')},
      ]),
    );
    const r = await run(['--expected', bad, '--package', file('s.xpi', storeXpi())]);
    expect(r.code).toBe(EXIT.input);
    expect(r.stderr).toMatch(/contains META-INF\/manifest\.mf/);
  });

  it('an archive the strict reader refuses is an input error with the reason', async () => {
    const zip = storeXpi();
    const truncated = zip.slice(0, zip.length - 30);
    const r = await run(['--expected', expected, '--package', file('broken.xpi', truncated)]);
    expect(r.code).toBe(EXIT.input);
    expect(r.stderr).toMatch(/store package: the strict zip reader refuses it \(/);
    const dup = writeZip([
      {name: 'manifest.json', data: '{}'},
      {name: 'Manifest.json', data: '{}'},
    ]);
    const r2 = await run(['--expected', expected, '--package', file('dup.xpi', dup)]);
    expect(r2.code).toBe(EXIT.input);
    expect(r2.stderr).toMatch(/duplicate-name/);
  });

  it('an unreadable file is an input error', async () => {
    const r = await run([
      '--expected',
      join(dir, 'nope.zip'),
      '--package',
      file('s2.xpi', storeXpi()),
    ]);
    expect(r.code).toBe(EXIT.input);
    expect(r.stderr).toMatch(/expected zip: cannot read \(ENOENT\)/);
    const r2 = await run(['--expected', expected, '--package', dir]);
    expect(r2.code).toBe(EXIT.input);
    expect(r2.stderr).toMatch(/store package: not a regular file/);
  });
});

describe('verify-store-package: SHA256SUMS', () => {
  const zip = expectedZip();
  const expected = file('intactwarden-0.1.0-firefox.zip', zip);
  const store = file('store.xpi', storeXpi());

  it('passes when the expected zip is listed (text or binary mode)', async () => {
    for (const sep of ['  ', ' *']) {
      const sums = file(
        'SHA256SUMS',
        `${'0'.repeat(64)}  other.zip\n${sha256(zip)}${sep}intactwarden-0.1.0-firefox.zip\n`,
      );
      const r = await run(['--expected', expected, '--package', store, '--sha256sums', sums]);
      expect(r.code).toBe(EXIT.identical);
      expect(r.stdout).toContain(
        'SHA256SUMS: the expected zip is listed as intactwarden-0.1.0-firefox.zip',
      );
    }
  });

  it('fails when the digest is listed only under another name than the release asset', async () => {
    const sums = file('SHA256SUMS', `${sha256(zip)}  intactwarden-0.1.0-source.tar.gz\n`);
    const r = await run(['--expected', expected, '--package', store, '--sha256sums', sums]);
    expect(r.code).toBe(EXIT.different);
    expect(r.stdout).toContain(
      'NOT listed as intactwarden-0.1.0-firefox.zip (only as intactwarden-0.1.0-source.tar.gz)',
    );
    // The name comes from the zip's manifest.json, not from the file name given.
    const renamed = file('renamed.zip', zip);
    const ok = file('SHA256SUMS', `${sha256(zip)}  intactwarden-0.1.0-firefox.zip\n`);
    const r2 = await run(['--expected', renamed, '--package', store, '--sha256sums', ok]);
    expect(r2.code).toBe(EXIT.identical);
  });

  it('fails (exit 1) when the expected zip is not listed, even with identical files', async () => {
    const sums = file('SHA256SUMS', `${'a'.repeat(64)}  intactwarden-0.1.0-firefox.zip\n`);
    const r = await run(['--expected', expected, '--package', store, '--sha256sums', sums]);
    expect(r.code).toBe(EXIT.different);
    expect(r.stdout).toContain('is NOT listed');
    expect(r.stdout).toContain('files: identical');
    expect(r.stdout).toContain('result: FAIL');
  });

  it('a malformed checksum file is an input error', async () => {
    for (const text of [
      '',
      `${sha256(zip)} intactwarden-0.1.0-firefox.zip\n`,
      `${sha256(zip).toUpperCase()}  intactwarden-0.1.0-firefox.zip\n`,
      'not a checksum line\n',
    ]) {
      const r = await run([
        '--expected',
        expected,
        '--package',
        store,
        '--sha256sums',
        file('SHA256SUMS', text),
      ]);
      expect(r.code, JSON.stringify(text)).toBe(EXIT.input);
      expect(r.stderr).toMatch(/SHA256SUMS: /);
    }
    const binary = file('SHA256SUMS', new Uint8Array([0xff, 0xfe, 0x00]));
    expect(
      (await run(['--expected', expected, '--package', store, '--sha256sums', binary])).code,
    ).toBe(EXIT.input);
  });

  it('parseSha256Sums reads sha256sum output and tolerates CRLF', () => {
    expect(parseSha256Sums(`${'b'.repeat(64)}  a.zip\r\n${'c'.repeat(64)} *b.zip\n`)).toEqual([
      {sha256: 'b'.repeat(64), name: 'a.zip'},
      {sha256: 'c'.repeat(64), name: 'b.zip'},
    ]);
    expect(() => parseSha256Sums('\n')).toThrow(InputError);
  });
});

describe('verify-store-package: usage', () => {
  it('usage errors exit 2', async () => {
    expect((await run([])).code).toBe(EXIT.usage);
    expect((await run(['--expected', 'a.zip'])).code).toBe(EXIT.usage);
    expect((await run(['--expected', 'a.zip', '--package', 'b', '--installed', 'c'])).code).toBe(
      EXIT.usage,
    );
    expect((await run(['--expected', 'a.zip', '--package', 'b', '--json'])).code).toBe(EXIT.usage);
    expect((await run(['--package', 'b'])).code).toBe(EXIT.usage);
    expect((await run(['--expected', 'a.zip', '--package', 'b', '--bogus'])).code).toBe(EXIT.usage);
    expect((await run(['--expected', 'a.zip', '--package', 'b', 'positional'])).code).toBe(
      EXIT.usage,
    );
  });

  it('--help documents every exit status', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(USAGE);
    for (const s of ['0 identical', '1 differences', '2 usage error', '3 input error'])
      expect(USAGE).toContain(s);
  });

  it('runs as a script (node tools/verify-store-package.ts), also through a symlinked path', () => {
    const script = join(ROOT, 'tools/verify-store-package.ts');
    const link = join(dir, 'linked-verify-store-package.ts');
    symlinkSync(script, link);
    for (const path of [script, link]) {
      expect(execFileSync(process.execPath, [path, '--help'], {encoding: 'utf8'}), path).toBe(
        USAGE,
      );
    }
  });

  it('prints plain paths unchanged and others as JSON strings', () => {
    expect(printable('a/b.js')).toBe('a/b.js');
    expect(printable('a b')).toBe('"a b"');
    expect(printable('é')).toBe('"é"');
    // A path from a package can never forge a report line.
    expect(printable('evil\nresult: PASS')).toBe(JSON.stringify('evil\nresult: PASS'));
  });

  it('compareFileSets sorts differences by path', () => {
    const d = compareFileSets(
      {
        files: new Map([
          ['b', '1'],
          ['a', '1'],
          ['c', '1'],
        ]),
        stripped: [],
        version: null,
      },
      {
        files: new Map([
          ['c', '2'],
          ['d', '1'],
          ['b', '1'],
        ]),
        stripped: [],
        version: null,
      },
    );
    expect(d.map(x => `${x.kind} ${x.path}`)).toEqual(['missing a', 'differs c', 'extra d']);
  });
});
