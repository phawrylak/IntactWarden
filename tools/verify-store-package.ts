/**
 * verify-store-package (docs/security.md): compares the IntactWarden
 * package a store serves (the XPI) with the package this project's release
 * workflow built and attested, file by file. Anyone can run it on their own
 * machine; the daily store-diff workflow (.github/workflows/store-diff.yml)
 * runs it in CI.
 *
 * Usage: see USAGE below (`npm run verify-store-package -- --help`).
 *
 * 1. With --sha256sums, the expected zip's SHA-256 must be listed in the
 *    release's SHA256SUMS (`<sha256>  <file>` lines, as sha256sum writes)
 *    under the release asset's name, `intactwarden-<version>-firefox.zip`
 *    (the version from the zip's manifest.json).
 * 2. Both packages are read with the strict zip reader of @intactwarden/core
 *    (directory entries ignored).
 * 3. AMO's five signature files (`META-INF/manifest.mf`, `mozilla.sf`,
 *    `mozilla.rsa`, `cose.manifest`, `cose.sig`) are stripped from the store
 *    side only (AMO re-signs every package); any other file the
 *    store adds, under `META-INF/` or not, is `extra`. An expected zip that
 *    contains `META-INF/` is an input error.
 * 4. Files are compared by path and SHA-256: `missing`, `extra`, `differs`.
 * 5. The tool prints how to check the expected zip's provenance with
 *    `gh attestation verify`, pinned to the release workflow and the release
 *    tag (`--source-ref refs/tags/v<version>`); it does not verify the
 *    attestation itself (the GitHub CLI does).
 *
 * The strict reader is not loosened for store packages: if AMO packages use
 * zip features it refuses, the tool exits 3 with the reason (to be confirmed
 * on the first listing).
 *
 * Only node: built-ins and @intactwarden/core; Node >= 22.18 runs this file
 * directly (type stripping).
 */

import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {readZipDirectory, readZipEntry, ZipError} from '@intactwarden/core/archive/zip.ts';

export const REPO = 'phawrylak/IntactWarden';
/** Where stores put their signature files; never part of a release build. */
export const STORE_SIGNATURE_DIR = 'META-INF/';
/** AMO's signature files: the only store files stripped before the comparison. */
export const STORE_SIGNATURE_FILES: ReadonlySet<string> = new Set([
  'META-INF/cose.manifest',
  'META-INF/cose.sig',
  'META-INF/manifest.mf',
  'META-INF/mozilla.rsa',
  'META-INF/mozilla.sf',
]);
/** The only workflow that builds and attests store packages. */
export const RELEASE_WORKFLOW = `${REPO}/.github/workflows/release-extension.yml`;

/** Exit statuses. */
export const EXIT = Object.freeze({identical: 0, different: 1, usage: 2, input: 3});

/** Caps for local input: a Firefox package is a few MB. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;

export const USAGE = `usage: npm run verify-store-package -- --expected <intactwarden-<version>-firefox.zip>
         --package <file.xpi|file.zip> [--sha256sums <SHA256SUMS>]

Compares the package a store serves with the package IntactWarden's release
workflow built and attested (the zip on the GitHub release).

  --expected <zip>      the release zip (download it with SHA256SUMS from the
                        GitHub release of the version you have installed)
  --package <file>      the package the store serves (for AMO, the .xpi file)
  --sha256sums <file>   the release's SHA256SUMS; the expected zip must be listed

AMO's five signature files (META-INF/manifest.mf, mozilla.sf, mozilla.rsa,
cose.manifest, cose.sig) are removed from the store side before the comparison;
every other file must be byte-identical, with nothing missing and nothing extra.
With --sha256sums, the expected zip must be listed as
intactwarden-<version>-firefox.zip (the version of its manifest.json). Check the
expected zip's provenance as well (add --source-digest <the tag's commit> to pin
the commit too):
  gh attestation verify <zip> --repo ${REPO} \\
    --signer-workflow ${RELEASE_WORKFLOW} \\
    --source-ref refs/tags/v<version>

Exit status: 0 identical (and listed in SHA256SUMS when given), 1 differences or
not listed in SHA256SUMS, 2 usage error, 3 input error (an unreadable file, an
archive the strict reader refuses, META-INF/ in the expected zip, a malformed
SHA256SUMS).
`;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export interface FileSet {
  /** Path (relative, `/`-separated) → lowercase hex SHA-256. */
  readonly files: ReadonlyMap<string, string>;
  /** Store signature files that were removed, sorted. */
  readonly stripped: readonly string[];
  /** `version` of manifest.json when it is `<major>.<minor>.<patch>`, else null. */
  readonly version: string | null;
}

export type Difference =
  | {readonly kind: 'missing'; readonly path: string}
  | {readonly kind: 'extra'; readonly path: string}
  | {
      readonly kind: 'differs';
      readonly path: string;
      readonly expected: string;
      readonly actual: string;
    };

export interface ChecksumLine {
  readonly sha256: string;
  readonly name: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A path as printed: unchanged when it is plain printable ASCII, else as a JSON string. */
export function printable(path: string): string {
  return /^[\x21-\x7e]+$/.test(path) ? path : JSON.stringify(path);
}

/** POSIX shell quoting for the printed `gh` command. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9._/+@=:,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function isStoreSignature(path: string): boolean {
  return STORE_SIGNATURE_FILES.has(path);
}

/** The `version` of a manifest.json, when it is `<major>.<minor>.<patch>`. */
function manifestVersion(bytes: Uint8Array): string | null {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const version = (value as Record<string, unknown>)['version'];
    return typeof version === 'string' && /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/.test(version)
      ? version
      : null;
  } catch {
    return null;
  }
}

/**
 * The files of a zip, read with the strict reader. On the store side, AMO's
 * signature files are stripped; on the expected side `META-INF/` is an error.
 */
export async function zipFileSet(
  bytes: Uint8Array,
  side: 'expected' | 'store',
  label: string,
): Promise<FileSet> {
  try {
    const entries = readZipDirectory(bytes);
    const files = new Map<string, string>();
    const stripped: string[] = [];
    let version: string | null = null;
    for (const entry of entries) {
      if (side === 'expected' && entry.name.startsWith(STORE_SIGNATURE_DIR)) {
        throw new InputError(
          `${label}: contains ${printable(entry.name)}; store signature files are added by the store, never by the release build`,
        );
      }
      if (entry.isDirectory) continue;
      if (side === 'store' && isStoreSignature(entry.name)) {
        stripped.push(entry.name);
        continue;
      }
      const data = await readZipEntry(bytes, entry);
      if (entry.name === 'manifest.json') version = manifestVersion(data);
      files.set(entry.name, sha256(data));
    }
    return {files, stripped: stripped.sort(compare), version};
  } catch (e) {
    if (e instanceof ZipError) {
      throw new InputError(`${label}: the strict zip reader refuses it (${e.code}): ${e.message}`);
    }
    throw e;
  }
}

/** Every difference, sorted by path. */
export function compareFileSets(expected: FileSet, actual: FileSet): Difference[] {
  const paths = [...new Set([...expected.files.keys(), ...actual.files.keys()])].sort(compare);
  const out: Difference[] = [];
  for (const path of paths) {
    const e = expected.files.get(path);
    const a = actual.files.get(path);
    if (a === undefined) out.push({kind: 'missing', path});
    else if (e === undefined) out.push({kind: 'extra', path});
    else if (e !== a) out.push({kind: 'differs', path, expected: e, actual: a});
  }
  return out;
}

/**
 * Parses a SHA256SUMS file: `<64 lowercase hex>  <name>` lines (or ` *<name>`,
 * sha256sum's binary mode), LF-separated, a trailing CR tolerated. Anything
 * else is an input error.
 */
export function parseSha256Sums(text: string, label = 'SHA256SUMS'): ChecksumLine[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: ChecksumLine[] = [];
  lines.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = /^([0-9a-f]{64}) [ *]([^\r\n]+)$/.exec(line);
    if (m === null) throw new InputError(`${label}: line ${i + 1} is not "<sha256>  <file>"`);
    out.push({sha256: m[1]!, name: m[2]!});
  });
  if (out.length === 0) throw new InputError(`${label}: lists no file`);
  return out;
}

async function readInput(path: string, label: string, max: number): Promise<Uint8Array> {
  let info;
  try {
    info = await stat(path);
  } catch (e) {
    throw new InputError(`${label}: cannot read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!info.isFile()) throw new InputError(`${label}: not a regular file`);
  if (info.size > max) throw new InputError(`${label}: larger than ${max} bytes`);
  try {
    return new Uint8Array(await readFile(path));
  } catch (e) {
    throw new InputError(`${label}: cannot read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface Report {
  readonly result: 'pass' | 'fail';
  readonly identical: boolean;
  readonly expected: {readonly path: string; readonly sha256: string; readonly files: number};
  readonly sha256sums?: {
    readonly path: string;
    readonly listed: boolean;
    /** The release asset name the zip must be listed as. */
    readonly expected_name: string;
    /** Every name the zip's digest is listed under. */
    readonly names: string[];
  };
  readonly store: {
    readonly path: string;
    readonly files: number;
    readonly stripped: readonly string[];
  };
  readonly differences: readonly Difference[];
  readonly provenanceCommand: string;
}

function provenanceCommand(expected: string, version: string | null): string {
  return (
    `gh attestation verify ${shellQuote(expected)} --repo ${REPO} --signer-workflow ${RELEASE_WORKFLOW}` +
    ` --source-ref refs/tags/v${version ?? '<version>'}`
  );
}

function textReport(r: Report): string {
  const lines: string[] = [];
  lines.push(
    `expected: ${printable(r.expected.path)} (sha256 ${r.expected.sha256}, ${r.expected.files} files)`,
  );
  if (r.sha256sums !== undefined) {
    const sums = r.sha256sums;
    lines.push(
      sums.listed
        ? `SHA256SUMS: the expected zip is listed as ${printable(sums.expected_name)}`
        : sums.names.length > 0
          ? `SHA256SUMS: the expected zip's sha256 is NOT listed as ${printable(sums.expected_name)} (only as ${sums.names.map(printable).join(', ')})`
          : `SHA256SUMS: the expected zip's sha256 is NOT listed in ${printable(sums.path)}`,
    );
  }
  lines.push(
    `store package: ${printable(r.store.path)} (${r.store.files} files` +
      (r.store.stripped.length === 0
        ? ', no store signature files)'
        : `; stripped ${r.store.stripped.length} store signature files: ${r.store.stripped.map(printable).join(', ')})`),
  );
  for (const d of r.differences) {
    if (d.kind === 'differs') {
      lines.push(`differs ${printable(d.path)} expected ${d.expected} actual ${d.actual}`);
    } else {
      lines.push(`${d.kind} ${printable(d.path)}`);
    }
  }
  if (r.identical) {
    lines.push(`files: identical (${r.expected.files} files)`);
  } else {
    lines.push(`files: ${r.differences.length} difference${r.differences.length === 1 ? '' : 's'}`);
  }
  lines.push(`result: ${r.result === 'pass' ? 'PASS' : 'FAIL'}`);
  lines.push(
    'provenance (not checked by this tool): verify that the expected zip was built and attested',
    `by IntactWarden's release workflow with:\n  ${r.provenanceCommand}`,
  );
  return `${lines.join('\n')}\n`;
}

interface Options {
  readonly expected: string;
  readonly package: string;
  readonly sha256sums?: string;
}

/** Runs the comparison; throws InputError on input errors. */
export async function verifyStorePackage(o: Options): Promise<Report> {
  const expectedBytes = await readInput(o.expected, 'expected zip', MAX_ARCHIVE_BYTES);
  const expectedSha256 = sha256(expectedBytes);
  const expected = await zipFileSet(expectedBytes, 'expected', 'expected zip');
  const version = expected.version;
  let sums: Report['sha256sums'];
  if (o.sha256sums !== undefined) {
    const raw = await readInput(o.sha256sums, 'SHA256SUMS', MAX_SUMS_BYTES);
    let text: string;
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    } catch {
      throw new InputError('SHA256SUMS: not UTF-8 text');
    }
    const names = parseSha256Sums(text)
      .filter(l => l.sha256 === expectedSha256)
      .map(l => l.name);
    // The release lists the zip under its asset name; the same digest under another name
    // (the source tarball's, say) does not vouch for it.
    const expectedName =
      version === null ? basename(o.expected) : `intactwarden-${version}-firefox.zip`;
    sums = {
      path: o.sha256sums,
      listed: names.includes(expectedName),
      expected_name: expectedName,
      names,
    };
  }
  const store = await zipFileSet(
    await readInput(o.package, 'store package', MAX_ARCHIVE_BYTES),
    'store',
    'store package',
  );
  const differences = compareFileSets(expected, store);
  const identical = differences.length === 0;
  return {
    result: identical && (sums === undefined || sums.listed) ? 'pass' : 'fail',
    identical,
    expected: {path: o.expected, sha256: expectedSha256, files: expected.files.size},
    ...(sums === undefined ? {} : {sha256sums: sums}),
    store: {path: o.package, files: store.files.size, stripped: store.stripped},
    differences,
    provenanceCommand: provenanceCommand(o.expected, version),
  };
}

/** Command line; returns the exit status. Never throws. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let values: {
    expected?: string;
    package?: string;
    sha256sums?: string;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        expected: {type: 'string'},
        package: {type: 'string'},
        sha256sums: {type: 'string'},
        help: {type: 'boolean', short: 'h'},
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    io.stderr(`verify-store-package: ${(e as Error).message}\n${USAGE}`);
    return EXIT.usage;
  }
  if (values.help === true) {
    io.stdout(USAGE);
    return EXIT.identical;
  }
  const problem =
    values.expected === undefined || values.expected === ''
      ? 'missing --expected'
      : values.package === undefined || values.package === ''
        ? 'missing --package'
        : values.sha256sums === ''
          ? 'empty path'
          : null;
  if (problem !== null) {
    io.stderr(`verify-store-package: ${problem}\n${USAGE}`);
    return EXIT.usage;
  }
  try {
    const report = await verifyStorePackage({
      expected: values.expected!,
      package: values.package!,
      ...(values.sha256sums === undefined ? {} : {sha256sums: values.sha256sums}),
    });
    io.stdout(textReport(report));
    return report.result === 'pass' ? EXIT.identical : EXIT.different;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    io.stderr(`verify-store-package: ${message}\n`);
    return EXIT.input;
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
