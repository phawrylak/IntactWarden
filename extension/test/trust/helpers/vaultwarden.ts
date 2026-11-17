/**
 * Synthetic Vaultwarden releases for the trust tests (built from the
 * builders' tarball fixture), a GitHub emulator release for each, and a
 * bundled bootstrap package whose cores come from the real CoreBuilder.
 */

import {createHash} from 'node:crypto';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import type {BuiltCore} from '@intactwarden/builders/api.ts';
import {
  VW_COMMIT,
  VW_REPO,
  VW_TAG_OBJECT,
  vwFiles,
  vwTarball,
} from '../../../../packages/builders/test/helpers/vaultwardenFixture.ts';
import type {BootstrapIndex, LocalPin} from '../../../src/contracts.ts';
import type {GitHubEmulator} from './githubEmulator.ts';

export {VW_COMMIT, VW_REPO, VW_TAG_OBJECT};
export const VW_REPO_ID = 161632059;

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const enc = new TextEncoder();

export interface VwAssets {
  readonly version: string;
  readonly tag: string;
  readonly asset: string;
  readonly tarball: Uint8Array;
}

/** A release tarball whose version files name `version`. */
export function vwAssets(version: string): VwAssets {
  const files = vwFiles();
  files['vw-version.json'] = `{"version":"${version}"}`;
  files['version.json'] = `{ "version": "${version}" }`;
  const tarball = vwTarball(files);
  const asset = `bw_web_v${version}.tar.gz`;
  return {version, tag: `v${version}`, asset, tarball};
}

/** Distinct commit / tag-object ids per version (40 hex). */
export function idsFor(version: string): {commit: string; tagObject: string} {
  const h = sha256(enc.encode(`vw ${version}`));
  return {commit: h.slice(0, 40), tagObject: h.slice(24, 64)};
}

/** Publishes a Vaultwarden release on the emulator; returns its assets. */
export function publishVw(
  emu: GitHubEmulator,
  version: string,
  options: {commit?: string; tagObject?: string; tarball?: boolean; digest?: string | null} = {},
): VwAssets {
  const a = vwAssets(version);
  const ids = idsFor(version);
  emu.addRelease({
    repoId: VW_REPO_ID,
    repo: VW_REPO,
    tag: a.tag,
    assets:
      options.tarball === false
        ? []
        : [
            {
              name: a.asset,
              bytes: a.tarball,
              ...(options.digest === undefined ? {} : {digest: options.digest}),
            },
          ],
  });
  emu.setTag(VW_REPO, VW_REPO_ID, a.tag, {
    commit: options.commit ?? ids.commit,
    tagObject: options.tagObject ?? ids.tagObject,
  });
  return a;
}

/** Builds the Vaultwarden core of `version` with the real builder. */
export async function buildVwCore(a: VwAssets, ids = idsFor(a.version)): Promise<BuiltCore> {
  return createCoreBuilder().build({
    app: 'vaultwarden-web',
    variant: 'release',
    version: a.version,
    release: {tag: a.tag, commit: ids.commit, tagObject: ids.tagObject},
    asset: {name: a.asset, sha256: sha256(a.tarball), size: a.tarball.length, bytes: a.tarball},
  });
}

export interface BundledPackage {
  readonly files: Map<string, Uint8Array>;
  readonly index: BootstrapIndex;
  readonly cores: readonly BuiltCore[];
}

/** A package with bundled Vaultwarden cores (and their pins) for the given versions. */
export async function bundledPackage(versions: readonly string[]): Promise<BundledPackage> {
  const files = new Map<string, Uint8Array>();
  const cores: BuiltCore[] = [];
  const pins: LocalPin[] = [];
  for (const version of versions) {
    const a = vwAssets(version);
    const ids = idsFor(version);
    const core = await buildVwCore(a, ids);
    cores.push(core);
    files.set(`data/bootstrap/cores/${core.sha256}.json`, core.bytes);
    pins.push({
      kind: 'release-asset',
      repo: VW_REPO,
      tag: a.tag,
      tag_commit: ids.commit,
      tag_object: ids.tagObject,
      asset: a.asset,
      sha256: sha256(a.tarball),
      size: a.tarball.length,
      source: 'bundled',
    });
  }
  const index: BootstrapIndex = {
    schema: 'intactwarden.bootstrap/1',
    generated_from: [{lock: 'test.lock.json', sha256: 'a'.repeat(64)}],
    cores: cores.map(c => ({
      app: c.app,
      variant: c.variant,
      version: c.version,
      build_id: c.buildId,
      assurance: c.assurance,
      sha256: c.sha256,
      size: c.bytes.length,
      path: `data/bootstrap/cores/${c.sha256}.json`,
    })),
    pins: {schema: 'intactwarden.localpins/1', pins},
  };
  files.set('data/bootstrap/index.json', enc.encode(JSON.stringify(index)));
  return {files, index, cores};
}
