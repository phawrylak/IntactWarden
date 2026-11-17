import {beforeAll, describe, expect, it} from 'vitest';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {BuildError, type BuildRequest, type CoreBuilder} from '@intactwarden/builders/api.ts';
import type {ReleaseJobSpec} from '../../src/contracts.ts';
import {runReleaseJob, type JobProgress} from '../../src/trust/job.ts';
import {createFakeFetch} from './helpers/fakeFetch.ts';
import {createGitHubEmulator} from './helpers/githubEmulator.ts';
import {
  buildVwCore,
  idsFor,
  publishVw,
  sha256,
  VW_REPO,
  VW_REPO_ID,
  type VwAssets,
} from './helpers/vaultwarden.ts';
import {flip} from './helpers/memory.ts';

const VERSION = '2026.11.0';

let assets: VwAssets;
let expectedSha: string;
beforeAll(async () => {
  const probe = createGitHubEmulator(createFakeFetch());
  assets = publishVw(probe, VERSION);
  expectedSha = (await buildVwCore(assets)).sha256;
});

function specFor(a: VwAssets, over: Partial<ReleaseJobSpec> = {}): ReleaseJobSpec {
  const ids = idsFor(a.version);
  const builder = createCoreBuilder();
  const plan = builder.plan('vaultwarden-web', 'release', a.version);
  return {
    jobId: '0123456789abcdef',
    plan,
    commit: ids.commit,
    tagObject: ids.tagObject,
    asset: {name: a.asset, sha256: sha256(a.tarball), size: a.tarball.length},
    configs: [],
    ...over,
  };
}

/** The real builder, recording whether build() ran. */
function spyBuilder(): CoreBuilder & {calls: BuildRequest[]} {
  const real = createCoreBuilder();
  const calls: BuildRequest[] = [];
  return {
    calls,
    plan: (app, variant, version) => real.plan(app, variant, version),
    build: async request => {
      calls.push(request);
      return real.build(request);
    },
  };
}

function setup(publish = true) {
  const fake = createFakeFetch();
  const emu = createGitHubEmulator(fake);
  if (publish) publishVw(emu, VERSION);
  const builder = spyBuilder();
  const progress: JobProgress[] = [];
  const deps = {
    fetch: fake.fetch,
    builder,
    onProgress: (p: JobProgress) => progress.push(p),
  };
  return {fake, emu, builder, progress, deps};
}

describe('runReleaseJob', () => {
  it('downloads, verifies and builds with the real builder, and returns the core', async () => {
    const {builder, progress, deps} = setup();
    const r = await runReleaseJob(specFor(assets), deps);
    expect(r).toEqual({
      ok: true,
      core: {sha256: expectedSha, bytes: expect.any(Uint8Array)},
      configs: [],
    });
    expect(r.ok && sha256(r.core.bytes)).toBe(expectedSha);
    expect(builder.calls).toHaveLength(1);
    expect(builder.calls[0]!.release).toEqual({
      tag: `v${VERSION}`,
      commit: idsFor(VERSION).commit,
      tagObject: idsFor(VERSION).tagObject,
    });
    // The builder gets the verified asset itself, in memory.
    expect(builder.calls[0]!.asset.bytes).toEqual(assets.tarball);
    expect(progress.map(p => p.phase).filter((p, i, a) => a[i - 1] !== p)).toEqual([
      'downloading',
      'verifying',
      'building',
      'storing',
    ]);
  });

  it('refuses a digest mismatch before anything parses the bytes', async () => {
    const {emu, builder, deps} = setup();
    const tampered = assets.tarball.slice();
    flip(tampered, tampered.length - 10, 0xff);
    emu.serveInstead(VW_REPO, `v${VERSION}`, assets.asset, tampered);
    const r = await runReleaseJob(specFor(assets), deps);
    expect(r).toEqual({ok: false, failure: 'digest-mismatch'});
    expect(builder.calls).toHaveLength(0);
  });

  it('refuses an asset larger than the cap without downloading it', async () => {
    const {emu, builder, deps} = setup();
    const r = await runReleaseJob(specFor(assets), {...deps, limits: {maxAssetBytes: 1000}});
    expect(r).toEqual({ok: false, failure: 'build-refused', detail: 'size-mismatch'});
    expect(emu.counts.download).toBe(0);
    expect(builder.calls).toHaveLength(0);
  });

  it('maps a corrupt archive (correct digest, broken gzip) to a builder refusal', async () => {
    const {emu, deps} = setup(false);
    const corrupt = assets.tarball.slice();
    flip(corrupt, corrupt.length - 6, 0xff); // the gzip CRC-32 / ISIZE trailer
    emu.addRelease({
      repoId: VW_REPO_ID,
      repo: VW_REPO,
      tag: `v${VERSION}`,
      assets: [{name: assets.asset, bytes: corrupt}],
    });
    const spec = specFor(assets, {
      asset: {...specFor(assets).asset, sha256: sha256(corrupt), size: corrupt.length},
    });
    expect(await runReleaseJob(spec, deps)).toEqual({
      ok: false,
      failure: 'build-refused',
      detail: 'archive-invalid',
    });
  });

  it('turns a network failure into a transient failure', async () => {
    const {deps} = setup(false);
    const r = await runReleaseJob(specFor(assets), deps);
    expect(r).toEqual({ok: false, failure: 'network'});
  });

  it('checks config files against their pins and reports their digests', async () => {
    const {fake, deps} = setup();
    const config = new TextEncoder().encode('{"a":1}');
    const ids = idsFor(VERSION);
    const url = `https://raw.githubusercontent.com/${VW_REPO}/${ids.commit}/apps/x.json`;
    fake.route('GET', url, () => new Response(config));
    // A builder that accepts configs: the real Vaultwarden plan has none, so use a stub.
    const stub: CoreBuilder = {
      ...deps.builder,
      build: async () => {
        throw new BuildError('derivation-failed', 'stub');
      },
    };
    const spec: ReleaseJobSpec = {
      ...specFor(assets),
      plan: {...specFor(assets).plan, configPaths: ['apps/x.json']},
      configs: [{path: 'apps/x.json', sha256: 'f'.repeat(64)}],
    };
    expect(await runReleaseJob(spec, {...deps, builder: stub})).toEqual({
      ok: false,
      failure: 'digest-mismatch',
    });
    const ok = {...spec, configs: [{path: 'apps/x.json', sha256: sha256(config)}]};
    expect(await runReleaseJob(ok, {...deps, builder: stub})).toEqual({
      ok: false,
      failure: 'build-refused',
      detail: 'derivation-failed',
    });
  });

  it('a config file that cannot be read to its end is transient, never a refusal', async () => {
    // A refusal would be kept for a day and logged as an incident; a broken connection is neither.
    const {fake, deps} = setup();
    const url = `https://raw.githubusercontent.com/${VW_REPO}/${idsFor(VERSION).commit}/apps/x.json`;
    const spec: ReleaseJobSpec = {
      ...specFor(assets),
      plan: {...specFor(assets).plan, configPaths: ['apps/x.json']},
      configs: [{path: 'apps/x.json'}],
    };
    // The connection breaks after the first chunk.
    fake.route('GET', url, () => {
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) return controller.error(new TypeError('connection reset'));
            sent = true;
            controller.enqueue(new TextEncoder().encode('{"a":'));
          },
        }),
      );
    });
    expect(await runReleaseJob(spec, deps)).toEqual({ok: false, failure: 'network'});
    // A body past the cap is not read to its end either.
    fake.route('GET', url, () => new Response(new Uint8Array(2000)));
    expect(await runReleaseJob(spec, {...deps, limits: {maxConfigBytes: 1000}})).toEqual({
      ok: false,
      failure: 'network',
    });
    // The commit has no such file: that does not change, so the build is refused.
    fake.route('GET', url, () => new Response('Not Found', {status: 404}));
    expect(await runReleaseJob(spec, deps)).toEqual({
      ok: false,
      failure: 'build-refused',
      detail: 'derivation-failed',
    });
    expect(deps.builder.calls).toHaveLength(0);
  });

  it('a builder digest mismatch after a verified download is transient', async () => {
    const {deps} = setup();
    const stub: CoreBuilder = {
      ...deps.builder,
      build: async () => {
        throw new BuildError('digest-mismatch', 'stub');
      },
    };
    expect(await runReleaseJob(specFor(assets), {...deps, builder: stub})).toEqual({
      ok: false,
      failure: 'network',
    });
  });
});
