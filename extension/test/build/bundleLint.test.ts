import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {PAGES} from '../../src/contracts.ts';
import {
  ACTION_ICONS,
  actionIconFile,
  PRODUCT_ICON_SIZES,
  productIconPath,
} from '../../src/platform/iconPaths.ts';
import {lintBundle, type LintOptions} from '../../build/bundleLint.ts';
import {buildManifest, serializeManifest} from '../../build/manifest.ts';
import {EXTENSION_DIR, extensionVersion, REPO_ROOT} from '../../build/paths.ts';

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const LOCK = 'fixtures/corpora/vaultwarden-web-2026.10.1.lock.json';
const CORE = '{"schema":"intactwarden.manifest/1"}';
const MESSAGES = JSON.stringify({
  extName: {message: 'IntactWarden'},
  extDescription: {message: 'x'},
  actionTitle: {message: 'IntactWarden'},
});

let root: string;
let seq = 0;
const ICONS = [...ACTION_ICONS.map(actionIconFile), ...PRODUCT_ICON_SIZES.map(productIconPath)];
const page = (script: string): string =>
  `<!doctype html><html><head><script src="${script}" defer></script></head><body></body></html>\n`;

async function put(dir: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(dir, path)), {recursive: true});
  await writeFile(join(dir, path), content);
}

/** A minimal package that passes every rule; a test package also carries bootstrap data. */
async function validPackage(test = false): Promise<string> {
  const dir = join(root, `firefox-${seq++}`);
  const manifest = await buildManifest({test, version: extensionVersion()});
  await put(dir, 'manifest.json', serializeManifest(manifest));
  await put(dir, 'background.js', `(() => { "use strict"; })();\n`);
  await put(dir, 'content.js', `(() => {})();\n`);
  for (const html of Object.values(PAGES)) {
    const base = html.slice(html.lastIndexOf('/') + 1).replace(/\.html$/, '');
    await put(dir, html, page(`${base}.js`));
    await put(dir, html.replace(/\.html$/, '.js'), `(() => {})();\n`);
  }
  await put(dir, '_locales/en/messages.json', MESSAGES);
  await put(dir, '_locales/pl/messages.json', MESSAGES);
  for (const path of ICONS) await put(dir, path, readFileSync(join(EXTENSION_DIR, path)));
  if (!test) return dir;
  const coreSha = sha256(CORE);
  await put(dir, `data/bootstrap/cores/${coreSha}.json`, CORE);
  await put(
    dir,
    'data/bootstrap/index.json',
    JSON.stringify({
      schema: 'intactwarden.bootstrap/1',
      generated_from: [{lock: LOCK, sha256: sha256(readFileSync(join(REPO_ROOT, LOCK)))}],
      cores: [{sha256: coreSha, size: CORE.length, path: `data/bootstrap/cores/${coreSha}.json`}],
      pins: {schema: 'intactwarden.localpins/1', pins: []},
    }),
  );
  return dir;
}

async function editJson(
  dir: string,
  path: string,
  edit: (j: Record<string, unknown>) => void,
): Promise<void> {
  const j = JSON.parse(await readFile(join(dir, path), 'utf8')) as Record<string, unknown>;
  edit(j);
  await writeFile(join(dir, path), JSON.stringify(j));
}

async function rules(dir: string, opts: Partial<LintOptions> = {}): Promise<string[]> {
  const findings = await lintBundle(dir, {test: false, ...opts});
  return [...new Set(findings.map(f => f.rule))].sort();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'iw-lint-'));
});
afterAll(async () => {
  await rm(root, {recursive: true, force: true});
});

describe('valid packages', () => {
  it('the production package passes', async () => {
    const dir = await validPackage();
    expect(
      await lintBundle(dir, {test: false, bundleInputs: ['extension/src/background/main.ts']}),
    ).toEqual([]);
  });

  it('the test package passes as a test build only', async () => {
    const dir = await validPackage(true);
    expect(await lintBundle(dir, {test: true})).toEqual([]);
    expect(await rules(dir)).toEqual(['host-permissions', 'production-test-data']);
  });
});

describe('bundle-lint rules', () => {
  it('host_permissions must be exactly the generated set', async () => {
    for (const edit of [
      (h: string[]) => h.pop(),
      (h: string[]) => h.push('https://api.github.com/*'),
      (h: string[]) => h.push(h[0]!),
      (h: string[]) => h.splice(0, h.length, '<all_urls>'),
    ]) {
      const dir = await validPackage();
      await editJson(dir, 'manifest.json', m => void edit(m['host_permissions'] as string[]));
      expect(await rules(dir)).toContain('host-permissions');
    }
  });

  it('gecko id and data_collection_permissions', async () => {
    const dir = await validPackage();
    await editJson(dir, 'manifest.json', m => {
      const bss = m['browser_specific_settings'] as {gecko: Record<string, unknown>};
      delete bss.gecko['data_collection_permissions'];
    });
    expect(await rules(dir)).toEqual(['gecko']);
    const dir2 = await validPackage();
    await editJson(dir2, 'manifest.json', m => {
      (m['browser_specific_settings'] as {gecko: Record<string, unknown>}).gecko['id'] = 'other@x';
    });
    expect(await rules(dir2)).toEqual(['gecko']);
  });

  it('desktop Firefox 153.0 or newer, no gecko_android', async () => {
    const dir = await validPackage();
    await editJson(dir, 'manifest.json', m => {
      const bss = m['browser_specific_settings'] as {gecko: Record<string, unknown>};
      bss.gecko['strict_min_version'] = '128.0';
    });
    expect(await rules(dir)).toEqual(['gecko']);
    const dir2 = await validPackage();
    await editJson(dir2, 'manifest.json', m => {
      const bss = m['browser_specific_settings'] as Record<string, unknown>;
      bss['gecko_android'] = {strict_min_version: '142.0'};
    });
    expect(await rules(dir2)).toEqual(['gecko']);
    const dir3 = await validPackage();
    await editJson(dir3, 'manifest.json', m => {
      (m['browser_specific_settings'] as {gecko: Record<string, unknown>}).gecko['update_url'] =
        'https://example.org/u.json';
    });
    expect(await rules(dir3)).toEqual(['gecko']);
  });

  it('the static content script runs on exactly the official origins, at document_start, in all frames', async () => {
    const widen = await validPackage();
    await editJson(widen, 'manifest.json', m => {
      (m['content_scripts'] as {matches: string[]}[])[0]!.matches = ['<all_urls>'];
    });
    expect(await rules(widen)).toEqual(['content-scripts']);
    const late = await validPackage();
    await editJson(late, 'manifest.json', m => {
      (m['content_scripts'] as Record<string, unknown>[])[0]!['run_at'] = 'document_idle';
    });
    expect(await rules(late)).toEqual(['content-scripts']);
    const top = await validPackage();
    await editJson(top, 'manifest.json', m => {
      (m['content_scripts'] as Record<string, unknown>[])[0]!['all_frames'] = false;
    });
    expect(await rules(top)).toEqual(['content-scripts']);
    const two = await validPackage();
    await editJson(two, 'manifest.json', m => {
      const cs = m['content_scripts'] as Record<string, unknown>[];
      cs.push({...cs[0]!});
    });
    expect(await rules(two)).toEqual(['content-scripts']);
  });

  it('no esbuild input from node_modules (no third-party code in the package)', async () => {
    const dir = await validPackage();
    expect(await rules(dir, {bundleInputs: ['node_modules/yaml/dist/index.js']})).toEqual([
      'third-party',
    ]);
    expect(await rules(dir, {bundleInputs: ['packages/core/node_modules/x/index.js']})).toEqual([
      'third-party',
    ]);
    expect(await rules(dir, {bundleInputs: ['packages/core/src/hash/sha256.ts']})).toEqual([]);
  });

  it('a text file outside the reviewed types fails, except the root LICENSE.txt', async () => {
    const dir = await validPackage();
    await put(dir, 'THIRD_PARTY_NOTICES.txt', 'x\n');
    expect(await rules(dir)).toEqual(['files']);
    const license = readFileSync(join(REPO_ROOT, 'LICENSE'));
    const atRoot = await validPackage();
    await put(atRoot, 'LICENSE.txt', license);
    expect(await rules(atRoot)).toEqual([]);
    const nested = await validPackage();
    await put(nested, 'ui/LICENSE.txt', license);
    expect(await rules(nested)).toEqual(['files']);
    const other = await validPackage();
    await put(other, 'LICENSE.txt', 'not the licence\n');
    expect(await rules(other)).toEqual(['files']);
  });

  it('optional hosts limited to https://*/* and http://*/*', async () => {
    const dir = await validPackage();
    await editJson(dir, 'manifest.json', m =>
      (m['optional_host_permissions'] as string[]).push('<all_urls>'),
    );
    expect(await rules(dir)).toEqual(['optional-hosts']);
  });
});

describe('reviewed package rules', () => {
  it('permissions equal the reviewed list', async () => {
    for (const edit of [
      (p: string[]) => p.splice(p.indexOf('webNavigation'), 1),
      (p: string[]) => p.push('debugger'),
      (p: string[]) => p.push('declarativeNetRequest'),
    ]) {
      const dir = await validPackage();
      await editJson(dir, 'manifest.json', m => void edit(m['permissions'] as string[]));
      expect(await rules(dir)).toEqual(['permissions']);
    }
  });

  it('manifest: only the reviewed top-level keys', async () => {
    for (const [key, value] of [
      ['optional_permissions', ['management']],
      ['content_security_policy', {extension_pages: "script-src 'self'"}],
      ['web_accessible_resources', []],
      ['externally_connectable', {ids: []}],
      ['declarative_net_request', {rule_resources: []}],
      ['devtools_page', 'ui/popup.html'],
      ['minimum_chrome_version', '128'],
    ] as const) {
      const dir = await validPackage();
      await editJson(dir, 'manifest.json', m => (m[key] = value));
      expect(await rules(dir), key).toEqual(['manifest']);
    }
  });

  it('manifest: MV3 and an event page', async () => {
    const dir = await validPackage();
    await editJson(dir, 'manifest.json', m => {
      m['manifest_version'] = 2;
      m['background'] = {service_worker: 'background.js'};
    });
    expect(await rules(dir)).toContain('manifest');
    const dir2 = await validPackage();
    await unlink(join(dir2, 'manifest.json'));
    expect(await rules(dir2)).toEqual(['manifest']);
  });

  it('no Node built-ins or globals in bundles', async () => {
    for (const code of [
      'require("fs")',
      'import("node:fs")',
      'process.env.X',
      'Buffer.from(x)',
      '__dirname',
    ]) {
      const dir = await validPackage();
      await put(dir, 'background.js', code);
      expect(await rules(dir)).toEqual(['no-node']);
    }
    const dir = await validPackage();
    await put(
      dir,
      'background.js',
      `const myrequire = 1; obj.require(x); retrieval(x); // process`,
    );
    expect(await rules(dir)).toEqual([]);
  });

  it('no runtime code generation or remote code', async () => {
    for (const code of [
      'eval("1")',
      'window.eval (x)',
      'new Function("a", "return a")',
      'Function("return this")',
      'setTimeout("alert(1)", 1)',
      'importScripts("https://evil.example/x.js")',
      'import("//evil.example/x.js")',
    ]) {
      const dir = await validPackage();
      await put(dir, 'content.js', code);
      expect(await rules(dir), code).toEqual(['no-eval']);
    }
    const ok = await validPackage();
    await put(
      ok,
      'content.js',
      'retrieval(x); evaluate(y); setTimeout(fn, 1); importScripts("w.js"); isFunction(x);',
    );
    expect(await rules(ok)).toEqual([]);
  });

  it('no inline, remote or missing scripts and no inline handlers in pages', async () => {
    for (const html of [
      '<script>alert(1)</script>',
      '<script src="https://evil.example/x.js"></script>',
      '<button onclick="x()"></button>',
      '<a href="javascript:void 0"></a>',
    ]) {
      const dir = await validPackage();
      await put(
        dir,
        'ui/popup.html',
        `<!doctype html><html><head><script src="popup.js"></script></head><body>${html}</body></html>`,
      );
      expect(await rules(dir), html).toEqual(['no-eval']);
    }
    const dir = await validPackage();
    await put(dir, 'ui/popup.html', '<!doctype html><script src="missing.js"></script>');
    expect(await rules(dir)).toEqual(['files']);
  });

  it('every manifest message key in en and pl', async () => {
    const dir = await validPackage();
    await editJson(dir, '_locales/pl/messages.json', m => delete m['actionTitle']);
    const findings = await lintBundle(dir, {test: false});
    expect(findings).toEqual([{rule: 'messages', message: 'pl: no actionTitle'}]);
    await unlink(join(dir, '_locales/en/messages.json'));
    expect(await rules(dir)).toEqual(['messages']);
  });

  it('bootstrap (test builds): index parses, cores hash to their names, nothing unlisted', async () => {
    const test = {test: true};
    const dir = await validPackage(true);
    const coreSha = sha256(CORE);
    await put(dir, `data/bootstrap/cores/${coreSha}.json`, CORE.replace('1', '2'));
    expect(await rules(dir, test)).toEqual(['bootstrap']);

    const dir2 = await validPackage(true);
    await put(dir2, `data/bootstrap/cores/${'0'.repeat(64)}.json`, '{}');
    expect(await rules(dir2, test)).toEqual(['bootstrap']);

    const dir3 = await validPackage(true);
    await unlink(join(dir3, 'data', 'bootstrap', 'index.json'));
    expect(await rules(dir3, test)).toEqual(['bootstrap']);
    await rm(join(dir3, 'data'), {recursive: true});
    expect(await rules(dir3, test)).toEqual([]);
  });

  it('the shipping package carries no bootstrap data', async () => {
    for (const path of ['data/bootstrap/index.json', `data/bootstrap/cores/${sha256(CORE)}.json`]) {
      const dir = await validPackage();
      await put(dir, path, CORE);
      expect(await lintBundle(dir, {test: false})).toEqual([
        {rule: 'production-test-data', message: `${path}: bundled data in a production package`},
      ]);
    }
  });

  it('files: referenced files exist, known types only, no dotfiles or source maps', async () => {
    const cases: [string, (dir: string) => Promise<void>][] = [
      ['missing popup script', dir => unlink(join(dir, 'ui/popup.js'))],
      ['missing product icon', dir => unlink(join(dir, 'assets/icons/icon-48.png'))],
      ['source map', dir => put(dir, 'background.js.map', '{}')],
      ['dotfile', dir => put(dir, '.DS_Store', '')],
      ['dot directory', dir => put(dir, '.hidden/x.json', '{}')],
      ['nested dot directory', dir => put(dir, 'ui/.cache/x.js', '')],
      ['unknown type', dir => put(dir, 'tool.exe', '')],
      ['fake png', dir => put(dir, 'assets/icons/icon-16.png', 'GIF89a')],
      // Package data is a test build's bootstrap index and its cores only.
      ['trust material', dir => put(dir, 'data/trust/trusted_root.json', '{}')],
      ['other data', dir => put(dir, 'data/extra.json', '{}')],
      [
        'map reference',
        dir => put(dir, 'content.js', 'x();\n//# sourceMappingURL=content.js.map\n'),
      ],
    ];
    for (const [name, mutate] of cases) {
      const dir = await validPackage();
      await mutate(dir);
      expect(await rules(dir), name).toEqual(['files']);
    }
    const ok = await validPackage();
    await put(ok, 'content.js', 'const m = "\\n//# sourceMappingURL=";\nx();\n');
    expect(await rules(ok)).toEqual([]);
  });
});
