import {describe, expect, it} from 'vitest';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {VERSION} from '@intactwarden/builders/release.ts';
import {compareVersions, isReleaseKey, VERSION_XYZ} from '../../src/trust/common.ts';

describe('VERSION_XYZ', () => {
  it("accepts exactly what the builders' VERSION accepts", () => {
    // The same expression; this one captures the three parts for compareVersions.
    expect(VERSION_XYZ.source.replaceAll('(', '(?:')).toBe(VERSION.source);
    expect(VERSION_XYZ.flags).toBe(VERSION.flags);
  });

  it('the builder has a plan for a version exactly when a release key may carry it', () => {
    const builder = createCoreBuilder();
    const key = (version: string) => ({app: 'vaultwarden-web', variant: 'release', version});
    for (const version of ['2026.10.1', '0.0.0', '999999.999999.999999']) {
      expect(isReleaseKey(key(version)), version).toBe(true);
      expect(builder.plan('vaultwarden-web', 'release', version).version).toBe(version);
    }
    for (const version of ['2026.06.1', '2026.10.1234567', '2026.10', '2026.10.1.2', '2026.10.x']) {
      expect(isReleaseKey(key(version)), version).toBe(false);
      expect(() => builder.plan('vaultwarden-web', 'release', version), version).toThrow();
    }
  });

  it('orders versions by their numbers', () => {
    expect(compareVersions('2026.10.1', '2026.9.12')).toBeGreaterThan(0);
    expect(compareVersions('2026.10.1', '2026.10.1')).toBe(0);
    expect(compareVersions('2025.12.3', '2026.1.0')).toBeLessThan(0);
  });
});
