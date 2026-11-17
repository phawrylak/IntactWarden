/**
 * Server-path classification before routing (profile resources.server_styles / dynamic_same_origin
 * / not_covered_paths / deployment server_rendered, relative to the deployment or instance base
 * path). Pure.
 *
 * Order: server stylesheets first (exact paths); then, for documents, the
 * declared server-rendered pages before dynamic paths (Vaultwarden's
 * `/identity/connect/authorize` is an auth-flow page while `/identity/**`
 * XHRs are data); for other types the dynamic paths first.
 */

import {matchPathGlob} from '@intactwarden/core/schema/profile.ts';
import type {ClassifyServerPath, ProtectedOrigin, ServerPathClass} from '../contracts.ts';
import {applies, isDocumentType, originOfUrl, pathOfUrl, relativePath} from './util.ts';

function dynamic(origin: ProtectedOrigin, rel: string): ServerPathClass | null {
  for (const rule of origin.profile.resources.dynamic_same_origin) {
    if (applies(origin, rule.deployments) && matchPathGlob(rule.path, rel)) {
      return {k: 'dynamic'};
    }
  }
  return null;
}

function rendered(origin: ProtectedOrigin, rel: string): ServerPathClass | null {
  for (const r of origin.deployment.server_rendered ?? []) {
    if (matchPathGlob(r.path, rel)) return {k: 'server-rendered', class: r.class};
  }
  return null;
}

function notCovered(origin: ProtectedOrigin, rel: string): ServerPathClass | null {
  for (const n of origin.profile.resources.not_covered_paths) {
    if (applies(origin, n.deployments) && matchPathGlob(n.path, rel)) {
      return {k: 'not-covered', reason: n.reason};
    }
  }
  return null;
}

export const classifyServerPath: ClassifyServerPath = (origin, url, type) => {
  if (originOfUrl(url) !== origin.origin) return {k: 'cross-origin'};
  const path = pathOfUrl(url);
  // A path that does not normalise is left to mapUrl, which answers `invalid`.
  if (path === null) return {k: 'build'};
  const rel = relativePath(origin, path);
  if (rel === null) return {k: 'outside-base'};
  for (const s of origin.profile.resources.server_styles ?? []) {
    if (applies(origin, s.deployments) && s.path === rel) return {k: 'server-style', style: s};
  }
  const order = isDocumentType(type)
    ? [rendered, notCovered, dynamic]
    : [dynamic, notCovered, rendered];
  for (const f of order) {
    const c = f(origin, rel);
    if (c !== null) return c;
  }
  return {k: 'build'};
};
