/**
 * `npm run build:ext [-- --test [--bootstrap all|none|bitwarden|vaultwarden]]`
 *
 * Builds the Firefox package (the only one IntactWarden ships) into `extension/dist/firefox/`
 * (`extension/dist-test/firefox/` with `--test`): the esbuild bundles `background.js`,
 * `content.js` and `ui/<page>.js`, the pages' HTML and CSS, `manifest.json` (manifest.ts),
 * `_locales/` (locales.ts) and the icons; then bundle-lint (bundleLint.ts). A missing file, an
 * esbuild warning or a lint finding fails the build.
 *
 * The shipping package carries no bundled cores: deep verify builds every release in the browser.
 * Only a test build may bundle cores (`--bootstrap`, bootstrap.ts), which downloads the pinned
 * releases; the end-to-end suite uses that.
 *
 * The bundles are IIFE (content scripts and event pages cannot be modules), not minified (store
 * review), without source maps, legal comments or `define` substitutions, and built from the
 * repository root so that output comments carry stable relative paths. One module is generated:
 * extension/src/trust/fingerprint.ts is replaced with the builder fingerprint (fingerprint.ts).
 * The output is a pure function of the sources (and, for a test build with bootstrap data, the
 * locks and the pinned release bytes): building twice gives byte-identical directories (CI
 * checks this). A test build differs from a production build only by its manifest and its
 * bootstrap data.
 */

import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import * as esbuild from 'esbuild';
import {MANIFEST_MESSAGE_KEYS, PAGES} from '../src/contracts.ts';
import {
  ACTION_ICONS,
  actionIconFile,
  PRODUCT_ICON_SIZES,
  productIconPath,
} from '../src/platform/iconPaths.ts';
import {
  buildBootstrap,
  isBootstrapSelection,
  writeBootstrap,
  type BootstrapData,
  type BootstrapSelection,
} from './bootstrap.ts';
import {lintBundle, type LintFinding} from './bundleLint.ts';
import {listFiles} from './files.ts';
import {computeBuilderFingerprint} from './fingerprint.ts';
import {copyLocales, manifestMessageKeys} from './locales.ts';
import {buildManifest, esbuildTargets, serializeManifest} from './manifest.ts';
import {
  DIST_DIR,
  DIST_TEST_DIR,
  EXTENSION_DIR,
  extensionVersion,
  isMain,
  LOCALES_DIR,
  PACKAGE_NAME,
  REPO_ROOT,
  repoRelative,
  SRC_DIR,
} from './paths.ts';

export interface BuildOptions {
  /** Test build: loopback host permissions, default output dist-test/. */
  readonly test?: boolean;
  /** Test builds only: which apps get bundled cores (default 'none': no bootstrap data). */
  readonly bootstrap?: BootstrapSelection;
  /** Test builds only: pre-built bootstrap data; otherwise generated with buildBootstrap(). */
  readonly bootstrapData?: BootstrapData;
  /** Parent of the `firefox/` package directory (default dist/ or dist-test/). */
  readonly outRoot?: string;
  readonly localesDir?: string;
  readonly log?: (line: string) => void;
}

export interface PackageBuild {
  readonly dir: string;
  /** Package paths, sorted. */
  readonly files: readonly string[];
  /** The esbuild inputs of the bundles (repository-relative, sorted). */
  readonly bundleInputs: readonly string[];
  /** The builder fingerprint written into the bundles. */
  readonly fingerprint: string;
  readonly findings: readonly LintFinding[];
}

export class BuildError extends Error {
  override name = 'BuildError';
}

/** esbuild entry points: output name (no extension) → source path. */
export function entryPoints(): Record<string, string> {
  const rel = (p: string): string => relative(REPO_ROOT, join(SRC_DIR, p)).split('\\').join('/');
  const entries: Record<string, string> = {
    background: rel('background/main.ts'),
    content: rel('content/main.ts'),
  };
  for (const [name, page] of Object.entries(PAGES)) {
    entries[page.replace(/\.html$/, '')] = rel(`ui/${name}/main.ts`);
  }
  return entries;
}

async function writeOut(dir: string, path: string, bytes: Uint8Array | string): Promise<void> {
  const abs = join(dir, path);
  await mkdir(dirname(abs), {recursive: true});
  await writeFile(abs, bytes);
}

/** Copies the pages' HTML and CSS and the shared stylesheet. */
async function writePages(dir: string): Promise<void> {
  await writeOut(dir, 'ui/ui.css', await readFile(join(SRC_DIR, 'ui', 'shared', 'ui.css')));
  for (const [name, page] of Object.entries(PAGES)) {
    const base = page.slice(page.lastIndexOf('/') + 1).replace(/\.html$/, '');
    for (const ext of ['.css', '.html']) {
      const bytes = await readFile(join(SRC_DIR, 'ui', name, `${base}${ext}`));
      await writeOut(dir, page.replace(/\.html$/, ext), bytes);
    }
  }
}

/** Copies the committed icon files the package names (iconPaths.ts); a missing one is an error. */
async function writeIcons(dir: string): Promise<void> {
  for (const path of [
    ...ACTION_ICONS.map(actionIconFile),
    ...PRODUCT_ICON_SIZES.map(productIconPath),
  ])
    await writeOut(dir, path, await readFile(join(EXTENSION_DIR, path)));
}

function formatMessages(messages: readonly esbuild.Message[]): string {
  return messages
    .map(m => {
      const loc =
        m.location === null ? '' : `${m.location.file}:${m.location.line}:${m.location.column}: `;
      return `  ${loc}${m.text}`;
    })
    .join('\n');
}

/** The module the build generates: the builder fingerprint replaces its stub. */
const FINGERPRINT_MODULE = join(SRC_DIR, 'trust', 'fingerprint.ts');

async function bundle(options: {
  readonly dir: string;
  readonly syntax: string[];
  readonly fingerprint: string;
}): Promise<{files: string[]; inputs: string[]}> {
  let generated = false;
  const fingerprintModule: esbuild.Plugin = {
    name: 'builder-fingerprint',
    setup(build) {
      build.onLoad({filter: /fingerprint\.ts$/}, args => {
        if (resolve(args.path) !== FINGERPRINT_MODULE) return undefined;
        generated = true;
        const value = JSON.stringify(options.fingerprint);
        return {contents: `export const BUILDER_FINGERPRINT = ${value};\n`, loader: 'ts'};
      });
    },
  };
  let result: esbuild.BuildResult<{write: false; metafile: true}>;
  try {
    result = await esbuild.build({
      absWorkingDir: REPO_ROOT,
      entryPoints: entryPoints(),
      outdir: options.dir,
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      platform: 'browser',
      target: options.syntax,
      minify: false,
      legalComments: 'none',
      charset: 'utf8',
      sourcemap: false,
      treeShaking: true,
      logLevel: 'silent',
      plugins: [fingerprintModule],
    });
  } catch (e) {
    const errors = (e as {errors?: esbuild.Message[]}).errors;
    throw new BuildError(`esbuild failed:\n${errors ? formatMessages(errors) : String(e)}`);
  }
  if (result.warnings.length > 0) {
    throw new BuildError(
      `esbuild warnings (treated as errors):\n${formatMessages(result.warnings)}`,
    );
  }
  if (!generated) throw new BuildError(`${repoRelative(FINGERPRINT_MODULE)} was not bundled`);
  const files: string[] = [];
  for (const f of result.outputFiles) {
    const rel = relative(options.dir, f.path).split('\\').join('/');
    if (rel.startsWith('..')) throw new BuildError(`esbuild wrote outside the package: ${f.path}`);
    await writeOut(options.dir, rel, f.contents);
    files.push(rel);
  }
  return {files, inputs: Object.keys(result.metafile.inputs).sort()};
}

/** Builds the Firefox package; throws BuildError on any failure (lint findings included). */
export async function buildExtension(options: BuildOptions = {}): Promise<PackageBuild> {
  const test = options.test ?? false;
  const selection = options.bootstrap ?? 'none';
  const localesDir = options.localesDir ?? LOCALES_DIR;
  const outRoot = resolve(options.outRoot ?? (test ? DIST_TEST_DIR : DIST_DIR));
  const log = options.log ?? (() => {});
  const version = extensionVersion();
  if (!test && (selection !== 'none' || options.bootstrapData !== undefined)) {
    throw new BuildError('bundled cores are for test builds only (--test)');
  }

  let bootstrap: BootstrapData | null = options.bootstrapData ?? null;
  if (bootstrap === null && selection !== 'none') {
    log(`bootstrap: generating (${selection})`);
    bootstrap = await buildBootstrap({apps: selection, log: line => log(`  ${line}`)});
  }

  const dir = join(outRoot, PACKAGE_NAME);
  log(`building ${repoRelative(dir)}${test ? ' (test build)' : ''}`);
  await rm(dir, {recursive: true, force: true});
  await mkdir(dir, {recursive: true});

  const manifest = await buildManifest({test, version});
  const fingerprint = await computeBuilderFingerprint();
  log(`builder fingerprint ${fingerprint}`);
  const {inputs} = await bundle({dir, syntax: esbuildTargets(manifest), fingerprint});
  await writePages(dir);
  await writeOut(dir, 'manifest.json', serializeManifest(manifest));
  const keys = [...new Set([...MANIFEST_MESSAGE_KEYS, ...manifestMessageKeys(manifest)])];
  await copyLocales(localesDir, dir, keys);
  await writeIcons(dir);
  await writeOut(dir, 'LICENSE.txt', await readFile(join(REPO_ROOT, 'LICENSE')));
  if (bootstrap !== null) await writeBootstrap(dir, bootstrap);

  const findings = await lintBundle(dir, {test, bundleInputs: inputs});
  if (findings.length > 0) {
    throw new BuildError(
      `bundle-lint failed for ${repoRelative(dir)}:\n` +
        findings.map(f => `  [${f.rule}] ${f.message}`).join('\n'),
    );
  }
  const files = await listFiles(dir);
  log(`${files.length} files, bundle-lint passed`);
  return {dir, files, bundleInputs: inputs, fingerprint, findings};
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = 'usage: npm run build:ext -- [--test [--bootstrap all|none|bitwarden|vaultwarden]]\n';

export async function main(argv: readonly string[]): Promise<number> {
  let values: {test?: boolean; bootstrap?: string};
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        test: {type: 'boolean'},
        bootstrap: {type: 'string'},
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const bootstrap = values.bootstrap ?? 'none';
  if (!isBootstrapSelection(bootstrap) || (bootstrap !== 'none' && values.test !== true)) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const result = await buildExtension({
      test: values.test ?? false,
      bootstrap,
      log: line => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`built ${repoRelative(result.dir)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`build:ext: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
