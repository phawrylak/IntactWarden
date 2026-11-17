import {describe, expect, it} from 'vitest';
import {
  DeriveError,
  deriveCloudConnectorJs,
  deriveCloudHtml,
  deriveCloudMain,
  extractCacheTag,
  type BitwardenConfigs,
} from '../src/derive/bitwarden-cloud-v1.ts';

// Synthetic mini-bundles shaped like the real web-v2026.10.1 files: every
// needle sits in the same minified context as in the release bundle.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder('utf-8', {ignoreBOM: true}).decode(b);

const HASH_A = '0123456789abcdef0123';
const HASH_B = 'fedcba9876543210fedc';

const BASE = {
  urls: {},
  stripeKey: 'pk_test_KEY',
  braintreeKey: 'sandbox_KEY',
  paypal: {businessId: 'SANDBOXBIZ', buttonAction: 'https://www.sandbox.paypal.com/cgi-bin/webscr'},
  dev: {port: 8080, allowedHosts: 'auto'},
  flags: {sdk: true},
  devFlags: {},
};

const CLOUD = {
  urls: {icons: 'https://icons.example.net', notifications: 'https://notifications.example.com'},
  stripeKey: 'pk_live_KEY',
  braintreeKey: 'production_KEY',
  paypal: {businessId: 'LIVEBIZ', buttonAction: 'https://www.paypal.com/cgi-bin/webscr'},
  dev: {proxyApi: 'https://api.example.com'},
  flags: {},
};

const CFG: BitwardenConfigs = {base: BASE, env: CLOUD, envName: 'cloud'};

/** Pieces of the synthetic main bundle, keyed by rule. */
const MAIN_PARTS = {
  head: '(()=>{var e={1:(e,t,s)=>{',
  i18n: 'const t=this.localesDirectory+"/"+e+"/messages.json?cache=i9gaj5",n=yield fetch(t);',
  urls: '(0,se.F)({provide:$y,useValue:{}}),',
  paypal:
    'this.payPalConfig={businessId:"SANDBOXBIZ",buttonAction:"https://www.sandbox.paypal.com/cgi-bin/webscr"},',
  braintree: 'window.braintree.dropin.create({authorization:"sandbox_KEY",container:this.c}),',
  dropin: 'i.src="scripts/dropin.js?cache=i9gaj5",',
  stripe: 'this.stripe=n.Stripe("pk_test_KEY"),',
  env: 'static isSelfHost(){return"selfhosted"==="selfhosted".toString()}',
  tail: '}}})();\n//# sourceMappingURL=main.' + HASH_A + '.js.map',
};

type MainPart = keyof typeof MAIN_PARTS;

function mainText(over: Partial<Record<MainPart, string>> = {}): string {
  const parts = {...MAIN_PARTS, ...over};
  return (Object.keys(MAIN_PARTS) as MainPart[]).map(k => parts[k]).join('');
}

const EXPECTED_MAIN = mainText({
  i18n: 'const t=this.localesDirectory+"/"+e+"/messages.json?cache=w4e0z",n=yield fetch(t);',
  urls: '(0,se.F)({provide:$y,useValue:{icons:"https://icons.example.net",notifications:"https://notifications.example.com"}}),',
  paypal:
    'this.payPalConfig={businessId:"LIVEBIZ",buttonAction:"https://www.paypal.com/cgi-bin/webscr"},',
  braintree: 'window.braintree.dropin.create({authorization:"production_KEY",container:this.c}),',
  dropin: 'i.src="scripts/dropin.js?cache=w4e0z",',
  stripe: 'this.stripe=n.Stripe("pk_live_KEY"),',
  env: 'static isSelfHost(){return"selfhosted"==="cloud".toString()}',
  tail: '}}})();\n//# sourceMappingURL=main.' + HASH_B + '.js.map',
});

const MAP_B = `main.${HASH_B}.js.map`;

function derive(text: string, cfg: BitwardenConfigs = CFG, tag = 'w4e0z', map = MAP_B): string {
  return dec(deriveCloudMain(enc(text), cfg, tag, map).bytes);
}

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function expectDeriveError(fn: () => unknown, message: RegExp): void {
  expect(fn).toThrow(DeriveError);
  expect(fn).toThrow(message);
}

describe('extractCacheTag', () => {
  it('reads the tag and requires all occurrences to agree', () => {
    expect(extractCacheTag(mainText())).toBe('i9gaj5');
    const two = 'a="x/messages.json?cache=ab1"; b="y/messages.json?cache=ab1"';
    expect(extractCacheTag(two)).toBe('ab1');
    expectDeriveError(
      () => extractCacheTag('a="messages.json?cache=ab1";b="messages.json?cache=ab2"'),
      /disagree/,
    );
  });

  it('fails closed on missing, malformed, unterminated or oversized tags', () => {
    expectDeriveError(() => extractCacheTag('nothing here'), /no messages\.json\?cache=/);
    expectDeriveError(() => extractCacheTag('"messages.json?cache="'), /CACHE_TAG must match/);
    expectDeriveError(() => extractCacheTag('"messages.json?cache=AB1"'), /CACHE_TAG must match/);
    expectDeriveError(() => extractCacheTag('"messages.json?cache=a-b"'), /CACHE_TAG must match/);
    expectDeriveError(
      () => extractCacheTag('"messages.json?cache=abcdefghijkl"'),
      /no closing quote/,
    );
    expect(extractCacheTag('"messages.json?cache=abcdefghijk"')).toBe('abcdefghijk');
    expectDeriveError(() => extractCacheTag('"messages.json?cache=abc'), /no closing quote/);
  });
});

describe('deriveCloudMain', () => {
  it('applies every rule exactly once', () => {
    expect(derive(mainText())).toBe(EXPECTED_MAIN);
  });

  it('emits the EU environment name and URLs', () => {
    const euprd = {...CLOUD, urls: {icons: 'https://icons.example.eu'}};
    const out = derive(mainText(), {base: BASE, env: euprd, envName: 'euprd'}, 'bjwi5');
    expect(out).toContain('return"selfhosted"==="euprd".toString()');
    expect(out).toContain('useValue:{icons:"https://icons.example.eu"}}');
    expect(out).toContain('messages.json?cache=bjwi5"');
  });

  it('inherits base values that the env config does not override', () => {
    const partial = omit(omit(CLOUD, 'stripeKey'), 'urls');
    const out = derive(mainText(), {base: BASE, env: partial, envName: 'cloud'});
    expect(out).toContain('n.Stripe("pk_test_KEY")');
    expect(out).toContain('useValue:{}}');
    expect(out).toContain('authorization:"production_KEY"');
  });

  it('locates all substitutions in the original text, so they cannot cascade', () => {
    // The new Stripe key equals the old Braintree key, and a URL contains ?cache=.
    const env = {
      ...CLOUD,
      stripeKey: 'sandbox_KEY',
      urls: {icons: 'https://icons.example.net/?cache=i9gaj5'},
    };
    const out = derive(mainText(), {base: BASE, env, envName: 'cloud'});
    expect(out).toContain('n.Stripe("sandbox_KEY")');
    expect(out).toContain('authorization:"production_KEY"');
    expect(out).toContain('useValue:{icons:"https://icons.example.net/?cache=i9gaj5"}}');
  });

  it('keeps everything else byte-identical, including non-ASCII text and a BOM', () => {
    const text = '﻿' + mainText({head: '(()=>{var z="Zażółć 🦀";var e={1:(e,t,s)=>{'});
    const out = deriveCloudMain(enc(text), CFG, 'w4e0z', MAP_B).bytes;
    expect(Array.from(out.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(dec(out)).toContain('var z="Zażółć 🦀"');
  });

  it('returns the byte offsets of the values it wrote, in order, after multi-byte text', () => {
    const text = '﻿' + mainText({head: '(()=>{var z="Zażółć 🦀";var e={1:(e,t,s)=>{'});
    const {bytes, slots} = deriveCloudMain(enc(text), CFG, 'w4e0z', MAP_B);
    expect(slots.map(o => [o.slot, dec(bytes.subarray(o.offset, o.offset + o.length))])).toEqual([
      ['CACHE_TAG', 'w4e0z'],
      ['CACHE_TAG', 'w4e0z'],
      ['MAIN', HASH_B],
    ]);
    expect(slots.map(o => o.offset)).toEqual([...slots.map(o => o.offset)].sort((a, b) => a - b));
  });

  it('rejects input that is not valid UTF-8', () => {
    const bytes = enc(mainText());
    const bad = new Uint8Array(bytes.length + 1);
    bad.set(bytes.subarray(0, 10));
    bad[10] = 0xff;
    bad.set(bytes.subarray(10), 11);
    expectDeriveError(() => deriveCloudMain(bad, CFG, 'w4e0z', MAP_B), /not valid UTF-8/);
  });

  describe('fails closed when a rule does not match exactly once', () => {
    const cases: Array<[MainPart, string, RegExp]> = [
      ['i18n', 'const t=this.localesDirectory+"/"+e+"/messages.json?cache=i9gaj5",', /cache=/],
      ['dropin', 'i.src="scripts/dropin.js?cache=i9gaj5",', /cache=/],
      ['urls', 'useValue:{}}', /URLS/],
      [
        'paypal',
        '{businessId:"SANDBOXBIZ",buttonAction:"https://www.sandbox.paypal.com/cgi-bin/webscr"}',
        /PAYPAL_CONFIG/,
      ],
      ['braintree', '"sandbox_KEY"', /BRAINTREE_KEY/],
      ['stripe', '"pk_test_KEY"', /STRIPE_KEY/],
      ['env', '"selfhosted"==="selfhosted".toString()', /ENV/],
    ];
    for (const [part, needle, label] of cases) {
      it(`${part}: missing`, () => {
        const text = mainText({[part]: MAIN_PARTS[part].replace(needle, 'x')});
        expectDeriveError(() => derive(text), label);
      });
      it(`${part}: duplicated`, () => {
        const text = mainText({[part]: MAIN_PARTS[part] + ';' + needle + ';'});
        expectDeriveError(() => derive(text), label);
      });
    }

    it('CACHE_TAG: dropin site with a different tag', () => {
      const text = mainText({dropin: 'i.src="scripts/dropin.js?cache=zzz",'});
      expectDeriveError(() => derive(text), /CACHE_TAG scripts\/dropin\.js\?cache=/);
    });

    it('CACHE_TAG: a third ?cache= site the recipe does not know', () => {
      const text = mainText({head: '(()=>{var u="x.css?cache=i9gaj5";var e={1:(e,t,s)=>{'});
      expectDeriveError(() => derive(text), /main CACHE_TAG sites: expected 2/);
    });

    it('sourceMappingURL: missing, not last, duplicated or malformed', () => {
      const comment = '//# sourceMappingURL=main.' + HASH_A + '.js.map';
      for (const tail of [
        '}}})();',
        '}}})();\n' + comment + '\n',
        '}}})();\n' + comment + ' ',
        '}}})();' + comment,
        '}}})();\n//# sourceMappingURL=main.' + HASH_A.toUpperCase() + '.js.map',
        '}}})();\n//# sourceMappingURL=vendor.' + HASH_A + '.js.map',
      ]) {
        expectDeriveError(() => derive(mainText({tail})), /sourceMappingURL/);
      }
      const extra = mainText({head: '(()=>{var m="sourceMappingURL";var e={1:(e,t,s)=>{'});
      expectDeriveError(() => derive(extra), /main sourceMappingURL: expected 1/);
    });

    it('two needles overlapping each other', () => {
      // The base Stripe key only occurs inside the PayPal literal.
      const base = {...BASE, stripeKey: 'SANDBOXBIZ'};
      const text = mainText({stripe: 'this.stripe=n.Stripe(k),'});
      expectDeriveError(
        () => derive(text, {base, env: CLOUD, envName: 'cloud'}),
        /overlaps another substitution/,
      );
    });
  });

  it('validates the CACHE_TAG, source map name and environment name', () => {
    for (const tag of ['', 'W4E0Z', 'abcdefghijkl', 'a"b', 'a b', 'ä']) {
      expectDeriveError(() => derive(mainText(), CFG, tag), /CACHE_TAG must match/);
    }
    for (const map of [
      `main.${HASH_B}.js`,
      `main.${HASH_B.toUpperCase()}.js.map`,
      `main.${HASH_B}0.js.map`,
      `../main.${HASH_B}.js.map`,
      `main.${HASH_B}.js.map\n`,
      `duo-redirect.${HASH_B}.js.map`,
    ]) {
      expectDeriveError(() => derive(mainText(), CFG, 'w4e0z', map), /invalid file name/);
    }
    const qa = {...CFG, envName: 'qa'} as unknown as BitwardenConfigs;
    expectDeriveError(() => derive(mainText(), qa), /unsupported envName/);
    const selfhosted = {...CFG, envName: 'selfhosted'} as unknown as BitwardenConfigs;
    expectDeriveError(() => derive(mainText(), selfhosted), /unsupported envName/);
  });

  describe('validates the config files', () => {
    const withEnv = (env: unknown): BitwardenConfigs => ({base: BASE, env, envName: 'cloud'});
    const withBase = (base: unknown): BitwardenConfigs => ({base, env: CLOUD, envName: 'cloud'});

    it('requires JSON objects with known keys only', () => {
      for (const bad of [null, [], 'x', 1, new Map()]) {
        expectDeriveError(() => derive(mainText(), withEnv(bad)), /must be a JSON object/);
        expectDeriveError(() => derive(mainText(), withBase(bad)), /must be a JSON object/);
      }
      expectDeriveError(
        () => derive(mainText(), withEnv({...CLOUD, scimUrl: 'https://x'})),
        /unsupported config key "scimUrl"/,
      );
      expectDeriveError(
        () => derive(mainText(), withEnv(JSON.parse('{"__proto__":{"urls":{}}}'))),
        /unsupported config key "__proto__"/,
      );
    });

    it('requires URL keys Terser prints unquoted and plain string values', () => {
      for (const urls of [
        {'icons-url': 'https://x'},
        {'1': 'https://x'},
        {_icons: 'https://x'},
        {icons: 1},
        {icons: 'https://x/"+alert(1)+"'},
        {icons: "https://x/'"},
        {icons: 'https://x/\\'},
        {icons: 'https://x/</script>'},
        {icons: 'https://x/`'},
        {icons: 'https://x/\n'},
        {icons: 'https://icöns.example'},
        'https://x',
        null,
      ]) {
        expectDeriveError(() => derive(mainText(), withEnv({...CLOUD, urls})), /env\.urls/);
      }
    });

    it('requires non-empty plain payment keys and a non-empty base PayPal object', () => {
      for (const stripeKey of ['', 1, null, 'pk_"x']) {
        expectDeriveError(
          () => derive(mainText(), withEnv({...CLOUD, stripeKey})),
          /env\.stripeKey/,
        );
      }
      expectDeriveError(
        () => derive(mainText(), {base: omit(BASE, 'braintreeKey'), env: {}, envName: 'cloud'}),
        /base\.braintreeKey/,
      );
      expectDeriveError(() => derive(mainText(), withBase({...BASE, paypal: {}})), /base\.paypal/);
      expectDeriveError(
        () => derive(mainText(), withEnv({...CLOUD, paypal: {businessId: 7}})),
        /env\.paypal\.businessId/,
      );
    });

    it('refuses env values the recipe cannot substitute', () => {
      expect(derive(mainText(), withEnv({...CLOUD, flags: {sdk: true}}))).toBe(EXPECTED_MAIN);
      expectDeriveError(
        () => derive(mainText(), withEnv({...CLOUD, flags: {sdk: false}})),
        /changes FLAGS/,
      );
      expectDeriveError(
        () => derive(mainText(), withEnv({...CLOUD, flags: {newFlag: true}})),
        /changes FLAGS/,
      );
      expectDeriveError(() => derive(mainText(), withEnv({...CLOUD, flags: []})), /flags/);
      expect(derive(mainText(), withEnv({...CLOUD, additionalRegions: []}))).toBe(EXPECTED_MAIN);
      expectDeriveError(
        () => derive(mainText(), withEnv({...CLOUD, additionalRegions: [{key: 'X'}]})),
        /additionalRegions/,
      );
    });

    it('ignores dev-server-only settings', () => {
      const env = {...CLOUD, dev: {anything: [1, 2]}, devFlags: {x: true}};
      expect(derive(mainText(), withEnv(env))).toBe(EXPECTED_MAIN);
    });
  });
});

describe('deriveCloudConnectorJs', () => {
  const connector = (name: string, extra = ''): string =>
    '(()=>{"use strict";class o{constructor(e,t){super(e||"en-US",t,e=>s(this,void 0,void 0,' +
    'function*(){const t=this.localesDirectory+"/"+e+"/messages.json?cache=i9gaj5",n=yield fetch(t);' +
    extra +
    'return n.json()}))}}})();\n//# sourceMappingURL=' +
    name;

  it('substitutes CACHE_TAG and the source map name only, and returns where it wrote them', () => {
    for (const [stem, slot] of [
      ['duo-redirect', 'DUO_JS'],
      ['webauthn-fallback', 'WEBAUTHN_FB_JS'],
    ] as const) {
      const src = connector(`${stem}.${HASH_A}.js.map`);
      const out = deriveCloudConnectorJs(enc(src), 'w4e0z', `${stem}.${HASH_B}.js.map`, slot);
      expect(dec(out.bytes)).toBe(
        src
          .replace('messages.json?cache=i9gaj5"', 'messages.json?cache=w4e0z"')
          .replace(`${stem}.${HASH_A}.js.map`, `${stem}.${HASH_B}.js.map`),
      );
      expect(
        out.slots.map(o => [o.slot, dec(out.bytes.subarray(o.offset, o.offset + o.length))]),
      ).toEqual([
        ['CACHE_TAG', 'w4e0z'],
        [slot, HASH_B],
      ]);
    }
  });

  it('fails closed on unexpected input', () => {
    const src = connector(`duo-redirect.${HASH_A}.js.map`);
    const run = (text: string, tag = 'w4e0z', map = `duo-redirect.${HASH_B}.js.map`) =>
      deriveCloudConnectorJs(enc(text), tag, map, 'DUO_JS');
    expectDeriveError(() => run(src, 'W4E0Z'), /CACHE_TAG must match/);
    expectDeriveError(
      () => run(src, 'w4e0z', `webauthn-fallback.${HASH_B}.js.map`),
      /is not a map of/,
    );
    expectDeriveError(() => run(src, 'w4e0z', `main.${HASH_B}.js.map`), /invalid file name/);
    expectDeriveError(() => run(src, 'w4e0z', `sso.${HASH_B}.js.map`), /invalid file name/);
    expectDeriveError(() => run(connector(`sso.${HASH_A}.js.map`)), /sourceMappingURL/);
    expectDeriveError(() => run(connector(`duo-redirect.${HASH_A}.js.map\n`)), /sourceMappingURL/);
    expectDeriveError(
      () => run(connector(`duo-redirect.${HASH_A}.js.map`, 'u="a.js?cache=i9gaj5";')),
      /connector CACHE_TAG sites: expected 1/,
    );
    expectDeriveError(
      () => run(connector(`duo-redirect.${HASH_A}.js.map`, 'u="messages.json?cache=i9gaj5";')),
      /connector CACHE_TAG sites: expected 1/,
    );
    expectDeriveError(
      () => run(src.replace('messages.json?cache=i9gaj5', 'messages.json')),
      /no messages\.json\?cache=/,
    );
    expectDeriveError(
      () => run(connector(`duo-redirect.${HASH_A}.js.map`, 'm="sourceMappingURL";')),
      /sourceMappingURL: expected 1/,
    );
  });
});

describe('deriveCloudHtml', () => {
  const MAIN_A = `app/main.${HASH_A}.js`;
  const MAIN_B = `app/main.${HASH_B}.js`;
  const VENDOR_A = `app/vendor.${HASH_A}.js`;
  const VENDOR_B = `app/vendor.${HASH_B}.js`;
  const html = (main: string, vendor: string, extra = ''): string =>
    '<!doctype html><html><head><meta charset="utf-8"/><title>Bitwarden Web vault</title>' +
    `<script defer="defer" src="${vendor}"></script><script defer="defer" src="${main}"></script>` +
    `<script defer="defer" src="styles.31d6cfe0d16ae931b73c.js"></script></head><body>${extra}</body></html>`;

  it('swaps the referenced script names and returns where it wrote the hashes', () => {
    const out = deriveCloudHtml(enc(html(MAIN_A, VENDOR_A)), [
      {from: MAIN_A, to: MAIN_B, slot: 'MAIN'},
    ]);
    expect(dec(out.bytes)).toBe(html(MAIN_B, VENDOR_A));
    const both = deriveCloudHtml(enc(html(MAIN_A, VENDOR_A)), [
      {from: MAIN_A, to: MAIN_B, slot: 'MAIN'},
      {from: VENDOR_A, to: VENDOR_B, slot: 'X'},
    ]);
    expect(dec(both.bytes)).toBe(html(MAIN_B, VENDOR_B));
    expect(
      both.slots.map(o => [o.slot, dec(both.bytes.subarray(o.offset, o.offset + o.length))]),
    ).toEqual([
      ['X', HASH_B],
      ['MAIN', HASH_B],
    ]);
    const duo = `connectors/duo-redirect.${HASH_A}.js`;
    const duoB = `connectors/duo-redirect.${HASH_B}.js`;
    const page = `<body><script defer="defer" src="${duo}"></script></body>`;
    expect(dec(deriveCloudHtml(enc(page), [{from: duo, to: duoB, slot: 'DUO_JS'}]).bytes)).toBe(
      page.replace(duo, duoB),
    );
  });

  it('requires each name exactly once, as a src attribute value', () => {
    const run = (text: string, renames = [{from: MAIN_A, to: MAIN_B, slot: 'MAIN'}]) =>
      deriveCloudHtml(enc(text), renames);
    expectDeriveError(() => run(html(MAIN_B, VENDOR_A)), /expected 1 occurrence/);
    expectDeriveError(
      () => run(html(MAIN_A, VENDOR_A, `<link rel="preload" href="${MAIN_A}">`)),
      /expected 1 occurrence/,
    );
    expectDeriveError(
      () => run(html(MAIN_A, VENDOR_A).replace(`src="${MAIN_A}"`, `data-x="${MAIN_A}"`)),
      /expected exactly 1 occurrence of "src=/,
    );
    expectDeriveError(
      () =>
        run(html(MAIN_A, VENDOR_A), [
          {from: MAIN_A, to: MAIN_B, slot: 'MAIN'},
          {from: MAIN_A, to: MAIN_B, slot: 'MAIN'},
        ]),
      /overlaps/,
    );
  });

  it('validates names and refuses renames to another script', () => {
    const run = (from: string, to: string) =>
      deriveCloudHtml(enc(html(MAIN_A, VENDOR_A)), [{from, to, slot: 'MAIN'}]);
    expectDeriveError(() => run(MAIN_A, VENDOR_B), /not a rename/);
    expectDeriveError(() => run(MAIN_A, `main.${HASH_B}.js`), /not a rename/);
    expectDeriveError(
      () => run(MAIN_A, `app/main.${HASH_B.toUpperCase()}.js`),
      /invalid file name/,
    );
    expectDeriveError(() => run(MAIN_A, `app/main.${HASH_B}.mjs`), /invalid file name/);
    expectDeriveError(() => run(MAIN_A, `app/main.${HASH_B}.js"`), /invalid file name/);
    expectDeriveError(() => run(MAIN_A, `app/main x.${HASH_B}.js`), /invalid file name/);
    expectDeriveError(() => run(`app/main.x.js`, MAIN_B), /invalid file name/);
    expectDeriveError(() => run(`../app/main.${HASH_A}.js`, MAIN_B), /invalid path segment/);
    expectDeriveError(() => run(`/app/main.${HASH_A}.js`, MAIN_B), /invalid path segment/);
    expectDeriveError(() => run(`app//main.${HASH_A}.js`, MAIN_B), /invalid path segment/);
    expectDeriveError(() => deriveCloudHtml(enc(html(MAIN_A, VENDOR_A)), []), /no renames/);
  });
});
