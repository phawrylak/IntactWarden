/**
 * Local deep verify of a Bitwarden release on the builders' synthetic
 * COMMERCIAL zip: each job builds the one variant asked for
 * (selfhosted-commercial, cloud-us or cloud-eu); a cloud job fetches the
 * configs by commit from raw.githubusercontent.com and they become config
 * pins; a config whose digest disagrees with its pin is refused.
 */

import {describe, expect, it} from 'vitest';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {
  BASE_CONFIG,
  buildReleaseZip,
  CLOUD_CONFIG,
  COMMERCIAL_ASSET,
  COMMIT,
  configBytes,
  EUPRD_CONFIG,
  TAG,
  VERSION,
} from '../../../packages/builders/test/helpers/bitwardenFixture.ts';
import type {ReleaseKey} from '../../src/contracts.ts';
import {memoryExtensionDb} from '../helpers/memoryDb.ts';
import {createGitHubClient} from '../../src/trust/github.ts';
import {createInProcessJobHost} from '../../src/trust/jobHost.ts';
import {createLocalTrustStore} from '../../src/trust/store.ts';
import {createFakeFetch} from './helpers/fakeFetch.ts';
import {createGitHubEmulator} from './helpers/githubEmulator.ts';
import {getCore, manualClock, memoryKv, packageReader} from './helpers/memory.ts';
import {sha256} from './helpers/vaultwarden.ts';

const REPO = 'bitwarden/clients';
const REPO_ID = 53538899;
const CONFIGS = {
  'apps/web/config/base.json': configBytes(BASE_CONFIG),
  'apps/web/config/cloud.json': configBytes(CLOUD_CONFIG),
  'apps/web/config/euprd.json': configBytes(EUPRD_CONFIG),
};
const key = (variant: ReleaseKey['variant']): ReleaseKey => ({
  app: 'bitwarden-web',
  variant,
  version: VERSION,
});

function setup(bundledFiles = new Map<string, Uint8Array>()) {
  const fake = createFakeFetch();
  const emu = createGitHubEmulator(fake);
  const zip = buildReleaseZip();
  emu.addRelease({
    repoId: REPO_ID,
    repo: REPO,
    tag: TAG,
    assets: [{name: COMMERCIAL_ASSET, bytes: zip}],
  });
  emu.setTag(REPO, REPO_ID, TAG, {commit: COMMIT});
  for (const [path, bytes] of Object.entries(CONFIGS)) emu.setRaw(REPO, COMMIT, path, bytes);
  const clock = manualClock();
  const kv = memoryKv();
  const db = memoryExtensionDb();
  const builder = createCoreBuilder();
  const store = createLocalTrustStore({
    kv,
    db,
    incident: async () => undefined,
    builder,
    builderFingerprint: 'f1',
    now: clock.now,
    jobHost: createInProcessJobHost({fetch: fake.fetch, builder}),
    github: createGitHubClient({fetch: fake.fetch, now: clock.now, kv}),
    readPackageFile: packageReader(bundledFiles),
    hasGitHubPermission: async () => true,
  });
  return {fake, emu, store, zip};
}

describe('local deep verify of a Bitwarden release', () => {
  it('builds the one variant asked for; a cloud job fetches the same three configs for both regions', async () => {
    const {emu, store} = setup();
    const known: string[][] = [];
    store.onReleaseKnown(refs => known.push(refs.map(r => r.buildId)));
    const outcome = await store.ensureRelease({key: key('cloud-eu'), trigger: 'unknown-build'});
    expect(outcome.ok).toBe(true);
    expect(known).toEqual([[`bitwarden-web@${VERSION}+cloud-eu`]]);
    expect(store.releaseState(key('cloud-us')).k).toBe('unknown');
    expect(store.releaseState(key('selfhosted-commercial')).k).toBe('unknown');
    expect(emu.counts.download).toBe(1);
    expect(emu.counts.raw).toBe(3);
    // The other region: one more download, the same three config requests.
    expect((await store.ensureRelease({key: key('cloud-us'), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
    expect(emu.counts.download).toBe(2);
    expect(emu.counts.raw).toBe(6);
    const us = await getCore(store, key('cloud-us'));
    expect(us?.ref.assurance).toBe('release-derived');
    expect(us?.core.derivation?.inputs.map(i => i.commit)).toEqual([COMMIT, COMMIT]);
    const pins = (await store.pins()).pins;
    // Each core pins the two config files it was derived from.
    expect(
      pins
        .filter(p => p.kind === 'config-file')
        .map(p => (p.kind === 'config-file' ? [p.path, p.sha256, p.commit] : null))
        .sort(),
    ).toEqual(Object.entries(CONFIGS).map(([path, bytes]) => [path, sha256(bytes), COMMIT]));
    expect(pins.find(p => p.kind === 'release-asset')).toMatchObject({
      asset: COMMERCIAL_ASSET,
      tag_commit: COMMIT,
      source: 'local',
    });
  });

  it('refuses a config file whose bytes disagree with its pin at the commit', async () => {
    const bundled = new Map<string, Uint8Array>();
    const index = {
      schema: 'intactwarden.bootstrap/1',
      generated_from: [],
      cores: [],
      pins: {
        schema: 'intactwarden.localpins/1',
        pins: [
          {
            kind: 'config-file',
            repo: REPO,
            commit: COMMIT,
            path: 'apps/web/config/cloud.json',
            sha256: 'c'.repeat(64),
            source: 'bundled',
          },
        ],
      },
    };
    bundled.set('data/bootstrap/index.json', new TextEncoder().encode(JSON.stringify(index)));
    const {store} = setup(bundled);
    expect(
      await store.ensureRelease({key: key('cloud-us'), trigger: 'unknown-build'}),
    ).toMatchObject({
      ok: false,
      failure: 'digest-mismatch',
      transient: false,
    });
    // The self-hosted variant needs no config file, so a cloud config that contradicts its pin
    // fails only the cloud job.
    expect(store.releaseState(key('selfhosted-commercial')).k).toBe('unknown');
    expect(
      await store.ensureRelease({key: key('selfhosted-commercial'), trigger: 'unknown-build'}),
    ).toMatchObject({ok: true});
  });

  it('builds the self-hosted variant without any config request', async () => {
    const {emu, store} = setup();
    expect(
      (await store.ensureRelease({key: key('selfhosted-commercial'), trigger: 'unknown-build'})).ok,
    ).toBe(true);
    expect(emu.counts.raw).toBe(0);
    expect((await store.listJobs())[0]).toMatchObject({
      phase: 'done',
      variant: 'selfhosted-commercial',
    });
  });

  it('a dispute seen through one variant covers every variant built from the asset', async () => {
    const {emu, store} = setup();
    const disputed: string[] = [];
    store.onReleaseDisputed(k => disputed.push(k.variant));
    expect((await store.ensureRelease({key: key('cloud-us'), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
    emu.setTag(REPO, REPO_ID, TAG, {commit: 'e'.repeat(40)});
    expect(
      await store.ensureRelease({key: key('selfhosted-commercial'), trigger: 'unknown-build'}),
    ).toMatchObject({ok: false, failure: 'disputed', dispute: 'tag-moved'});
    expect(disputed.sort()).toEqual(['cloud-eu', 'cloud-us', 'selfhosted-commercial']);
    for (const v of ['selfhosted-commercial', 'cloud-us', 'cloud-eu'] as const) {
      expect(store.releaseState(key(v)).k).toBe('disputed');
    }
  });

  it('a dispute stops a sibling variant job queued before it, even if GitHub flips back', async () => {
    // With one job per variant, the cloud-us job is queued before the selfhosted-commercial job
    // finds the dispute; GitHub then answers with the pinned values again. The queued job must not
    // register a current core.
    const {emu, store} = setup();
    expect((await store.ensureRelease({key: key('cloud-eu'), trigger: 'unknown-build'})).ok).toBe(
      true,
    );
    const downloads = emu.counts.download;
    emu.setTag(REPO, REPO_ID, TAG, {commit: 'e'.repeat(40)});
    const disputed: string[] = [];
    store.onReleaseDisputed(k => {
      disputed.push(k.variant);
      emu.setTag(REPO, REPO_ID, TAG, {commit: COMMIT});
    });
    const known: string[] = [];
    store.onReleaseKnown(refs => known.push(...refs.map(r => r.buildId)));
    const [first, second] = await Promise.all([
      store.ensureRelease({key: key('selfhosted-commercial'), trigger: 'unknown-build'}),
      store.ensureRelease({key: key('cloud-us'), trigger: 'unknown-build'}),
    ]);
    expect(first).toMatchObject({ok: false, failure: 'disputed', dispute: 'tag-moved'});
    expect(second).toMatchObject({ok: false, failure: 'disputed', dispute: 'tag-moved'});
    expect(disputed.sort()).toEqual(['cloud-eu', 'cloud-us', 'selfhosted-commercial']);
    expect(known).toEqual([]);
    expect(store.releaseState(key('cloud-us')).k).toBe('disputed');
    expect(await getCore(store, key('cloud-us'))).toBeNull();
    expect(
      await store.candidates({app: 'bitwarden-web', variant: 'cloud-us', hintVersion: VERSION}),
    ).toEqual([]);
    expect((await getCore(store, key('cloud-eu')))?.ref.status).toBe('disputed');
    // The queued job ended as a disputed failure and downloaded nothing after the dispute.
    expect(emu.counts.download).toBe(downloads);
    expect((await store.listJobs())[0]).toMatchObject({
      variant: 'cloud-us',
      phase: 'failed',
      failure: 'disputed',
    });
  });

  it('refuses a missing config file at the commit as a derivation failure', async () => {
    const {emu, store} = setup();
    // Move the tag to a commit whose configs do not exist (first sight: no pin yet).
    emu.setTag(REPO, REPO_ID, TAG, {commit: 'e'.repeat(40)});
    expect(
      await store.ensureRelease({key: key('cloud-us'), trigger: 'unknown-build'}),
    ).toMatchObject({
      ok: false,
      failure: 'build-refused',
      detail: 'derivation-failed',
    });
  });
});
