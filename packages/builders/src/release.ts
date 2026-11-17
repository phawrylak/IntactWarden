/**
 * The release loader and the release-exact core of both apps: the Bitwarden
 * self-hosted COMMERCIAL zip and the Vaultwarden tarball of
 * dani-garcia/bw_web_builds. The cloud cores are derived from a loaded Bitwarden
 * release (cloudCore.ts).
 *
 * Steps, all fail-closed (RefusalError, or the archive readers' errors):
 * 1. size and sha256 of the asset equal GitHub's listed values, before anything parses it;
 * 2. the archive is read with the strict readers (zip; gzip and tar), every file below the
 *    profile's `archive_root`, every member name mapped to one manifest key;
 * 3. the version files name the plan's version (`/version.json`; Vaultwarden also
 *    `/vw-version.json`);
 * 4. the asset ships no file at a path the server generates itself (profile
 *    `resources.server_styles`, Vaultwarden's `/css/vaultwarden.css`).
 *
 * The two apps differ only in the facts of `APPS`. A self-hosted server serves the archive
 * unchanged except `/app-id.json`, which it answers from its own configuration (a dynamic data
 * entry). The core is a pure function of the asset bytes, the release coordinates and the bundled
 * profile: no timestamps, no archive metadata, no dependence on entry order.
 */

import {iterateTarGzFiles} from '@intactwarden/core/archive/tar.ts';
import {iterateZipFiles} from '@intactwarden/core/archive/zip.ts';
import {sha256Hex} from '@intactwarden/core/hash/sha256.ts';
import {canonicalBytes} from '@intactwarden/core/jcs/canonicalize.ts';
import {
  coreProblem,
  type CoreManifest,
  type ExactEntry,
  type FileEntry,
  type ReleaseAssetArtifact,
  type Source,
} from '@intactwarden/core/schema/manifest.ts';
import type {Hosting} from '@intactwarden/core/routing/mapUrl.ts';
import type {AppProfile} from '@intactwarden/core/schema/profile.ts';
import {bitwardenWeb, vaultwardenWeb} from '@intactwarden/profiles';
import type {AssetPlan, BuilderApp} from './api.ts';
import {classifyPath, compareStrings, manifestKey, RefusalError} from './files.ts';
import {bytesOf, isCheckedPath} from './retain.ts';

/** What sets the two apps apart. */
interface AppFacts {
  readonly profile: AppProfile;
  /** The strict archive reader of the asset's format. */
  readonly read: (
    asset: Uint8Array,
    opts: {readonly stripPrefix: string},
  ) => AsyncIterable<{readonly path: string; readonly bytes: Uint8Array}>;
  /** Files that must hold `{"version": "<the plan's version>"}`. */
  readonly versionFiles: readonly string[];
  readonly hosting: Hosting;
  /** Whether a 404 must carry the release's `/404.html` (never on Rocket). */
  readonly notFound: boolean;
}

export const APPS: Readonly<Record<BuilderApp, AppFacts>> = {
  'bitwarden-web': {
    profile: bitwardenWeb,
    read: iterateZipFiles,
    versionFiles: ['/version.json'],
    hosting: 'bitwarden-selfhost',
    notFound: true,
  },
  'vaultwarden-web': {
    profile: vaultwardenWeb,
    read: iterateTarGzFiles,
    versionFiles: ['/vw-version.json', '/version.json'],
    hosting: 'vaultwarden-rocket',
    notFound: false,
  },
};

/**
 * Paths a self-hosted server answers itself (Bitwarden util/Server/Startup.cs, Vaultwarden
 * src/api/web.rs).
 */
const DYNAMIC_PATHS: readonly string[] = ['/app-id.json'];

/**
 * What a core needs of one file of a release: its digest and size, and the bytes only of the
 * files the checks read (retain.ts).
 */
export interface ReleaseFileInfo {
  /** Manifest key ("/" + member name below the archive root, normalised). */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** Only for the files of retain.ts `isCheckedPath`. */
  readonly bytes?: Uint8Array;
}

/** A release asset that passed steps 1-4. */
export interface LoadedRelease {
  readonly plan: AssetPlan;
  readonly commit: string;
  readonly tagObject?: string;
  readonly sha256: string;
  readonly size: number;
  /** All regular files, keyed by manifest path. */
  readonly files: ReadonlyMap<string, ReleaseFileInfo>;
}

/** A canonical core manifest, its exact bytes and their digest. */
export interface CoreBuild {
  readonly core: CoreManifest;
  /** RFC 8785 bytes. */
  readonly bytes: Uint8Array;
  /** Lowercase hex SHA-256 of `bytes` (the core's content address). */
  readonly sha256: string;
}

/** An upstream x.y.z version (each part at most six digits, no leading zero). */
export const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;

const strictUtf8 = new TextDecoder('utf-8', {fatal: true});

/** A profile pattern ("web-v{version}") filled with a version. */
export function fill(pattern: string, version: string): string {
  return pattern.replace('{version}', version);
}

/** `{"version": "<x.y.z>"}` and nothing else. */
function readVersionFile(file: ReleaseFileInfo | undefined, path: string): string {
  if (file === undefined) throw new RefusalError(`release has no ${path}`, 'version-mismatch');
  let parsed: unknown;
  try {
    parsed = JSON.parse(strictUtf8.decode(bytesOf(file, path)));
  } catch {
    throw new RefusalError(`${path} is not valid UTF-8 JSON`, 'version-mismatch');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).join() !== 'version'
  ) {
    throw new RefusalError(`${path} must be {"version": "<x.y.z>"}`, 'version-mismatch');
  }
  const version: unknown = (parsed as {version: unknown}).version;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new RefusalError(`${path}: version must be "x.y.z"`, 'version-mismatch');
  }
  return version;
}

/** Steps 1-4 of the module comment; the caller checks the plan and the release coordinates. */
export async function loadRelease(
  plan: AssetPlan,
  release: {readonly commit: string; readonly tagObject?: string},
  asset: {readonly sha256: string; readonly size: number; readonly bytes: Uint8Array},
): Promise<LoadedRelease> {
  const facts = APPS[plan.app];
  // Cheap, and before 50 MB are hashed.
  if (asset.bytes.length !== asset.size) {
    throw new RefusalError(
      `asset has ${asset.bytes.length} bytes, listed ${asset.size}`,
      'size-mismatch',
    );
  }
  const actual = await sha256Hex(asset.bytes);
  if (actual !== asset.sha256) {
    throw new RefusalError(
      `asset digest mismatch: sha256 ${actual}, listed ${asset.sha256}`,
      'digest-mismatch',
    );
  }

  // The streaming readers may yield files before a later error: nothing here outlives a throw.
  const files = new Map<string, ReleaseFileInfo>();
  for await (const {path, bytes} of facts.read(asset.bytes, {
    stripPrefix: facts.profile.upstream.archive_root,
  })) {
    const key = manifestKey(path);
    if (files.has(key))
      throw new RefusalError(`two archive members map to ${key}`, 'archive-invalid');
    const info = {path: key, size: bytes.length, sha256: await sha256Hex(bytes)};
    files.set(key, isCheckedPath(key) ? {...info, bytes} : info);
  }
  for (const path of facts.versionFiles) {
    const version = readVersionFile(files.get(path), path);
    if (version !== plan.version) {
      throw new RefusalError(
        `${path} says ${version}, tag ${plan.tag} says ${plan.version}`,
        'version-mismatch',
      );
    }
  }
  for (const style of facts.profile.resources.server_styles ?? []) {
    if (files.has(style.path)) {
      throw new RefusalError(
        `the build ships ${style.path}, which the server generates itself`,
        'forbidden-content',
      );
    }
  }
  return {
    plan,
    commit: release.commit,
    ...(release.tagObject === undefined ? {} : {tagObject: release.tagObject}),
    sha256: asset.sha256,
    size: asset.size,
    files,
  };
}

export function sourceOf(loaded: LoadedRelease): Source {
  return {
    repo: `https://github.com/${loaded.plan.repo}`,
    repo_id: loaded.plan.repoId,
    tag: loaded.plan.tag,
    commit: loaded.commit,
    ...(loaded.tagObject === undefined ? {} : {tag_object: loaded.tagObject}),
  };
}

export function artifactOf(loaded: LoadedRelease): ReleaseAssetArtifact {
  return {
    kind: 'github-release-asset',
    name: loaded.plan.assetName,
    sha256: loaded.sha256,
    size: loaded.size,
    root: APPS[loaded.plan.app].profile.upstream.archive_root,
  };
}

export function exactEntry(file: ReleaseFileInfo): ExactEntry {
  return {sha256: file.sha256, size: file.size, class: classifyPath(file.path)};
}

/** The release-exact core: every file as an exact entry, the server's own paths dynamic. */
export async function releaseCore(loaded: LoadedRelease): Promise<CoreBuild> {
  const {plan, files} = loaded;
  const facts = APPS[plan.app];
  const dynamic: FileEntry = {class: 'data', dynamic: true};
  const entries: Record<string, FileEntry> = {};
  for (const path of [...files.keys()].sort(compareStrings)) {
    entries[path] = DYNAMIC_PATHS.includes(path) ? dynamic : exactEntry(files.get(path)!);
  }
  for (const path of DYNAMIC_PATHS) entries[path] ??= dynamic;
  const notFound = facts.notFound && files.has('/404.html');
  return finishCore({
    schema: 'intactwarden.manifest/1',
    build_id: `${plan.app}@${plan.version}+${plan.variant}`,
    app: plan.app,
    variant: plan.variant,
    version: {label: plan.version},
    source: sourceOf(loaded),
    artifact: artifactOf(loaded),
    routing: {
      hosting: facts.hosting,
      base_path: '/',
      index: '/index.html',
      ...(notFound ? {not_found: '/404.html'} : {}),
    },
    files: entries,
  });
}

/** Checks the builders' postcondition (coreProblem), then canonicalises and hashes a core. */
export async function finishCore(core: CoreManifest): Promise<CoreBuild> {
  const problem = coreProblem(core);
  if (problem !== null) {
    throw new RefusalError(`generated core manifest is invalid: ${problem}`, 'invalid-core');
  }
  const bytes = canonicalBytes(core);
  return {core, bytes, sha256: await sha256Hex(bytes)};
}
