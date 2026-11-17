/**
 * Blocked page view model.
 * Pure: input is the BlockedView the background returns for the incident in
 * the page's fragment (R10).
 */

import type {BlockedView, EnsureReleaseOutcome} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {formatBytes, fullHash} from './format.ts';
import {BUILD_REFUSAL_LABEL, FAILURE_LABEL, JOB_PHASE_LABEL} from './labels.ts';
import {reasonText, stateDescription, stateTitle} from './stateText.ts';

export interface BlockedPageView {
  readonly title: string;
  readonly sentence: string;
  readonly reasons: readonly string[];
  readonly rows: readonly {
    readonly label: string;
    readonly value: string;
    readonly mono?: boolean;
  }[];
  /** DISPUTED: the recorded and the new value of the pin. */
  readonly dispute: readonly string[];
  readonly canProceedOnce: boolean;
  /** Where Retry and Proceed once navigate (origin + path; query and fragment are never stored). */
  readonly target: string | null;
}

/** origin + path when both are well-formed (http(s) origin, absolute path without query or fragment). */
export function retryTarget(origin: string, path: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) return null;
  if (!path.startsWith('/') || /[?#\s\\]/.test(path) || path.startsWith('//')) return null;
  return `${origin}${path}`;
}

export function blockedPageView(view: BlockedView): BlockedPageView {
  return {
    title: t('blocked_heading', [stateTitle(view.state)]),
    sentence:
      view.state === 'PROTECTION_LOST'
        ? t('blocked_protection_lost_desc')
        : stateDescription(view.state),
    reasons: view.reasons
      .map(r => reasonText(view.state, r))
      .filter((x): x is string => x !== null),
    rows: [
      {label: t('blocked_label_site'), value: view.origin, mono: true},
      {label: t('blocked_label_path'), value: view.path, mono: true},
      {label: t('blocked_label_expected'), value: fullHash(view.expected), mono: true},
      {label: t('blocked_label_observed'), value: fullHash(view.observed), mono: true},
    ],
    dispute: view.dispute
      ? [
          t('details_dispute_recorded', [view.dispute.recorded]),
          t('details_dispute_observed', [view.dispute.observed]),
        ]
      : [],
    canProceedOnce: view.canProceedOnce && view.observed !== null,
    target: retryTarget(view.origin, view.path),
  };
}

/**
 * NEW_BUILD on the blocked page: reload once the build is known, that is once the job the
 * background attached (running, or finished at or after the incident) is done, or when the
 * background says that only a new load can decide (`reload`).
 */
export function shouldReload(view: BlockedView | null): boolean {
  return view !== null && view.retry && (view.reload === true || view.job?.phase === 'done');
}

/** One progress line of a deep-verify job (the blocked page on NEW_BUILD and on Retry). */
export function jobLine(job: BlockedView['job']): string | null {
  if (job === null) return null;
  const phase = t(JOB_PHASE_LABEL[job.phase]);
  if (job.phase === 'failed' && job.failure)
    return t('job_failed_line', [t(FAILURE_LABEL[job.failure])]);
  if (
    job.phase === 'downloading' &&
    typeof job.bytes === 'number' &&
    typeof job.total === 'number'
  ) {
    return t('job_download_line', [formatBytes(job.bytes), formatBytes(job.total)]);
  }
  return phase;
}

/**
 * The line under Retry on a Build not verified page while it asks GitHub for the release again
 * (UI_DEEP_VERIFY): why it failed, else the job's progress (JOB_UPDATED), else that it runs. On
 * success the page loads the vault instead.
 */
export function retryLine(job: BlockedView['job'], outcome: EnsureReleaseOutcome | null): string {
  if (outcome === null || outcome.ok) return jobLine(job) ?? t('popup_unknown_deep_verify');
  const failure = t(FAILURE_LABEL[outcome.failure]);
  const detail = outcome.detail ? ` (${t(BUILD_REFUSAL_LABEL[outcome.detail])})` : '';
  return t('popup_unknown_failed', [failure + detail]);
}
