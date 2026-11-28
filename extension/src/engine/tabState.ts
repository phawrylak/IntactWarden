/**
 * TabStateRecord builder (R10): the tab state is the
 * highest-ranked state among the tab's live sessions (top document and protected frames). The popup
 * and the icon read only this persisted record. A tab whose top-level document is not protected
 * never shows a framed document's positive state.
 */

import {joinAll, rankOf} from '@intactwarden/core/verdict/states.ts';
import type {
  BindingView,
  Count,
  CoverageCounts,
  DocSummary,
  LoadedCore,
  OriginAlert,
  ProtectedOrigin,
  TabAllowances,
  TabStateRecord,
  VerdictFlag,
} from '../contracts.ts';
import type {SessionRec} from './types.ts';

function count(s: SessionRec, cls: readonly string[]): Count {
  let ok = 0;
  let total = 0;
  for (const item of Object.values(s.items)) {
    if (!cls.includes(item.cls)) continue;
    total++;
    if (item.outcome.r === 'ok') ok++;
  }
  return {ok, total};
}

export function coverage(s: SessionRec): CoverageCounts {
  let unverifiable = 0;
  const thirdParty = new Set<string>();
  for (const item of Object.values(s.items)) {
    if (item.outcome.r === 'unverifiable') unverifiable++;
    if (item.outcome.r === 'third-party') thirdParty.add(item.outcome.id);
  }
  return {
    document: {ok: s.docVerified ? 1 : 0, total: s.docClass === 'pending' ? 0 : 1},
    scripts: count(s, ['script']),
    wasm: count(s, ['wasm']),
    styles: count(s, ['style', 'server-style']),
    data: count(s, ['data']),
    fonts: count(s, ['font']),
    unverifiable,
    thirdParty: [...thirdParty].sort(),
  };
}

function bindingView(s: SessionRec, core: LoadedCore | null): BindingView | null {
  const b = s.binding;
  if (b === null) return null;
  const src = core?.core.source;
  return {
    buildId: b.buildId,
    app: b.app,
    variant: b.variant,
    version: b.version,
    assurance: b.assurance,
    source: b.source,
    repo: src?.repo ?? '',
    tag: src?.tag ?? '',
    commit: src?.commit ?? '',
    artifactSha256: core?.core.artifact.sha256 ?? null,
    retroAt: b.retro ? b.boundAt : null,
  };
}

export function summarize(s: SessionRec, core: LoadedCore | null): DocSummary {
  const styles = Object.entries(s.serverStyles);
  const first = styles[0];
  return {
    doc: s.doc,
    frame: s.frame,
    path: s.path,
    docClass: s.docClass,
    state: s.state,
    reasons: s.reasons,
    flags: s.flags,
    counts: coverage(s),
    binding: bindingView(s, core),
    serverStyle:
      first === undefined
        ? null
        : {
            path: first[0],
            accepted: first[1].accepted,
            hiddenCount: first[1].hidden.length,
            ...(first[1].reason !== undefined ? {reason: first[1].reason} : {}),
          },
    coResident:
      s.coResident === null
        ? null
        : {class: s.coResident.class, sourcePath: s.coResident.sourcePath},
    thirdPartyBlocked: thirdPartyBlocked(s),
  };
}

/** Payment scripts the floor kept out of the document (the popup offers each). */
function thirdPartyBlocked(s: SessionRec): string[] {
  const out = new Set<string>();
  for (const item of Object.values(s.items)) {
    const o = item.outcome;
    if (o.r === 'third-party' && o.kind === 'unpinnable-script' && !o.allowed) out.add(o.id);
  }
  return [...out].sort();
}

export interface TabStateInput {
  readonly tab: number;
  readonly now: number;
  readonly sessions: readonly SessionRec[];
  readonly origin: ProtectedOrigin | null;
  readonly alert: OriginAlert | null;
  readonly allowances: TabAllowances | null;
  readonly permissionMissing: boolean;
  readonly cores: ReadonlyMap<string, LoadedCore>;
  readonly unknownBuild: TabStateRecord['unknownBuild'];
}

/** States that tell the user the page is good; a framed protected document never lends them to its tab. */
const POSITIVE: ReadonlySet<string> = new Set(['VERIFIED']);

/** The live sessions the tab state joins (see buildTabState). */
export function countedSessions(sessions: readonly SessionRec[]): readonly SessionRec[] {
  const embeddedOnly = !sessions.some(s => s.topLevel);
  return embeddedOnly ? sessions.filter(s => !POSITIVE.has(s.state)) : sessions;
}

/** The session the tab record shows on top; undefined when the tab gets no record. */
export function tabTop(sessions: readonly SessionRec[]): SessionRec | undefined {
  const counted = countedSessions(sessions);
  if (counted.length === 0) return undefined;
  return (
    counted.find(s => s.topLevel) ??
    [...counted].sort((a, b) => a.frame - b.frame || b.startedAt - a.startedAt)[0]
  );
}

/**
 * The tab's record, or null when no protected document is live in it.
 *
 * Embedded only (no protected top-level document, e.g. a vault frame inside another site's page):
 * the address bar shows another site, so a frame's VERIFIED never makes the tab look verified. Such
 * a tab gets a record only for what the user must see: a frame in an amber or red state.
 */
export function buildTabState(i: TabStateInput): TabStateRecord | null {
  const counted = countedSessions(i.sessions);
  const top = tabTop(i.sessions);
  if (top === undefined) return null;
  const state = joinAll(counted.map(s => s.state));
  const reasons = new Set<string>();
  const flags = new Set<VerdictFlag>();
  for (const s of counted) {
    for (const f of s.flags) flags.add(f);
    if (rankOf(s.state) === rankOf(state)) for (const r of s.reasons) reasons.add(r);
  }
  const coreOf = (s: SessionRec): LoadedCore | null =>
    s.binding === null ? null : (i.cores.get(s.binding.coreSha256) ?? null);
  const summarizeWith = (s: SessionRec): DocSummary => summarize(s, coreOf(s));
  return {
    v: 1,
    tab: i.tab,
    updatedAt: i.now,
    origin: top.origin,
    app: top.app,
    deploymentId: top.deploymentId,
    kind: i.origin?.kind ?? null,
    instance:
      i.origin?.instance === null || i.origin?.instance === undefined
        ? null
        : {added_at: i.origin.instance.added_at},
    state,
    reasons: [...reasons].slice(0, 20),
    flags: [...flags],
    top: summarizeWith(top),
    frames: counted.filter(s => s !== top).map(summarizeWith),
    hint: top.binding === null ? (top.unknownBuild?.hint ?? null) : null,
    unknownBuild: i.unknownBuild,
    alert: i.alert,
    allowances: i.allowances,
    permissionMissing: i.permissionMissing,
  };
}
