/**
 * Release resolution for deep verify:
 * GitHub release by repository id → the profile's asset, its listed size and sha256 digest → tag
 * → commit (and tag object) → comparison with the pins. The result is the `ReleaseJobSpec` a job
 * host executes, or a `ReleaseFailure`.
 *
 * Nothing here downloads an asset or trusts a vendor origin: every value comes from the bundled
 * profile (through the builder's `AssetPlan`) or from GitHub.
 */

import type {AssetPlan, BuildRefusal} from '@intactwarden/builders/api.ts';
import type {DisputeEvidence, DisputeReason, ReleaseFailure, ReleaseJobSpec} from '../contracts.ts';
import {releaseDownloadUrl} from './common.ts';
import type {GhResult, GitHubAsset, GitHubClient} from './github.ts';
import {disputeEvidence, type ObservedAsset, type PinStore} from './pins.ts';

export interface ResolveDeps {
  readonly github: GitHubClient;
  readonly pins: Pick<PinStore, 'checkAsset' | 'findConfig'>;
}

export type ResolveFailure = {
  readonly ok: false;
  readonly failure: ReleaseFailure;
  readonly transient: boolean;
  readonly retryAt: number | null;
  readonly dispute?: DisputeReason;
  readonly evidence?: DisputeEvidence;
  readonly detail?: BuildRefusal;
};

export type ResolveOutcome =
  | {
      readonly ok: true;
      readonly spec: Omit<ReleaseJobSpec, 'jobId'>;
      /** The release asset to pin (TOFU) when no pin exists yet; null when it is pinned already. */
      readonly observed: ObservedAsset | null;
    }
  | ResolveFailure;

const permanent = (failure: ReleaseFailure, detail?: BuildRefusal): ResolveFailure =>
  detail === undefined
    ? {ok: false, failure, transient: false, retryAt: null}
    : {ok: false, failure, transient: false, retryAt: null, detail};

/** Maps a non-ok GitHub result to a failure (`notFound` names the permanent code for a 404). */
function fromGitHub(
  r: Exclude<GhResult<unknown>, {k: 'ok'}>,
  notFound: ReleaseFailure,
): ResolveFailure {
  switch (r.k) {
    case 'not-found':
      return permanent(notFound);
    case 'rate-limited':
      return {ok: false, failure: 'rate-limited', transient: true, retryAt: r.retryAt};
    case 'network':
    case 'bad-response':
      return {ok: false, failure: 'network', transient: true, retryAt: null};
  }
}

function findAsset(assets: readonly GitHubAsset[], name: string): GitHubAsset | null {
  const matches = assets.filter(a => a.name === name);
  return matches.length === 1 ? matches[0]! : null;
}

/** Resolves the release of `plan` on GitHub and checks it against the pins. Never throws. */
export async function resolveRelease(plan: AssetPlan, deps: ResolveDeps): Promise<ResolveOutcome> {
  const release = await deps.github.getRelease(plan.repoId, plan.tag);
  if (release.k !== 'ok') return fromGitHub(release, 'release-not-found');
  const rel = release.value;
  if (rel.tag !== plan.tag || rel.draft) return permanent('release-not-found');

  const asset = findAsset(rel.assets, plan.assetName);
  if (asset === null || !asset.uploaded) {
    return permanent(plan.app === 'vaultwarden-web' ? 'image-only-release' : 'asset-not-found');
  }
  // The release answered by repository id must be the repository the profile names: the asset's
  // listed address must name the profile's repository and tag.
  const assetUrl = releaseDownloadUrl(plan.repo, plan.tag, plan.assetName);
  if (asset.downloadUrl.toLowerCase() !== assetUrl.toLowerCase())
    return permanent('release-not-found');
  if (asset.sha256 === null) return permanent('digest-unavailable');
  if (asset.size === 0) return permanent('asset-not-found');

  const ref = await deps.github.getTagRef(plan.repoId, plan.tag);
  if (ref.k !== 'ok') return fromGitHub(ref, 'release-not-found');
  const {commit, tagObject} = ref.value;

  const observed: ObservedAsset = {
    repo: plan.repo,
    tag: plan.tag,
    commit,
    ...(tagObject === undefined ? {} : {tagObject}),
    asset: asset.name,
    sha256: asset.sha256,
    size: asset.size,
  };
  const check = deps.pins.checkAsset(observed);
  if (check.k === 'dispute') {
    return {
      ok: false,
      failure: 'disputed',
      transient: false,
      retryAt: null,
      dispute: check.reason,
      evidence: disputeEvidence(check.reason, check.pin, observed),
    };
  }

  const spec: Omit<ReleaseJobSpec, 'jobId'> = {
    plan,
    commit,
    ...(tagObject === undefined ? {} : {tagObject}),
    asset: {id: asset.id, name: asset.name, sha256: asset.sha256, size: asset.size},
    configs: plan.configPaths.map(path => {
      const pin = deps.pins.findConfig(plan.repo, commit, path);
      return pin === null ? {path} : {path, sha256: pin.sha256};
    }),
  };
  return {ok: true, spec, observed: check.k === 'new' ? observed : null};
}
