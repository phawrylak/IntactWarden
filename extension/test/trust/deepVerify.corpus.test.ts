/**
 * Corpus test of local deep verify (opt-in: INTACTWARDEN_CORPUS=1; uses the
 * digest-addressed cache in fixtures/corpora/.downloads/, downloading the
 * pinned assets once): a GitHub emulator serves the real web-v2026.10.1
 * COMMERCIAL zip and configs and the real bw_web_v2026.10.1 tarball, and the
 * trust store, starting with no bundled cores, resolves, pins, downloads,
 * verifies and builds them exactly as it would from github.com. Every core
 * must equal the golden digests the builders' corpus tests and the test
 * packages' bootstrap are held to.
 */

import {beforeAll, describe, expect, it} from 'vitest';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {
  CORPUS_ENABLED,
  fetchBitwardenConfigs,
  fetchBitwardenZip,
  fetchVaultwardenTarball,
  loadBitwardenLock,
  loadVaultwardenLock,
} from '../../../tools/corpus.ts';
import {GOLDEN_CORES} from '../../../packages/builders/test/helpers/golden.ts';
import {memoryExtensionDb} from '../helpers/memoryDb.ts';
import {createGitHubClient} from '../../src/trust/github.ts';
import {createInProcessJobHost} from '../../src/trust/jobHost.ts';
import {createLocalTrustStore, type LocalTrustStore} from '../../src/trust/store.ts';
import {createFakeFetch} from './helpers/fakeFetch.ts';
import {createGitHubEmulator} from './helpers/githubEmulator.ts';
import {getCore, manualClock, memoryKv, packageReader} from './helpers/memory.ts';

const BW = loadBitwardenLock('2026.10.1');
const VW = loadVaultwardenLock('2026.10.1');
const BW_REPO_ID = 53538899;

describe.runIf(CORPUS_ENABLED)('local deep verify on the corpus releases', () => {
  let store: LocalTrustStore;
  let fetchCount: () => number;

  beforeAll(async () => {
    const fake = createFakeFetch();
    const emu = createGitHubEmulator(fake);
    const zip = await fetchBitwardenZip(BW);
    const configs = await fetchBitwardenConfigs(BW);
    emu.addRelease({
      repoId: BW_REPO_ID,
      repo: BW.release.repo,
      tag: BW.release.tag,
      assets: [{name: BW.release.asset, bytes: zip}],
    });
    emu.setTag(BW.release.repo, BW_REPO_ID, BW.release.tag, {commit: BW.release.commit});
    for (const name of ['base', 'cloud', 'euprd'] as const) {
      emu.setRaw(BW.release.repo, BW.config[name].commit, BW.config[name].path, configs[name]);
    }
    const tarball = await fetchVaultwardenTarball(VW);
    emu.addRelease({
      repoId: VW.release.repo_id,
      repo: VW.release.repo,
      tag: VW.release.tag,
      assets: [{name: VW.release.asset, bytes: tarball}],
    });
    emu.setTag(VW.release.repo, VW.release.repo_id, VW.release.tag, {
      commit: VW.release.commit,
      tagObject: VW.release.tag_object,
    });

    const clock = manualClock();
    const kv = memoryKv();
    const db = memoryExtensionDb();
    const builder = createCoreBuilder();
    store = createLocalTrustStore({
      kv,
      db,
      incident: async () => undefined,
      builder,
      builderFingerprint: 'f1',
      now: clock.now,
      jobHost: createInProcessJobHost({fetch: fake.fetch, builder}),
      github: createGitHubClient({fetch: fake.fetch, now: clock.now, kv}),
      readPackageFile: packageReader(new Map()), // no bundled cores: everything is deep-verified
      hasGitHubPermission: async () => true,
    });
    fetchCount = () => emu.counts.download;
  });

  it('builds each COMMERCIAL variant in its own job, equal to the golden cores', async () => {
    const variants = ['selfhosted-commercial', 'cloud-us', 'cloud-eu'] as const;
    for (const variant of variants) {
      const outcome = await store.ensureRelease({
        key: {app: 'bitwarden-web', variant, version: '2026.10.1'},
        trigger: 'unknown-build',
      });
      expect(outcome.ok, variant).toBe(true);
    }
    const cores = await store.listCores();
    const byId = Object.fromEntries(cores.map(c => [c.buildId, c.sha256]));
    for (const variant of variants) {
      const id = `bitwarden-web@2026.10.1+${variant}`;
      expect(byId[id], id).toBe(GOLDEN_CORES[id]);
    }
    expect(fetchCount()).toBe(3);
    // The cloud cores' config inputs became local pins at the tag commit.
    const configPins = (await store.pins()).pins.filter(p => p.kind === 'config-file');
    expect(
      configPins.map(p => (p.kind === 'config-file' ? [p.path, p.sha256] : null)).sort(),
    ).toEqual(
      (['base', 'cloud', 'euprd'] as const)
        .map(n => [BW.config[n].path, BW.config[n].sha256])
        .sort(),
    );
    // Already known: no second job.
    const again = await store.ensureRelease({
      key: {app: 'bitwarden-web', variant: 'selfhosted-commercial', version: '2026.10.1'},
      trigger: 'unknown-build',
    });
    expect(again.ok).toBe(true);
    expect(fetchCount()).toBe(3);
  });

  it('builds the Vaultwarden release core, equal to the golden core', async () => {
    const outcome = await store.ensureRelease({
      key: {app: 'vaultwarden-web', variant: 'release', version: '2026.10.1'},
      trigger: 'unknown-build',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.refs[0]!.sha256).toBe(GOLDEN_CORES['vaultwarden-web@2026.10.1+release']);
    }
    const core = await getCore(store, {
      app: 'vaultwarden-web',
      variant: 'release',
      version: '2026.10.1',
    });
    expect(core?.core.source.tag_object).toBe(VW.release.tag_object);
  });
});
