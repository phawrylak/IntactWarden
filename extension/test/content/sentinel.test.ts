/**
 * DOM sentinel (content/sentinel.ts) on a minimal fake DOM: script elements of another origin are
 * reported once per URL; same-origin scripts, non-executable script types and non-http(s) URLs are
 * not.
 */

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {DomDetail, DomEvent} from '../../src/contracts.ts';
import {startSentinel} from '../../src/content/sentinel.ts';

interface FakeEl {
  nodeType: 1;
  localName: string;
  baseURI: string;
  attributes: {name: string; value: string}[];
  children: FakeEl[];
  getAttribute(n: string): string | null;
  hasAttribute(n: string): boolean;
  getElementsByTagName(t: string): FakeEl[];
}

function el(
  localName: string,
  attrs: Record<string, string> = {},
  children: FakeEl[] = [],
): FakeEl {
  const attributes = Object.entries(attrs).map(([name, value]) => ({name, value}));
  const e: FakeEl = {
    nodeType: 1,
    localName,
    baseURI: 'https://vault.bitwarden.com/',
    attributes,
    children,
    getAttribute: n => attributes.find(a => a.name === n)?.value ?? null,
    hasAttribute: n => attributes.some(a => a.name === n),
    getElementsByTagName: () => {
      const out: FakeEl[] = [];
      const walk = (x: FakeEl): void => {
        for (const c of x.children) {
          out.push(c);
          walk(c);
        }
      };
      walk(e);
      return out;
    },
  };
  return e;
}

type Callback = (records: unknown[]) => void;
let observerCallback: Callback | null = null;
const saved = (globalThis as Record<string, unknown>)['MutationObserver'];

beforeAll(() => {
  (globalThis as Record<string, unknown>)['MutationObserver'] = class {
    constructor(cb: Callback) {
      observerCallback = cb;
    }
    observe(): void {}
    disconnect(): void {}
  };
});

afterAll(() => {
  (globalThis as Record<string, unknown>)['MutationObserver'] = saved;
});

describe('sentinel: scripts of another origin', () => {
  it('reports each third-party script URL once, at load and when added later', () => {
    const reports: [DomEvent, DomDetail][] = [];
    const html = el('html', {}, [
      el('head', {}, [
        el('script', {src: '/app/main.js'}),
        el('script', {src: 'https://js.stripe.com/v3/?key=secret#x'}),
        el('script', {type: 'text/template', src: 'https://evil.example/t.html'}),
        el('script', {src: 'data:text/javascript,1'}),
      ]),
    ]);
    const root = {nodeType: 9, documentElement: html};
    const flushes: (() => void)[] = [];
    const s = startSentinel(
      root as unknown as Node,
      (e, d) => reports.push([e, d]),
      fn => flushes.push(fn),
      'https://vault.bitwarden.com',
    );
    s.configure();
    expect(reports).toEqual([
      ['third-party-script', {count: 1, what: 'script', url: 'https://js.stripe.com/v3/'}],
    ]);
    // Added by the page later, plus the same URL again.
    observerCallback?.([
      {
        type: 'childList',
        addedNodes: [
          el('script', {src: 'https://www.paypalobjects.com/api/checkout.min.js'}),
          el('script', {src: 'https://js.stripe.com/v3/'}),
        ],
      },
    ]);
    for (const f of flushes.splice(0)) f();
    expect(reports.slice(1)).toEqual([
      [
        'third-party-script',
        {count: 1, what: 'script', url: 'https://www.paypalobjects.com/api/checkout.min.js'},
      ],
    ]);
    s.stop();
  });
});
