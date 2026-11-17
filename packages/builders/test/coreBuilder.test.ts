/**
 * Unit tests of the CoreBuilder (src/coreBuilder.ts), the one entry point into the builders, on
 * the synthetic releases of test/helpers (no vendor bytes): plans from the bundled profiles, one
 * variant per build, and the mapping of every refusal to a stable BuildError code.
 */

import {describe, expect, it} from 'vitest';
import {ZipError} from '@intactwarden/core/archive/zip.ts';
import {canonicalBytes} from '@intactwarden/core/jcs/canonicalize.ts';
import {coreProblem} from '@intactwarden/core/schema/manifest.ts';
import {BuildError, type BuildRefusal, type BuilderVariant} from '../src/api.ts';
import {ContextError} from '../src/contexts.ts';
import {createCoreBuilder, toBuildError} from '../src/coreBuilder.ts';
import {RefusalError} from '../src/files.ts';
import {
  BASE,
  bitwardenRequest,
  buildReleaseZip,
  CLOUD,
  COMMIT,
  CONFIGS,
  EUPRD,
  mainJs,
  SELF,
  sha256,
  TAG,
  VERSION,
} from './helpers/bitwardenFixture.ts';
import {
  VW_ASSET,
  VW_COMMIT,
  VW_TAG,
  VW_TAG_OBJECT,
  VW_VERSION,
  vwFiles,
  vwRequest,
  vwTarball,
} from './helpers/vaultwardenFixture.ts';

const builder = createCoreBuilder();
const ZIP = buildReleaseZip();
const TARBALL = vwTarball();

async function refusal(promise: Promise<unknown>): Promise<BuildRefusal> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(BuildError);
    expect((e as BuildError).name).toBe('BuildError');
    return (e as BuildError).code;
  }
  throw new Error('expected a BuildError');
}

function syncRefusal(fn: () => unknown): BuildRefusal {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BuildError);
    return (e as BuildError).code;
  }
  throw new Error('expected a BuildError');
}

describe('CoreBuilder.plan', () => {
  it('plans one variant; both cloud variants fetch the same three config files', () => {
    const us = builder.plan('bitwarden-web', 'cloud-us', '2026.11.0');
    expect(us).toEqual({
      app: 'bitwarden-web',
      variant: 'cloud-us',
      version: '2026.11.0',
      repo: 'bitwarden/clients',
      repoId: 53538899,
      tag: 'web-v2026.11.0',
      assetName: 'web-2026.11.0-selfhosted-COMMERCIAL.zip',
      configPaths: [BASE, CLOUD, EUPRD],
    });
    expect(builder.plan('bitwarden-web', 'cloud-eu', '2026.11.0')).toEqual({
      ...us,
      variant: 'cloud-eu',
    });
    expect(Object.isFrozen(us) && Object.isFrozen(us.configPaths)).toBe(true);
  });

  it('plans no config file for the release-exact variants', () => {
    expect(builder.plan('bitwarden-web', 'selfhosted-commercial', VERSION)).toMatchObject({
      variant: 'selfhosted-commercial',
      assetName: `web-${VERSION}-selfhosted-COMMERCIAL.zip`,
      configPaths: [],
    });
    expect(builder.plan('vaultwarden-web', 'release', VW_VERSION)).toEqual({
      app: 'vaultwarden-web',
      variant: 'release',
      version: VW_VERSION,
      repo: 'dani-garcia/bw_web_builds',
      repoId: 161632059,
      tag: VW_TAG,
      assetName: VW_ASSET,
      configPaths: [],
    });
  });

  it('refuses unknown apps and variants, and versions that are not x.y.z', () => {
    for (const version of ['2026.10', 'v2026.10.1', '01.2.3', '2026.10.1+build.3', '', '1.2.3.4']) {
      expect(
        syncRefusal(() => builder.plan('bitwarden-web', 'cloud-us', version)),
        version,
      ).toBe('unsupported');
    }
    expect(syncRefusal(() => builder.plan('vaultwarden-web', 'cloud-us', VERSION))).toBe(
      'unsupported',
    );
    expect(syncRefusal(() => builder.plan('bitwarden-web', 'release', VERSION))).toBe(
      'unsupported',
    );
    expect(
      syncRefusal(() => builder.plan('bitwarden-web', 'selfhosted-oss' as BuilderVariant, VERSION)),
    ).toBe('unsupported');
    expect(syncRefusal(() => builder.plan('nope' as 'bitwarden-web', 'release', VERSION))).toBe(
      'unsupported',
    );
  });
});

describe('CoreBuilder.build: Bitwarden', () => {
  it('builds each variant of the COMMERCIAL zip in its own call', async () => {
    const variants = ['selfhosted-commercial', 'cloud-us', 'cloud-eu'] as const;
    const cores = await Promise.all(variants.map(v => builder.build(bitwardenRequest(ZIP, v))));
    for (const [i, c] of cores.entries()) {
      expect(c.variant).toBe(variants[i]);
      expect(c.buildId).toBe(`bitwarden-web@${VERSION}+${c.variant}`);
      expect(c.core.build_id).toBe(c.buildId);
      expect(c.version).toBe(VERSION);
      expect(c.app).toBe('bitwarden-web');
      expect(sha256(c.bytes)).toBe(c.sha256);
      expect(canonicalBytes(JSON.parse(new TextDecoder().decode(c.bytes)))).toEqual(c.bytes);
      expect(coreProblem(c.core)).toBeNull();
    }
    expect(cores.map(c => c.assurance)).toEqual([
      'release-exact',
      'release-derived',
      'release-derived',
    ]);
    expect(cores[0]!.configInputs).toBeUndefined();
    expect(cores[1]!.configInputs).toEqual([
      {path: BASE, commit: COMMIT, sha256: sha256(CONFIGS[BASE]!)},
      {path: CLOUD, commit: COMMIT, sha256: sha256(CONFIGS[CLOUD]!)},
    ]);
    expect(cores[2]!.configInputs).toEqual([
      {path: BASE, commit: COMMIT, sha256: sha256(CONFIGS[BASE]!)},
      {path: EUPRD, commit: COMMIT, sha256: sha256(CONFIGS[EUPRD]!)},
    ]);
  });

  it('a variant needs only its own inputs, so a broken cloud config fails no other variant', async () => {
    const broken = {...CONFIGS, [EUPRD]: new TextEncoder().encode('[')};
    expect(await refusal(builder.build(bitwardenRequest(ZIP, 'cloud-eu', {configs: broken})))).toBe(
      'derivation-failed',
    );
    const selfhosted = await builder.build(
      bitwardenRequest(ZIP, 'selfhosted-commercial', {configs: undefined}),
    );
    expect(selfhosted.variant).toBe('selfhosted-commercial');
    const us = await builder.build(
      bitwardenRequest(ZIP, 'cloud-us', {
        configs: {[BASE]: CONFIGS[BASE]!, [CLOUD]: CONFIGS[CLOUD]!},
      }),
    );
    expect(us.variant).toBe('cloud-us');
  });

  it('is deterministic', async () => {
    const a = await builder.build(bitwardenRequest(ZIP, 'cloud-us'));
    const b = await createCoreBuilder().build(bitwardenRequest(ZIP.slice(), 'cloud-us'));
    expect(b.sha256).toBe(a.sha256);
  });

  it('refuses a request that does not match its plan', async () => {
    const r = bitwardenRequest(ZIP);
    expect(await refusal(builder.build({...r, asset: {...r.asset, name: 'other.zip'}}))).toBe(
      'asset-name-mismatch',
    );
    expect(
      await refusal(builder.build({...r, release: {tag: 'web-v2026.10.2', commit: COMMIT}})),
    ).toBe('tag-mismatch');
    expect(await refusal(builder.build({...r, version: '2026.10.2'}))).toBe('tag-mismatch');
    expect(await refusal(builder.build({...r, version: '2026.10'}))).toBe('unsupported');
    expect(await refusal(builder.build({...r, variant: 'release'}))).toBe('unsupported');
    expect(await refusal(builder.build({...r, app: 'nope' as 'bitwarden-web'}))).toBe(
      'unsupported',
    );
    expect(await refusal(builder.build({...r, release: {tag: TAG, commit: 'HEAD'}}))).toBe(
      'unsupported',
    );
    expect(
      await refusal(builder.build({...r, release: {tag: TAG, commit: COMMIT, tagObject: 'x'}})),
    ).toBe('unsupported');
  });

  it('refuses a cloud build without its two config files', async () => {
    const r = bitwardenRequest(ZIP, 'cloud-us');
    expect(await refusal(builder.build({...r, configs: {[BASE]: CONFIGS[BASE]!}}))).toBe(
      'unsupported',
    );
    expect(await refusal(builder.build({...r, configs: undefined}))).toBe('unsupported');
  });

  it('checks the size before the digest, and the digest before reading the zip', async () => {
    const r = bitwardenRequest(ZIP);
    expect(await refusal(builder.build({...r, asset: {...r.asset, size: ZIP.length + 1}}))).toBe(
      'size-mismatch',
    );
    const flipped = ZIP.slice();
    flipped[100] = flipped[100]! ^ 1;
    expect(await refusal(builder.build({...r, asset: {...r.asset, bytes: flipped}}))).toBe(
      'digest-mismatch',
    );
    // Garbage with a matching digest gets as far as the zip reader.
    const junk = new TextEncoder().encode('not a zip at all');
    expect(await refusal(builder.build(bitwardenRequest(junk)))).toBe('archive-invalid');
  });

  it('maps content refusals to stable codes', async () => {
    const cases: [Record<string, string | Uint8Array | null>, BuilderVariant, BuildRefusal][] = [
      [{'version.json': '{"version":"2026.10.0"}'}, 'selfhosted-commercial', 'version-mismatch'],
      [{'version.json': null}, 'selfhosted-commercial', 'version-mismatch'],
      [{'tool.exe': 'MZ'}, 'selfhosted-commercial', 'unsupported'],
      // The cloud recipe needs the two ?cache= sites of main.
      [
        {[`app/main.${SELF.main}.js`]: mainJs().replace('?cache=', '?nocache=')},
        'cloud-us',
        'derivation-failed',
      ],
    ];
    for (const [override, variant, code] of cases) {
      const zip = buildReleaseZip({override});
      expect(
        await refusal(builder.build(bitwardenRequest(zip, variant))),
        JSON.stringify(override),
      ).toBe(code);
    }
    // A config that is not JSON.
    const bad = {...CONFIGS, [CLOUD]: new TextEncoder().encode('{')};
    expect(await refusal(builder.build(bitwardenRequest(ZIP, 'cloud-us', {configs: bad})))).toBe(
      'derivation-failed',
    );
  });
});

describe('CoreBuilder.build: Vaultwarden', () => {
  it('builds the release core with the tag object', async () => {
    const core = await builder.build(vwRequest(TARBALL));
    expect(core).toMatchObject({
      app: 'vaultwarden-web',
      variant: 'release',
      buildId: `vaultwarden-web@${VW_VERSION}+release`,
      version: VW_VERSION,
      assurance: 'release-exact',
    });
    expect(core.core.source.tag_object).toBe(VW_TAG_OBJECT);
    expect(core.configInputs).toBeUndefined();
  });

  it('refuses mismatching archives and contents', async () => {
    const enc = new TextEncoder();
    const junk = enc.encode('not gzip');
    expect(await refusal(builder.build(vwRequest(junk)))).toBe('archive-invalid');
    const css = vwTarball({...vwFiles(), 'css/vaultwarden.css': 'body{}'});
    expect(await refusal(builder.build(vwRequest(css)))).toBe('forbidden-content');
    const older = vwTarball({...vwFiles(), 'vw-version.json': '{"version":"2026.9.0"}'});
    expect(await refusal(builder.build(vwRequest(older)))).toBe('version-mismatch');
    expect(
      await refusal(
        builder.build(
          vwRequest(TARBALL, {release: {tag: VW_TAG, commit: VW_COMMIT, tagObject: VW_COMMIT}}),
        ),
      ),
    ).toBe('unsupported');
  });
});

describe('toBuildError', () => {
  it('keeps BuildErrors and the refusal of a RefusalError', () => {
    const e = new BuildError('tag-mismatch', 'x');
    expect(toBuildError(e, 'unsupported')).toBe(e);
    expect(toBuildError(new RefusalError('m', 'version-mismatch'), 'unsupported').code).toBe(
      'version-mismatch',
    );
    expect(toBuildError(new RefusalError('m'), 'invalid-core').code).toBe('invalid-core');
  });

  it('maps core error classes and falls back to the phase code', () => {
    expect(toBuildError(new ZipError('bad-signature' as never, 'x'), 'unsupported').code).toBe(
      'archive-invalid',
    );
    expect(toBuildError(new ContextError('x'), 'unsupported').code).toBe('derivation-failed');
    expect(toBuildError(new TypeError('x'), 'archive-invalid')).toMatchObject({
      code: 'archive-invalid',
      message: 'TypeError: x',
    });
    expect(toBuildError('thrown string', 'derivation-failed').code).toBe('derivation-failed');
  });
});
