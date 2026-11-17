/**
 * Obtains the browser binaries of the Firefox end-to-end suite (extension/test/e2e/README.md):
 * Firefox for Linux x86_64 (en-US) from `archive.mozilla.org/pub/firefox/releases/` and
 * geckodriver for linux64 from the `mozilla/geckodriver` GitHub releases. Only the versions pinned
 * in `extension/test/e2e/browsers.lock.json` can be obtained, and each archive must hash to the
 * sha256 pinned there before it is unpacked (fetchPinned of tools/corpus.ts, which caches it by
 * digest). The binaries are unpacked into the git-ignored `.cache/browsers/`.
 *
 * Nothing downloaded is executed here: archives are verified and unpacked with the system `tar`.
 * Selenium Manager (which would download drivers and browsers by itself) is never used; the e2e
 * runner hands both paths to selenium-webdriver explicitly.
 */

import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {access, chmod, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchPinned} from '../corpus.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BROWSERS_DIR = join(REPO_ROOT, '.cache', 'browsers');
export const LOCK_PATH = join(REPO_ROOT, 'extension', 'test', 'e2e', 'browsers.lock.json');

const FIREFOX_RELEASES = 'https://archive.mozilla.org/pub/firefox/releases/';
const GECKODRIVER_RELEASES = 'https://github.com/mozilla/geckodriver/releases/download/';
const HEX64 = /^[0-9a-f]{64}$/;
/** A release (`160.0`) or an ESR (`153.7.0esr`); never a beta, `latest` or a path. */
const FIREFOX_VERSION = /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:esr)?$/;
const GECKODRIVER_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** An exact version and the sha256 of its Linux x86_64 archive. */
export interface Pin {
  readonly version: string;
  readonly sha256: string;
}

export interface BrowsersLock {
  /** The first entry is the default; CI runs every entry. */
  readonly firefox: readonly Pin[];
  readonly geckodriver: Pin;
}

export interface Browsers {
  readonly firefox: string;
  readonly firefoxVersion: string;
  readonly geckodriver: string;
  readonly geckodriverVersion: string;
}

function pin(raw: unknown, version: RegExp, what: string): Pin {
  const p = raw as Partial<Pin> | null;
  if (typeof p?.version !== 'string' || !version.test(p.version)) {
    throw new Error(`${what}: bad version`);
  }
  if (typeof p.sha256 !== 'string' || !HEX64.test(p.sha256)) {
    throw new Error(`${what}: sha256 must be 64 lower-case hex digits`);
  }
  return {version: p.version, sha256: p.sha256};
}

export function readLock(path: string = LOCK_PATH): BrowsersLock {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {firefox?: unknown; geckodriver?: unknown};
  if (!Array.isArray(raw.firefox) || raw.firefox.length === 0) {
    throw new Error(`${path}: firefox must list at least one pinned version`);
  }
  return {
    firefox: raw.firefox.map(f => pin(f, FIREFOX_VERSION, `${path}: firefox`)),
    geckodriver: pin(raw.geckodriver, GECKODRIVER_VERSION, `${path}: geckodriver`),
  };
}

type Log = (line: string) => void;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Unpacks the pinned archive into `dir` (replaced atomically) unless it already holds it. */
async function ensure(p: Pin, url: string, dir: string, bin: string, log: Log): Promise<string> {
  const markerFile = join(dir, '.iw-verified.json');
  try {
    const marker = JSON.parse(await readFile(markerFile, 'utf8')) as {sha256?: string};
    if (marker.sha256 === p.sha256 && (await exists(bin))) return bin;
  } catch {
    // not unpacked yet
  }
  log(`fetching ${url} (sha256 ${p.sha256}, pinned in the lock)`);
  const archive = await fetchPinned(url, p.sha256);
  const tmp = `${dir}.${process.pid}.tmp`;
  await rm(tmp, {recursive: true, force: true});
  await mkdir(tmp, {recursive: true});
  const flag = url.endsWith('.tar.xz') ? '-xJf' : '-xzf';
  const tar = spawnSync('tar', [flag, '-', '-C', tmp], {input: archive, encoding: 'utf8'});
  if (tar.status !== 0) throw new Error(`tar ${url}: ${tar.stderr || tar.error}`);
  await writeFile(join(tmp, '.iw-verified.json'), `${JSON.stringify({...p, source: url})}\n`);
  await rm(dir, {recursive: true, force: true});
  await rename(tmp, dir);
  if (!(await exists(bin))) throw new Error(`${bin} missing after unpacking`);
  return bin;
}

/** Both binaries, downloading and verifying what is missing; throws when one cannot be obtained. */
export async function ensureBrowsers(
  options: {firefox?: string; log?: Log} = {},
): Promise<Browsers> {
  const lock = readLock();
  const log = options.log ?? (() => {});
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`only linux x64 is supported (this is ${process.platform} ${process.arch})`);
  }
  const ff = lock.firefox.find(f => f.version === (options.firefox ?? lock.firefox[0]!.version));
  if (ff === undefined) {
    throw new Error(`Firefox ${options.firefox} is not pinned in ${LOCK_PATH}`);
  }
  const gd = lock.geckodriver;
  // geckodriver first: without it nothing can drive Firefox, so do not fetch 90 MB for nothing.
  const gdDir = join(BROWSERS_DIR, `geckodriver-${gd.version}`);
  const geckodriver = await ensure(
    gd,
    `${GECKODRIVER_RELEASES}v${gd.version}/geckodriver-v${gd.version}-linux64.tar.gz`,
    gdDir,
    join(gdDir, 'geckodriver'),
    log,
  );
  await chmod(geckodriver, 0o755);
  const ffDir = join(BROWSERS_DIR, `firefox-${ff.version}`);
  const firefox = await ensure(
    ff,
    `${FIREFOX_RELEASES}${ff.version}/linux-x86_64/en-US/firefox-${ff.version}.tar.xz`,
    ffDir,
    join(ffDir, 'firefox', 'firefox'),
    log,
  );
  return {firefox, firefoxVersion: ff.version, geckodriver, geckodriverVersion: gd.version};
}
