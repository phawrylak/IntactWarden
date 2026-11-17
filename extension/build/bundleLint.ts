/**
 * Bundle-lint: the checks of docs/security.md on a built package directory; each finding
 * carries a rule name. `buildExtension` runs it on the package it writes and
 * `packageExtension` again before zipping; any finding fails.
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BOOTSTRAP_INDEX_PATH, MANIFEST_MESSAGE_KEYS, PAGES} from '../src/contracts.ts';
import {manifestMessageKeys, REQUIRED_LOCALES} from './locales.ts';
import {generatedHostPermissions, officialMatchPatterns} from './manifest.ts';
import {isPackagePath, listFiles} from './files.ts';
import {REPO_ROOT} from './paths.ts';

export interface LintFinding {
  readonly rule: string;
  readonly message: string;
}

export interface LintOptions {
  /** Test build (dist-test): loopback hosts expected, bootstrap data allowed. */
  readonly test: boolean;
  /** The esbuild metafile inputs of the bundles (the build passes them; none may be third-party). */
  readonly bundleInputs?: readonly string[];
  /** Repository root, to compare LICENSE.txt with the repository LICENSE (null: skipped). */
  readonly repoRoot?: string | null;
}

/** Reviewed API permissions (docs/security.md). */
export const PERMISSIONS: readonly string[] = Object.freeze([
  'webRequest',
  'webRequestBlocking',
  'webRequestFilterResponse',
  'webRequestFilterResponse.serviceWorkerScript',
  'storage',
  'scripting',
  'webNavigation',
  'notifications',
]);

/**
 * The reviewed top-level manifest keys. Anything else (content_security_policy,
 * declarative_net_request, web_accessible_resources, externally_connectable, optional_permissions,
 * devtools_page, ...) fails the `manifest` rule.
 */
export const MANIFEST_KEYS: readonly string[] = Object.freeze([
  'manifest_version',
  'name',
  'description',
  'default_locale',
  'version',
  'author',
  'icons',
  'action',
  'options_ui',
  'host_permissions',
  'optional_host_permissions',
  'content_scripts',
  'background',
  'permissions',
  'browser_specific_settings',
]);

export const GECKO_ID = 'intactwarden@phawrylak';
/** Minimum Firefox version (docs/security.md): desktop ESR 153. */
export const GECKO_MIN_VERSION = '153.0';
export const ALLOWED_OPTIONAL_HOSTS = Object.freeze(['https://*/*', 'http://*/*']);

const TEXT_EXTENSIONS = ['.js', '.html', '.css', '.json', '.svg'];
const BINARY_EXTENSIONS = ['.png'];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const NODE_PATTERNS: readonly [RegExp, string][] = [
  [/["'`]node:[a-z_/]+["'`]/, 'node: module specifier'],
  [/(?<![\w$.])require\s*\(/, 'require('],
  [/(?<![\w$.])__require\b/, 'esbuild require shim'],
  [
    /(?<![\w$.])process\.(env|versions|platform|argv|exit|nextTick|cwd|stdout|stderr)\b/,
    'process global',
  ],
  [/(?<![\w$.])Buffer\.(from|alloc|allocUnsafe|isBuffer|concat|byteLength)\b/, 'Buffer global'],
  [/(?<![\w$.])__(dirname|filename)\b/, '__dirname/__filename'],
];

const EVAL_PATTERNS: readonly [RegExp, string][] = [
  [/(?<![\w$])eval\s*\(/, 'eval('],
  [/(?<![\w$.])new\s+Function\s*\(/, 'new Function('],
  [/(?<![\w$.])Function\s*\(\s*["'`]/, 'Function(string)'],
  [/(?<![\w$])set(Timeout|Interval)\s*\(\s*["'`]/, 'string timer'],
  [/(?<![\w$])importScripts\s*\(\s*["'`](https?:)?\/\//, 'remote importScripts('],
  [/(?<![\w$.])import\s*\(\s*["'`](https?:)?\/\//, 'remote import('],
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && b.every(x => a.includes(x));
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Lints the package in `dir`. Returns every finding (empty: the package passes). */
export async function lintBundle(dir: string, options: LintOptions): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  const fail = (rule: string, message: string): void => void findings.push({rule, message});
  const {test} = options;

  let files: string[];
  try {
    files = await listFiles(dir);
  } catch (e) {
    return [{rule: 'files', message: (e as Error).message}];
  }
  const has = (p: string): boolean => files.includes(p);
  const read = (p: string): Promise<Buffer> => readFile(join(dir, p));

  // --- manifest
  if (!has('manifest.json')) return [{rule: 'manifest', message: 'manifest.json is missing'}];
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse((await read('manifest.json')).toString('utf8'));
    if (!isRecord(parsed)) throw new Error('not an object');
    manifest = parsed;
  } catch (e) {
    return [{rule: 'manifest', message: `manifest.json: ${(e as Error).message}`}];
  }
  if (manifest['manifest_version'] !== 3) fail('manifest', 'manifest_version must be 3');
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) fail('manifest', `${key} is not a reviewed manifest key`);
  }
  const bg = isRecord(manifest['background']) ? manifest['background'] : {};
  if (strings(bg['scripts']).length === 0 || bg['service_worker'] !== undefined) {
    fail('manifest', 'Firefox needs background.scripts (event page) and no service_worker');
  }

  // --- permissions
  const permissions = strings(manifest['permissions']);
  if (!sameSet(permissions, PERMISSIONS)) {
    fail(
      'permissions',
      `permissions [${permissions.join(', ')}] differ from the reviewed list ` +
        `[${PERMISSIONS.join(', ')}]`,
    );
  }
  const rawHosts = manifest['host_permissions'];
  const hosts = strings(rawHosts);
  const expectedHosts = generatedHostPermissions({test});
  if (
    !Array.isArray(rawHosts) ||
    hosts.length !== rawHosts.length ||
    !sameSet(hosts, expectedHosts)
  ) {
    fail(
      'host-permissions',
      `host_permissions [${hosts.join(', ')}] are not the generated set [${expectedHosts.join(', ')}]`,
    );
  }
  const optionalHosts = strings(manifest['optional_host_permissions']);
  for (const h of optionalHosts) {
    if (!ALLOWED_OPTIONAL_HOSTS.includes(h)) fail('optional-hosts', `optional host ${h}`);
  }

  // --- gecko / browser-specific settings
  const bss = manifest['browser_specific_settings'];
  const gecko = isRecord(bss) && isRecord(bss['gecko']) ? bss['gecko'] : null;
  if (gecko === null || gecko['id'] !== GECKO_ID) fail('gecko', `gecko id must be ${GECKO_ID}`);
  const dcp =
    gecko !== null && isRecord(gecko['data_collection_permissions'])
      ? gecko['data_collection_permissions']
      : null;
  const required = dcp === null ? [] : strings(dcp['required']);
  if (dcp === null || required.length !== 1 || required[0] !== 'none') {
    fail('gecko', 'gecko.data_collection_permissions must be {"required": ["none"]}');
  }
  if (gecko !== null && gecko['strict_min_version'] !== GECKO_MIN_VERSION) {
    fail('gecko', `gecko.strict_min_version must be ${GECKO_MIN_VERSION}`);
  }
  const geckoKeys = ['id', 'strict_min_version', 'data_collection_permissions'];
  if (gecko !== null && Object.keys(gecko).some(k => !geckoKeys.includes(k))) {
    fail('gecko', 'gecko may only hold id, strict_min_version and data_collection_permissions');
  }
  // Desktop Firefox only: no gecko_android (AMO then offers the add-on on desktop only).
  if (isRecord(bss) && Object.keys(bss).some(k => k !== 'gecko')) {
    fail('gecko', 'browser_specific_settings may only hold gecko');
  }

  // --- content scripts
  const contentScripts = Array.isArray(manifest['content_scripts'])
    ? manifest['content_scripts']
    : [];
  // The static content script runs only on the official origins (instances register theirs at
  // run time, behind their own host permission), at document_start in every frame.
  const expectedMatches = officialMatchPatterns();
  const cs = contentScripts.length === 1 && isRecord(contentScripts[0]) ? contentScripts[0] : null;
  if (cs === null) {
    fail(
      'content-scripts',
      `exactly one static content script expected, found ${contentScripts.length}`,
    );
  } else {
    const matches = strings(cs['matches']);
    const rawMatches = cs['matches'];
    if (
      !Array.isArray(rawMatches) ||
      matches.length !== rawMatches.length ||
      !sameSet(matches, expectedMatches)
    )
      fail(
        'content-scripts',
        `content_scripts matches [${matches.join(', ')}] are not the official origins [${expectedMatches.join(', ')}]`,
      );
    if (cs['run_at'] !== 'document_start') fail('content-scripts', 'run_at must be document_start');
    if (cs['all_frames'] !== true) fail('content-scripts', 'all_frames must be true');
    const js = strings(cs['js']);
    if (js.length !== 1 || js[0] !== 'content.js')
      fail('content-scripts', `content script files [${js.join(', ')}] must be [content.js]`);
    if (cs['exclude_matches'] !== undefined || cs['css'] !== undefined || cs['world'] !== undefined)
      fail('content-scripts', 'exclude_matches, css and world are not used');
  }

  // --- files: types, dotfiles, source maps, referenced files
  for (const f of files) {
    // The one non-code file: the MIT licence text, which every copy must include.
    if (f === 'LICENSE.txt') continue;
    const name = f.slice(f.lastIndexOf('/') + 1);
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    if (!isPackagePath(f) || f.split('/').some(s => s.startsWith('.')))
      fail('files', `unexpected file name ${f}`);
    else if (ext === '.map') fail('files', `source map ${f}`);
    else if (!TEXT_EXTENSIONS.includes(ext) && !BINARY_EXTENSIONS.includes(ext)) {
      fail('files', `unexpected file type ${f}`);
    } else if (f.startsWith('data/bootstrap/')) {
      // Bundled cores and pins are test data: the shipping package has none.
      if (!test) fail('production-test-data', `${f}: bundled data in a production package`);
    } else if (f.startsWith('data/')) {
      fail('files', `unexpected file ${f}`);
    }
  }
  const referenced = new Set<string>();
  for (const s of strings(bg['scripts'])) referenced.add(s);
  for (const cs of contentScripts) {
    if (isRecord(cs))
      for (const s of [...strings(cs['js']), ...strings(cs['css'])]) referenced.add(s);
  }
  const icons = manifest['icons'];
  if (isRecord(icons))
    for (const v of Object.values(icons)) if (typeof v === 'string') referenced.add(v);
  const action = isRecord(manifest['action']) ? manifest['action'] : {};
  if (typeof action['default_popup'] === 'string') referenced.add(action['default_popup']);
  const defaultIcon = action['default_icon'];
  if (typeof defaultIcon === 'string') referenced.add(defaultIcon);
  else if (isRecord(defaultIcon)) {
    for (const v of Object.values(defaultIcon)) if (typeof v === 'string') referenced.add(v);
  }
  const optionsUi = isRecord(manifest['options_ui']) ? manifest['options_ui'] : {};
  if (typeof optionsUi['page'] === 'string') referenced.add(optionsUi['page']);
  for (const page of Object.values(PAGES)) {
    referenced.add(page);
    referenced.add(page.replace(/\.html$/, '.js'));
  }
  for (const r of [...referenced].sort())
    if (!has(r)) fail('files', `${r} is referenced but missing`);
  for (const input of options.bundleInputs ?? []) {
    if (input.split('/').includes('node_modules'))
      fail('third-party', `${input} is third-party code in the bundles`);
  }

  // --- content scans
  const repoRoot = options.repoRoot === undefined ? REPO_ROOT : options.repoRoot;
  for (const f of files) {
    const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '';
    const bytes = await read(f);
    if (f === 'LICENSE.txt') {
      if (repoRoot !== null && !bytes.equals(readFileSync(join(repoRoot, 'LICENSE')))) {
        fail('files', 'LICENSE.txt is not the repository LICENSE');
      }
      continue;
    }
    if (ext === '.png') {
      if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) fail('files', `${f} is not a PNG`);
      continue;
    }
    if (!TEXT_EXTENSIONS.includes(ext)) continue;
    const text = bytes.toString('utf8');
    if (ext === '.js') {
      for (const [re, what] of NODE_PATTERNS) if (re.test(text)) fail('no-node', `${f}: ${what}`);
      for (const [re, what] of EVAL_PATTERNS) if (re.test(text)) fail('no-eval', `${f}: ${what}`);
      // A source-map reference is the bundle's last line (strings that mention one are fine).
      const last = text.trimEnd().split('\n').pop() ?? '';
      if (/^\s*\/[/*][#@] sourceMappingURL=/.test(last))
        fail('files', `${f} references a source map`);
    }
    if (ext === '.html') lintHtml(f, text, fail, has);
  }

  // --- messages
  const keys = [...new Set([...manifestMessageKeys(manifest), ...MANIFEST_MESSAGE_KEYS])].sort();
  if (manifest['default_locale'] !== 'en') fail('messages', 'default_locale must be "en"');
  for (const locale of REQUIRED_LOCALES) {
    const path = `_locales/${locale}/messages.json`;
    if (!has(path)) {
      fail('messages', `${path} is missing`);
      continue;
    }
    let catalogue: unknown;
    try {
      catalogue = JSON.parse((await read(path)).toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      fail('messages', `${path} is not JSON`);
      continue;
    }
    const names = isRecord(catalogue) ? Object.keys(catalogue).map(k => k.toLowerCase()) : [];
    for (const k of keys)
      if (!names.includes(k.toLowerCase())) fail('messages', `${locale}: no ${k}`);
  }

  // --- bootstrap data (test builds)
  if (test) await lintBootstrap(files, read, fail);

  return findings;
}

function lintHtml(
  file: string,
  text: string,
  fail: (rule: string, message: string) => void,
  has: (p: string) => boolean,
): void {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? '';
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (src === undefined) {
      if ((m[2] ?? '').trim() !== '') fail('no-eval', `${file}: inline script`);
      else fail('no-eval', `${file}: script without src`);
    } else if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
      fail('no-eval', `${file}: remote script ${src}`);
    } else if (!has(`${dir}${src}`.replace(/^\.\//, ''))) {
      fail('files', `${file}: script ${src} is missing`);
    }
  }
  if (/<[^>]*\son[a-z]+\s*=/i.test(text))
    fail('no-eval', `${file}: inline event handler attribute`);
  if (/javascript:/i.test(text)) fail('no-eval', `${file}: javascript: URL`);
}

async function lintBootstrap(
  files: readonly string[],
  read: (p: string) => Promise<Buffer>,
  fail: (rule: string, message: string) => void,
): Promise<void> {
  const coreFiles = files.filter(
    f => f.startsWith('data/bootstrap/') && f !== BOOTSTRAP_INDEX_PATH,
  );
  if (!files.includes(BOOTSTRAP_INDEX_PATH)) {
    if (coreFiles.length > 0) fail('bootstrap', 'bootstrap core files without an index');
    return;
  }
  let index: unknown;
  try {
    index = JSON.parse((await read(BOOTSTRAP_INDEX_PATH)).toString('utf8'));
  } catch {
    fail('bootstrap', `${BOOTSTRAP_INDEX_PATH} is not JSON`);
    return;
  }
  if (!isRecord(index) || index['schema'] !== 'intactwarden.bootstrap/1') {
    fail('bootstrap', 'bootstrap index schema must be intactwarden.bootstrap/1');
    return;
  }
  const cores = Array.isArray(index['cores']) ? index['cores'] : [];
  const listed = new Set<string>();
  for (const c of cores) {
    const sha = isRecord(c) ? c['sha256'] : undefined;
    const path = isRecord(c) ? c['path'] : undefined;
    const size = isRecord(c) ? c['size'] : undefined;
    if (
      typeof sha !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sha) ||
      path !== `data/bootstrap/cores/${sha}.json`
    ) {
      fail('bootstrap', `core entry with bad sha256 or path: ${JSON.stringify(path)}`);
      continue;
    }
    listed.add(path);
    if (!files.includes(path)) {
      fail('bootstrap', `${path} is missing`);
      continue;
    }
    const bytes = await read(path);
    if (sha256(bytes) !== sha) fail('bootstrap', `${path} does not hash to its name`);
    if (size !== bytes.length)
      fail('bootstrap', `${path}: size ${bytes.length}, index ${String(size)}`);
  }
  for (const f of coreFiles) if (!listed.has(f)) fail('bootstrap', `${f} is not in the index`);
}
