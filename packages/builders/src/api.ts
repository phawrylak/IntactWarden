/**
 * The one entry point into the builders (coreBuilder.ts), used by the extension's local deep
 * verify, the bundled cores of test builds and the recompute command line (tools/recompute.ts): one
 * call builds one variant from one release asset, so every caller builds the same bytes with the
 * same code and the same profile policy.
 *
 * Everything here is pure (no Node, no DOM, no extension APIs): the caller fetches the asset and
 * config bytes from GitHub and passes them in. The builder never fetches anything and never
 * trusts bytes from a vendor origin; its inputs are GitHub release assets checked against GitHub's
 * listed digest, and config files at the tag commit.
 */

import type {CoreManifest} from '@intactwarden/core/schema/manifest.ts';
import type {Assurance} from '@intactwarden/core/verdict/states.ts';

/** The apps this package builds cores for (bundled profiles `bitwarden-web`, `vaultwarden-web`). */
export type BuilderApp = 'bitwarden-web' | 'vaultwarden-web';

/** Variants of those apps (profile `variants` keys); each app has one release asset. */
export type BuilderVariant = 'selfhosted-commercial' | 'cloud-us' | 'cloud-eu' | 'release';

/**
 * What must be fetched from GitHub to build one variant of one version. All values come from
 * the bundled profile and the builder's own tables, never from the network.
 */
export interface AssetPlan {
  readonly app: BuilderApp;
  readonly variant: BuilderVariant;
  /** "x.y.z". */
  readonly version: string;
  /** "<owner>/<repo>" (profile `upstream.repo`). */
  readonly repo: string;
  /**
   * Numeric GitHub repository id (profile `upstream.repo_id`); use it in REST paths
   * (`/repositories/<id>/…`).
   */
  readonly repoId: number;
  /** The release tag (profile `upstream.tag_pattern` filled with `version`). */
  readonly tag: string;
  /** The app's release asset (profile `upstream.asset` filled with `version`). */
  readonly assetName: string;
  /**
   * Repository paths of config files to fetch at the tag commit. Both cloud variants plan the
   * same three files (`apps/web/config/base.json`, `cloud.json`, `euprd.json`), so the two
   * regions make the same requests; a release-exact variant plans none.
   */
  readonly configPaths: readonly string[];
}

export interface BuildRequest {
  readonly app: BuilderApp;
  readonly variant: BuilderVariant;
  /** "x.y.z"; must agree with the tag and with the files in the asset. */
  readonly version: string;
  readonly release: {
    /** The release tag; must equal the plan's tag. */
    readonly tag: string;
    /** Lowercase 40-hex commit the tag peels to. */
    readonly commit: string;
    /** Lowercase 40-hex object id of an annotated tag (Vaultwarden cores record it). */
    readonly tagObject?: string;
  };
  /**
   * The release asset. The builder hashes it again before it reads the archive, reads it with the
   * strict readers and keeps only the file bytes its checks read (retain.ts).
   */
  readonly asset: {
    readonly name: string;
    /**
     * GitHub's listed digest (lowercase hex), already compared with the downloaded bytes by the
     * caller and checked again here.
     */
    readonly sha256: string;
    readonly size: number;
    readonly bytes: Uint8Array;
  };
  /** Config file bytes at `release.commit`, keyed by repository path (the plan's `configPaths`). */
  readonly configs?: Readonly<Record<string, Uint8Array>>;
}

export interface BuiltCore {
  readonly app: BuilderApp;
  readonly variant: BuilderVariant;
  /** The core's `build_id`, e.g. "bitwarden-web@2026.10.1+cloud-us". */
  readonly buildId: string;
  readonly version: string;
  readonly assurance: Assurance;
  readonly core: CoreManifest;
  /** Exact RFC 8785 bytes of `core`. */
  readonly bytes: Uint8Array;
  /** Lowercase hex sha256 of `bytes`: the core's content address. */
  readonly sha256: string;
  /** Config files the core was derived from (cloud variants only), for local pins. */
  readonly configInputs?: readonly {
    readonly path: string;
    readonly commit: string;
    readonly sha256: string;
  }[];
}

/** Why a build was refused. Codes, never free text, reach the UI. */
export type BuildRefusal =
  | 'digest-mismatch'
  | 'size-mismatch'
  | 'tag-mismatch'
  | 'asset-name-mismatch'
  | 'archive-invalid'
  | 'version-mismatch'
  | 'forbidden-content'
  | 'derivation-failed'
  | 'invalid-core'
  | 'unsupported';

/** Thrown by `CoreBuilder.build`; `code` is stable, `message` is for logs only (no URLs). */
export class BuildError extends Error {
  override name = 'BuildError';
  readonly code: BuildRefusal;
  constructor(code: BuildRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CoreBuilder {
  /**
   * The fetch plan for one variant and version. Throws BuildError (`unsupported`) for a variant
   * that is not the app's or a version that is not "x.y.z".
   */
  plan(app: BuilderApp, variant: BuilderVariant, version: string): AssetPlan;
  /**
   * Builds the requested variant from the release asset. Verifies the asset size and digest
   * first, then reads the archive with the strict readers of @intactwarden/core. Rejects with
   * BuildError.
   */
  build(request: BuildRequest): Promise<BuiltCore>;
}
