/**
 * Locations and environment variables shared by `npm run test:e2e` (run.ts) and the e2e test files.
 */

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {PackageKind} from './scenarios.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DIST_TEST = join(REPO_ROOT, 'extension', 'dist-test');
/** Results of the last run (git-ignored), printed by run.ts. */
export const RESULTS_DIR = join(REPO_ROOT, '.cache', 'e2e');

/** Set by run.ts: the e2e test files skip themselves otherwise (`npm test` never runs them). */
export const E2E_ENABLED = process.env['INTACTWARDEN_E2E'] === '1';

/** Package directories per kind; run.ts builds both before the suite. */
export const PACKAGES: Readonly<Record<PackageKind, string>> = Object.freeze({
  full: process.env['INTACTWARDEN_E2E_PKG_FULL'] ?? join(DIST_TEST, 'firefox'),
  'bitwarden-only':
    process.env['INTACTWARDEN_E2E_PKG_BWONLY'] ?? join(DIST_TEST, 'bootstrap-bitwarden', 'firefox'),
  release: process.env['INTACTWARDEN_E2E_PKG_RELEASE'] ?? join(DIST_TEST, 'release', 'firefox'),
});

/** The browser binaries (set by run.ts after tools/e2e/browsers.ts verified them). */
export const FIREFOX_BIN = process.env['INTACTWARDEN_E2E_FIREFOX_BIN'] ?? '';
export const GECKODRIVER_BIN = process.env['INTACTWARDEN_E2E_GECKODRIVER'] ?? '';

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly evidence: readonly string[];
  readonly error?: string;
  readonly ms: number;
}

export function writeResults(results: readonly ScenarioResult[], note = ''): void {
  mkdirSync(RESULTS_DIR, {recursive: true});
  writeFileSync(
    join(RESULTS_DIR, 'firefox.json'),
    `${JSON.stringify({at: new Date().toISOString(), note, results}, null, 2)}\n`,
  );
}
