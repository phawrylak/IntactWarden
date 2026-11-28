/**
 * Popup view model. Pure: input is the
 * persisted TabStateRecord the background returns for the tab (R10); output
 * is localised text and the buttons to offer. It never computes a verdict:
 * state, reasons and flags are shown as the engine wrote them.
 */

import {type AppId, type CoverageCounts, type TabStateRecord} from '../../contracts.ts';
import {matchPatternFor} from '../../deployments/serverAddress.ts';
import {tn} from '../../i18n/plural.ts';
import {t} from '../../i18n/t.ts';
import {
  commitUrl,
  formatDateTime,
  formatTime,
  isVersion,
  releaseName,
  releaseUrl,
} from '../shared/format.ts';
import {
  APP_LABEL,
  ASSURANCE_BADGE,
  DEPLOYMENT_LABEL,
  FAILURE_LABEL,
  THIRD_PARTY_LABEL,
  keyFor,
} from '../shared/labels.ts';
import {
  colourFor,
  flagText,
  hintedRelease,
  reasonText,
  selfHostedLead,
  stateDescription,
  stateTitle,
  toolbarIconFor,
} from '../shared/stateText.ts';

export interface LinkView {
  readonly text: string;
  readonly href: string | null;
  /** The whole value when `text` shortens it (a commit), shown as a tooltip. */
  readonly title?: string;
}

export interface ProvenanceView {
  readonly app: string;
  readonly deployment: string | null;
  /** "2026.10.1", or "2026.11.0 (server-asserted)" when no build is bound. */
  readonly version: string | null;
  readonly release: LinkView | null;
  readonly commit: LinkView | null;
  readonly assurance: string | null;
  /** "Bundled with IntactWarden 1.0.0" / "Built in your browser from GitHub release …". */
  readonly source: string | null;
  readonly artifact: string | null;
}

export interface PopupButtons {
  readonly details: boolean;
  /** Opens the incidents page at the open alert: its recovery steps and the one Acknowledge. */
  readonly checklist: {readonly incidentId: string} | null;
  readonly grant: {readonly pattern: string} | null;
  readonly allowStyle: {readonly path: string} | null;
  /**
   * Payment scripts kept out of this page: each can be allowed for ONE page load,
   * behind the consent text (`consent`), which reloads the tab.
   */
  readonly allowThirdParty: readonly {
    readonly id: string;
    readonly label: string;
    readonly consent: readonly string[];
  }[];
}

export interface PopupView {
  readonly protected: boolean;
  readonly colour: string;
  readonly header: {
    readonly product: string;
    readonly origin: string | null;
    readonly deployment: string | null;
    readonly badge: string | null;
  };
  readonly lead: string | null;
  readonly title: string;
  readonly sentence: string;
  readonly reasons: readonly string[];
  readonly flags: readonly string[];
  readonly alert: string | null;
  readonly unknownBuild: string | null;
  readonly provenance: ProvenanceView | null;
  readonly coverage: string | null;
  readonly serverStyle: string | null;
  readonly serverStyleNote: string | null;
  readonly coResident: string | null;
  readonly limits: readonly string[];
  readonly buttons: PopupButtons;
}

const NO_BUTTONS: PopupButtons = Object.freeze({
  details: false,
  checklist: null,
  grant: null,
  allowStyle: null,
  allowThirdParty: [],
});

function thirdPartyName(id: string): string {
  const key = keyFor(THIRD_PARTY_LABEL, id);
  return key ? t(key) : id;
}

/** What the user agrees to before a payment script runs on one page. */
export function thirdPartyConsent(vendor: string): readonly string[] {
  return [
    t('consent_third_party_source', [vendor]),
    t('consent_third_party_reach'),
    t('consent_third_party_scope'),
    t('consent_third_party_private'),
  ];
}

/** What was checked: "Document 1/1 · Scripts 41/41 · … · Third-party 1 (Stripe)". */
export function coverageLine(c: CoverageCounts): string {
  const parts = [
    t('coverage_document', [String(c.document.ok), String(c.document.total)]),
    t('coverage_scripts', [String(c.scripts.ok), String(c.scripts.total)]),
  ];
  if (c.wasm.total > 0) parts.push(t('coverage_wasm', [String(c.wasm.ok), String(c.wasm.total)]));
  if (c.styles.total > 0)
    parts.push(t('coverage_styles', [String(c.styles.ok), String(c.styles.total)]));
  if (c.data.total > 0) parts.push(t('coverage_data', [String(c.data.ok), String(c.data.total)]));
  if (c.fonts.total > 0)
    parts.push(t('coverage_fonts', [String(c.fonts.ok), String(c.fonts.total)]));
  parts.push(t('coverage_unverifiable', [String(c.unverifiable)]));
  const tp = [...new Set(c.thirdParty)];
  parts.push(
    tp.length === 0
      ? t('coverage_third_party_none')
      : t('coverage_third_party', [String(tp.length), tp.map(thirdPartyName).join(', ')]),
  );
  return parts.join(' · ');
}

function provenance(record: TabStateRecord, extVersion: string): ProvenanceView | null {
  if (record.app === null) return null;
  const app: AppId = record.app;
  const b = record.top?.binding ?? null;
  const deploymentKey = record.deploymentId ? keyFor(DEPLOYMENT_LABEL, record.deploymentId) : null;
  let version: string | null = null;
  let release: LinkView | null = null;
  let source: string | null = null;
  if (b !== null) {
    version = b.version;
    const name = releaseName(b.repo, b.tag);
    if (name) release = {text: name, href: releaseUrl(b.repo, b.tag)};
    source =
      b.source === 'bundled'
        ? t('provenance_bundled', [extVersion])
        : t('provenance_built_locally', [name ?? b.tag]);
  } else if (isVersion(record.hint?.version)) {
    version = t('provenance_server_asserted', [record.hint.version]);
    const hinted = hintedRelease(app, record.hint.version);
    if (hinted) release = {text: hinted.name, href: releaseUrl(hinted.repo, hinted.tag)};
  }
  const commit =
    b && commitUrl(b.repo, b.commit)
      ? {text: b.commit.slice(0, 12), href: commitUrl(b.repo, b.commit), title: b.commit}
      : null;
  return {
    app: t(APP_LABEL[app]),
    deployment: deploymentKey ? t(deploymentKey) : null,
    version,
    release,
    commit,
    // A red state says the page does not match its release; the manifest's assurance class
    // below it would say the opposite.
    assurance:
      b && colourFor(record.state, record.flags) !== 'red' ? t(ASSURANCE_BADGE[b.assurance]) : null,
    source,
    artifact: b?.artifactSha256 ? t('provenance_artifact', [b.artifactSha256]) : null,
  };
}

function unknownBuildLine(record: TabStateRecord): string | null {
  const u = record.unknownBuild;
  if (u === null) return null;
  if (u.phase === 'hint') return t('popup_unknown_hint');
  if (u.phase === 'deep-verify') return t('popup_unknown_deep_verify');
  return u.failure ? t('popup_unknown_failed', [t(FAILURE_LABEL[u.failure])]) : null;
}

function serverStyle(record: TabStateRecord): {line: string | null; note: string | null} {
  const s = record.top?.serverStyle ?? null;
  const note = record.app === 'vaultwarden-web' ? t('popup_vaultwarden_style_note') : null;
  if (s === null) return {line: null, note};
  if (s.accepted) return {line: tn('popup_server_style_accepted', s.hiddenCount), note};
  const reason = s.reason ? reasonText('UNVERIFIED_STYLE', s.reason) : null;
  return {line: t('popup_server_style_rejected', [reason ?? '—']), note};
}

function limits(record: TabStateRecord): string[] {
  const out: string[] = [];
  const tp = record.top?.counts.thirdParty ?? [];
  if (tp.length > 0)
    out.push(t('popup_limit_third_party', [[...new Set(tp)].map(thirdPartyName).join(', ')]));
  out.push(t('popup_limit_dynamic'));
  return out;
}

function buttons(record: TabStateRecord): PopupButtons {
  const alert = record.alert;
  const pattern = record.origin ? matchPatternFor(record.origin) : null;
  const top = record.top;
  const style = top?.serverStyle ?? null;
  const allowedStyles = record.allowances?.serverStyles ?? [];
  return {
    details: top !== null,
    checklist: alert && !alert.acknowledged ? {incidentId: alert.incident_id} : null,
    grant:
      pattern !== null &&
      (record.permissionMissing || record.reasons.includes('permission-revoked'))
        ? {pattern}
        : null,
    allowStyle:
      record.state === 'UNVERIFIED_STYLE' &&
      style &&
      !style.accepted &&
      !allowedStyles.includes(style.path)
        ? {path: style.path}
        : null,
    allowThirdParty: (top?.thirdPartyBlocked ?? []).map(id => {
      const label = thirdPartyName(id);
      return {id, label, consent: thirdPartyConsent(label)};
    }),
  };
}

/**
 * The popup for a tab: `record` null means the tab is not protected (or has no state yet).
 * `extVersion` is the extension's own version (runtime.getManifest().version).
 */
export function popupView(record: TabStateRecord | null, extVersion: string): PopupView {
  // While CHECKING withholds green the popup says "Checking…", as the toolbar does; a
  // protected top document still being classified (NOT_PROTECTED + CHECKING) is shown as such.
  const checking = record !== null && toolbarIconFor(record.state, record.flags) === 'grey-spinner';
  if (record === null || (record.state === 'NOT_PROTECTED' && !checking)) {
    return {
      protected: false,
      colour: 'none',
      header: {
        product: t('extName'),
        origin: record?.origin ?? null,
        deployment: null,
        badge: null,
      },
      lead: null,
      title: t('popup_not_protected_title'),
      sentence: t('state_NOT_PROTECTED_desc'),
      reasons: [],
      flags: [],
      alert: null,
      unknownBuild: null,
      provenance: null,
      coverage: null,
      serverStyle: null,
      serverStyleNote: null,
      coResident: null,
      limits: [],
      buttons: NO_BUTTONS,
    };
  }
  const top = record.top;
  const retroAt = top?.binding?.retroAt ?? null;
  const deploymentKey = record.deploymentId ? keyFor(DEPLOYMENT_LABEL, record.deploymentId) : null;
  const style = serverStyle(record);
  const alert = record.alert;
  const colour = colourFor(record.state, record.flags);
  return {
    protected: true,
    colour,
    header: {
      product: t('extName'),
      origin: record.origin,
      deployment: deploymentKey ? t(deploymentKey) : null,
      badge: t('popup_badge'),
    },
    lead: selfHostedLead(record),
    title: checking ? t('outcome_pending') : stateTitle(record.state),
    sentence: checking ? t('flag_checking') : stateDescription(record.state),
    reasons: record.reasons
      .map(r => reasonText(record.state, r))
      .filter((x): x is string => x !== null),
    // The checking sentence is already the popup's sentence; do not repeat it as a flag line.
    flags: record.flags.filter(f => !checking || f !== 'CHECKING').map(f => flagText(f, retroAt)),
    alert:
      alert !== null && !alert.acknowledged
        ? t('popup_alert_unacknowledged', [stateTitle(alert.state), formatDateTime(alert.at)])
        : null,
    unknownBuild: unknownBuildLine(record),
    provenance: provenance(record, extVersion),
    coverage: top ? coverageLine(top.counts) : null,
    serverStyle: style.line,
    serverStyleNote: style.note,
    coResident: top?.coResident
      ? t('popup_co_resident_source', [top.coResident.sourcePath, formatTime(record.updatedAt)])
      : null,
    limits: limits(record),
    buttons: buttons(record),
  };
}

/**
 * A tab that shows the blocked page (ui/blocked.html): its denied session has ended, so there is
 * no record; the page in the tab says why and what can be done.
 */
export function blockedTabView(extVersion: string): PopupView {
  return {
    ...popupView(null, extVersion),
    title: t('popup_blocked_page_title'),
    sentence: t('popup_blocked_page_desc'),
  };
}
