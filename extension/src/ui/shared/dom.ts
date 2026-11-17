/**
 * textContent-only DOM helpers (no
 * innerHTML, every string set with textContent). Text children become text
 * nodes; attributes go through an allowlist, so no event-handler attribute,
 * inline style or `javascript:` link can be created from data.
 */

// A type-only DOM global (lib.dom.d.ts); ESLint's no-undef does not know types.
// eslint-disable-next-line no-undef
type TagMap = HTMLElementTagNameMap;

export type Child = Node | string | null | undefined | false;
/** A child or (nested) arrays of children. */
export type Children = Child | readonly Children[];

export interface Props {
  readonly class?: string;
  readonly id?: string;
  /** Allowlisted attributes (see ALLOWED_ATTRS and `aria-*` / `data-*`). */
  readonly attrs?: Readonly<Record<string, string | boolean | number | null | undefined>>;
  /** Event listeners by event type ("click", "change", "input", ...). */
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
}

const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  'role',
  'title',
  'type',
  'name',
  'value',
  'for',
  'href',
  'target',
  'rel',
  'disabled',
  'checked',
  'selected',
  'hidden',
  'lang',
  'dir',
  'tabindex',
  'autocomplete',
  'inputmode',
  'spellcheck',
  'placeholder',
  'required',
  'max',
  'min',
  'open',
  'scope',
  'colspan',
  'datetime',
  'translate',
]);

/** True for an href this UI may create: https, or a relative extension page ("details.html#3"). */
export function isSafeHref(href: string): boolean {
  if (href.startsWith('https://')) {
    try {
      return new URL(href).protocol === 'https:';
    } catch {
      return false;
    }
  }
  return /^[a-z]+\.html(?:#[A-Za-z0-9@._+:=&-]*)?$/.test(href);
}

function setAttr(node: Element, name: string, value: string | boolean | number): void {
  const lower = name.toLowerCase();
  const allowed =
    ALLOWED_ATTRS.has(lower) || /^aria-[a-z]+$/.test(lower) || /^data-[a-z-]+$/.test(lower);
  if (!allowed) throw new Error(`dom: attribute not allowed: ${name}`);
  if (lower === 'href' && !isSafeHref(String(value))) throw new Error('dom: unsafe href');
  if (typeof value === 'boolean') {
    if (value) node.setAttribute(lower, '');
    else node.removeAttribute(lower);
    return;
  }
  node.setAttribute(lower, String(value));
}

function append(node: Node, child: Children): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child as readonly Children[]) append(node, c);
    return;
  }
  node.appendChild(typeof child === 'string' ? document.createTextNode(child) : (child as Node));
}

/** Creates an element; string children become text nodes (never parsed as markup). */
export function el<K extends keyof TagMap>(
  tag: K,
  props?: Props | null,
  ...children: readonly Children[]
): TagMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.class) node.className = props.class;
    if (props.id) node.id = props.id;
    for (const [name, value] of Object.entries(props.attrs ?? {})) {
      if (value !== null && value !== undefined) setAttr(node, name, value);
    }
    for (const [event, handler] of Object.entries(props.on ?? {})) {
      if (handler) node.addEventListener(event, handler);
    }
  }
  append(node, children);
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replaces the children of `node`. */
export function mount(node: Node, ...children: readonly Children[]): void {
  clear(node);
  append(node, children);
}

/** A link to GitHub or to another extension page; unsafe hrefs render as plain text. */
export function link(href: string | null, text: string, title?: string): HTMLElement {
  if (href === null || !isSafeHref(href)) return el('span', {attrs: {title}}, text);
  const external = href.startsWith('https://');
  return el(
    'a',
    {attrs: {href, title, ...(external ? {target: '_blank', rel: 'noopener noreferrer'} : {})}},
    text,
  );
}

/** A labelled checkbox; `onChange` receives the new value. */
export function checkbox(
  id: string,
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  options: {readonly disabled?: boolean; readonly hint?: string} = {},
): HTMLElement {
  const input = el('input', {
    id,
    attrs: {
      type: 'checkbox',
      checked,
      disabled: options.disabled ?? false,
      'aria-describedby': options.hint ? `${id}-hint` : undefined,
    },
    on: {change: e => onChange((e.target as HTMLInputElement).checked)},
  });
  return el(
    'div',
    {class: 'field field-check'},
    input,
    el('label', {attrs: {for: id}}, label),
    options.hint ? el('p', {class: 'hint', id: `${id}-hint`}, options.hint) : null,
  );
}

export function button(
  text: string,
  onClick: (event: Event) => void,
  options: {
    readonly kind?: 'primary' | 'secondary' | 'danger';
    readonly disabled?: boolean;
    readonly id?: string;
  } = {},
): HTMLButtonElement {
  return el(
    'button',
    {
      class: `btn btn-${options.kind ?? 'secondary'}`,
      ...(options.id ? {id: options.id} : {}),
      attrs: {type: 'button', disabled: options.disabled ?? false},
      on: {click: onClick},
    },
    text,
  );
}

/** A section with a heading (h2) and an id for the heading (aria-labelledby). */
export function section(
  id: string,
  heading: string,
  ...children: readonly Children[]
): HTMLElement {
  return el(
    'section',
    {class: 'card', id, attrs: {'aria-labelledby': `${id}-h`}},
    el('h2', {id: `${id}-h`}, heading),
    ...children,
  );
}
