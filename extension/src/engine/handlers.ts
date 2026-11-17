/**
 * Background message handlers of the engine: the CS_* messages of content scripts and the UI_*
 * messages of extension pages.
 *
 * Tab and frame come only from the router's validated sender; a content script's claimed DocKey
 * must equal the backend's DocKey for that sender, otherwise the message is ignored. Payloads are
 * checked for shape before they reach the engine.
 */

import {redactUrl} from '@intactwarden/core/privacy/redactUrl.ts';
import type {AllowanceRequest, DomEvent} from '../contracts.ts';
import type {SenderDoc} from '../backends/types.ts';
import {MessageError, type Router, type SenderContext} from '../platform/messaging.ts';
import type {EngineRuntime} from './types.ts';

const DOM_EVENTS: ReadonlySet<string> = new Set<DomEvent>([
  'inline-script',
  'inline-handler',
  'sw-register',
  'blob-frame',
  'data-frame',
  'srcdoc',
  'base-element',
  'object-element',
  'javascript-url',
  'third-party-script',
]);

const SHA256 = /^[0-9a-f]{64}$/;

function contentSender(s: SenderContext): SenderDoc {
  if (s.kind !== 'content' || s.tab === null) throw new MessageError('bad-sender');
  return {
    tab: s.tab,
    frame: s.frame ?? 0,
    url: s.url,
    ...(s.incognito === true ? {incognito: true} : {}),
  };
}

const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length <= max;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function tabOf(p: unknown): number {
  const t = (p as {tab?: unknown} | null)?.tab;
  if (!int(t) || t < 0) throw new MessageError('bad-message');
  return t;
}

function allowance(v: unknown): AllowanceRequest {
  if (typeof v !== 'object' || v === null) throw new MessageError('bad-message');
  const x = v as Record<string, unknown>;
  switch (x.k) {
    case 'third-party':
      if (str(x.id, 128)) return {k: 'third-party', id: x.id};
      break;
    case 'server-style':
      if (str(x.path, 1024) && x.path.startsWith('/')) return {k: 'server-style', path: x.path};
      break;
    case 'proceed-once':
      if (str(x.sha256, 64) && SHA256.test(x.sha256)) return {k: x.k, sha256: x.sha256};
      break;
  }
  throw new MessageError('bad-message');
}

export function registerEngineHandlers(router: Router, engine: EngineRuntime): void {
  router.handle('CS_HELLO', async (_p, s) => engine.hello(contentSender(s)));
  router.handle('CS_DOM', async (p, s) => {
    if (!str(p?.doc, 200) || !str(p?.event, 32) || !DOM_EVENTS.has(p.event)) {
      throw new MessageError('bad-message');
    }
    const count = int(p.detail?.count) ? p.detail.count : 1;
    await engine.contentDom(contentSender(s), {
      doc: p.doc,
      event: p.event,
      detail: {
        count,
        ...(str(p.detail?.what, 64) ? {what: p.detail.what} : {}),
        ...(str(p.detail?.url, 4096) ? {url: redactUrl(p.detail.url)} : {}),
      },
    });
    return null;
  });
  router.handle('CS_CSP_VIOLATION', async (p, s) => {
    if (!str(p?.doc, 200) || !str(p?.directive, 64)) throw new MessageError('bad-message');
    const blocked = str(p.blockedUrl, 4096) ? p.blockedUrl : '';
    await engine.contentCspViolation(contentSender(s), {
      doc: p.doc,
      directive: p.directive,
      blockedUrl: blocked === 'inline' || blocked === 'eval' ? blocked : redactUrl(blocked),
    });
    return null;
  });
  router.handle('UI_GET_STATE', async p => engine.tabState(tabOf(p)));
  router.handle('UI_GET_DETAILS', async p => engine.details(tabOf(p)));
  router.handle('UI_GET_BLOCKED', async p => {
    if (!str(p?.incidentId, 64)) throw new MessageError('bad-message');
    return engine.blockedView(p.incidentId);
  });
  router.handle('UI_ACK_ALERT', async p => {
    if (!str(p?.origin, 512)) throw new MessageError('bad-message');
    return engine.acknowledgeAlert(p.origin);
  });
  router.handle('UI_LIST_ALERTS', async () => engine.listAlerts());
  router.handle('UI_LIST_INCIDENTS', async p => {
    const limit = int(p?.limit) ? Math.max(1, Math.min(p.limit, 500)) : 100;
    return engine.listIncidents(limit);
  });
  router.handle('UI_ALLOW_FOR_TAB', async p => {
    await engine.allowForTab(tabOf(p), allowance(p?.allowance));
    return null;
  });
}
