/**
 * The recompute command (`npm run recompute -- …` or `node tools/recompute.ts …`): anyone can
 * rebuild the core manifest of a release from the release asset they downloaded themselves, with
 * the CoreBuilder the extension's deep verify calls, and compare the printed sha256 with the core
 * the extension builds (its Details page shows the first 16 digits). Every input is a local file;
 * the command makes no network request. Exit status: 0 success, 1 build refused, 2 usage error.
 */

import {realpathSync} from 'node:fs';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {BuildError, type BuilderApp, type BuilderVariant} from '@intactwarden/builders/api.ts';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';

export const USAGE = `usage: recompute.ts --app <app> --variant <variant> --version <x.y.z>
         --asset <file> --asset-sha256 <hex> --commit <sha> --out <file>
         [--tag-object <sha>] [--config-dir <dir>]

  bitwarden-web    selfhosted-commercial | cloud-us | cloud-eu
  vaultwarden-web  release

--asset is the release asset (web-<v>-selfhosted-COMMERCIAL.zip of bitwarden/clients,
bw_web_v<v>.tar.gz of dani-garcia/bw_web_builds); its sha256 must equal --asset-sha256 as
the GitHub release lists it. git ls-remote <repo> <tag> '<tag>^{}' prints the ids: one line
(a lightweight tag, as Bitwarden's) is --commit; two lines (an annotated tag, as
Vaultwarden's) are --tag-object and, on the ^{} line, --commit. The core records both:
without --tag-object the sha256 of an annotated-tag release differs from the extension's.
A cloud variant needs --config-dir with base.json and cloud.json (cloud-us) or euprd.json
(cloud-eu) of apps/web/config at that commit.

Writes the core as RFC 8785 bytes to --out and prints its sha256.
Exit status: 0 success, 1 build refused, 2 usage error.
`;

const OPTIONS = {
  app: {type: 'string'},
  variant: {type: 'string'},
  version: {type: 'string'},
  asset: {type: 'string'},
  'asset-sha256': {type: 'string'},
  commit: {type: 'string'},
  'tag-object': {type: 'string'},
  'config-dir': {type: 'string'},
  out: {type: 'string'},
  help: {type: 'boolean', short: 'h'},
} as const;

/** Output channels: results on stdout, diagnostics on stderr. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

class UsageError extends Error {}

/** Reads a file, or returns undefined when it does not exist. */
async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Runs the command; returns the exit status. Never throws. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    let v: Record<string, string | boolean | undefined>;
    try {
      v = parseArgs({
        args: [...argv],
        options: OPTIONS,
        strict: true,
        allowPositionals: false,
      }).values;
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e));
    }
    if (v['help'] === true) {
      io.stdout(USAGE);
      return 0;
    }
    const need = (name: string): string => {
      const value = v[name];
      if (typeof value !== 'string' || value === '') throw new UsageError(`missing --${name}`);
      return value;
    };
    const builder = createCoreBuilder();
    // An unknown app, variant or version is a usage error, not a refused build.
    let plan;
    try {
      plan = builder.plan(
        need('app') as BuilderApp,
        need('variant') as BuilderVariant,
        need('version'),
      );
    } catch (e) {
      if (e instanceof BuildError) throw new UsageError(e.message);
      throw e;
    }
    const out = need('out');
    const bytes = new Uint8Array(await readFile(need('asset')));
    const configs: Record<string, Uint8Array> = {};
    const configDir = v['config-dir'];
    if (typeof configDir === 'string') {
      // The builder refuses a missing file of the variant; files of the other region may be absent.
      for (const path of plan.configPaths) {
        const file = await readOptional(join(configDir, basename(path)));
        if (file !== undefined) configs[path] = file;
      }
    }
    const tagObject = v['tag-object'];
    const built = await builder.build({
      app: plan.app,
      variant: plan.variant,
      version: plan.version,
      release: {
        tag: plan.tag,
        commit: need('commit'),
        ...(typeof tagObject === 'string' ? {tagObject} : {}),
      },
      asset: {name: plan.assetName, sha256: need('asset-sha256'), size: bytes.length, bytes},
      configs,
    });
    // Via a temporary file and rename, so a reader never sees a partial file.
    await mkdir(dirname(resolve(out)), {recursive: true});
    const tmp = `${out}.${process.pid}.tmp`;
    await writeFile(tmp, built.bytes);
    await rename(tmp, out);
    io.stderr(`${built.buildId}: ${Object.keys(built.core.files).length} files\n`);
    io.stdout(`${built.sha256}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n${USAGE}`);
      return 2;
    }
    io.stderr(
      e instanceof BuildError
        ? `refused (${e.code}): ${e.message}\n`
        : `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`,
    );
    return 1;
  }
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
  process.exitCode = await main(process.argv.slice(2), {
    stdout: t => void process.stdout.write(t),
    stderr: t => void process.stderr.write(t),
  });
}
