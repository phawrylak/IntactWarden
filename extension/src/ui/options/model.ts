/**
 * Options view models. Pure: inputs
 * are the records the background returns (instances, trust panel, refusal
 * codes); outputs are localised strings. Codes become text only through
 * catalogue keys (ui/shared/labels.ts).
 */

import type {
  AddInstanceRefusal,
  CoreRef,
  DeepVerifyJobView,
  InstanceView,
  LocalPin,
  TrustPanelView,
} from '../../contracts.ts';
import {tn} from '../../i18n/plural.ts';
import {t} from '../../i18n/t.ts';
import {formatDate, formatDateTime, fullHash} from '../shared/format.ts';
import {
  APP_LABEL,
  ASSURANCE_BADGE,
  BUILD_REFUSAL_LABEL,
  FAILURE_LABEL,
  JOB_PHASE_LABEL,
  PROBE_REFUSAL_LABEL,
} from '../shared/labels.ts';

export function refusalText(code: AddInstanceRefusal): string {
  return t(PROBE_REFUSAL_LABEL[code]);
}

export interface InstanceRow {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly granted: boolean;
  readonly pattern: string;
}

export function instanceRow(v: InstanceView): InstanceRow {
  const r = v.record;
  return {
    id: r.id,
    title: r.origin,
    lines: [
      t('options_instance_app', [t(APP_LABEL[r.app])]),
      t('options_instance_base_path', [r.base_path]),
      t('options_instance_added', [formatDate(r.added_at)]),
      v.permission.granted
        ? t('options_instance_permission_ok')
        : t('options_instance_permission_missing'),
      ...(v.lastBuild ? [t('options_instance_last_build', [v.lastBuild])] : []),
    ],
    granted: v.permission.granted,
    pattern: v.permission.pattern,
  };
}

export interface CoreRow {
  readonly buildId: string;
  readonly assurance: string;
  readonly source: string;
  readonly disputed: boolean;
}

function coreRow(ref: CoreRef): CoreRow {
  return {
    buildId: ref.buildId,
    assurance: t(ASSURANCE_BADGE[ref.assurance]),
    source:
      ref.source === 'bundled'
        ? t('trust_source_bundled')
        : t('trust_source_deep_verify', [formatDateTime(ref.addedAt)]),
    disputed: ref.status === 'disputed',
  };
}

export function jobRow(job: DeepVerifyJobView): string {
  const app = t(APP_LABEL[job.app]);
  const phase =
    job.phase === 'failed' && job.failure
      ? t(FAILURE_LABEL[job.failure]) +
        (job.detail ? ` (${t(BUILD_REFUSAL_LABEL[job.detail])})` : '')
      : t(JOB_PHASE_LABEL[job.phase]);
  return t('trust_job_line', [app, job.version, phase, formatDateTime(job.startedAt)]);
}

export function pinRow(pin: LocalPin): string {
  const source = pin.source === 'bundled' ? t('trust_pin_bundled') : t('trust_pin_local');
  if (pin.kind === 'release-asset') {
    return t('trust_pin_asset', [
      `${pin.repo} ${pin.tag}`,
      pin.asset,
      fullHash(pin.sha256),
      source,
    ]);
  }
  return t('trust_pin_config', [pin.repo, pin.path, fullHash(pin.sha256), source]);
}

export interface TrustModel {
  readonly summary: readonly string[];
  readonly cores: readonly CoreRow[];
  readonly jobs: readonly string[];
  readonly pins: readonly string[];
  readonly githubPermission: boolean;
}

export function trustModel(view: TrustPanelView, now: number): TrustModel {
  const s = view.snapshot;
  const summary = [t('trust_sources')];
  if (!s.loaded) summary.push(t('trust_load_failed'));
  summary.push(tn('trust_cores_count', view.cores.length));
  if (s.githubBackoffUntil !== null && s.githubBackoffUntil > now) {
    summary.push(t('trust_github_backoff', [formatDateTime(s.githubBackoffUntil)]));
  }
  const cores = [...view.cores].sort((a, b) => a.buildId.localeCompare(b.buildId)).map(coreRow);
  const jobs = [...view.jobs]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map(jobRow);
  const pins = view.pins.pins.map(pinRow);
  return {
    summary,
    cores,
    jobs,
    pins,
    githubPermission: view.githubPermission,
  };
}
