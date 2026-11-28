import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {OFFICIAL_ORIGINS} from '@intactwarden/profiles';
import {
  buildManifest,
  esbuildTargets,
  generatedHostPermissions,
  officialMatchPatterns,
  originMatchPattern,
  TEST_HOST_PERMISSIONS,
  type JsonObject,
} from '../../build/manifest.ts';
import {extensionVersion, MANIFEST_PATH} from '../../build/paths.ts';

const committed = (): JsonObject => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as JsonObject;

describe('host permissions', () => {
  it('derives match patterns from the bundled profiles', () => {
    expect(OFFICIAL_ORIGINS).toEqual(['https://vault.bitwarden.com', 'https://vault.bitwarden.eu']);
    expect(officialMatchPatterns()).toEqual([
      'https://vault.bitwarden.com/*',
      'https://vault.bitwarden.eu/*',
    ]);
    expect(originMatchPattern('https://github.com')).toBe('https://github.com/*');
  });

  it('refuses official origins that are not canonical https origins', () => {
    for (const bad of ['http://a.example', 'https://a.example:8443', 'https://a.example/x']) {
      expect(() => originMatchPattern(bad)).toThrow();
    }
  });

  it('is the official origins plus the API and release-assets (and loopback in test builds)', () => {
    const production = generatedHostPermissions({test: false});
    expect(production).toEqual([
      'https://vault.bitwarden.com/*',
      'https://vault.bitwarden.eu/*',
      'https://api.github.com/*',
      'https://release-assets.githubusercontent.com/*',
    ]);
    // raw answers with CORS headers, and github.com is never contacted.
    for (const host of [
      'raw.githubusercontent.com',
      'github.com',
      'objects.githubusercontent.com',
    ]) {
      expect(production).not.toContain(`https://${host}/*`);
    }
    expect(generatedHostPermissions({test: true})).toEqual([
      ...production,
      ...TEST_HOST_PERMISSIONS,
    ]);
  });
});

describe('extension/manifest.json', () => {
  it('carries the extension version, and the build refuses another one', async () => {
    expect(committed()['version']).toBe(extensionVersion());
    await expect(buildManifest({test: false, version: '9.9.9'})).rejects.toThrow(/version/);
  });

  it('host_permissions and content-script matches are exactly the generated sets', async () => {
    const m = await buildManifest({test: false, version: extensionVersion()});
    expect(m).toEqual(committed());
    expect(m['host_permissions']).toEqual(generatedHostPermissions({test: false}));
    expect(m['content_scripts']).toEqual([
      {
        matches: officialMatchPatterns(),
        js: ['content.js'],
        run_at: 'document_start',
        all_frames: true,
      },
    ]);
  });

  it('test builds add only the loopback hosts', async () => {
    const prod = await buildManifest({test: false, version: extensionVersion()});
    const test = await buildManifest({test: true, version: extensionVersion()});
    expect(test['host_permissions']).toEqual(generatedHostPermissions({test: true}));
    expect({...test, host_permissions: null}).toEqual({...prod, host_permissions: null});
  });

  it('desktop Firefox only: event page, gecko id, data collection none, no gecko_android', () => {
    const m = committed();
    expect(m['background']).toEqual({scripts: ['background.js']});
    expect(m['browser_specific_settings']).toEqual({
      gecko: {
        id: 'intactwarden@phawrylak',
        strict_min_version: '153.0',
        data_collection_permissions: {required: ['none']},
      },
    });
  });
});

describe('esbuildTargets', () => {
  it('follows the manifest’s minimum Firefox version', () => {
    expect(esbuildTargets(committed())).toEqual(['firefox153']);
    expect(() => esbuildTargets({})).toThrow();
  });
});
