import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {OFFICIAL_ORIGINS} from '@intactwarden/profiles';
import {
  buildManifest,
  esbuildTargets,
  generatedHostPermissions,
  officialMatchPatterns,
  originMatchPattern,
  serializeManifest,
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

describe('serializeManifest', () => {
  // AMO rewrites manifest.json with Python's json.dumps(manifest, indent=2) when it signs a package.
  // Written in that encoding already, the file AMO serves is the release's, byte for byte.
  it("writes AMO's encoding: Python json.dumps(indent=2), ASCII only, no final newline", () => {
    const value: JsonObject = {
      author: 'Paweł Hawrylak',
      name: 'zażółć 😀',
      ctl: 'a\u007fb\tc\u0001"/\\',
      empty: [],
      none: {},
      nested: {a: [1, 'é', true, null]},
    };
    // python3 -c 'import json; print(json.dumps(json.dumps(VALUE, indent=2)))'
    const python =
      '{\n  "author": "Pawe\\u0142 Hawrylak",\n  "name": "za\\u017c\\u00f3\\u0142\\u0107 \\ud83d\\ude00",\n' +
      '  "ctl": "a\\u007fb\\tc\\u0001\\"/\\\\",\n  "empty": [],\n  "none": {},\n  "nested": {\n    "a": [\n' +
      '      1,\n      "\\u00e9",\n      true,\n      null\n    ]\n  }\n}';
    expect(serializeManifest(value)).toBe(python);
  });

  it('keeps the committed manifest as it is, only encoded', () => {
    const text = serializeManifest(committed());
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    expect(text.endsWith('}')).toBe(true);
    expect(text).toContain('"author": "Pawe\\u0142 Hawrylak"');
    expect(JSON.parse(text)).toEqual(committed());
  });
});

describe('esbuildTargets', () => {
  it('follows the manifest’s minimum Firefox version', () => {
    expect(esbuildTargets(committed())).toEqual(['firefox153']);
    expect(() => esbuildTargets({})).toThrow();
  });
});
