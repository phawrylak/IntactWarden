/**
 * Content-script entry (content/main.ts) with a minimal fake window: one hello per document, no
 * page lifecycle listener, and a page-dispatched (untrusted) `securitypolicyviolation` is ignored.
 * Separate file because it installs globals.
 */

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

type Listener = (e: Record<string, unknown>) => void;

const windowListeners = new Map<string, Listener[]>();
const documentListeners = new Map<string, Listener[]>();
const sent: {type: string; payload: unknown}[] = [];
let created = 0;
const messageListeners: ((m: unknown, sender: unknown) => unknown)[] = [];

function fire(map: Map<string, Listener[]>, type: string, e: Record<string, unknown>): void {
  for (const l of map.get(type) ?? []) l(e);
}

const saved: Record<string, unknown> = {};
const g = globalThis as Record<string, unknown>;

beforeAll(async () => {
  for (const k of ['window', 'location', 'document', 'MutationObserver']) saved[k] = g[k];
  const win = {
    addEventListener: (t: string, l: Listener) =>
      windowListeners.set(t, [...(windowListeners.get(t) ?? []), l]),
  } as Record<string, unknown>;
  win['top'] = win;
  g['window'] = win;
  g['location'] = {protocol: 'https:', href: 'https://vault.example/', hash: ''};
  g['MutationObserver'] = class {
    observe(): void {}
    disconnect(): void {}
  };
  g['document'] = {
    documentElement: {
      nodeType: 1,
      localName: 'html',
      attributes: [],
      getElementsByTagName: () => [],
    },
    addEventListener: (t: string, l: Listener) =>
      documentListeners.set(t, [...(documentListeners.get(t) ?? []), l]),
    // Counted, then refused (the fake has no DOM): the content script never builds page UI.
    createElement: () => {
      created++;
      throw new Error('no DOM in this test');
    },
  };
  const {boot} = await import('../../src/content/main.ts');
  const ext = {
    runtime: {
      id: 'x',
      sendMessage: async (m: {type: string; payload: unknown}) => {
        sent.push({type: m.type, payload: m.payload});
        return m.type === 'CS_HELLO'
          ? {
              ok: true,
              value: {doc: '2:0:7', protected: true},
            }
          : {ok: true, value: null};
      },
      onMessage: {
        addListener: (l: (m: unknown, sender: unknown) => unknown) => messageListeners.push(l),
      },
    },
  };
  boot(ext as never);
  await new Promise(r => setTimeout(r, 10));
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
});

describe('content script', () => {
  it('announces the document once and listens to no page lifecycle event', () => {
    expect(sent.filter(m => m.type === 'CS_HELLO').map(m => m.payload)).toEqual([{}]);
    // No port to the background (nothing keeps the event page alive), and nothing for a
    // back/forward cache restore: protected documents are no-store, which Firefox never restores.
    expect([...windowListeners.keys()]).toEqual([]);
  });

  it('a forged securitypolicyviolation is not reported', () => {
    fire(documentListeners, 'securitypolicyviolation', {
      isTrusted: false,
      blockedURI: 'inline',
      effectiveDirective: 'script-src-elem',
      disposition: 'enforce',
    });
    expect(sent.filter(m => m.type === 'CS_CSP_VIOLATION')).toEqual([]);
    fire(documentListeners, 'securitypolicyviolation', {
      isTrusted: true,
      blockedURI: 'inline',
      effectiveDirective: 'script-src-elem',
      disposition: 'enforce',
    });
    expect(sent.filter(m => m.type === 'CS_CSP_VIOLATION')).toHaveLength(1);
  });

  it('shows nothing in the page and takes no message from the background', () => {
    expect(created).toBe(0);
    expect(messageListeners).toEqual([]);
  });
});
