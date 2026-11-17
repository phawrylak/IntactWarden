/**
 * Details page view model. Pure: input
 * is the DetailsView the background returns (persisted session data, R10).
 * Every path is shown without query or fragment; server-stylesheet selectors
 * are data (textContent), never markup.
 */

import type {DetailsView, ItemOutcome, ItemRecord, ServerStyleRecord} from '../../contracts.ts';
import {tn} from '../../i18n/plural.ts';
import {t} from '../../i18n/t.ts';
import {fullHash, hexPrefix, releaseName} from '../shared/format.ts';
import {
  DOC_CLASS_LABEL,
  ITEM_CLASS_LABEL,
  MATCH_HOW_LABEL,
  OUTCOME_LABEL,
  UNVERIFIABLE_LABEL,
} from '../shared/labels.ts';
import {reasonText, stateTitle, toolbarIconFor} from '../shared/stateText.ts';

export interface ItemRow {
  readonly path: string;
  readonly cls: string;
  readonly expected: string;
  readonly observed: string;
  /** The whole hashes, shown as tooltips of the shortened cells (null: nothing more to show). */
  readonly expectedFull: string | null;
  readonly observedFull: string | null;
  readonly result: string;
  readonly tone: 'ok' | 'bad' | 'warn' | 'muted';
}

export interface StyleView {
  readonly path: string;
  readonly sha256: string;
  readonly verdict: string;
  readonly hidden: readonly string[];
}

export interface DocView {
  readonly heading: string;
  readonly state: string;
  readonly docClass: string;
  readonly build: string | null;
  /** Where the bound core came from (bundled, or built in this browser). */
  readonly source: string | null;
  readonly core: string | null;
  /** DISPUTED: the pinned value this browser recorded and the one GitHub reports now. */
  readonly dispute: readonly string[];
  readonly rows: readonly ItemRow[];
  readonly styles: readonly StyleView[];
}

/** Drops anything after `?` or `#` (defence in depth: records are already redacted). */
export function stripQueryFragment(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

export function outcomeText(outcome: ItemOutcome): {
  readonly text: string;
  readonly tone: ItemRow['tone'];
} {
  const label = t(OUTCOME_LABEL[outcome.r]);
  switch (outcome.r) {
    case 'ok':
      return {text: `${label} (${t(MATCH_HOW_LABEL[outcome.how])})`, tone: 'ok'};
    case 'mismatch':
      return {
        text: `${label}: ${reasonText('MISMATCH', outcome.reason) ?? outcome.reason}`,
        tone: 'bad',
      };
    case 'unverifiable':
      return {text: `${label}: ${t(UNVERIFIABLE_LABEL[outcome.reason])}`, tone: 'warn'};
    case 'third-party':
      return {
        text: `${label}: ${outcome.host}${outcome.allowed ? ` (${t('details_allowed_for_page')})` : ''}`,
        tone: 'warn',
      };
    case 'style-rejected':
      return {
        text: `${label}: ${reasonText('UNVERIFIED_STYLE', outcome.reason) ?? outcome.reason}`,
        tone: 'warn',
      };
    default:
      return {text: label, tone: 'muted'};
  }
}

function wholeOrNull(sha256: string | null | undefined): string | null {
  const whole = fullHash(sha256);
  return whole === '—' ? null : whole;
}

export function itemRow(item: ItemRecord): ItemRow {
  const o = outcomeText(item.outcome);
  return {
    path: stripQueryFragment(item.path),
    cls: t(ITEM_CLASS_LABEL[item.cls]),
    expected:
      item.expected === 'template'
        ? t('details_expected_template')
        : hexPrefix(item.expected ?? null),
    observed: hexPrefix(item.sha256 ?? null),
    expectedFull: item.expected === 'template' ? null : wholeOrNull(item.expected),
    observedFull: wholeOrNull(item.sha256),
    result: o.text,
    tone: o.tone,
  };
}

export function styleView(path: string, s: ServerStyleRecord): StyleView {
  return {
    path: stripQueryFragment(path),
    sha256: fullHash(s.sha256),
    verdict: s.accepted
      ? tn('details_style_accepted', s.hidden.length)
      : t('details_style_rejected', [
          s.reason ? (reasonText('UNVERIFIED_STYLE', s.reason) ?? s.reason) : '—',
        ]),
    hidden: s.accepted ? s.hidden : [],
  };
}

const TONE_ORDER: Record<ItemRow['tone'], number> = {bad: 0, warn: 1, muted: 2, ok: 3};

export function detailsModel(view: DetailsView): {
  readonly origin: string;
  readonly docs: readonly DocView[];
} {
  return {
    origin: view.origin,
    docs: view.docs.map(d => {
      const s = d.summary;
      const b = s.binding;
      const rows = d.items
        .map(itemRow)
        .sort((a, z) => TONE_ORDER[a.tone] - TONE_ORDER[z.tone] || a.path.localeCompare(z.path));
      return {
        heading:
          s.frame === 0
            ? t('details_top_document', [stripQueryFragment(s.path)])
            : t('details_frame', [stripQueryFragment(s.path)]),
        // As the toolbar says it: "Checking…" while the document or some of its files are being
        // verified, never "Not protected" or "Verified".
        state:
          toolbarIconFor(s.state, s.flags) === 'grey-spinner'
            ? t('outcome_pending')
            : stateTitle(s.state),
        docClass: t(DOC_CLASS_LABEL[s.docClass]),
        build: b ? t('details_build', [b.buildId, releaseName(b.repo, b.tag) ?? b.tag]) : null,
        source:
          b === null
            ? null
            : b.source === 'bundled'
              ? t('trust_source_bundled')
              : t('details_source_deep_verify'),
        core: d.coreSha256 ? t('details_core', [fullHash(d.coreSha256)]) : null,
        dispute: d.dispute?.evidence
          ? [
              t('details_dispute_recorded', [d.dispute.evidence.recorded]),
              t('details_dispute_observed', [d.dispute.evidence.observed]),
            ]
          : [],
        rows,
        styles: Object.entries(d.serverStyles).map(([path, rec]) => styleView(path, rec)),
      };
    }),
  };
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return stripQueryFragment(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
}

/**
 * "Copy redacted report": JSON of the details with no query or fragment in
 * any string (every string is cut at the first `?` or `#`). `extVersion` is the extension's own
 * version (runtime.getManifest().version).
 */
export function redactedReport(view: DetailsView, now: number, extVersion: string): string {
  return JSON.stringify(
    {
      schema: 'intactwarden.report/1',
      generated_at: new Date(now).toISOString(),
      extension_version: extVersion,
      details: scrub(view),
    },
    null,
    2,
  );
}
