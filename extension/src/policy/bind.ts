/**
 * Document binding: for each candidate core, mapUrl → exact
 * entry, template (matched on the bytes), or the routing's not-found document; the first match
 * binds. Pure.
 *
 * A navigation that binds nowhere takes part in unknown-build resolution only at a document path: a
 * path the profile declares (`identify.documents`) answered with content, or a document key of a
 * candidate core. Anything else (a path outside the manifest, a 404 that is not the build's
 * not-found document, an error page) is an unknown document.
 */

import {mapUrl} from '@intactwarden/core/routing/mapUrl.ts';
import {isExactEntry, isTemplateEntry, type FileEntry} from '@intactwarden/core/schema/manifest.ts';
import {matchPathGlob} from '@intactwarden/core/schema/profile.ts';
import {matchTemplate} from '@intactwarden/core/template/match.ts';
import type {BindDocument, BindResult, BodyEvidence} from '../contracts.ts';
import {pathOfUrl, relativePath} from './util.ts';

type Tried = Extract<BindResult, {k: 'unbound'}>['tried'][number];

/** Matches document bytes against one entry: the template's slot values, or null when it does not match. */
async function matchEntry(
  entry: FileEntry,
  body: BodyEvidence,
  bound: Readonly<Record<string, string>>,
): Promise<Record<string, string> | null> {
  if (isExactEntry(entry)) {
    return entry.sha256 === body.sha256 && entry.size === body.size ? {} : null;
  }
  if (isTemplateEntry(entry)) {
    // Without the bytes (evicted after a restart) a template cannot be judged: no match.
    if (body.bytes === undefined) return null;
    const m = await matchTemplate(entry.template, body.bytes, bound);
    return m.ok ? m.slots : null;
  }
  return null;
}

export const bindDocument: BindDocument = async input => {
  const {origin, url, status, body, candidates, now} = input;
  const tried: Tried[] = [];
  const path = pathOfUrl(url);
  const rel = path === null ? null : relativePath(origin, path);
  let documentPath =
    ((status >= 200 && status < 300) || status === 304) &&
    rel !== null &&
    (origin.profile.identify.documents ?? []).some(g => matchPathGlob(g, rel));
  for (const c of candidates) {
    // Candidates come only from the origin's own profile and deployment.
    if (c.ref.app !== origin.app || c.ref.variant !== origin.deployment.variant) continue;
    const r = mapUrl(url, c.core.routing, c.fileIndex, status, {basePath: origin.basePath});
    let key: string | null = null;
    let bound: Readonly<Record<string, string>> = {};
    let fallback = false;
    if (r.kind === 'file' && r.key !== null) {
      key = r.key;
      bound = r.bound;
    } else if (r.kind === 'not-found-document') {
      key = r.path;
      fallback = true;
    }
    if (key === null) {
      tried.push({buildId: c.ref.buildId, route: r.kind, differsAtManifestPath: false});
      continue;
    }
    const entry = c.core.files[key];
    if (entry === undefined) {
      tried.push({buildId: c.ref.buildId, route: r.kind, differsAtManifestPath: false});
      continue;
    }
    if (entry.class !== 'document') {
      // A navigation to a subresource path (class unknown).
      return {k: 'invalid', reason: 'not-a-document'};
    }
    const slots = await matchEntry(entry, body, bound);
    if (slots === null) {
      // A 404 body that is not the build's not-found document says nothing about the build.
      if (!fallback) documentPath = true;
      tried.push({buildId: c.ref.buildId, route: r.kind, differsAtManifestPath: !fallback});
      continue;
    }
    return {
      k: 'bound',
      core: c,
      binding: {
        buildId: c.ref.buildId,
        app: c.ref.app,
        variant: c.ref.variant,
        version: c.ref.version,
        assurance: c.ref.assurance,
        coreSha256: c.ref.sha256,
        source: c.ref.source,
        key,
        slots: {...bound, ...slots},
        boundAt: now,
        retro: false,
      },
    };
  }
  if (!documentPath) return {k: 'invalid', reason: 'not-a-document-path'};
  return {k: 'unbound', tried};
};
