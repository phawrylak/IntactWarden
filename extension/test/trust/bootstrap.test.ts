import {beforeAll, describe, expect, it} from 'vitest';
import {canonicalBytes} from '@intactwarden/core/jcs/canonicalize.ts';
import type {BootstrapIndex} from '../../src/contracts.ts';
import {loadBootstrap} from '../../src/trust/bootstrap.ts';
import {flip, packageReader} from './helpers/memory.ts';
import {bundledPackage, sha256, type BundledPackage} from './helpers/vaultwarden.ts';

const enc = new TextEncoder();
const INDEX = 'data/bootstrap/index.json';

let pkg: BundledPackage;
beforeAll(async () => {
  pkg = await bundledPackage(['2026.10.1', '2026.9.0']);
});

function withIndex(change: (index: {-readonly [K in keyof BootstrapIndex]: unknown}) => void) {
  const files = new Map(pkg.files);
  const index = structuredClone(pkg.index) as {-readonly [K in keyof BootstrapIndex]: unknown};
  change(index);
  files.set(INDEX, enc.encode(JSON.stringify(index)));
  return files;
}

describe('loadBootstrap', () => {
  it('loads and verifies every bundled core and the bundled pins', async () => {
    const r = await loadBootstrap(packageReader(pkg.files));
    expect(r.error).toBeNull();
    expect(r.skipped).toEqual([]);
    expect(r.cores.map(c => c.entry.build_id)).toEqual([
      'vaultwarden-web@2026.10.1+release',
      'vaultwarden-web@2026.9.0+release',
    ]);
    expect(r.cores[0]!.parsed.core.build_id).toBe('vaultwarden-web@2026.10.1+release');
    expect(r.cores[0]!.parsed.fileIndex.lookup('/index.html')).not.toBeNull();
    expect(r.pins).toHaveLength(2);
  });

  it('skips a tampered core and still loads the others', async () => {
    const files = new Map(pkg.files);
    const entry = pkg.index.cores[0]!;
    const bytes = files.get(entry.path)!.slice();
    flip(bytes, bytes.length - 3, 1);
    files.set(entry.path, bytes);
    const r = await loadBootstrap(packageReader(files));
    expect(r.cores.map(c => c.entry.build_id)).toEqual(['vaultwarden-web@2026.9.0+release']);
    expect(r.skipped).toEqual([{path: entry.path, reason: 'sha256'}]);
  });

  it('skips a core that is not canonical JSON even when the index names its digest', async () => {
    const entry = pkg.index.cores[0]!;
    const pretty = enc.encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(pkg.files.get(entry.path)!)), null, 1),
    );
    const digest = sha256(pretty);
    const files = withIndex(index => {
      (index.cores as {sha256: string; size: number; path: string}[])[0] = {
        ...entry,
        sha256: digest,
        size: pretty.length,
        path: `data/bootstrap/cores/${digest}.json`,
      };
    });
    files.set(`data/bootstrap/cores/${digest}.json`, pretty);
    const r = await loadBootstrap(packageReader(files));
    expect(r.skipped).toEqual([
      {path: `data/bootstrap/cores/${digest}.json`, reason: 'not-canonical'},
    ]);
  });

  it('skips canonical JSON that is not the core the index names (never throws)', async () => {
    const entry = pkg.index.cores[0]!;
    for (const value of [null, 1, [], {build_id: entry.build_id}]) {
      const bytes = canonicalBytes(value);
      const digest = sha256(bytes);
      const files = withIndex(index => {
        (index.cores as {sha256: string; size: number; path: string}[])[0] = {
          ...entry,
          sha256: digest,
          size: bytes.length,
          path: `data/bootstrap/cores/${digest}.json`,
        };
      });
      files.set(`data/bootstrap/cores/${digest}.json`, bytes);
      const r = await loadBootstrap(packageReader(files));
      expect(r.skipped[0]?.reason, JSON.stringify(value)).toBe('identity');
      expect(r.cores).toHaveLength(1);
    }
  });

  it('skips a core whose identity, assurance or path disagrees with the index', async () => {
    const entry = pkg.index.cores[0]!;
    const cases: [Record<string, unknown>, string][] = [
      [{version: '2026.10.2', build_id: 'vaultwarden-web@2026.10.2+release'}, 'identity'],
      [{build_id: 'vaultwarden-web@2026.10.1+other'}, 'build-id'],
      [{assurance: 'release-derived'}, 'assurance'],
      [{path: 'data/bootstrap/cores/other.json'}, 'path'],
      [{app: 'other-app'}, 'app'],
      [{size: 1}, 'size'],
    ];
    for (const [change, reason] of cases) {
      const files = withIndex(index => {
        (index.cores as Record<string, unknown>[])[0] = {...entry, ...change};
      });
      const r = await loadBootstrap(packageReader(files));
      expect(r.skipped[0]?.reason, JSON.stringify(change)).toBe(reason);
      expect(r.cores).toHaveLength(1);
    }
  });

  it('skips duplicate build ids and missing core files', async () => {
    const files = withIndex(index => {
      const cores = index.cores as unknown[];
      cores.push(cores[0]);
    });
    files.delete(pkg.index.cores[1]!.path);
    const r = await loadBootstrap(packageReader(files));
    expect(r.cores).toHaveLength(1);
    expect(r.skipped.map(s => s.reason).sort()).toEqual(['duplicate', 'missing']);
  });

  it('a package without an index (the shipping package) has no bundled cores, without an error or a log', async () => {
    const logs: string[] = [];
    const none = {cores: [], pins: [], skipped: [], error: null};
    expect(await loadBootstrap(packageReader(new Map()), code => logs.push(code))).toEqual(none);
    const unreadable = async (): Promise<Uint8Array> => {
      throw new Error('boom');
    };
    expect(await loadBootstrap(unreadable, code => logs.push(code))).toEqual(none);
    expect(logs).toEqual([]);
  });

  it('fails as a whole on a malformed or foreign index', async () => {
    const files = new Map(pkg.files);
    files.set(INDEX, enc.encode('{nope'));
    expect((await loadBootstrap(packageReader(files))).error).toBe('index-json');
    files.set(INDEX, canonicalBytes({schema: 'intactwarden.bootstrap/2', cores: []}));
    const r = await loadBootstrap(packageReader(files));
    expect(r.error).toBe('index-schema');
    expect(r.cores).toEqual([]);
  });
});
