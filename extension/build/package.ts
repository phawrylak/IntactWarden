/**
 * `npm run package:ext` (docs/release.md).
 *
 * Zips the built production package (`<dist>/firefox/`) deterministically (zip.ts: sorted entries,
 * STORE, fixed 1980-01-01 timestamps and attributes) into `<dist>/intactwarden-<version>-firefox.zip`
 * and writes `<dist>/SHA256SUMS` (`<sha256>  <file>`). Run `npm run build:ext` first; this script
 * never builds. Before zipping it runs bundle-lint as a production package (a test build, or a
 * build with bundled cores, is refused) and checks that the manifest version is the extension's
 * version; it reads the zip back with the strict reader of @intactwarden/core, which
 * verify-store-package also uses (structure and CRC of every entry). CI builds and packages twice
 * and compares the SHA256SUMS (docs/security.md).
 */

import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {readZipDirectory, readZipEntry} from '@intactwarden/core/archive/zip.ts';
import {lintBundle} from './bundleLint.ts';
import {DIST_DIR, extensionVersion, isMain, PACKAGE_NAME, repoRelative} from './paths.ts';
import {zipDirectory} from './zip.ts';

export const SUMS_FILE = 'SHA256SUMS';

export function zipName(version: string): string {
  return `intactwarden-${version}-${PACKAGE_NAME}.zip`;
}

export interface PackageOptions {
  /** Directory holding the `firefox/` build; the zip and SHA256SUMS are written here (default extension/dist). */
  readonly distDir?: string;
  readonly log?: (line: string) => void;
}

export interface PackagedZip {
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
}

/** Packages the Firefox build; throws with every problem found. */
export async function packageExtension(options: PackageOptions = {}): Promise<PackagedZip> {
  const distDir = resolve(options.distDir ?? DIST_DIR);
  const log = options.log ?? (() => {});
  const version = extensionVersion();
  const dir = join(distDir, PACKAGE_NAME);
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error(`${repoRelative(dir)} is not built; run npm run build:ext first`);
  }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    version?: unknown;
  };
  if (manifest.version !== version) {
    throw new Error(`manifest version ${String(manifest.version)} is not ${version}`);
  }
  const findings = await lintBundle(dir, {test: false});
  if (findings.length > 0) {
    throw new Error(
      `bundle-lint failed, not packaging:\n` +
        findings.map(f => `  [${f.rule}] ${f.message}`).join('\n'),
    );
  }
  const zip = await zipDirectory(dir);
  for (const entry of readZipDirectory(zip)) await readZipEntry(zip, entry);
  const file = zipName(version);
  await writeFile(join(distDir, file), zip);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  log(`${file}: ${zip.length} bytes, sha256 ${sha256}`);
  await writeFile(join(distDir, SUMS_FILE), `${sha256}  ${file}\n`);
  return {file, sha256, size: zip.length};
}

if (isMain(import.meta.url)) {
  try {
    await packageExtension({log: line => process.stdout.write(`${line}\n`)});
  } catch (e) {
    process.stderr.write(`package:ext: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
