/**
 * Core manifest of the Bitwarden cloud web vaults (assurance "release-derived"):
 * vault.bitwarden.com (`cloud-us`, ENV=cloud) and vault.bitwarden.eu (`cloud-eu`, ENV=euprd).
 *
 * The cloud builds are not published. They are derived from the self-hosted
 * COMMERCIAL release zip with the closed derivation
 * (@intactwarden/core/derive/bitwarden-cloud-v1.ts) and the config files at the tag
 * commit. Files the derivation does not touch keep their exact entries; a release where another
 * script embeds CACHE_TAG is refused, as that script would differ on the cloud. The six
 * derived files become masked-hash templates whose only variable bytes are
 * the slots CACHE_TAG (a per-build random nonce) and MAIN / DUO_JS /
 * WEBAUTHN_FB_JS (content hashes in file names):
 *
 * | template key                                   | slots                   |
 * |------------------------------------------------|-------------------------|
 * | /index.html                                    | MAIN                    |
 * | /app/main.{MAIN}.js                            | CACHE_TAG ×2, MAIN      |
 * | /duo-redirect-connector.html                   | DUO_JS                  |
 * | /connectors/duo-redirect.{DUO_JS}.js           | CACHE_TAG, DUO_JS       |
 * | /webauthn-fallback-connector.html              | WEBAUTHN_FB_JS          |
 * | /connectors/webauthn-fallback.{WEBAUTHN_FB_JS}.js | CACHE_TAG, WEBAUTHN_FB_JS |
 *
 * Keys: templated scripts are keyed by a path pattern with a `{SLOT}`
 * placeholder. The extension binds that slot from the
 * request path, and the same value must appear in the HTML that loads the
 * script and in the script's own sourceMappingURL. Keying by the observed
 * concrete name instead would make the core depend on one deployment; with
 * patterns the core is a function of the release and the configs alone, so a
 * redeploy that only changes CACHE_TAG (and therefore the content hashes)
 * verifies without a new core.
 *
 * The derivation returns where it wrote each slot value. Before a template is
 * emitted, the builder checks (fail closed):
 * - the context rule (contexts.ts): in a script, every slot sits at a
 *   `?cache=<CACHE_TAG>"` site or in the final `//` comment line; in HTML,
 *   inside a double-quoted src/href value;
 * - buildTemplate's byte checks (charset, neighbours, allowlist,
 *   round trip).
 *
 * The source maps of the three derived scripts differ on the cloud and
 * cannot be derived; they are left out (source maps are never executed).
 */

import {
  deriveCloudConnectorJs,
  deriveCloudHtml,
  deriveCloudMain,
  type BitwardenConfigs,
} from '@intactwarden/core/derive/bitwarden-cloud-v1.ts';
import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import type {FileEntry} from '@intactwarden/core/schema/manifest.ts';
import {
  buildTemplate,
  type SlotOccurrence,
  type Template,
} from '@intactwarden/core/template/build.ts';
import {checkHtmlSlots, checkJsSlots} from '../contexts.ts';
import {compareStrings, RefusalError} from '../files.ts';
import {
  artifactOf,
  exactEntry,
  finishCore,
  sourceOf,
  type CoreBuild,
  type LoadedRelease,
  type ReleaseFileInfo,
} from '../release.ts';
import {bytesOf, embedsCacheTag} from '../retain.ts';

export type CloudVariant = 'cloud-us' | 'cloud-eu';
export type BitwardenCloudEnv = 'cloud' | 'euprd';

/** The ENV each cloud variant is built with (apps/web/config/<env>.json). */
export const CLOUD_ENV: Readonly<Record<CloudVariant, BitwardenCloudEnv>> = {
  'cloud-us': 'cloud',
  'cloud-eu': 'euprd',
};

const configPath = (name: string): string => `apps/web/config/${name}.json`;

/**
 * The config files a cloud deep verify fetches at the tag commit: the same three for both
 * regions, so GitHub cannot tell a vault.bitwarden.com user from a vault.bitwarden.eu user.
 */
export const CLOUD_CONFIG_PATHS: readonly string[] = Object.freeze(
  ['base', 'cloud', 'euprd'].map(configPath),
);

export function isCloudVariant(variant: string): variant is CloudVariant {
  return Object.hasOwn(CLOUD_ENV, variant);
}

type SlotName = 'CACHE_TAG' | 'MAIN' | 'DUO_JS' | 'WEBAUTHN_FB_JS';
type SlotValues = Readonly<Record<SlotName, string>>;
type HashSlot = Exclude<SlotName, 'CACHE_TAG'>;

/** The three content-hashed scripts the derivation changes, and the document that loads each. */
interface ScriptSpec {
  readonly slot: HashSlot;
  /** Directory below the root, with trailing '/'. */
  readonly dir: string;
  readonly stem: string;
  readonly html: string;
}

const SCRIPTS: readonly ScriptSpec[] = [
  {slot: 'MAIN', dir: 'app/', stem: 'main', html: '/index.html'},
  {slot: 'DUO_JS', dir: 'connectors/', stem: 'duo-redirect', html: '/duo-redirect-connector.html'},
  {
    slot: 'WEBAUTHN_FB_JS',
    dir: 'connectors/',
    stem: 'webauthn-fallback',
    html: '/webauthn-fallback-connector.html',
  },
];

const HASH = /^[0-9a-f]{20}$/;

/** The slot values the files are derived with; the templates mask them. */
const PLACEHOLDERS: SlotValues = {
  CACHE_TAG: 'intact0a',
  MAIN: '0123456789abcdef0123',
  DUO_JS: '1123456789abcdef0123',
  WEBAUTHN_FB_JS: '2123456789abcdef0123',
};

const strictUtf8 = new TextDecoder('utf-8', {fatal: true});

function scriptName(spec: ScriptSpec, hash: string): string {
  return `${spec.dir}${spec.stem}.${hash}.js`;
}

function templateKey(spec: ScriptSpec): string {
  return `/${spec.dir}${spec.stem}.{${spec.slot}}.js`;
}

/** A config file of the variant, parsed. */
function config(configs: Readonly<Record<string, Uint8Array>>, path: string): unknown {
  const bytes = configs[path];
  if (bytes === undefined) throw new RefusalError(`needs the config file ${path}`, 'unsupported');
  try {
    return JSON.parse(strictUtf8.decode(bytes));
  } catch {
    throw new RefusalError(`${path}: not valid UTF-8 JSON`, 'derivation-failed');
  }
}

/** Self-hosted inputs of the derivation, located in the release. */
interface Inputs {
  readonly html: ReadonlyMap<string, ReleaseFileInfo>;
  /** Per script spec: the self-hosted script and its 20-hex content hash. */
  readonly scripts: ReadonlyMap<HashSlot, {file: ReleaseFileInfo; hash: string}>;
}

function locateInputs(files: ReadonlyMap<string, ReleaseFileInfo>): Inputs {
  const html = new Map<string, ReleaseFileInfo>();
  const scripts = new Map<HashSlot, {file: ReleaseFileInfo; hash: string}>();
  for (const spec of SCRIPTS) {
    const doc = files.get(spec.html);
    if (doc === undefined)
      throw new RefusalError(`release has no ${spec.html}`, 'derivation-failed');
    html.set(spec.html, doc);
    const prefix = `/${spec.dir}${spec.stem}.`;
    const found = [...files.values()].filter(f => {
      const hash =
        f.path.startsWith(prefix) && f.path.endsWith('.js') ? f.path.slice(prefix.length, -3) : '';
      return HASH.test(hash);
    });
    if (found.length !== 1) {
      throw new RefusalError(
        `expected exactly one ${prefix}<20 hex>.js, found ${found.length}`,
        'derivation-failed',
      );
    }
    const file = found[0]!;
    scripts.set(spec.slot, {file, hash: file.path.slice(prefix.length, -3)});
  }
  const derived = new Set([...scripts.values()].map(s => s.file.path));
  for (const f of files.values()) {
    if (f.bytes !== undefined && !derived.has(f.path) && embedsCacheTag(f.path, f.bytes))
      throw new RefusalError(`${f.path} embeds CACHE_TAG but is not derived`, 'derivation-failed');
  }
  return {html, scripts};
}

interface Derived {
  readonly key: string;
  readonly cls: 'document' | 'script';
  readonly lang: 'js' | 'html';
  readonly selfhostedPath: string;
  readonly bytes: Uint8Array;
  readonly occurrences: readonly SlotOccurrence[];
}

/** Derives the six files for one set of slot values, with the slots the derivation wrote. */
function deriveAll(inputs: Inputs, cfg: BitwardenConfigs, values: SlotValues): Derived[] {
  const out: Derived[] = [];
  for (const spec of SCRIPTS) {
    const self = inputs.scripts.get(spec.slot)!;
    const hash = values[spec.slot];
    const mapName = `${spec.stem}.${hash}.js.map`;
    const selfhosted = bytesOf(self.file, self.file.path);
    const js =
      spec.slot === 'MAIN'
        ? deriveCloudMain(selfhosted, cfg, values.CACHE_TAG, mapName)
        : deriveCloudConnectorJs(selfhosted, values.CACHE_TAG, mapName, spec.slot);
    out.push({
      key: templateKey(spec),
      cls: 'script',
      lang: 'js',
      selfhostedPath: self.file.path,
      bytes: js.bytes,
      occurrences: js.slots,
    });
    const doc = inputs.html.get(spec.html)!;
    const html = deriveCloudHtml(bytesOf(doc, doc.path), [
      {from: scriptName(spec, self.hash), to: scriptName(spec, hash), slot: spec.slot},
    ]);
    out.push({
      key: spec.html,
      cls: 'document',
      lang: 'html',
      selfhostedPath: doc.path,
      bytes: html.bytes,
      occurrences: html.slots,
    });
  }
  return out.sort((a, b) => compareStrings(a.key, b.key));
}

/**
 * Template for one derived file: context check, then buildTemplate (byte
 * checks and the round trip).
 */
async function templateFor(d: Derived): Promise<Template> {
  if (d.lang === 'js') checkJsSlots(d.bytes, d.occurrences);
  else checkHtmlSlots(d.bytes, d.occurrences);
  return buildTemplate(d.bytes, d.occurrences);
}

/**
 * The cloud core of `variant`, derived from a loaded COMMERCIAL release and the config files at
 * the tag commit (`base.json` and the variant's `<env>.json` of CLOUD_CONFIG_PATHS). Throws on
 * anything the derivation cannot compute; the caller then has no core for the variant (in the
 * extension: BUILD_UNVERIFIED `not-derivable`, never red).
 */
export async function cloudCore(
  loaded: LoadedRelease,
  variant: CloudVariant,
  configs: Readonly<Record<string, Uint8Array>>,
): Promise<CoreBuild> {
  const env = CLOUD_ENV[variant];
  const paths = [configPath('base'), configPath(env)] as const;
  const cfg: BitwardenConfigs = {
    base: config(configs, paths[0]),
    env: config(configs, paths[1]),
    envName: env,
  };
  const inputs = locateInputs(loaded.files);
  const derived = deriveAll(inputs, cfg, PLACEHOLDERS);

  const files: Record<string, FileEntry> = {};
  const replaced = new Set(derived.map(d => d.selfhostedPath));
  for (const path of [...loaded.files.keys()].sort(compareStrings)) {
    const sourceMapOfDerived = path.endsWith('.map') && replaced.has(path.slice(0, -4));
    if (replaced.has(path) || sourceMapOfDerived) continue;
    files[path] = exactEntry(loaded.files.get(path)!);
  }
  for (const d of derived) {
    files[d.key] = {class: d.cls, template: await templateFor(d)};
  }

  const {plan} = loaded;
  const notFound = files['/404.html']?.class === 'document' ? '/404.html' : undefined;
  return finishCore({
    schema: 'intactwarden.manifest/1',
    build_id: `${plan.app}@${plan.version}+${variant}`,
    app: plan.app,
    variant,
    version: {label: plan.version},
    source: sourceOf(loaded),
    artifact: artifactOf(loaded),
    derivation: {
      env,
      inputs: await Promise.all(
        paths.map(async path => ({
          path,
          commit: loaded.commit,
          sha256: await sha256Hex(configs[path]!),
        })),
      ),
    },
    routing: {
      hosting: 'static-exact',
      base_path: '/',
      index: '/index.html',
      ...(notFound === undefined ? {} : {not_found: notFound}),
    },
    files,
  });
}
