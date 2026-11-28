/**
 * Integration test of the extension build (esbuild on the real sources, the Firefox package) with
 * a fixture catalogue, and synthetic bootstrap data for the test build, so it needs neither the
 * network nor the corpus. The real bootstrap data is covered by bootstrap.corpus.test.ts.
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {readZipDirectory, readZipEntry} from '@intactwarden/core/archive/zip.ts';
import type {BootstrapIndex} from '../../src/contracts.ts';
import {ACTION_ICONS, actionIconFile} from '../../src/platform/iconPaths.ts';
import type {BootstrapData} from '../../build/bootstrap.ts';
import {buildExtension, type PackageBuild} from '../../build/build.ts';
import {listFiles} from '../../build/files.ts';
import {computeBuilderFingerprint, readFingerprintSources} from '../../build/fingerprint.ts';
import {generatedHostPermissions} from '../../build/manifest.ts';
import {packageExtension, zipName} from '../../build/package.ts';
import {extensionVersion, REPO_ROOT} from '../../build/paths.ts';
import {main as verifyStorePackage} from '../../../tools/verify-store-package.ts';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const enc = new TextEncoder();
const LOCK = 'fixtures/corpora/vaultwarden-web-2026.10.1.lock.json';

function syntheticBootstrap(): BootstrapData {
  const core = enc.encode('{"schema":"intactwarden.manifest/1"}');
  const coreSha = sha256(core);
  const path = `data/bootstrap/cores/${coreSha}.json`;
  const index: BootstrapIndex = {
    schema: 'intactwarden.bootstrap/1',
    generated_from: [{lock: LOCK, sha256: sha256(readFileSync(join(REPO_ROOT, LOCK)))}],
    cores: [
      {
        app: 'vaultwarden-web',
        variant: 'release',
        version: '2026.10.1',
        build_id: 'vaultwarden-web@2026.10.1+release',
        assurance: 'release-exact',
        sha256: coreSha,
        size: core.length,
        path,
      },
    ],
    pins: {schema: 'intactwarden.localpins/1', pins: []},
  };
  const indexBytes = enc.encode(JSON.stringify(index));
  return {
    index,
    indexBytes,
    indexSha256: sha256(indexBytes),
    files: new Map([
      [path, core],
      ['data/bootstrap/index.json', indexBytes],
    ]),
  };
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of await listFiles(dir)) out.set(f, sha256(await readFile(join(dir, f))));
  return out;
}

let root: string;
let locales: string;
let first: PackageBuild;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'iw-build-'));
  locales = join(root, '_locales');
  const messages = JSON.stringify({
    extName: {message: 'IntactWarden'},
    extDescription: {message: 'Checks web vaults.'},
    actionTitle: {message: 'IntactWarden'},
  });
  for (const l of ['en', 'pl']) {
    await mkdir(join(locales, l), {recursive: true});
    await writeFile(join(locales, l, 'messages.json'), messages);
  }
  first = await buildExtension({outRoot: join(root, 'a'), localesDir: locales});
}, 120_000);

afterAll(async () => {
  await rm(root, {recursive: true, force: true});
});

describe('buildExtension', () => {
  it('builds the Firefox package and bundle-lint passes', () => {
    expect(first.dir).toBe(join(root, 'a', 'firefox'));
    expect(first.findings).toEqual([]);
    // No third-party code: every esbuild input is a repository source (bundle-lint `third-party`).
    expect(first.bundleInputs.filter(i => i.includes('node_modules'))).toEqual([]);
    expect(first.bundleInputs.length).toBeGreaterThan(0);
  });

  it('writes the expected package layout', () => {
    expect(first.files).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'background.js',
        'content.js',
        'ui/popup.html',
        'ui/popup.js',
        'ui/options.html',
        '_locales/en/messages.json',
        '_locales/pl/messages.json',
        'assets/icons/icon-128.png',
        'LICENSE.txt',
      ]),
    );
    // The shipping package bundles no cores and no pins.
    expect(first.files.filter(f => f.startsWith('data/'))).toEqual([]);
    expect(first.files).toEqual(expect.arrayContaining(ACTION_ICONS.map(i => actionIconFile(i))));
    expect(first.files.filter(f => f.endsWith('.png') && f.includes('/state/'))).toEqual([]);
  });

  it('copies the committed icons byte for byte', async () => {
    for (const f of first.files.filter(p => p.startsWith('assets/'))) {
      expect(await readFile(join(first.dir, f)), f).toEqual(
        await readFile(join(REPO_ROOT, 'extension', f)),
      );
    }
  });

  it('refuses bundled cores in a production build', async () => {
    await expect(
      buildExtension({
        bootstrapData: syntheticBootstrap(),
        outRoot: join(root, 'refused'),
        localesDir: locales,
      }),
    ).rejects.toThrow(/test builds only/);
  });

  it('writes the builder fingerprint into the bundles', async () => {
    expect(first.fingerprint).toBe(await computeBuilderFingerprint());
    const bg = await readFile(join(first.dir, 'background.js'), 'utf8');
    expect(bg).toContain(`BUILDER_FINGERPRINT = "${first.fingerprint}"`);
    expect(bg).not.toContain('unbuilt');
  });

  it('fingerprints every bundled package source that can change a core', async () => {
    const sources = new Set((await readFingerprintSources()).keys());
    // The extension loads these three core directories; the builders do not.
    const unhashed = /^packages\/core\/src\/(?:privacy|style|verdict)\//;
    const bundled = first.bundleInputs.filter(i => i.startsWith('packages/'));
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.filter(i => !sources.has(i) && !unhashed.test(i))).toEqual([]);
  });

  it('bundles are IIFE and not minified', async () => {
    const bg = await readFile(join(first.dir, 'background.js'), 'utf8');
    expect(bg).toMatch(/^"use strict";\n\(\(\) => \{\n/);
    expect(bg).not.toMatch(/\bexport\b\s*\{/);
    expect(bg.split('\n').length).toBeGreaterThan(100);
    // What AMO's linter reads as minified code: a source-map comment anywhere in a script.
    for (const f of first.files.filter(p => p.endsWith('.js'))) {
      const text = await readFile(join(first.dir, f), 'utf8');
      expect(text, f).not.toMatch(/\/\/[#@]\s(source(?:Mapping)?URL)=\s*(\S+)/);
    }
  });

  it('copies the catalogue byte for byte and fills the manifest', async () => {
    expect(await readFile(join(first.dir, '_locales/pl/messages.json'), 'utf8')).toBe(
      await readFile(join(locales, 'pl/messages.json'), 'utf8'),
    );
    const manifest = JSON.parse(await readFile(join(first.dir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest['version']).toBe(extensionVersion());
    expect(manifest['host_permissions']).toEqual(generatedHostPermissions({test: false}));
    expect(manifest['background']).toEqual({scripts: ['background.js']});
  });

  it('is reproducible: a second build is byte-identical, and so is the zip', async () => {
    await buildExtension({outRoot: join(root, 'b'), localesDir: locales});
    expect(await snapshot(join(root, 'b', 'firefox'))).toEqual(
      await snapshot(join(root, 'a', 'firefox')),
    );
    const pa = await packageExtension({distDir: join(root, 'a')});
    const pb = await packageExtension({distDir: join(root, 'b')});
    expect(pb).toEqual(pa);
    expect(pa.file).toBe(zipName(extensionVersion()));
    expect(pa.file).toMatch(/^intactwarden-\d+\.\d+\.\d+-firefox\.zip$/);
    // SHA256SUMS: one `<sha256>  <file>` line.
    expect(await readFile(join(root, 'a', 'SHA256SUMS'), 'utf8')).toBe(
      `${pa.sha256}  ${pa.file}\n`,
    );
    const zip = new Uint8Array(await readFile(join(root, 'a', pa.file)));
    const entries = readZipDirectory(zip);
    expect(entries.map(e => e.name)).toEqual(first.files);
    expect(await readZipEntry(zip, entries[0]!)).toEqual(
      new Uint8Array(await readFile(join(first.dir, entries[0]!.name))),
    );
    // The package the release publishes passes the tool that compares it with the store's copy.
    const zipPath = join(root, 'a', pa.file);
    const errors: string[] = [];
    const code = await verifyStorePackage(
      ['--expected', zipPath, '--package', zipPath, '--sha256sums', join(root, 'a', 'SHA256SUMS')],
      {stdout: () => {}, stderr: t => void errors.push(t)},
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  }, 120_000);

  it('test builds differ only by the loopback hosts and bootstrap data (same scripts) and are never packaged', async () => {
    const out = join(root, 'test');
    const ff = await buildExtension({
      test: true,
      bootstrapData: syntheticBootstrap(),
      outRoot: out,
      localesDir: locales,
    });
    const manifest = JSON.parse(await readFile(join(ff.dir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest['host_permissions']).toEqual(generatedHostPermissions({test: true}));
    expect(ff.files).toContain('data/bootstrap/index.json');
    // No test hook in the shipped code: every script of a test build is the production script.
    const scripts = ff.files.filter(f => f.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(2);
    for (const f of scripts) {
      expect(await readFile(join(ff.dir, f)), f).toEqual(await readFile(join(first.dir, f)));
    }
    await expect(packageExtension({distDir: out})).rejects.toThrow(
      /bundle-lint failed, not packaging/,
    );
  }, 120_000);

  it('refuses a broken catalogue before writing a package that could load', async () => {
    const bad = join(root, 'bad-locales');
    await mkdir(join(bad, 'en'), {recursive: true});
    await writeFile(join(bad, 'en', 'messages.json'), JSON.stringify({extName: {message: 'x'}}));
    await expect(buildExtension({outRoot: join(root, 'bad'), localesDir: bad})).rejects.toThrow(
      /missing required locale pl/,
    );
  }, 120_000);
});
