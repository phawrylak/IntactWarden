/**
 * publish-amo (docs/release.md, "Release checklist"): submits a release to addons.mozilla.org
 * from the maintainer's own computer. The AMO API key is never stored on GitHub; it is read from
 * WEB_EXT_API_KEY and WEB_EXT_API_SECRET, for example injected by `bws run`.
 *
 * Usage: see USAGE below (`npm run publish:amo -- --help`).
 *
 * Nothing is sent to AMO unless every check passes:
 * 1. The tag verifies with `git verify-tag`, and its signature is by the primary key that
 *    `RELEASE_KEY_FPR` names in the release workflow at the tagged commit.
 * 2. The zip, the source tarball and SHA256SUMS are downloaded from the GitHub release of the tag;
 *    both files must match SHA256SUMS.
 * 3. `gh attestation verify` must show that the release workflow built both files from that tag
 *    and that commit.
 * 4. The zip's manifest.json must carry the tag's version and the add-on id of the tagged commit.
 * Then the zip is uploaded unchanged (listed channel), AMO's validation is awaited, and a version
 * is created from the upload with the source tarball attached. AMO's review follows.
 *
 * Only node: built-ins, `yaml` and the project's own modules; Node >= 22.18 runs this file
 * directly (type stripping).
 */

import {execFile} from 'node:child_process';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {parse as parseYaml} from 'yaml';
import {readZipDirectory, readZipEntry} from '@intactwarden/core/archive/zip.ts';
import {parseSha256Sums, RELEASE_WORKFLOW, REPO} from './verify-store-package.ts';

export const AMO_API = 'https://addons.mozilla.org/api/v5/';
/** How long AMO's validation of an upload is awaited. */
export const VALIDATION_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 5_000;
const MAX_FILE = 128 * 1024 * 1024;

export const EXIT = Object.freeze({submitted: 0, refused: 1, usage: 2});

export const USAGE = `usage: npm run publish:amo -- [--dry-run] v<major>.<minor>.<patch>

Checks the GitHub release of the tag (tag signature, SHA256SUMS, build provenance, manifest) and,
unless --dry-run, submits its zip and source tarball to AMO (listed channel).
Run it in a clone that has the tag, with gh signed in and the release key in gpg.
The AMO API key comes from WEB_EXT_API_KEY and WEB_EXT_API_SECRET, for example:
  bws run -- npm run publish:amo -- v1.0.0
`;

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Deps {
  /** Runs a program without a shell. */
  run(cmd: string, args: readonly string[]): Promise<RunResult>;
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  /** A new empty directory and the function that removes it. */
  tempDir(): Promise<{dir: string; remove: () => Promise<void>}>;
  readFile(path: string): Promise<Uint8Array>;
  sleep(ms: number): Promise<void>;
  now(): number;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** A check failed; nothing was sent to AMO. */
export class Refusal extends Error {}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

async function must(deps: Deps, cmd: string, args: readonly string[], what: string) {
  const r = await deps.run(cmd, args);
  if (r.code !== 0) throw new Refusal(`${what} failed:\n${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** A JWT for the AMO API (HS256, valid 60 s, a fresh jti each time). */
export function amoToken(key: string, secret: string, nowMs: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(nowMs / 1000);
  const head = `${b64({alg: 'HS256', typ: 'JWT'})}.${b64({iss: key, jti: randomUUID(), iat, exp: iat + 60})}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

/** The release key's primary fingerprint, from the release workflow at the tagged commit. */
async function releaseKeyFpr(deps: Deps, commit: string): Promise<string> {
  const text = await must(
    deps,
    'git',
    ['show', `${commit}:.github/workflows/release-extension.yml`],
    'reading the release workflow',
  );
  const doc: unknown = parseYaml(text);
  const fpr = isRecord(doc) && isRecord(doc['env']) ? doc['env']['RELEASE_KEY_FPR'] : undefined;
  if (typeof fpr !== 'string' || !/^[0-9A-F]{40}$/.test(fpr)) {
    throw new Refusal(
      'the release workflow at the tag does not name a release key (RELEASE_KEY_FPR)',
    );
  }
  return fpr;
}

async function checkTag(deps: Deps, tag: string): Promise<{commit: string; addonId: string}> {
  const commit = (
    await must(deps, 'git', ['rev-parse', '--verify', `${tag}^{commit}`], `finding tag ${tag}`)
  ).trim();
  const fpr = await releaseKeyFpr(deps, commit);
  const v = await deps.run('git', ['verify-tag', '--raw', tag]);
  const status = `${v.stdout}\n${v.stderr}`;
  if (v.code !== 0)
    throw new Refusal(`the signature of ${tag} does not verify:\n${v.stderr.trim()}`);
  // A VALIDSIG line ends with the fingerprint of the primary key, whichever subkey signed.
  if (!new RegExp(`^\\[GNUPG:\\] VALIDSIG .* ${fpr}$`, 'm').test(status)) {
    throw new Refusal(`${tag} is not signed by the release key ${fpr}`);
  }
  const manifest: unknown = JSON.parse(
    await must(deps, 'git', ['show', `${commit}:extension/manifest.json`], 'reading the manifest'),
  );
  const addonId = addonIdOf(manifest);
  if (addonId === null) throw new Refusal('the manifest at the tag names no add-on id');
  return {commit, addonId};
}

function addonIdOf(manifest: unknown): string | null {
  const bss = isRecord(manifest) ? manifest['browser_specific_settings'] : undefined;
  const gecko = isRecord(bss) ? bss['gecko'] : undefined;
  const id = isRecord(gecko) ? gecko['id'] : undefined;
  return typeof id === 'string' ? id : null;
}

async function readSmall(deps: Deps, path: string): Promise<Uint8Array> {
  const bytes = await deps.readFile(path);
  if (bytes.length > MAX_FILE) throw new Refusal(`${path} is larger than ${MAX_FILE} bytes`);
  return bytes;
}

interface Release {
  readonly zip: {name: string; bytes: Uint8Array};
  readonly source: {name: string; bytes: Uint8Array};
}

async function checkRelease(
  deps: Deps,
  dir: string,
  tag: string,
  version: string,
  t: {commit: string; addonId: string},
): Promise<Release> {
  const zipName = `intactwarden-${version}-firefox.zip`;
  const sourceName = `intactwarden-${version}-source.tar.gz`;
  await must(
    deps,
    'gh',
    ['release', 'download', tag, '--repo', REPO, '--dir', dir].concat([
      '--pattern',
      zipName,
      '--pattern',
      sourceName,
      '--pattern',
      'SHA256SUMS',
    ]),
    `downloading the release ${tag}`,
  );
  const sums = parseSha256Sums(
    new TextDecoder().decode(await readSmall(deps, join(dir, 'SHA256SUMS'))),
  );
  const files = [];
  for (const name of [zipName, sourceName]) {
    const bytes = await readSmall(deps, join(dir, name));
    const listed = sums.filter(l => l.name === name);
    if (listed.length !== 1 || listed[0]!.sha256 !== sha256(bytes)) {
      throw new Refusal(`${name} does not match SHA256SUMS`);
    }
    await must(
      deps,
      'gh',
      [
        'attestation',
        'verify',
        join(dir, name),
        '--repo',
        REPO,
        '--signer-workflow',
        RELEASE_WORKFLOW,
      ].concat(['--source-ref', `refs/tags/${tag}`, '--source-digest', t.commit]),
      `checking the build provenance of ${name}`,
    );
    files.push({name, bytes});
  }
  const zip = files[0]!;
  const entry = readZipDirectory(zip.bytes).find(e => e.name === 'manifest.json');
  if (entry === undefined) throw new Refusal(`${zipName} has no manifest.json`);
  const manifest: unknown = JSON.parse(
    new TextDecoder().decode(await readZipEntry(zip.bytes, entry)),
  );
  if (!isRecord(manifest) || manifest['version'] !== version) {
    throw new Refusal(`${zipName} does not carry version ${version}`);
  }
  if (addonIdOf(manifest) !== t.addonId)
    throw new Refusal(`${zipName} does not carry the add-on id ${t.addonId}`);
  return {zip, source: files[1]!};
}

async function amo(
  deps: Deps,
  key: string,
  secret: string,
  method: 'GET' | 'POST',
  path: string,
  body?: FormData,
): Promise<Record<string, unknown>> {
  const res = await deps.fetch(new URL(path, AMO_API), {
    method,
    headers: {Authorization: `JWT ${amoToken(key, secret, deps.now())}`},
    ...(body === undefined ? {} : {body}),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Refusal(`AMO answered ${res.status} to ${method} ${path}: ${text.slice(0, 500)}`);
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Refusal(`AMO sent an unexpected answer to ${method} ${path}`);
  return data;
}

async function submit(deps: Deps, rel: Release, version: string, addonId: string): Promise<void> {
  const key = deps.env['WEB_EXT_API_KEY']!;
  const secret = deps.env['WEB_EXT_API_SECRET']!;
  const up = new FormData();
  up.set('upload', new Blob([new Uint8Array(rel.zip.bytes)]), rel.zip.name);
  up.set('channel', 'listed');
  let upload = await amo(deps, key, secret, 'POST', 'addons/upload/', up);
  const uuid = upload['uuid'];
  if (typeof uuid !== 'string' || !/^[0-9a-f-]{32,36}$/.test(uuid))
    throw new Refusal('AMO returned no upload id');
  deps.stdout(`uploaded ${rel.zip.name}; waiting for AMO's validation\n`);
  const deadline = deps.now() + VALIDATION_TIMEOUT_MS;
  while (upload['processed'] !== true) {
    if (deps.now() > deadline) throw new Refusal(`AMO did not validate upload ${uuid} in time`);
    await deps.sleep(POLL_MS);
    upload = await amo(deps, key, secret, 'GET', `addons/upload/${uuid}/`);
  }
  if (upload['valid'] !== true) {
    throw new Refusal(
      `AMO's validation failed for upload ${uuid}:\n${JSON.stringify(upload['validation'])}`,
    );
  }
  if (upload['version'] !== version)
    throw new Refusal(`AMO read version ${String(upload['version'])}, not ${version}`);
  const create = new FormData();
  create.set('upload', uuid);
  create.set('source', new Blob([new Uint8Array(rel.source.bytes)]), rel.source.name);
  const created = await amo(
    deps,
    key,
    secret,
    'POST',
    `addons/addon/${encodeURIComponent(addonId)}/versions/`,
    create,
  );
  deps.stdout(
    `submitted version ${String(created['version'])} (AMO id ${String(created['id'])}); AMO's review follows\n`,
  );
}

export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {'dry-run': {type: 'boolean'}, help: {type: 'boolean'}},
    });
  } catch (e) {
    deps.stderr(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return EXIT.usage;
  }
  if (args.values.help === true) {
    deps.stdout(USAGE);
    return EXIT.submitted;
  }
  const tag = args.positionals.length === 1 ? args.positionals[0]! : '';
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (m === null) {
    deps.stderr(USAGE);
    return EXIT.usage;
  }
  const dryRun = args.values['dry-run'] === true;
  if (!dryRun && !(deps.env['WEB_EXT_API_KEY'] && deps.env['WEB_EXT_API_SECRET'])) {
    deps.stderr('WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set (for example with bws run)\n');
    return EXIT.usage;
  }
  const version = m[1]!;
  const temp = await deps.tempDir();
  try {
    const t = await checkTag(deps, tag);
    const rel = await checkRelease(deps, temp.dir, tag, version, t);
    deps.stdout(`${tag}: tag signature, SHA256SUMS, build provenance and manifest check out\n`);
    if (dryRun) {
      deps.stdout('dry run: nothing was sent to AMO\n');
      return EXIT.submitted;
    }
    await submit(deps, rel, version, t.addonId);
    deps.stdout(
      `once AMO has approved it, compare the store package: gh workflow run store-diff.yml --repo ${REPO}\n`,
    );
    return EXIT.submitted;
  } catch (e) {
    deps.stderr(`refused: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.refused;
  } finally {
    await temp.remove();
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
    run: (cmd, args) =>
      new Promise(resolve =>
        execFile(cmd, [...args], {maxBuffer: 16 * 1024 * 1024}, (err, stdout, stderr) =>
          resolve({
            code: err === null ? 0 : typeof err.code === 'number' ? err.code : 1,
            stdout,
            stderr,
          }),
        ),
      ),
    fetch,
    env: process.env,
    tempDir: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'intactwarden-amo-'));
      return {dir, remove: () => rm(dir, {recursive: true, force: true})};
    },
    readFile: async path => new Uint8Array(await readFile(path)),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    stdout: t => void process.stdout.write(t),
    stderr: t => void process.stderr.write(t),
  });
}
