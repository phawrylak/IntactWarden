/**
 * Closed validator for stylesheets that a self-hosted server generates
 * itself (profile `resources.server_styles`). Such a stylesheet is never part
 * of a core manifest: its bytes depend on the server's configuration and on
 * templates the admin may replace (Vaultwarden's `/css/vaultwarden.css`).
 * It cannot run script, but CSS can redress the UI and, with
 * `url()`, fonts or imports, send requests that leak what selectors match.
 * Hiding is not harmless either: `display: none` stops lazy-loaded images
 * (Vaultwarden's per-item `/icons/<host>/icon.png`) and virtual-scroll
 * fetches inside the hidden element, so a hiding rule whose selector depends
 * on vault data (`tr:has([title^="Edit item - a"]) app-vault-icon`) tells the
 * server what is on the page through the requests that never arrive.
 *
 * A validator therefore accepts only a shape that can do neither, and
 * everything else is UNVERIFIED_STYLE: `custom-rules`
 * for well-formed CSS with other rules or other selectors, `malformed` for
 * input the strict parser refuses. Nothing here builds a RegExp from data (R8).
 *
 * checkVaultwardenCss accepts what Vaultwarden's built-in template
 * (`src/static/templates/scss/vaultwarden.scss.hbs`) compiles to:
 * - rules whose only declaration is `display: none` (with or without
 *   `!important`) and whose selectors are all in
 *   VAULTWARDEN_STOCK_HIDE_SELECTORS: the selectors the stock template emits
 *   at server tags 1.36.0 to 1.37.5, for web vaults from 2025.5.1, on every
 *   configuration-flag combination. They are fixed strings that match app
 *   structure, never vault data. Any other hiding selector, including an
 *   admin's own, is `custom-rules`. The accepted selectors are returned so
 *   the UI can say what the server hides;
 * - the one icon rule of the template, exactly: selector
 *   `bit-nav-logo bit-nav-item a:before` with `content: ""`,
 *   `background-image: url("../images/icon-white.svg")` (a build file),
 *   `background-repeat: no-repeat`, `background-position: center center`,
 *   `height: 32px` and `display: block`, in any order.
 * The input must be printable ASCII plus tab, CR and LF, at most 64 KiB,
 * with no backslash (escapes), no '@' (at-rules such as @import and
 * @font-face), no comments and no nested blocks. Strings may not contain
 * their own delimiter, a newline, '{', '}' or ';'. Whitespace inside values
 * is normalised before comparison, and selectors are compared in a canonical
 * form (canonicalSelector), so compressed and expanded output of the same
 * rules are both accepted. The exact grass output on every config-flag
 * combination, and the list for later server tags, are not known yet.
 */

/** Upper bound on a server stylesheet (the stock Vaultwarden output is ~2 KB). */
export const MAX_SERVER_STYLE_BYTES = 64 * 1024;

export type StyleCheck =
  | {
      readonly ok: true;
      /** Selectors of the accepted `display: none` rules, one per entry, canonical, in order. */
      readonly hidden: readonly string[];
    }
  | {
      readonly ok: false;
      /** UNVERIFIED_STYLE reason code. */
      readonly reason: 'custom-rules' | 'malformed';
      readonly detail: string;
    };

interface Rule {
  /** Whitespace-normalised, for messages and the icon rule. */
  readonly selector: string;
  /** The selector text as written, for canonicalSelector. */
  readonly raw: string;
  readonly declarations: readonly {readonly name: string; readonly value: string}[];
}

class StyleSyntaxError extends Error {}

const ICON_SELECTOR = 'bit-nav-logo bit-nav-item a:before';
const ICON_DECLARATIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['content', ['""', "''"]],
  [
    'background-image',
    [
      'url("../images/icon-white.svg")',
      "url('../images/icon-white.svg')",
      'url(../images/icon-white.svg)',
    ],
  ],
  ['background-repeat', ['no-repeat']],
  ['background-position', ['center center']],
  ['height', ['32px']],
  ['display', ['block']],
]);

/**
 * The hiding selectors of Vaultwarden's stock `scss/vaultwarden.scss.hbs`, as
 * written there, at server tags 1.36.0 to 1.37.5 (template revisions
 * `ed63273a`, `7c23af76`, `52a3184e` by sha256 prefix), every
 * configuration-flag branch, for web vaults from 2025.5.1 (older branches
 * use backslash escapes, which the parser refuses anyway). Each one matches
 * app structure (element names, fixed routes, fixed classes and titles),
 * never vault data, and none can hide a per-item image. The list only grows,
 * with the vetted selectors of later server tags.
 */
export const VAULTWARDEN_STOCK_HIDE_SELECTORS: readonly string[] = [
  // Static changes (1.37.5)
  '.vw-hide',
  'head',
  'bit-nav-item[route="settings/subscription"]',
  'a[href$="/settings/sponsored-families"]',
  '.vw-email-sso',
  '.vw-email-continue',
  '.vw-continue-login',
  '.vw-sso-login',
  'app-user-layout app-password-settings app-webauthn-login-settings',
  '.vw-passkey-login',
  '.vw-or-text',
  '.vw-other-login',
  'bit-nav-item[route="settings/two-factor"]',
  'a[href$="/settings/two-factor"]',
  'app-organization-plans > form > bit-section:nth-child(2)',
  'app-org-account form.ng-untouched:nth-child(5)',
  'app-org-reports-home > app-report-list > div.tw-inline-grid > div:nth-child(6)',
  'app-security > app-two-factor-setup > form',
  ':is(bit-dialog, [bit-dialog]) div.tw-ml-4:has(bit-form-control input)',
  ':is(bit-dialog, [bit-dialog]) div.tw-col-span-4:has(input[formcontrolname*="access"], input[formcontrolname*="manage"])',
  'bit-nav-logo bit-nav-item .bwi-shield',
  'app-user-layout app-danger-zone button:nth-child(1)',
  'ng-dropdown-panel div.ng-dropdown-panel-items div:has(> [title="Firefox Relay"])',
  'ng-dropdown-panel div.ng-dropdown-panel-items div:has(> [title="DuckDuckGo"])',
  // Dynamic changes (1.37.5), each behind a configuration flag
  'app-root a[routerlink="/signup"]',
  'app-two-factor-auth > form > bit-form-control',
  '.providers-2fa-1',
  '.providers-2fa-3',
  '.providers-2fa-7',
  'bit-nav-item[route="settings/emergency-access"]',
  'bit-nav-item[route="sends"]',
  'a[routerlink="/hint"]',
  'app-change-password > form > .form-group:nth-child(5)',
  'auth-input-password > form > bit-form-field:nth-child(4)',
  '.vw-password-hint',
  'div:has(> app-change-email)',
  // 1.36.0, before the custom-role selectors were wrapped in :is() (1.37.0)
  'bit-dialog div.tw-ml-4:has(bit-form-control input)',
  'bit-dialog div.tw-col-span-4:has(input[formcontrolname*="access"], input[formcontrolname*="manage"])',
];

/** Checks Vaultwarden's server stylesheet (module comment). Never throws. */
export function checkVaultwardenCss(css: Uint8Array): StyleCheck {
  try {
    const rules = parseStylesheet(css);
    const hidden: string[] = [];
    for (const rule of rules) {
      if (isHideDeclaration(rule)) {
        for (const selector of splitSelectorList(rule.raw)) {
          const canonical = canonicalSelector(selector);
          if (!STOCK_HIDE.has(canonical)) {
            return {
              ok: false,
              reason: 'custom-rules',
              detail: `hiding selector ${JSON.stringify(canonical.slice(0, 120))} is not a stock Vaultwarden selector`,
            };
          }
          hidden.push(canonical);
        }
      } else if (!isIconRule(rule)) {
        return {
          ok: false,
          reason: 'custom-rules',
          detail: `rule ${JSON.stringify(rule.selector.slice(0, 120))} is not a hiding rule`,
        };
      }
    }
    return {ok: true, hidden};
  } catch (e) {
    const detail = e instanceof StyleSyntaxError ? e.message : 'unparseable stylesheet';
    return {ok: false, reason: 'malformed', detail};
  }
}

function isHideDeclaration(rule: Rule): boolean {
  if (rule.declarations.length !== 1) return false;
  const [d] = rule.declarations;
  return d!.name === 'display' && (d!.value === 'none' || d!.value === 'none !important');
}

function isIconRule(rule: Rule): boolean {
  if (rule.selector !== ICON_SELECTOR) return false;
  if (rule.declarations.length !== ICON_DECLARATIONS.size) return false;
  const seen = new Set<string>();
  for (const {name, value} of rule.declarations) {
    if (seen.has(name) || !(ICON_DECLARATIONS.get(name) ?? []).includes(value)) return false;
    seen.add(name);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Selector lists

/**
 * Splits a selector list on top-level commas (outside strings, parentheses
 * and brackets). The list already passed scanTo, so strings are well formed
 * and nesting is balanced. An empty item is refused.
 */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (ch === '"' || ch === "'") i = stringEnd(list, i);
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  for (const item of out) {
    if (normalise(item) === '') throw new StyleSyntaxError('empty selector in a selector list');
  }
  return out;
}

/** Whitespace before these, or after the ones in NO_SPACE_AFTER, never changes a selector. */
const NO_SPACE_BEFORE = '>+~,)]';
const NO_SPACE_AFTER = '>+~,([';

/**
 * A canonical spelling of one selector, so that the template's source and
 * grass's compressed output compare equal. It works on the raw selector
 * text, never on whitespace-normalised text, because whitespace inside a
 * string is significant. Whitespace runs become one space (a descendant
 * combinator); whitespace before `>`, `+`, `~`, `,`, `)` or `]`, after `>`,
 * `+`, `~`, `,`, `(` or `[`, and anywhere inside `[...]` is dropped; strings
 * are spelled with double quotes; an unquoted attribute value that is an
 * identifier is quoted (`[title=DuckDuckGo]` is `[title="DuckDuckGo"]`).
 * Space before `(` or `[` is kept: `a [x]` and `a[x]` differ. Each step
 * preserves what the selector matches, and anything else is kept as is, so
 * an unusual spelling simply fails to match the allowlist.
 */
function canonicalSelector(selector: string): string {
  let out = '';
  let space = false;
  let inBracket = false;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (isSpace(ch.charCodeAt(0))) {
      space = out.length > 0;
      continue;
    }
    const prev = out[out.length - 1]!;
    if (space && !inBracket && !NO_SPACE_BEFORE.includes(ch) && !NO_SPACE_AFTER.includes(prev)) {
      out += ' ';
    }
    space = false;
    if (ch === '"' || ch === "'") {
      const end = stringEnd(selector, i);
      const body = selector.slice(i + 1, end);
      out += body.includes('"') ? selector.slice(i, end + 1) : `"${body}"`;
      i = end;
      continue;
    }
    out += ch;
    if (ch === '[') inBracket = true;
    else if (ch === ']') inBracket = false;
    else if (inBracket && ch === '=') {
      // An unquoted identifier value is quoted; anything else stays as is.
      let j = i + 1;
      while (j < selector.length && isSpace(selector.charCodeAt(j))) j++;
      let k = j;
      while (k < selector.length && isIdentChar(selector.charCodeAt(k))) k++;
      const value = selector.slice(j, k);
      if (k > j && isIdentifier(value)) {
        out += `"${value}"`;
        i = k - 1;
      }
    }
  }
  return out;
}

function isIdentChar(c: number): boolean {
  return (
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x2d ||
    c === 0x5f
  );
}

/** An ASCII CSS identifier without escapes: not starting with a digit, or '-' then a digit. */
function isIdentifier(value: string): boolean {
  const first = value.charCodeAt(0);
  if (first >= 0x30 && first <= 0x39) return false;
  if (first === 0x2d) {
    const second = value.charCodeAt(1);
    if (value.length === 1 || (second >= 0x30 && second <= 0x39)) return false;
  }
  return true;
}

/** The allowlist in canonical form (after the constants canonicalSelector reads). */
const STOCK_HIDE: ReadonlySet<string> = new Set(
  VAULTWARDEN_STOCK_HIDE_SELECTORS.map(s => canonicalSelector(s)),
);

// ---------------------------------------------------------------------------
// Strict parser for the flat rule subset

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** Collapses whitespace runs to one space, trims, and spells "!important" as " !important". */
function normalise(text: string): string {
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += text[i];
  }
  const bang = out.indexOf('!');
  if (bang === -1) return out;
  const head = out.slice(0, bang).trimEnd();
  const tail = out.slice(bang + 1).trimStart();
  if (tail !== 'important' || out.indexOf('!', bang + 1) !== -1) return out;
  return `${head} !important`;
}

function parseStylesheet(css: Uint8Array): Rule[] {
  if (!(css instanceof Uint8Array)) throw new StyleSyntaxError('not bytes');
  if (css.length > MAX_SERVER_STYLE_BYTES) {
    throw new StyleSyntaxError(`larger than ${MAX_SERVER_STYLE_BYTES} bytes`);
  }
  let text = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (!(isSpace(c) || (c >= 0x20 && c <= 0x7e))) {
      throw new StyleSyntaxError(`byte 0x${c.toString(16)} at offset ${i} is not printable ASCII`);
    }
    if (c === 0x5c) throw new StyleSyntaxError('backslash escapes are not allowed');
    if (c === 0x40) throw new StyleSyntaxError('at-rules are not allowed');
    if (c === 0x2f && css[i + 1] === 0x2a) throw new StyleSyntaxError('comments are not allowed');
    text += String.fromCharCode(c);
  }

  const rules: Rule[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (i >= text.length) break;
    const open = scanTo(text, i, '{', '};');
    const raw = text.slice(i, open);
    const selector = normalise(raw);
    if (selector === '') throw new StyleSyntaxError('rule without a selector');
    const close = scanTo(text, open + 1, '}', '{');
    rules.push({selector, raw, declarations: parseDeclarations(text.slice(open + 1, close))});
    i = close + 1;
  }
  return rules;
}

/**
 * Index of the first `target` at or after `from` that is outside strings,
 * parentheses and brackets. Throws on any character of `forbidden` at that
 * level, on '{', '}' or ';' inside parentheses or brackets (CSS nests blocks
 * there, so brace matching would no longer agree with the browser's), on
 * unbalanced ')' or ']', on a malformed string and at the end of input.
 * With `untilEnd`, a missing `target` returns `text.length` instead.
 */
function scanTo(
  text: string,
  from: number,
  target: string,
  forbidden: string,
  untilEnd = false,
): number {
  const stack: string[] = [];
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      i = stringEnd(text, i);
      continue;
    }
    if (ch === '(' || ch === '[') {
      stack.push(ch === '(' ? ')' : ']');
      continue;
    }
    if (ch === ')' || ch === ']') {
      if (stack.pop() !== ch) throw new StyleSyntaxError(`unbalanced "${ch}" at offset ${i}`);
      continue;
    }
    if (stack.length > 0) {
      if (ch === '{' || ch === '}' || ch === ';') {
        throw new StyleSyntaxError(`"${ch}" inside parentheses or brackets at offset ${i}`);
      }
      continue;
    }
    if (ch === target) return i;
    if (forbidden.includes(ch)) throw new StyleSyntaxError(`unexpected "${ch}" at offset ${i}`);
  }
  if (stack.length > 0) throw new StyleSyntaxError('unclosed parenthesis or bracket');
  if (untilEnd) return text.length;
  throw new StyleSyntaxError(`missing "${target}"`);
}

/** Index of the closing quote of the string starting at `start`. */
function stringEnd(text: string, start: number): number {
  const quote = text[start]!;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === quote) return i;
    if (ch === '\n' || ch === '\r' || ch === '{' || ch === '}' || ch === ';') {
      throw new StyleSyntaxError(`unexpected character in a string at offset ${i}`);
    }
  }
  throw new StyleSyntaxError('unterminated string');
}

/** The declarations of a block (no '{' or '}' inside), split on top-level ';'. */
function parseDeclarations(block: string): {name: string; value: string}[] {
  const out: {name: string; value: string}[] = [];
  let start = 0;
  while (start <= block.length) {
    const end = scanTo(block, start, ';', '', true);
    const text = block.slice(start, end);
    start = end + 1;
    if (normalise(text) === '') continue;
    const colon = scanTo(text, 0, ':', '');
    const name = normalise(text.slice(0, colon));
    const value = normalise(text.slice(colon + 1));
    // A second top-level ':' is refused ('' never matches, so this scans to the end).
    scanTo(text, colon + 1, '', ':', true);
    if (!isPropertyName(name) || value === '') {
      throw new StyleSyntaxError(`malformed declaration ${JSON.stringify(normalise(text))}`);
    }
    out.push({name, value});
  }
  return out;
}

/** Lowercase property names only (no custom properties, no vendor-case tricks). */
function isPropertyName(name: string): boolean {
  if (name.length === 0 || name.length > 64 || name.startsWith('--')) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 0x61 && c <= 0x7a) || c === 0x2d)) return false;
  }
  return true;
}
