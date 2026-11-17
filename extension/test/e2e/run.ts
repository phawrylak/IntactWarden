/**
 * `npm run test:e2e [-- --no-build] [-- <vitest arguments>]` (extension/test/e2e/README.md):
 *
 * 1. builds the two test packages (`--test`): every bundled core into `extension/dist-test/firefox/`,
 *    and only Bitwarden's into `extension/dist-test/bootstrap-bitwarden/firefox/` (the Vaultwarden
 *    release is then an unknown build that local deep verify must resolve); and the shipping
 *    (production) package, which bundles no cores, into `extension/dist-test/release/firefox/`;
 * 2. obtains Firefox and geckodriver with tools/e2e/browsers.ts (the versions and sha256 pinned in
 *    browsers.lock.json, unpacked into the git-ignored `.cache/browsers/`);
 *    INTACTWARDEN_E2E_FIREFOX_VERSION=<version> (CI matrix, e.g. 153.7.0esr) picks another pinned
 *    version. A browser that cannot be obtained fails the run;
 * 3. runs the vitest `e2e` project with INTACTWARDEN_E2E=1: the network plumbing check and the
 *    scenarios in real Firefox, against the fixture servers replaying the real releases;
 * 4. prints every scenario's evidence from `.cache/e2e/firefox.json`.
 *
 * The exit code is vitest's (non-zero on any failed scenario).
 */

import {spawn} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {buildBootstrap} from '../../build/bootstrap.ts';
import {buildExtension} from '../../build/build.ts';
import {ensureBrowsers} from '../../../tools/e2e/browsers.ts';
import {DIST_TEST, REPO_ROOT, RESULTS_DIR, type ScenarioResult} from './env.ts';

const out = (line = ''): void => void process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  // Arguments after `--` go to vitest (e.g. `-- -t sm-genuine` runs the scenarios whose name
  // matches).
  const {values, positionals} = parseArgs({
    args: process.argv.slice(2),
    options: {'no-build': {type: 'boolean'}},
    strict: true,
    allowPositionals: true,
  });
  const full = join(DIST_TEST, 'firefox');
  const bitwardenOnly = join(DIST_TEST, 'bootstrap-bitwarden', 'firefox');
  const release = join(DIST_TEST, 'release', 'firefox');
  if (values['no-build'] !== true) {
    out('test:e2e: building the test packages and the shipping package');
    const log = (l: string): void => out(`  ${l}`);
    const all = await buildBootstrap({apps: 'all', log});
    await buildExtension({test: true, bootstrapData: all, log});
    await buildExtension({
      test: true,
      bootstrap: 'bitwarden',
      outRoot: join(DIST_TEST, 'bootstrap-bitwarden'),
      log,
    });
    await buildExtension({outRoot: join(DIST_TEST, 'release'), log});
  }
  for (const dir of [full, bitwardenOnly, release]) {
    if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`no package in ${dir}`);
  }

  out('test:e2e: obtaining Firefox and geckodriver (tools/e2e/browsers.ts)');
  // INTACTWARDEN_E2E_FIREFOX_VERSION picks another pinned version (the CI matrix: latest + ESR).
  const pinned = process.env['INTACTWARDEN_E2E_FIREFOX_VERSION'];
  const b = await ensureBrowsers({
    log: l => out(`  ${l}`),
    ...(pinned !== undefined && pinned !== '' ? {firefox: pinned} : {}),
  });
  out(`  Firefox ${b.firefoxVersion}, geckodriver ${b.geckodriverVersion}`);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    INTACTWARDEN_E2E: '1',
    INTACTWARDEN_E2E_PKG_FULL: full,
    INTACTWARDEN_E2E_PKG_BWONLY: bitwardenOnly,
    INTACTWARDEN_E2E_PKG_RELEASE: release,
    INTACTWARDEN_E2E_FIREFOX_BIN: b.firefox,
    INTACTWARDEN_E2E_GECKODRIVER: b.geckodriver,
  };

  rmSync(RESULTS_DIR, {recursive: true, force: true});
  const vitest = join(REPO_ROOT, 'node_modules', '.bin', 'vitest');
  const code = await new Promise<number>(resolve => {
    const child = spawn(vitest, ['run', '--project', 'e2e', ...positionals], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('exit', c => resolve(c ?? 1));
  });

  out();
  out('test:e2e: scenario evidence');
  const file = join(RESULTS_DIR, 'firefox.json');
  if (!existsSync(file)) {
    out('  no results');
  } else {
    const r = JSON.parse(readFileSync(file, 'utf8')) as {note: string; results: ScenarioResult[]};
    if (r.note !== '') out(`  ${r.note}`);
    for (const s of r.results) {
      out(`  ${s.ok ? 'PASS' : 'FAIL'} ${s.id} (${s.ms} ms)`);
      for (const e of s.evidence) out(`      ${e}`);
      if (s.error !== undefined) out(`      error: ${s.error}`);
    }
  }
  return code;
}

process.exitCode = await main().catch((e: unknown) => {
  process.stderr.write(`test:e2e: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  return 1;
});
