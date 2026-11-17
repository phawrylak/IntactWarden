/**
 * DOM sentinel: a MutationObserver plus an initial scan for inline
 * `<script>`, `on*` attributes, `srcdoc`, `blob:` and `data:` frames, `<base>`, `<object>`,
 * `<embed>`, `javascript:` URLs and `<script src>` of another origin (each distinct URL reported
 * once). It starts at document_start, before page scripts, and counts hits until the background's
 * sensor configuration arrives. Signals only: counts and redacted locations, never page content.
 */

import {redactUrl} from '@intactwarden/core/privacy/redactUrl.ts';
import type {DomDetail, DomEvent} from '../contracts.ts';

export type SentinelReport = (event: DomEvent, detail: DomDetail) => void;

const JS_TYPES = new Set([
  '',
  'module',
  'importmap',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jscript',
  'text/x-javascript',
  'application/x-javascript',
]);

const URL_ATTRS = ['src', 'href', 'action', 'formaction', 'data'];

export interface Sentinel {
  /** Starts reporting (and flushes what was counted so far). */
  configure(): void;
  stop(): void;
}

interface Hit {
  count: number;
  what?: string;
  url?: string;
}

/** At most this many distinct third-party script URLs are reported per document. */
const MAX_THIRD_PARTY_URLS = 32;

export function startSentinel(
  root: Node,
  report: SentinelReport,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  ownOrigin: string | null = (globalThis as {location?: {origin?: string}}).location?.origin ??
    null,
): Sentinel {
  let configured = false;
  const hits = new Map<string, Hit & {event: DomEvent}>();
  const thirdParty = new Set<string>();
  let flushScheduled = false;

  const hit = (event: DomEvent, what?: string, url?: string): void => {
    // Third-party scripts are reported per URL; everything else is counted per event.
    const key = event === 'third-party-script' && url !== undefined ? `${event} ${url}` : event;
    const h = hits.get(key) ?? {event, count: 0};
    h.count++;
    if (what !== undefined) h.what ??= what;
    if (url !== undefined) h.url ??= redactUrl(url);
    hits.set(key, h);
    if (configured && !flushScheduled) {
      flushScheduled = true;
      schedule(flush, 200);
    }
  };

  const crossOriginScript = (el: Element, value: string | null): void => {
    if (value === null || ownOrigin === null) return;
    let u: URL;
    try {
      u = new URL(value.trim(), el.baseURI ?? undefined);
    } catch {
      return;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin === ownOrigin) return;
    const url = redactUrl(u.href);
    if (thirdParty.has(url) || thirdParty.size >= MAX_THIRD_PARTY_URLS) return;
    thirdParty.add(url);
    hit('third-party-script', 'script', url);
  };

  const flush = (): void => {
    flushScheduled = false;
    if (!configured) return;
    for (const h of hits.values()) {
      report(h.event, {
        count: h.count,
        ...(h.what !== undefined ? {what: h.what} : {}),
        ...(h.url !== undefined ? {url: h.url} : {}),
      });
    }
    hits.clear();
  };

  const checkElement = (el: Element): void => {
    const tag = el.localName;
    for (const a of Array.from(el.attributes)) checkAttribute(el, a.name, a.value);
    if (tag === 'script') {
      const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
      if (!el.hasAttribute('src') && JS_TYPES.has(type)) hit('inline-script', 'script');
    } else if (tag === 'base') {
      hit('base-element', 'base');
    } else if (tag === 'object' || tag === 'embed') {
      hit('object-element', tag);
    }
  };

  const checkAttribute = (el: Element, name: string, value: string | null): void => {
    const n = name.toLowerCase();
    if (n.startsWith('on')) {
      hit('inline-handler', n);
      return;
    }
    if (value === null) return;
    const v = value.trim().toLowerCase();
    const tag = el.localName;
    if (tag === 'script' && n === 'src') {
      // An executable script element (its `src` checked on insertion and on every change).
      const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
      if (JS_TYPES.has(type)) crossOriginScript(el, value);
    }
    if (n === 'srcdoc' && (tag === 'iframe' || tag === 'frame')) hit('srcdoc', tag);
    if (URL_ATTRS.includes(n)) {
      if (v.startsWith('javascript:')) hit('javascript-url', tag);
      else if ((tag === 'iframe' || tag === 'frame') && v.startsWith('blob:'))
        hit('blob-frame', tag);
      else if ((tag === 'iframe' || tag === 'frame') && v.startsWith('data:'))
        hit('data-frame', tag);
    }
  };

  const scan = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    checkElement(el);
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) checkElement(all[i]!);
  };

  const observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach(scan);
      } else if (r.type === 'attributes' && r.attributeName !== null && r.target.nodeType === 1) {
        const el = r.target as Element;
        checkAttribute(el, r.attributeName, el.getAttribute(r.attributeName));
      }
    }
  });
  observer.observe(root, {childList: true, subtree: true, attributes: true});
  scan((root as Document).documentElement ?? root);

  return {
    configure() {
      configured = true;
      flush();
    },
    stop() {
      observer.disconnect();
      hits.clear();
    },
  };
}
