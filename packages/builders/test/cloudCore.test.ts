import {describe, expect, it} from 'vitest';
import {canonicalBytes} from '@intactwarden/core/jcs/canonicalize.ts';
import {
  coreProblem,
  isTemplateEntry,
  type TemplateEntry,
} from '@intactwarden/core/schema/manifest.ts';
import type {Template} from '@intactwarden/core/template/build.ts';
import {matchTemplate} from '@intactwarden/core/template/match.ts';
import {BuildError, type BuildRequest} from '../src/api.ts';
import {createCoreBuilder} from '../src/coreBuilder.ts';
import {
  BASE,
  BASE_CONFIG,
  bitwardenRequest,
  buildReleaseZip,
  CLOUD,
  CLOUD_CONFIG,
  COMMIT,
  CONFIGS,
  configBytes,
  connectorHtml,
  connectorJs,
  EUPRD,
  indexHtml,
  mainJs,
  releaseFiles,
  SELF,
  sha256,
} from './helpers/bitwardenFixture.ts';
import {deriveCloudFiles, type CloudDeployment} from './helpers/cloudFiles.ts';

const builder = createCoreBuilder();
const ZIP = buildReleaseZip();
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const US: CloudDeployment = {
  cacheTag: 'w4e0z',
  mainName: 'app/main.1acba9cab2a37e1e33ca.js',
  duoJsName: 'connectors/duo-redirect.25df43e178f0cf2fa02e.js',
  webauthnFbJsName: 'connectors/webauthn-fallback.710aaf235219942d0d5e.js',
};

const OTHER: CloudDeployment = {
  cacheTag: 'q1',
  mainName: 'app/main.9a8eda2d501e783f60d9.js',
  duoJsName: 'connectors/duo-redirect.bfc70c3f6e9687130f2c.js',
  webauthnFbJsName: 'connectors/webauthn-fallback.5c4ac8bdb384501a4194.js',
};

/** The release files by manifest path, for deriveCloudFiles. */
const FILES = new Map(
  [...releaseFiles()].map(([name, data]) => [
    '/' + name,
    typeof data === 'string' ? enc(data) : data,
  ]),
);
const derive = (to: CloudDeployment, env = CONFIGS[CLOUD]!) =>
  deriveCloudFiles(FILES, {base: CONFIGS[BASE]!, env, envName: 'cloud'}, to);

const cloudRequest = (over: Partial<BuildRequest> = {}, zip = ZIP): BuildRequest =>
  bitwardenRequest(zip, 'cloud-us', over);

async function refused(request: BuildRequest, message: RegExp): Promise<void> {
  const promise = builder.build(request);
  await expect(promise).rejects.toBeInstanceOf(BuildError);
  await expect(promise).rejects.toThrow(message);
}

const TEMPLATE_KEYS = [
  '/app/main.{MAIN}.js',
  '/connectors/duo-redirect.{DUO_JS}.js',
  '/connectors/webauthn-fallback.{WEBAUTHN_FB_JS}.js',
  '/duo-redirect-connector.html',
  '/index.html',
  '/webauthn-fallback-connector.html',
];

function templateOf(entry: unknown): Template {
  // A manifest template is a Template (read-only): matchTemplate takes it as is.
  return (entry as TemplateEntry).template;
}

describe('cloud core (bitwarden-cloud-v1)', async () => {
  const us = await builder.build(cloudRequest());
  const release = await builder.build(bitwardenRequest(ZIP));
  const live = derive(US);

  it('derives the six files a cloud deployment serves', () => {
    expect(live.map(d => d.path).sort()).toEqual(
      [
        '/' + US.mainName,
        '/' + US.duoJsName,
        '/' + US.webauthnFbJsName,
        '/index.html',
        '/duo-redirect-connector.html',
        '/webauthn-fallback-connector.html',
      ].sort(),
    );
    const byPath = new Map(live.map(d => [d.path, dec(d.bytes)]));
    const main = byPath.get('/' + US.mainName)!;
    expect(main).toContain('messages.json?cache=w4e0z"');
    expect(main).toContain('scripts/dropin.js?cache=w4e0z"');
    expect(main).toContain('return"selfhosted"==="cloud".toString()');
    expect(main).toContain('n.Stripe("pk_live_KEY")');
    expect(main.endsWith('\n//# sourceMappingURL=main.1acba9cab2a37e1e33ca.js.map')).toBe(true);
    expect(byPath.get('/index.html')).toBe(indexHtml('1acba9cab2a37e1e33ca'));
    expect(byPath.get('/duo-redirect-connector.html')).toBe(
      connectorHtml('duo-redirect', '25df43e178f0cf2fa02e'),
    );
    expect(byPath.get('/' + US.duoJsName)).toBe(
      connectorJs('duo-redirect', '25df43e178f0cf2fa02e', 'w4e0z'),
    );
  });

  it('emits templates keyed by path pattern', () => {
    const {core} = us;
    const keys = Object.keys(core.files).filter(k => isTemplateEntry(core.files[k]!));
    expect(keys.sort()).toEqual([...TEMPLATE_KEYS].sort());
    const main = core.files['/app/main.{MAIN}.js'] as TemplateEntry;
    expect(main.class).toBe('script');
    expect(main.template.parts.filter(p => 'slot' in p)).toEqual([
      {slot: 'CACHE_TAG'},
      {slot: 'CACHE_TAG'},
      {slot: 'MAIN'},
    ]);
    const duo = core.files['/connectors/duo-redirect.{DUO_JS}.js'] as TemplateEntry;
    expect(duo.template.parts.filter(p => 'slot' in p)).toEqual([
      {slot: 'CACHE_TAG'},
      {slot: 'DUO_JS'},
    ]);
    const index = core.files['/index.html'] as TemplateEntry;
    expect(index.class).toBe('document');
    expect(index.template.parts.filter(p => 'slot' in p)).toEqual([{slot: 'MAIN'}]);
  });

  it('keeps every other file exact and drops the derived scripts and their maps', () => {
    const {core} = us;
    const dropped = [
      `/app/main.${SELF.main}.js`,
      `/app/main.${SELF.main}.js.map`,
      `/connectors/duo-redirect.${SELF.duo}.js`,
      `/connectors/duo-redirect.${SELF.duo}.js.map`,
      `/connectors/webauthn-fallback.${SELF.webauthn}.js`,
      `/connectors/webauthn-fallback.${SELF.webauthn}.js.map`,
    ];
    const replaced = [
      '/index.html',
      '/duo-redirect-connector.html',
      '/webauthn-fallback-connector.html',
    ];
    for (const [path, entry] of Object.entries(release.core.files)) {
      if (dropped.includes(path)) expect(core.files[path], path).toBeUndefined();
      else if (replaced.includes(path)) expect(isTemplateEntry(core.files[path]!), path).toBe(true);
      else if (path === '/app-id.json') {
        // Cloud serves the release file; only self-hosted servers override it.
        expect(core.files[path]).toMatchObject({class: 'data', sha256: expect.any(String)});
      } else expect(core.files[path], path).toEqual(entry);
    }
  });

  it('records the derivation, routing and envelope', () => {
    expect(us.core).toMatchObject({
      build_id: 'bitwarden-web@2026.10.1+cloud-us',
      variant: 'cloud-us',
      source: {
        repo: 'https://github.com/bitwarden/clients',
        repo_id: 53538899,
        tag: 'web-v2026.10.1',
        commit: COMMIT,
      },
      artifact: release.core.artifact,
      derivation: {
        env: 'cloud',
        inputs: [
          {
            path: 'apps/web/config/base.json',
            commit: COMMIT,
            sha256: sha256(configBytes(BASE_CONFIG)),
          },
          {
            path: 'apps/web/config/cloud.json',
            commit: COMMIT,
            sha256: sha256(configBytes(CLOUD_CONFIG)),
          },
        ],
      },
      routing: {
        hosting: 'static-exact',
        base_path: '/',
        index: '/index.html',
        not_found: '/404.html',
      },
    });
    expect(coreProblem(us.core)).toBeNull();
    expect(us.bytes).toEqual(canonicalBytes(us.core));
    expect(us.sha256).toBe(sha256(us.bytes));
  });

  it('matches every deployment that differs only in slot values', async () => {
    for (const to of [US, OTHER]) {
      for (const d of derive(to)) {
        const t = templateOf(us.core.files[d.key]);
        const r = await matchTemplate(t, d.bytes);
        expect(r.ok, d.key).toBe(true);
        if (r.ok && d.key !== '/index.html' && !d.key.endsWith('connector.html')) {
          expect(r.slots['CACHE_TAG']).toBe(to.cacheTag);
        }
      }
    }
  });

  it('extracts the slot values from live bytes and rejects any code change', async () => {
    const main = live.find(d => d.key === '/app/main.{MAIN}.js')!;
    const t = templateOf(us.core.files[main.key]);
    expect(await matchTemplate(t, main.bytes, {MAIN: '1acba9cab2a37e1e33ca'})).toMatchObject({
      ok: true,
      slots: {CACHE_TAG: 'w4e0z', MAIN: '1acba9cab2a37e1e33ca'},
    });
    // CACHE_TAG-only redeploy (a hotfix): still matches.
    const hotfix = enc(dec(main.bytes).replaceAll('?cache=w4e0z"', '?cache=zz9top"'));
    expect((await matchTemplate(t, hotfix)).ok).toBe(true);
    // MAIN bound from the request path must agree with the file.
    expect((await matchTemplate(t, main.bytes, {MAIN: 'ffffffffffffffffffff'})).ok).toBe(false);
    // Inconsistent CACHE_TAG within the document.
    const split = enc(dec(main.bytes).replace('?cache=w4e0z"', '?cache=other"'));
    expect((await matchTemplate(t, split)).ok).toBe(false);
    // One byte of code changed.
    const text = dec(main.bytes);
    const code = enc(text.replace('pk_live_KEY', 'pk_live_KEX'));
    expect((await matchTemplate(t, code)).ok).toBe(false);
    const flip = main.bytes.slice();
    flip[10] = flip[10]! ^ 0x01;
    expect((await matchTemplate(t, flip)).ok).toBe(false);
  });

  it('builds cloud-eu from euprd.json', async () => {
    const eu = await builder.build(bitwardenRequest(ZIP, 'cloud-eu'));
    expect(eu.core.build_id).toBe('bitwarden-web@2026.10.1+cloud-eu');
    expect(eu.core.derivation?.env).toBe('euprd');
    expect(eu.core.derivation?.inputs[1]?.path).toBe(EUPRD);
    expect(eu.sha256).not.toBe(us.sha256);
    const main = deriveCloudFiles(
      FILES,
      {base: CONFIGS[BASE]!, env: CONFIGS[EUPRD]!, envName: 'euprd'},
      US,
    ).find(d => d.key === '/app/main.{MAIN}.js')!;
    expect(dec(main.bytes)).toContain('"selfhosted"==="euprd".toString()');
    const t = templateOf(eu.core.files['/app/main.{MAIN}.js']);
    expect((await matchTemplate(t, main.bytes)).ok).toBe(true);
  });

  it('refuses config files the recipe cannot use', async () => {
    await refused(
      cloudRequest({configs: {...CONFIGS, [CLOUD]: enc('{"urls": ')}}),
      /not valid UTF-8 JSON/,
    );
    const regions = configBytes({...CLOUD_CONFIG, additionalRegions: [{key: 'x'}]});
    await refused(cloudRequest({configs: {...CONFIGS, [CLOUD]: regions}}), /DeriveError/);
  });

  it('refuses releases the recipe cannot derive', async () => {
    const twoMains = buildReleaseZip({override: {'app/main.0f0f0f0f0f0f0f0f0f0f.js': mainJs()}});
    await refused(cloudRequest({}, twoMains), /exactly one \/app\/main\.<20 hex>\.js, found 2/);
    const noDuo = buildReleaseZip({override: {'duo-redirect-connector.html': null}});
    await refused(cloudRequest({}, noDuo), /release has no \/duo-redirect-connector\.html/);
    // A third ?cache= site that the recipe does not know about.
    const extra = buildReleaseZip({
      override: {
        [`app/main.${SELF.main}.js`]: mainJs().replace(
          'globalThis.intactwarden=',
          'x="a?cache=1";globalThis.intactwarden=',
        ),
      },
    });
    await refused(cloudRequest({}, extra), /DeriveError/);
    // Another script that embeds CACHE_TAG differs on the cloud: not derivable, never a mismatch.
    const sso = buildReleaseZip({
      override: {'connectors/sso.b9116a340807ff18cc2d.js': 'fetch("messages.json?cache=x");'},
    });
    await expect(builder.build(cloudRequest({}, sso))).rejects.toMatchObject({
      code: 'derivation-failed',
      message: expect.stringMatching(/sso\.b9116a340807ff18cc2d\.js embeds CACHE_TAG but is not/),
    });
  });

  it('refuses an HTML slot outside a src or href value', async () => {
    // The only main script src inside an HTML comment: derivable, but not an attribute.
    const commented = indexHtml().replace(
      `<script defer="defer" src="app/main.${SELF.main}.js"></script>`,
      `<!-- <script defer="defer" src="app/main.${SELF.main}.js"></script> -->`,
    );
    const zip = buildReleaseZip({override: {'index.html': commented}});
    await refused(cloudRequest({}, zip), /slot MAIN at byte \d+: not inside an attribute value/);
  });
});
