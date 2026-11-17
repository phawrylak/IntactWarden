/**
 * The retention rule (src/retain.ts): the loader keeps only the bytes the checks read and refuses
 * a missing one instead of skipping it; and it checks the listed size and digest first.
 */

import {describe, expect, it} from 'vitest';
import {BuildError, type BuildRequest} from '../src/api.ts';
import {createCoreBuilder} from '../src/coreBuilder.ts';
import {RefusalError} from '../src/files.ts';
import {loadRelease} from '../src/release.ts';
import {bytesOf, isCheckedPath} from '../src/retain.ts';
import {
  bitwardenRequest,
  buildReleaseZip,
  COMMERCIAL_ASSET,
  COMMIT,
  SELF,
  sha256,
  SM_CHUNK,
  VERSION,
} from './helpers/bitwardenFixture.ts';
import {vwRequest, vwTarball} from './helpers/vaultwardenFixture.ts';

const builder = createCoreBuilder();
const ZIP = buildReleaseZip();
const TARBALL = vwTarball();

describe('retention rule', () => {
  it('names the files the checks read', () => {
    for (const p of [
      '/index.html',
      '/404.html',
      '/duo-redirect-connector.html',
      '/version.json',
      '/vw-version.json',
      `/app/main.${SELF.main}.js`,
      '/connectors/duo-redirect.0123456789abcdef0123.js',
      '/connectors/webauthn-fallback.0123456789abcdef0123.js',
    ]) {
      expect(isCheckedPath(p), p).toBe(true);
    }
    for (const p of [
      '/app/main.0123.js',
      '/app/polyfills.0123456789abcdef0123.js',
      '/connectors/webauthn.0123456789abcdef0123.js',
      '/images/logo.svg',
      '/app-id.json',
      `${SM_CHUNK}.map`,
      '/locales/en/messages.json',
    ]) {
      expect(isCheckedPath(p), p).toBe(false);
    }
  });

  it('the loader keeps exactly the checked bytes', async () => {
    const plan = builder.plan('bitwarden-web', 'selfhosted-commercial', VERSION);
    const loaded = await loadRelease(
      plan,
      {commit: COMMIT},
      {sha256: sha256(ZIP), size: ZIP.length, bytes: ZIP},
    );
    expect(
      [...loaded.files.values()]
        .filter(f => f.bytes !== undefined)
        .map(f => f.path)
        .sort(),
    ).toEqual([...loaded.files.keys()].filter(isCheckedPath).sort());
    const image = loaded.files.get('/images/logo.svg');
    expect(image).toEqual({path: '/images/logo.svg', size: image!.size, sha256: image!.sha256});
    expect(() => bytesOf(image, '/images/logo.svg')).toThrow(RefusalError);
    expect(() => bytesOf(undefined, '/x')).toThrow(/not retained/);
  });
});

describe('CoreBuilder: the asset is checked before the archive is read', () => {
  it('refuses a size or digest that differs from the listed one', async () => {
    const code = async (request: BuildRequest): Promise<string> =>
      builder.build(request).then(
        () => 'built',
        (e: unknown) => (e as BuildError).code,
      );
    const r = bitwardenRequest(ZIP);
    expect(r.asset.name).toBe(COMMERCIAL_ASSET);
    expect(await code({...r, asset: {...r.asset, bytes: ZIP.subarray(1)}})).toBe('size-mismatch');
    expect(await code({...r, asset: {...r.asset, sha256: '1'.repeat(64)}})).toBe('digest-mismatch');
    const vw = vwRequest(TARBALL);
    expect(await code(vw)).toBe('built');
  });
});
