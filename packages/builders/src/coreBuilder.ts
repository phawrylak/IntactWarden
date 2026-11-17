/**
 * The CoreBuilder of api.ts. `plan` comes from the bundled profiles and the cloud table of
 * cloudCore.ts, never from the network. `build` checks the request against its plan, loads the
 * asset (size and sha256 before anything parses the bytes), builds the one requested variant and
 * checks the core's identity.
 *
 * Every refusal is a BuildError whose code comes from the throw site (RefusalError.refusal), from
 * the error class of @intactwarden/core (archive readers: `archive-invalid`; derivation and
 * template checks: `derivation-failed`), or, for anything unexpected, from the phase that failed
 * (request `unsupported`, load `archive-invalid`, build `derivation-failed`).
 */

import {GzipError} from '@intactwarden/core/archive/gzip.ts';
import {TarError} from '@intactwarden/core/archive/tar.ts';
import {ZipError} from '@intactwarden/core/archive/zip.ts';
import {DeriveError} from '@intactwarden/core/derive/bitwarden-cloud-v1.ts';
import {TemplateError} from '@intactwarden/core/template/build.ts';
import {
  BuildError,
  type AssetPlan,
  type BuilderApp,
  type BuilderVariant,
  type BuildRefusal,
  type BuildRequest,
  type BuiltCore,
  type CoreBuilder,
} from './api.ts';
import {CLOUD_CONFIG_PATHS, cloudCore, isCloudVariant} from './bitwarden/cloudCore.ts';
import {RefusalError} from './files.ts';
import {APPS, fill, loadRelease, releaseCore, VERSION, type CoreBuild} from './release.ts';

/** Every variant this package builds, and its app. */
const APP_OF: Readonly<Record<BuilderVariant, BuilderApp>> = {
  'selfhosted-commercial': 'bitwarden-web',
  'cloud-us': 'bitwarden-web',
  'cloud-eu': 'bitwarden-web',
  release: 'vaultwarden-web',
};

const OBJECT_ID = /^[0-9a-f]{40}$/;

type Phase = 'request' | 'load' | 'build';

const PHASE_FALLBACK: Readonly<Record<Phase, BuildRefusal>> = {
  request: 'unsupported',
  load: 'archive-invalid',
  build: 'derivation-failed',
};

function refuse(code: BuildRefusal, message: string): never {
  throw new BuildError(code, message);
}

/** Maps anything a loader or builder throws to a BuildError (see the module comment). */
export function toBuildError(error: unknown, fallback: BuildRefusal): BuildError {
  if (error instanceof BuildError) return error;
  if (error instanceof RefusalError)
    return new BuildError(error.refusal ?? fallback, error.message);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (error instanceof ZipError || error instanceof TarError || error instanceof GzipError) {
    return new BuildError('archive-invalid', message);
  }
  if (error instanceof DeriveError || error instanceof TemplateError) {
    return new BuildError('derivation-failed', message);
  }
  return new BuildError(fallback, message);
}

/** The fetch plan of one variant and version (CoreBuilder.plan). */
function planOf(app: BuilderApp, variant: BuilderVariant, version: string): AssetPlan {
  if (!Object.hasOwn(APP_OF, variant) || APP_OF[variant] !== app) {
    refuse('unsupported', `no builder for ${String(app)} variant ${JSON.stringify(variant)}`);
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    refuse('unsupported', `version must be "x.y.z", got ${JSON.stringify(version)}`);
  }
  const {upstream} = APPS[app].profile;
  return Object.freeze({
    app,
    variant,
    version,
    repo: upstream.repo,
    repoId: upstream.repo_id,
    tag: fill(upstream.tag_pattern, version),
    assetName: fill(upstream.asset, version),
    configPaths: isCloudVariant(variant) ? CLOUD_CONFIG_PATHS : Object.freeze([]),
  });
}

/** Builds the one variant of a request (CoreBuilder.build, before error mapping). */
async function buildChecked(
  request: BuildRequest,
  setPhase: (phase: Phase) => void,
): Promise<BuiltCore> {
  const plan = planOf(request.app, request.variant, request.version);
  const {release, asset} = request;
  if (release.tag !== plan.tag) {
    refuse('tag-mismatch', `release tag ${JSON.stringify(release.tag)}, plan ${plan.tag}`);
  }
  if (asset.name !== plan.assetName) {
    refuse('asset-name-mismatch', `${JSON.stringify(asset.name)} is not ${plan.assetName}`);
  }
  // Both end up in the core's source.
  if (!OBJECT_ID.test(release.commit)) {
    refuse('unsupported', 'release commit must be 40 lowercase hex digits');
  }
  if (
    release.tagObject !== undefined &&
    (!OBJECT_ID.test(release.tagObject) || release.tagObject === release.commit)
  ) {
    refuse('unsupported', 'tag object must be the 40-hex id of an annotated tag, not the commit');
  }

  setPhase('load');
  const loaded = await loadRelease(plan, release, asset);

  setPhase('build');
  const build: CoreBuild = isCloudVariant(plan.variant)
    ? await cloudCore(loaded, plan.variant, request.configs ?? {})
    : await releaseCore(loaded);
  return builtCore(plan, build);
}

/** Creates the CoreBuilder over the bundled profiles. Stateless; safe to share. */
export function createCoreBuilder(): CoreBuilder {
  const build = async (request: BuildRequest): Promise<BuiltCore> => {
    let phase: Phase = 'request';
    try {
      return await buildChecked(request, p => (phase = p));
    } catch (e) {
      throw toBuildError(e, PHASE_FALLBACK[phase]);
    }
  };
  return Object.freeze({plan: planOf, build});
}

/** The BuiltCore of one variant, after checking that the core names what was asked for. */
function builtCore(plan: AssetPlan, build: CoreBuild): BuiltCore {
  const {core} = build;
  const buildId = `${plan.app}@${plan.version}+${plan.variant}`;
  if (
    core.build_id !== buildId ||
    core.app !== plan.app ||
    core.variant !== plan.variant ||
    core.version.label !== plan.version
  ) {
    refuse('invalid-core', `built ${core.build_id}, expected ${buildId}`);
  }
  const inputs = core.derivation?.inputs;
  return Object.freeze({
    app: plan.app,
    variant: plan.variant,
    buildId,
    version: plan.version,
    assurance: APPS[plan.app].profile.variants[plan.variant]!.assurance,
    core,
    bytes: build.bytes,
    sha256: build.sha256,
    ...(inputs === undefined
      ? {}
      : {
          configInputs: Object.freeze(
            inputs.map(i => Object.freeze({path: i.path, commit: i.commit, sha256: i.sha256})),
          ),
        }),
  });
}
