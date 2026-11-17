/**
 * The six files a Bitwarden cloud deployment serves for one CACHE_TAG and one set of script
 * names, derived from the self-hosted release files with the recipe of @intactwarden/core. The
 * builder derives with its own placeholder values and keeps only templates; the tests, the corpus
 * comparison with the live cloud and the e2e cloud emulator need the bytes a real deployment
 * serves.
 */

import {
  deriveCloudConnectorJs,
  deriveCloudHtml,
  deriveCloudMain,
} from '@intactwarden/core/derive/bitwarden-cloud-v1.ts';

/** What one cloud deployment chose: its CACHE_TAG and the script names its HTML references. */
export interface CloudDeployment {
  readonly cacheTag: string;
  /** "app/main.<20 hex>.js". */
  readonly mainName: string;
  /** "connectors/duo-redirect.<20 hex>.js". */
  readonly duoJsName: string;
  /** "connectors/webauthn-fallback.<20 hex>.js". */
  readonly webauthnFbJsName: string;
}

export interface DerivedCloudFile {
  /** Manifest key in the cloud core (with a `{SLOT}` placeholder for scripts). */
  readonly key: string;
  /** Path the deployment serves the file at. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

const SCRIPTS = [
  {name: 'mainName', prefix: 'app/main.', slot: 'MAIN', html: '/index.html'},
  {
    name: 'duoJsName',
    prefix: 'connectors/duo-redirect.',
    slot: 'DUO_JS',
    html: '/duo-redirect-connector.html',
  },
  {
    name: 'webauthnFbJsName',
    prefix: 'connectors/webauthn-fallback.',
    slot: 'WEBAUTHN_FB_JS',
    html: '/webauthn-fallback-connector.html',
  },
] as const;

const HASHED = /^[0-9a-f]{20}\.js$/;

/**
 * Derives the six files. `files`: the release's files by manifest path ("/index.html");
 * `configs`: the raw base.json and `<envName>`.json at the tag commit.
 */
export function deriveCloudFiles(
  files: ReadonlyMap<string, Uint8Array>,
  configs: {
    readonly base: Uint8Array;
    readonly env: Uint8Array;
    readonly envName: 'cloud' | 'euprd';
  },
  to: CloudDeployment,
): DerivedCloudFile[] {
  const parse = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
  const cfg = {base: parse(configs.base), env: parse(configs.env), envName: configs.envName};
  const out: DerivedCloudFile[] = [];
  for (const s of SCRIPTS) {
    const name = to[s.name];
    if (!name.startsWith(s.prefix) || !HASHED.test(name.slice(s.prefix.length))) {
      throw new Error(`${s.name} must be ${s.prefix}<20 hex>.js`);
    }
    const self = [...files.keys()].filter(
      p => p.startsWith(`/${s.prefix}`) && HASHED.test(p.slice(s.prefix.length + 1)),
    );
    if (self.length !== 1) throw new Error(`expected one /${s.prefix}<20 hex>.js`);
    const mapName = `${name.slice(name.lastIndexOf('/') + 1)}.map`;
    const js = files.get(self[0]!)!;
    out.push({
      key: `/${s.prefix}{${s.slot}}.js`,
      path: `/${name}`,
      bytes:
        s.slot === 'MAIN'
          ? deriveCloudMain(js, cfg, to.cacheTag, mapName).bytes
          : deriveCloudConnectorJs(js, to.cacheTag, mapName, s.slot).bytes,
    });
    out.push({
      key: s.html,
      path: s.html,
      bytes: deriveCloudHtml(files.get(s.html)!, [
        {from: self[0]!.slice(1), to: name, slot: s.slot},
      ]).bytes,
    });
  }
  return out;
}
