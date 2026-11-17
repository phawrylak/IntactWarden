/**
 * Catalogue keys for every closed code the UI shows.
 *
 * Each map is a Record over the contract's union, so adding a code to the
 * contract without a key fails the typecheck, and the catalogue test checks
 * every value against both catalogues. Codes are rendered only through these
 * keys: no free text from storage, the network or a profile reaches the UI,
 * except data that is shown as data (origins,
 * paths, hashes, selectors).
 */

import type {
  AppId,
  Assurance,
  DocClass,
  IncidentKind,
  ItemClass,
  ItemOutcome,
  JobPhase,
  AddInstanceRefusal,
  ReleaseDetail,
  ReleaseFailure,
  UnverifiableReason,
  VerdictFlag,
} from '../../contracts.ts';

export const APP_LABEL: Readonly<Record<AppId, string>> = Object.freeze({
  'bitwarden-web': 'app_bitwarden_web',
  'vaultwarden-web': 'app_vaultwarden_web',
});

/** Deployment ids of the bundled profiles. */
export const DEPLOYMENT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'cloud-us': 'deployment_cloud_us',
  'cloud-eu': 'deployment_cloud_eu',
  'self-hosted': 'deployment_self_hosted',
});

export const ASSURANCE_BADGE: Readonly<Record<Assurance, string>> = Object.freeze({
  'release-exact': 'assurance_release_exact',
  'release-derived': 'assurance_release_derived',
});

export const FLAG_LABEL: Readonly<Record<VerdictFlag, string>> = Object.freeze({
  CHECKING: 'flag_checking',
  BLOCKED: 'flag_blocked',
  RETRO: 'flag_retro',
});

export const FAILURE_LABEL: Readonly<Record<ReleaseFailure, string>> = Object.freeze({
  'release-not-found': 'failure_release_not_found',
  'asset-not-found': 'failure_asset_not_found',
  'image-only-release': 'failure_image_only_release',
  'digest-unavailable': 'failure_digest_unavailable',
  'digest-mismatch': 'failure_digest_mismatch',
  'build-refused': 'failure_build_refused',
  disputed: 'failure_disputed',
  network: 'failure_network',
  'rate-limited': 'failure_rate_limited',
  'permission-missing': 'failure_permission_missing',
  'limit-reached': 'failure_limit_reached',
});

export const BUILD_REFUSAL_LABEL: Readonly<Record<ReleaseDetail, string>> = Object.freeze({
  'digest-mismatch': 'refusal_digest_mismatch',
  'size-mismatch': 'refusal_size_mismatch',
  'tag-mismatch': 'refusal_tag_mismatch',
  'asset-name-mismatch': 'refusal_asset_name_mismatch',
  'archive-invalid': 'refusal_archive_invalid',
  'version-mismatch': 'refusal_version_mismatch',
  'forbidden-content': 'refusal_forbidden_content',
  'derivation-failed': 'refusal_derivation_failed',
  'invalid-core': 'refusal_invalid_core',
  unsupported: 'refusal_unsupported',
  'rebuild-differs': 'refusal_rebuild_differs',
});

export const JOB_PHASE_LABEL: Readonly<Record<JobPhase, string>> = Object.freeze({
  queued: 'job_phase_queued',
  resolving: 'job_phase_resolving',
  downloading: 'job_phase_downloading',
  verifying: 'job_phase_verifying',
  building: 'job_phase_building',
  storing: 'job_phase_storing',
  done: 'job_phase_done',
  failed: 'job_phase_failed',
});

/** Why a server could not be added. */
export const PROBE_REFUSAL_LABEL: Readonly<Record<AddInstanceRefusal, string>> = Object.freeze({
  'invalid-input': 'options_add_refusal_invalid_input',
  'refused-official-origin': 'options_add_refusal_official_origin',
  'http-not-loopback': 'options_add_refusal_http_not_loopback',
  'lookalike-unconfirmed': 'options_add_refusal_lookalike_unconfirmed',
  'permission-denied': 'options_add_refusal_permission_denied',
  unreachable: 'options_add_refusal_unreachable',
  'no-server': 'options_add_refusal_no_server',
  'duplicate-instance': 'options_add_refusal_duplicate',
});

export const INCIDENT_KIND_LABEL: Readonly<Record<IncidentKind, string>> = Object.freeze({
  mismatch: 'incident_kind_mismatch',
  'protection-lost': 'incident_kind_protection_lost',
  'build-unverified': 'incident_kind_build_unverified',
  'release-disputed': 'incident_kind_release_disputed',
  'deep-verify-failed': 'incident_kind_deep_verify_failed',
  'proceed-once': 'incident_kind_proceed_once',
});

export const ITEM_CLASS_LABEL: Readonly<Record<ItemClass, string>> = Object.freeze({
  document: 'item_class_document',
  script: 'item_class_script',
  style: 'item_class_style',
  wasm: 'item_class_wasm',
  font: 'item_class_font',
  data: 'item_class_data',
  image: 'item_class_image',
  media: 'item_class_media',
  sourcemap: 'item_class_sourcemap',
  'server-style': 'item_class_server_style',
  dynamic: 'item_class_dynamic',
  'third-party': 'item_class_third_party',
  unknown: 'item_class_unknown',
});

export const OUTCOME_LABEL: Readonly<Record<ItemOutcome['r'], string>> = Object.freeze({
  ok: 'outcome_ok',
  mismatch: 'outcome_mismatch',
  unverifiable: 'outcome_unverifiable',
  'third-party': 'outcome_third_party',
  'style-rejected': 'outcome_style_rejected',
  passive: 'outcome_passive',
  'non-executing': 'outcome_non_executing',
  recorded: 'outcome_recorded',
});

export const MATCH_HOW_LABEL: Readonly<Record<Extract<ItemOutcome, {r: 'ok'}>['how'], string>> =
  Object.freeze({
    exact: 'match_exact',
    template: 'match_template',
    'style-accepted': 'match_style_accepted',
  });

export const UNVERIFIABLE_LABEL: Readonly<Record<UnverifiableReason, string>> = Object.freeze({
  'empty-body': 'unverifiable_empty_body',
  'sw-served': 'unverifiable_sw_served',
  'no-host-permission': 'unverifiable_no_host_permission',
  timeout: 'unverifiable_timeout',
  'filter-failed': 'unverifiable_filter_failed',
  unbound: 'unverifiable_unbound',
  'verifier-restarted': 'unverifiable_verifier_restarted',
  'too-large': 'unverifiable_too_large',
  'internal-error': 'unverifiable_internal_error',
});

export const DOC_CLASS_LABEL: Readonly<Record<DocClass, string>> = Object.freeze({
  pending: 'doc_class_pending',
  manifest: 'doc_class_manifest',
  'server-rendered': 'doc_class_server_rendered',
  'not-covered': 'doc_class_not_covered',
  'dynamic-document': 'doc_class_dynamic_document',
  unknown: 'doc_class_unknown',
});

/** Third-party ids of the bundled profiles. Unknown ids are shown as data. */
export const THIRD_PARTY_LABEL: Readonly<Record<string, string>> = Object.freeze({
  stripe: 'third_party_stripe',
  braintree: 'third_party_braintree',
  paypal: 'third_party_paypal',
  duo: 'third_party_duo',
  '2fa-directory': 'third_party_2fa_directory',
  'hibp-range': 'third_party_hibp',
  'hibp-images': 'third_party_hibp',
  'email-forwarders': 'third_party_email_forwarders',
  'icon-services': 'third_party_icon_services',
  'billing-scripts': 'third_party_billing_scripts',
});

/** Lookup in a map keyed by data (deployment or third-party id): null when the id is unknown. */
export function keyFor(map: Readonly<Record<string, string>>, id: string): string | null {
  return Object.hasOwn(map, id) ? (map[id] ?? null) : null;
}
