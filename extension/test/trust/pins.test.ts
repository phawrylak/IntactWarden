import {describe, expect, it} from 'vitest';
import {LOCAL_KEYS, type ReleaseAssetPin} from '../../src/contracts.ts';
import {
  createPinStore,
  disputeEvidence,
  validatePin,
  type ObservedAsset,
} from '../../src/trust/pins.ts';
import {memoryKv} from './helpers/memory.ts';

const H = (c: string): string => c.repeat(64);
const COMMIT = 'f35c1cbb7b582781243d1166f5cad21f6988ab5f';
const TAG_OBJECT = '878e7d7a00f5989f1d743cd0c2d7b9aa460107c5';

const observed: ObservedAsset = {
  repo: 'dani-garcia/bw_web_builds',
  tag: 'v2026.11.0',
  commit: COMMIT,
  tagObject: TAG_OBJECT,
  asset: 'bw_web_v2026.11.0.tar.gz',
  sha256: H('a'),
  size: 1000,
};

const bundledPin: ReleaseAssetPin = {
  kind: 'release-asset',
  repo: 'bitwarden/clients',
  tag: 'web-v2026.10.1',
  tag_commit: '91214c3b978edb5496a32a946451960fe7d44531',
  asset: 'web-2026.10.1-selfhosted-COMMERCIAL.zip',
  sha256: '8ae50b7dd15c213b9ce43fbc93cd85af061d95ad0782651d80c5e68f3f3824a6',
  size: 50220770,
  source: 'bundled',
};

async function store(initial: Record<string, unknown> = {}) {
  const kv = memoryKv(initial);
  const pins = createPinStore({kv});
  await pins.load([bundledPin]);
  return {kv, pins};
}

describe('pins (TOFU)', () => {
  it('records a first-seen pin, persists it, and matches it later', async () => {
    const {kv, pins} = await store();
    expect(pins.checkAsset(observed)).toEqual({k: 'new'});
    const pin = await pins.recordAsset(observed);
    expect(pin).toEqual({
      kind: 'release-asset',
      repo: observed.repo,
      tag: observed.tag,
      tag_commit: COMMIT,
      tag_object: TAG_OBJECT,
      asset: observed.asset,
      sha256: H('a'),
      size: 1000,
      source: 'local',
    });
    expect(pins.checkAsset(observed)).toEqual({k: 'match', pin});
    expect(kv.data.get(LOCAL_KEYS.pins)).toEqual({schema: 'intactwarden.localpins/1', pins: [pin]});

    const reloaded = createPinStore({kv});
    await reloaded.load([]);
    expect(reloaded.checkAsset(observed).k).toBe('match');
  });

  it('never replaces a pin: a different observation is a dispute', async () => {
    const {pins} = await store();
    await pins.recordAsset(observed);
    const cases: [Partial<ObservedAsset>, string][] = [
      [{sha256: H('b')}, 'pin-changed'],
      [{size: 999}, 'pin-changed'],
      [{commit: 'a'.repeat(40)}, 'tag-moved'],
      [{tagObject: 'b'.repeat(40)}, 'tag-moved'],
      [{tagObject: undefined}, 'tag-moved'],
    ];
    for (const [change, reason] of cases) {
      const o = {...observed, ...change};
      if ('tagObject' in change && change.tagObject === undefined)
        delete (o as {tagObject?: string}).tagObject;
      const check = pins.checkAsset(o);
      expect(check.k, JSON.stringify(change)).toBe('dispute');
      if (check.k === 'dispute') expect(check.reason).toBe(reason);
      // Recording again keeps the first pin.
      expect((await pins.recordAsset(o)).sha256).toBe(H('a'));
    }
    expect(pins.all().pins.filter(p => p.source === 'local')).toHaveLength(1);
  });

  it('names the two values that differ as the evidence of a dispute', async () => {
    const {pins} = await store();
    const pin = await pins.recordAsset(observed);
    expect(disputeEvidence('pin-changed', pin, {...observed, sha256: H('b')})).toEqual({
      recorded: H('a'),
      observed: H('b'),
    });
    expect(disputeEvidence('tag-moved', pin, {...observed, commit: 'a'.repeat(40)})).toEqual({
      recorded: COMMIT,
      observed: 'a'.repeat(40),
    });
    // The same commit: the objects the tags point to (the commit itself for a lightweight tag).
    expect(disputeEvidence('tag-moved', pin, {...observed, tagObject: 'b'.repeat(40)})).toEqual({
      recorded: TAG_OBJECT,
      observed: 'b'.repeat(40),
    });
    const lightweight = {sha256: observed.sha256, commit: COMMIT};
    expect(disputeEvidence('tag-moved', pin, lightweight)).toEqual({
      recorded: TAG_OBJECT,
      observed: COMMIT,
    });
  });

  it('checks GitHub against the bundled pin first (repository name case-insensitive)', async () => {
    const {pins} = await store();
    const o: ObservedAsset = {
      repo: 'Bitwarden/Clients',
      tag: bundledPin.tag,
      commit: bundledPin.tag_commit,
      asset: bundledPin.asset,
      sha256: H('c'),
      size: bundledPin.size,
    };
    expect(pins.checkAsset(o)).toMatchObject({k: 'dispute', reason: 'pin-changed'});
    expect(pins.checkAsset({...o, sha256: bundledPin.sha256})).toMatchObject({k: 'match'});
    expect(await pins.recordAsset(o)).toBe(bundledPin);
  });

  it('keeps no pin in force that storage rejected, and keeps writing afterwards', async () => {
    const kv = memoryKv();
    let fail = true;
    const flaky = {
      get: kv.get,
      set: async (k: string, v: unknown) => {
        if (fail) {
          fail = false;
          throw new Error('QuotaExceededError');
        }
        return kv.set(k, v);
      },
    };
    const pins = createPinStore({kv: flaky});
    await pins.load([]);
    await expect(pins.recordAsset(observed)).rejects.toThrow();
    expect(pins.checkAsset(observed)).toEqual({k: 'new'});
    const pin = await pins.recordAsset(observed);
    expect(kv.data.get(LOCAL_KEYS.pins)).toEqual({schema: 'intactwarden.localpins/1', pins: [pin]});
  });

  it('finds the pin this browser recorded even where a bundled pin is in force', async () => {
    const local = {...bundledPin, sha256: H('e'), source: 'local'};
    const {pins} = await store({
      [LOCAL_KEYS.pins]: {schema: 'intactwarden.localpins/1', pins: [local]},
    });
    expect(pins.findAsset(bundledPin.repo, bundledPin.tag, bundledPin.asset)).toBe(bundledPin);
    expect(pins.findLocalAsset(bundledPin.repo, bundledPin.tag, bundledPin.asset)).toEqual(local);
    expect(pins.findLocalAsset(bundledPin.repo, 'web-v1.0.0', bundledPin.asset)).toBeNull();
  });

  it('pins config files by commit and path', async () => {
    const {pins} = await store();
    const pin = await pins.recordConfig(
      'bitwarden/clients',
      COMMIT,
      'apps/web/config/base.json',
      H('d'),
    );
    expect(pins.findConfig('bitwarden/clients', COMMIT, 'apps/web/config/base.json')).toEqual(pin);
    expect(
      pins.findConfig('bitwarden/clients', 'a'.repeat(40), 'apps/web/config/base.json'),
    ).toBeNull();
    const again = await pins.recordConfig(
      'bitwarden/clients',
      COMMIT,
      'apps/web/config/base.json',
      H('e'),
    );
    expect(again.sha256).toBe(H('d'));
  });

  it('drops malformed persisted pins and pins from the wrong source', async () => {
    const good = {...bundledPin, source: 'local'};
    const {pins} = await store({
      [LOCAL_KEYS.pins]: {
        schema: 'intactwarden.localpins/1',
        pins: [
          good,
          {...good, sha256: 'XYZ'},
          {...good, extra: 1},
          {...good, source: 'bundled'},
          null,
        ],
      },
    });
    expect(pins.all().pins).toHaveLength(2); // the bundled one and `good`
    expect(validatePin({...good, tag_object: 'short'}, 'local')).toBeNull();
    expect(validatePin({...good, repo: '../x'}, 'local')).toBeNull();
    // A pin with a field outside the closed key set is dropped too.
    expect(validatePin({...good, first_seen: '2026-10-28T01:05:00Z'}, 'local')).toBeNull();
  });
});
