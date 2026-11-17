import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  builderFingerprint,
  computeBuilderFingerprint,
  readFingerprintSources,
} from '../../build/fingerprint.ts';
import {REPO_ROOT} from '../../build/paths.ts';

const enc = new TextEncoder();
const files = (entries: Record<string, string>): Map<string, Uint8Array> =>
  new Map(Object.entries(entries).map(([path, text]) => [path, enc.encode(text)]));

const BASE = {
  'packages/builders/src/release.ts': 'export const a = 1;\n',
  'packages/core/src/jcs/canonicalize.ts': 'export const b = 2;\n',
};

describe('builderFingerprint', () => {
  it('is a sha256 of the files, independent of their order', () => {
    const fp = builderFingerprint(files(BASE));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(builderFingerprint(new Map([...files(BASE)].reverse()))).toBe(fp);
  });

  it('changes when a builder source changes, is added, removed or renamed', () => {
    const fp = builderFingerprint(files(BASE));
    const changed = {...BASE, 'packages/builders/src/release.ts': 'export const a = 2;\n'};
    expect(builderFingerprint(files(changed))).not.toBe(fp);
    const added = {...BASE, 'packages/builders/src/new.ts': ''};
    expect(builderFingerprint(files(added))).not.toBe(fp);
    const rest = {'packages/builders/src/release.ts': BASE['packages/builders/src/release.ts']};
    expect(builderFingerprint(files(rest))).not.toBe(fp);
    const renamed = {...rest, 'packages/core/src/jcs/other.ts': 'export const b = 2;\n'};
    expect(builderFingerprint(files(renamed))).not.toBe(fp);
  });
});

describe('the fingerprint sources', () => {
  it('are the code that builds and reads cores, without tests', async () => {
    const paths = [...(await readFingerprintSources()).keys()];
    expect(paths).toEqual(
      expect.arrayContaining([
        'packages/builders/src/coreBuilder.ts',
        'packages/builders/src/bitwarden/cloudCore.ts',
        'packages/core/src/jcs/canonicalize.ts',
        'packages/core/src/derive/bitwarden-cloud-v1.ts',
        'packages/profiles/index.ts',
        'packages/profiles/bitwarden-web.ts',
        'extension/src/trust/coresDb.ts',
      ]),
    );
    expect(paths.filter(p => p.includes('/test/') || !p.endsWith('.ts'))).toEqual([]);
  });

  it('leave out only the core directories that cannot change a core', async () => {
    const paths = [...(await readFingerprintSources()).keys()];
    const entries = await readdir(join(REPO_ROOT, 'packages/core/src'));
    const unhashed = entries.filter(e => !paths.some(p => p.startsWith(`packages/core/src/${e}/`)));
    expect(unhashed.sort()).toEqual(['privacy', 'style', 'verdict']);
  });

  it('import the unhashed core directories as types only', async () => {
    const dec = new TextDecoder();
    const runtimeImports: string[] = [];
    for (const [path, bytes] of await readFingerprintSources()) {
      // Any other string that names one of the directories counts: a dynamic or bare import too.
      const text = dec.decode(bytes).replace(/^(?:import|export)\s+type\b[^;]*;/gm, '');
      for (const [, s] of text.matchAll(/'([^'\n]*\/(?:privacy|style|verdict)\/[^'\n]*)'/g))
        runtimeImports.push(`${path}: ${s}`);
    }
    expect(runtimeImports).toEqual([]);
  });

  it('give a stable fingerprint', async () => {
    expect(await computeBuilderFingerprint()).toBe(await computeBuilderFingerprint());
  });
});
