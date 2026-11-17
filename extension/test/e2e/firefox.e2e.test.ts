/**
 * The end-to-end scenarios: the built test packages in an official headless Firefox
 * (firefox/driver.ts) against the fixture servers. Runs under `npm run test:e2e`, which obtains
 * and verifies Firefox and geckodriver first (tools/e2e/browsers.ts).
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, it} from 'vitest';
import {
  E2E_ENABLED,
  RESULTS_DIR,
  FIREFOX_BIN,
  GECKODRIVER_BIN,
  PACKAGES,
  writeResults,
  type ScenarioResult,
} from './env.ts';
import {ENCODING_SCENARIOS} from './encodings.ts';
import {RealFirefox} from './firefox/driver.ts';
import {SCENARIOS} from './scenarios.ts';
import {startFixtures, type RunningFixtures} from './server/fixtures.ts';
import {GITHUB_MIRROR_HOSTS} from './server/github.ts';
import {PAYMENT_HOSTS} from './server/payments.ts';
import {startMappedNetwork, type MappedNetwork} from './server/proxy.ts';
import {FRAMING_HOST, framingSite} from './server/sites.ts';

/** The extension's console lines (its logWarn output) from a scenario log, for a failure report. */
function extensionLog(file: string | null): string[] {
  if (file === null || !existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.includes('[IntactWarden]'))
    .slice(-20);
  return [`log ${file}`, ...lines.map(l => `console: ${l.slice(0, 300)}`)];
}

describe.runIf(E2E_ENABLED)('e2e: official Firefox, temporary add-on, fixture servers', () => {
  let fx: RunningFixtures;
  let net: MappedNetwork;
  let driver: RealFirefox;
  const results: ScenarioResult[] = [];

  beforeAll(async () => {
    fx = await startFixtures();
    net = await startMappedNetwork(
      new Map([
        ...GITHUB_MIRROR_HOSTS.map(h => [h, fx.github.handler] as const),
        ...PAYMENT_HOSTS.map(h => [h, fx.payments.handler] as const),
        [new URL(fx.bitwardenCloud.origin).host, fx.bitwardenCloud.handler] as const,
        [FRAMING_HOST, framingSite] as const,
      ]),
    );
    driver = new RealFirefox({
      firefoxBin: FIREFOX_BIN,
      geckodriverBin: GECKODRIVER_BIN,
      packages: PACKAGES,
      proxyPort: net.proxy.port,
      logDir: join(RESULTS_DIR, 'firefox-logs'),
    });
  });

  afterAll(async () => {
    const refused = net?.refused.length
      ? `proxy refused: ${[...new Set(net.refused)].join(', ')}`
      : '';
    writeResults(results, refused);
    await driver?.uninstall();
    await net?.close();
    await fx?.close();
  });

  // The content codings (encodings.ts) run with the others.
  for (const s of [...SCENARIOS, ...ENCODING_SCENARIOS]) {
    it(`${s.id}: ${s.title}`, async () => {
      const started = Date.now();
      driver.logName = s.id;
      try {
        await driver.install(s.pkg, s.prefs);
        const evidence = await s.run(driver, fx);
        results.push({id: s.id, title: s.title, ok: true, evidence, ms: Date.now() - started});
      } catch (e) {
        results.push({
          id: s.id,
          title: s.title,
          ok: false,
          evidence: extensionLog(driver.logFile),
          error: e instanceof Error ? e.message : String(e),
          ms: Date.now() - started,
        });
        throw e;
      } finally {
        await driver.uninstall();
        fx.bitwardenCloud.hotfix(null);
      }
    });
  }
});
