/**
 * Subresource verification against the bound core: server paths first, then
 * mapUrl; exact or template match with the binding's slots; third parties; server stylesheets
 * through checkVaultwardenCss; content type and charset per entry class. Pure.
 */

import {mapUrl} from '@intactwarden/core/routing/mapUrl.ts';
import {isExactEntry, isTemplateEntry, type FileEntry} from '@intactwarden/core/schema/manifest.ts';
import {matchUrlPattern} from '@intactwarden/core/schema/profile.ts';
import {checkVaultwardenCss} from '@intactwarden/core/style/serverStyle.ts';
import {matchTemplate} from '@intactwarden/core/template/match.ts';
import type {
  ItemClass,
  ItemOutcome,
  ItemRecord,
  LoadedCore,
  VerifyItem,
  VerifyItemInput,
} from '../contracts.ts';
import {contentTypeAllowed, isExecutableContentType} from './headerGuard.ts';
import {classifyServerPath} from './classify.ts';
import {classOfType, header, isActiveType, pathOfUrl} from './util.ts';

function entryClass(entry: FileEntry): ItemClass {
  return entry.class as ItemClass;
}

/** The file `url` names in the core (its 200 mapping), or null when it names none. */
export function listedEntryOf(
  origin: VerifyItemInput['origin'],
  core: LoadedCore,
  url: string,
): {key: string; entry: FileEntry} | null {
  const r = mapUrl(url, core.core.routing, core.fileIndex, 200, {basePath: origin.basePath});
  if (r.kind !== 'file' || r.key === null) return null;
  const entry = core.core.files[r.key];
  if (entry === undefined) return null;
  return {key: r.key, entry};
}

/**
 * The outcome of a cross-origin URL a protected document loads, from the profile's
 * `third_party` declarations; null when no declaration matches. `unexpected` third parties
 * (billing scripts on Vaultwarden) are a MISMATCH; a payment script is allowed only for the one
 * document the user allowed it for (`allowedThirdParty`). Used for observed requests
 * and for script elements and CSP reports the content script sees.
 */
export function thirdPartyOutcome(
  origin: VerifyItemInput['origin'],
  url: string,
  allowedThirdParty: string | null,
): ItemOutcome | null {
  const tp = origin.profile.third_party.find(t => t.match.some(m => matchUrlPattern(m, url)));
  if (tp === undefined) return null;
  if (tp.kind === 'unexpected') return {r: 'mismatch', reason: 'unknown-path'};
  const allowed = tp.kind === 'passive' || tp.kind === 'data' || tp.id === allowedThirdParty;
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = '';
  }
  return {r: 'third-party', id: tp.id, host, kind: tp.kind, allowed};
}

export const verifyItem: VerifyItem = async i => {
  const {request, body, status} = i;
  const url = request.url;
  const path = pathOfUrl(url) ?? url;
  const ctype = header(i.headers, 'content-type');
  const active = isActiveType(request.type) || classOfType(request.type, path) === 'wasm';
  const base = {
    req: request.req,
    url,
    type: request.type,
    at: i.now,
    ...(body !== null ? {sha256: body.sha256, size: body.size} : {}),
  };
  const rec = (
    p: string,
    cls: ItemClass,
    outcome: ItemOutcome,
    extra: Partial<ItemRecord> = {},
  ): ItemRecord => ({...base, path: p, cls, key: null, outcome, ...extra});

  const sp = classifyServerPath(i.origin, url, request.type);
  switch (sp.k) {
    case 'cross-origin': {
      const declared = thirdPartyOutcome(i.origin, url, i.allowedThirdParty);
      if (declared !== null) return rec(url, 'third-party', declared);
      return active
        ? rec(url, 'third-party', {r: 'mismatch', reason: 'unknown-path'})
        : rec(url, 'third-party', {r: 'passive'});
    }
    case 'server-style': {
      // Only a stylesheet is checked here; anything else active on this path is not a release file.
      if (request.type !== 'stylesheet') {
        return active
          ? rec(path, 'server-style', {r: 'mismatch', reason: 'unknown-path'})
          : rec(path, 'server-style', {r: 'passive'});
      }
      if (!contentTypeAllowed('server-style', ctype)) {
        return rec(path, 'server-style', {r: 'mismatch', reason: 'header'});
      }
      if (body === null)
        return rec(path, 'server-style', {r: 'unverifiable', reason: 'empty-body'});
      const check = body.bytes !== undefined ? checkVaultwardenCss(body.bytes) : null;
      if (check === null)
        return rec(path, 'server-style', {r: 'unverifiable', reason: 'internal-error'});
      return check.ok
        ? rec(path, 'server-style', {r: 'ok', how: 'style-accepted'})
        : rec(path, 'server-style', {r: 'style-rejected', reason: check.reason});
    }
    case 'dynamic': {
      if (active || request.type === 'main_frame' || request.type === 'sub_frame') {
        return rec(path, 'dynamic', {r: 'mismatch', reason: 'unknown-path'});
      }
      if (isExecutableContentType(ctype))
        return rec(path, 'dynamic', {r: 'mismatch', reason: 'header'});
      return rec(path, 'dynamic', {r: 'passive'});
    }
    case 'not-covered':
    case 'server-rendered':
    case 'outside-base':
      return active
        ? rec(path, classOfType(request.type, path), {r: 'mismatch', reason: 'unknown-path'})
        : rec(path, classOfType(request.type, path), {r: 'passive'});
    case 'build':
      break;
  }

  const core = i.core;
  const r = mapUrl(url, core.core.routing, core.fileIndex, status, {basePath: i.origin.basePath});
  const typeCls = classOfType(request.type, path);
  // The listed file the URL names, whatever the status: a body the page can read (a fetch of a
  // locale answered 404 or 500) must be that file's bytes.
  const listed = listedEntryOf(i.origin, core, url) !== null;
  const hasBody = body !== null && body.size > 0;
  switch (r.kind) {
    case 'server-not-found':
      return rec(path, typeCls, {r: 'non-executing'});
    case 'missing-file':
      return rec(path, typeCls, {r: 'mismatch', reason: 'bytes'}, {key: r.key});
    case 'outside-base':
      return active
        ? rec(path, typeCls, {r: 'mismatch', reason: 'unknown-path'})
        : rec(path, typeCls, {r: 'passive'});
    case 'invalid':
      if (status >= 400 && !hasBody) return rec(path, typeCls, {r: 'non-executing'});
      // Browsers run no script or stylesheet from a non-ok response; that answer is unverifiable.
      if (isActiveType(request.type))
        return rec(path, typeCls, {r: 'unverifiable', reason: 'internal-error'});
      // Data the page reads, a listed `.wasm` fetched by fetch() included (a bundler's loader
      // instantiates it without checking the status), must be the listed file's bytes.
      if (listed && hasBody) return rec(path, typeCls, {r: 'mismatch', reason: 'bytes'});
      return active
        ? rec(path, typeCls, {r: 'unverifiable', reason: 'internal-error'})
        : rec(path, typeCls, {r: 'passive'});
    case 'not-found-document': {
      const e = core.core.files[r.path];
      if (e !== undefined && isExactEntry(e) && body !== null && e.sha256 === body.sha256) {
        return rec(path, typeCls, {r: 'non-executing'});
      }
      return active || (listed && hasBody)
        ? rec(path, typeCls, {r: 'mismatch', reason: 'bytes'})
        : rec(path, typeCls, {r: 'non-executing'});
    }
    case 'file':
      break;
  }

  if (r.key === null) {
    return active
      ? rec(path, typeCls, {r: 'mismatch', reason: 'unknown-path'})
      : rec(path, typeCls, {r: 'passive'});
  }
  const key = r.key;
  const entry = core.core.files[key];
  if (entry === undefined) return rec(path, typeCls, {r: 'unverifiable', reason: 'internal-error'});
  const cls = entryClass(entry);
  const extra: Partial<ItemRecord> = {
    key,
    expected: isExactEntry(entry) ? entry.sha256 : 'template',
  };
  if (status === 206) {
    return cls === 'media' || cls === 'image'
      ? rec(path, cls, {r: 'passive'}, extra)
      : rec(path, cls, {r: 'mismatch', reason: 'bytes'}, extra);
  }
  if (!contentTypeAllowed(cls, ctype))
    return rec(path, cls, {r: 'mismatch', reason: 'header'}, extra);
  if (body === null) return rec(path, cls, {r: 'unverifiable', reason: 'empty-body'}, extra);
  if (isExactEntry(entry)) {
    if (body.size === 0 && entry.size > 0) {
      return rec(path, cls, {r: 'unverifiable', reason: 'empty-body'}, extra);
    }
    return entry.sha256 === body.sha256
      ? rec(path, cls, {r: 'ok', how: 'exact'}, extra)
      : rec(path, cls, {r: 'mismatch', reason: 'bytes'}, extra);
  }
  if (isTemplateEntry(entry)) {
    if (body.size === 0) return rec(path, cls, {r: 'unverifiable', reason: 'empty-body'}, extra);
    const bound = {...i.binding.slots, ...r.bound};
    // Without the bytes (evicted after a restart) a template cannot be judged, never a mismatch.
    if (body.bytes === undefined)
      return rec(path, cls, {r: 'unverifiable', reason: 'internal-error'}, extra);
    const m = await matchTemplate(entry.template, body.bytes, bound);
    return m.ok
      ? rec(path, cls, {r: 'ok', how: 'template'}, extra)
      : rec(path, cls, {r: 'mismatch', reason: 'bytes'}, extra);
  }
  return rec(path, cls, {r: 'unverifiable', reason: 'internal-error'}, extra);
};
