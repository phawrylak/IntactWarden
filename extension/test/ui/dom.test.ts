/**
 * textContent-only DOM helpers: strings
 * become text nodes, attributes go through an allowlist, unsafe links render
 * as text. Runs against a tiny fake document whose `innerHTML` throws.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {button, checkbox, el, isSafeHref, link, mount} from '../../src/ui/shared/dom.ts';

class FakeNode {
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  readonly nodeName: string;
  private readonly ownText: string;
  constructor(nodeName: string, ownText = '') {
    this.nodeName = nodeName;
    this.ownText = ownText;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.nodeName === '#text'
      ? this.ownText
      : this.childNodes.map(c => c.textContent).join('');
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  className = '';
  id = '';
  disabled = false;
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML must never be used');
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  createTextNode: (text: string) => new FakeNode('#text', text),
};

let saved: unknown;
beforeEach(() => {
  saved = (globalThis as {document?: unknown}).document;
  (globalThis as {document?: unknown}).document = fakeDocument;
});
afterEach(() => {
  (globalThis as {document?: unknown}).document = saved;
});

describe('el', () => {
  it('creates text nodes for strings, even when they look like markup', () => {
    const node = el('p', {class: 'x', id: 'y'}, '<img src=x onerror=alert(1)>', null, false, [
      'a',
      ['b'],
    ]) as unknown as FakeElement;
    expect(node.childNodes.map(c => c.nodeName)).toEqual(['#text', '#text', '#text']);
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>ab');
    expect(node.className).toBe('x');
    expect(node.id).toBe('y');
  });

  it('refuses event-handler attributes, inline styles and unsafe links', () => {
    expect(() => el('div', {attrs: {onclick: 'x'}})).toThrow(/not allowed/);
    expect(() => el('div', {attrs: {style: 'color:red'}})).toThrow(/not allowed/);
    expect(() => el('a', {attrs: {href: 'javascript:alert(1)'}})).toThrow(/unsafe href/);
    const ok = el('input', {
      attrs: {type: 'checkbox', checked: true, disabled: false, 'aria-label': 'x', 'data-id': '1'},
    }) as unknown as FakeElement;
    expect([...ok.attributes]).toEqual([
      ['type', 'checkbox'],
      ['checked', ''],
      ['aria-label', 'x'],
      ['data-id', '1'],
    ]);
  });

  it('mount replaces children', () => {
    const root = el('div', null, 'old') as unknown as FakeElement;
    mount(root as unknown as Node, 'new', el('b', null, '!'));
    expect(root.textContent).toBe('new!');
  });
});

describe('links and controls', () => {
  it('allows https and relative extension pages only', () => {
    expect(isSafeHref('https://github.com/bitwarden/clients/releases/tag/web-v2026.10.1')).toBe(
      true,
    );
    expect(isSafeHref('details.html#42')).toBe(true);
    expect(isSafeHref('details.html#42')).toBe(true);
    expect(isSafeHref('http://example.org')).toBe(false);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,x')).toBe(false);
    expect(isSafeHref('../secret.html')).toBe(false);
    const unsafe = link('javascript:alert(1)', 'click') as unknown as FakeElement;
    expect(unsafe.nodeName).toBe('SPAN');
    const external = link('https://github.com/x/y', 'repo') as unknown as FakeElement;
    expect(external.attributes.get('rel')).toBe('noopener noreferrer');
    expect(external.attributes.get('target')).toBe('_blank');
  });

  it('labels checkboxes and buttons for assistive technology', () => {
    const box = checkbox('c1', 'Label', true, () => undefined, {
      hint: 'Hint',
    }) as unknown as FakeElement;
    const [input, label, hint] = box.childNodes as FakeElement[];
    expect(input!.attributes.get('aria-describedby')).toBe('c1-hint');
    expect(label!.attributes.get('for')).toBe('c1');
    expect(hint!.id).toBe('c1-hint');
    const b = button('Go', () => undefined, {kind: 'primary'}) as unknown as FakeElement;
    expect(b.attributes.get('type')).toBe('button');
    expect(b.className).toBe('btn btn-primary');
  });
});
