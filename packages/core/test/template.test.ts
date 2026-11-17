import {createHash} from 'node:crypto';
import {beforeAll, describe, expect, it} from 'vitest';
import {
  buildTemplate,
  TemplateError,
  type SlotOccurrence,
  type Template,
} from '../src/template/build.ts';
import {matchTemplate, validateTemplate} from '../src/template/match.ts';
import {FORBIDDEN_SLOT_BYTES, getSlotSpec, slotMark} from '../src/template/slots.ts';

// --- helpers ---------------------------------------------------------------

const encoder = new TextEncoder();
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

type Segment = string | {slot: string; value: string};

/** Concatenates literal strings (UTF-8) and slot values, recording offsets. */
function assemble(segments: Segment[]): {bytes: Uint8Array; occurrences: SlotOccurrence[]} {
  const chunks: Uint8Array[] = [];
  const occurrences: SlotOccurrence[] = [];
  let offset = 0;
  for (const s of segments) {
    const chunk = encoder.encode(typeof s === 'string' ? s : s.value);
    if (typeof s !== 'string') occurrences.push({offset, length: chunk.length, slot: s.slot});
    chunks.push(chunk);
    offset += chunk.length;
  }
  return {bytes: concat(chunks), occurrences};
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Printable filler that contains no slot-adjacent surprises (no NUL). */
function filler(rand: () => number, n: number): string {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ;,.(){}[]=+-*/"\'`<>$\n';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)]!;
  return s;
}

function mutate(bytes: Uint8Array, at: number, value: number): Uint8Array {
  const copy = bytes.slice();
  copy[at] = value;
  return copy;
}

function insert(bytes: Uint8Array, at: number, extra: string): Uint8Array {
  return concat([bytes.subarray(0, at), encoder.encode(extra), bytes.subarray(at)]);
}

function replaceRange(bytes: Uint8Array, start: number, end: number, value: string): Uint8Array {
  return concat([bytes.subarray(0, start), encoder.encode(value), bytes.subarray(end)]);
}

function expectFail(r: Awaited<ReturnType<typeof matchTemplate>>, reason?: string): void {
  expect(r.ok).toBe(false);
  if (!r.ok && reason !== undefined) expect(r.reason).toContain(reason);
}

// --- fixtures (synthetic; shaped like the real files, no vendor bytes) -----

const MAIN_US = '1acba9cab2a37e1e33ca';
const MAIN_EU = '9a8eda2d501e783f60d9';
const DUO = '0123456789abcdef0123';

function bwMain(cacheTag: string, main: string, pad = ''): ReturnType<typeof assemble> {
  return assemble([
    '(()=>{"use strict";var e={};' + pad + 'const t="locales/"+n+"/messages.json?cache=',
    {slot: 'CACHE_TAG', value: cacheTag},
    '";/* zażółć gęślą jaźń */fetch(t);const s="scripts/dropin.js?cache=',
    {slot: 'CACHE_TAG', value: cacheTag},
    '";e.isSelfHost=function(){return"cloud"==="cloud".toString()};' + pad + '\n})();\n',
    '//# sourceMappingURL=main.',
    {slot: 'MAIN', value: main},
    '.js.map',
  ]);
}

function bwIndex(main: string): ReturnType<typeof assemble> {
  return assemble([
    '<!doctype html><html><head><script src="app/main.',
    {slot: 'MAIN', value: main},
    '.js" defer></script></head><body></body></html>\n',
  ]);
}

function bwDuo(cacheTag: string, duo: string): ReturnType<typeof assemble> {
  return assemble([
    'var u="duo-redirect.json?cache=',
    {slot: 'CACHE_TAG', value: cacheTag},
    '";\n//# sourceMappingURL=duo-redirect.',
    {slot: 'DUO_JS', value: duo},
    '.js.map',
  ]);
}

function build(f: ReturnType<typeof assemble>): Promise<Template> {
  return buildTemplate(f.bytes, f.occurrences);
}

const SLOT_NAMES = ['CACHE_TAG', 'MAIN', 'DUO_JS', 'WEBAUTHN_FB_JS'];
const allSlots = () => SLOT_NAMES.map(n => getSlotSpec(n)!);

// --- slots -----------------------------------------------------------------

describe('slot allowlist', () => {
  it('defines exactly the closed set of slots', () => {
    expect(allSlots().map(s => s.name)).toEqual(SLOT_NAMES);
    // Beyond the charset only CACHE_TAG refuses values.
    for (const spec of allSlots()) {
      expect(Object.keys(spec).sort()).toEqual([
        'charset',
        'inCharset',
        'max',
        'min',
        'name',
        ...(spec.name === 'CACHE_TAG' ? ['refused'] : []),
      ]);
    }
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'main', '']) {
      expect(getSlotSpec(name)).toBeUndefined();
    }
    expect(getSlotSpec('API_ORIGIN')).toBeUndefined();
    expect(Object.isFrozen(getSlotSpec('MAIN'))).toBe(true);
  });

  it('has exactly the specified charsets and length bounds', () => {
    const accepted = (name: string): string => {
      const spec = getSlotSpec(name)!;
      let s = '';
      for (let b = 0; b < 256; b++) if (spec.inCharset(b)) s += String.fromCharCode(b);
      return s;
    };
    const lowerHex = '0123456789abcdef';
    expect(accepted('CACHE_TAG')).toBe('0123456789abcdefghijklmnopqrstuvwxyz');
    for (const n of ['MAIN', 'DUO_JS', 'WEBAUTHN_FB_JS']) {
      expect(accepted(n)).toBe(lowerHex);
      expect(getSlotSpec(n)).toMatchObject({min: 20, max: 20});
    }
    expect(getSlotSpec('CACHE_TAG')).toMatchObject({min: 1, max: 11});
  });

  it('charsets exclude quotes, backslash, angle brackets, $, braces, newline and NUL', () => {
    const required = ['"', "'", '`', '\\', '<', '>', '$', '{', '}', '\n', '\0'].map(c =>
      c.charCodeAt(0),
    );
    for (const b of required) expect(FORBIDDEN_SLOT_BYTES).toContain(b);
    for (const spec of allSlots()) {
      for (const b of FORBIDDEN_SLOT_BYTES)
        expect(spec.inCharset(b), `${spec.name} ${b}`).toBe(false);
      // Only printable ASCII, never whitespace, controls or non-ASCII bytes.
      for (let b = 0; b < 256; b++) {
        if (spec.inCharset(b)) expect(b > 0x20 && b < 0x7f, `${spec.name} ${b}`).toBe(true);
      }
    }
  });

  it('builds MARK(name) as NUL "INTACTWARDEN:" name NUL', () => {
    // NUL I N T A C T W A R D E N :
    const prefix = [
      0x00, 0x49, 0x4e, 0x54, 0x41, 0x43, 0x54, 0x57, 0x41, 0x52, 0x44, 0x45, 0x4e, 0x3a,
    ];
    expect([...slotMark('MAIN')]).toEqual([...prefix, 0x4d, 0x41, 0x49, 0x4e, 0x00]);
    expect([...slotMark('CACHE_TAG')]).toEqual([...encoder.encode('\0INTACTWARDEN:CACHE_TAG\0')]);
    expect(() => slotMark('')).toThrow();
    expect(() => slotMark('A\0B')).toThrow();
    expect(() => slotMark('main')).toThrow();
  });
});

// --- build + match: genuine bytes ------------------------------------------

describe('buildTemplate / matchTemplate: genuine bytes', () => {
  it('matches the genuine file and returns the slot values and occurrences', async () => {
    const f = bwMain('w4e0z', MAIN_US);
    const t = await build(f);
    expect(t.parts.map(p => ('lit' in p ? 'lit' : p.slot))).toEqual([
      'lit',
      'CACHE_TAG',
      'lit',
      'CACHE_TAG',
      'lit',
      'MAIN',
      'lit',
    ]);
    expect(t.parts.at(-1)).toEqual({lit: 7}); // ".js.map"
    expect(t.length_without_slots).toBe(f.bytes.length - 5 - 5 - 20);
    const r = await matchTemplate(t, f.bytes);
    expect(r).toEqual({
      ok: true,
      slots: {CACHE_TAG: 'w4e0z', MAIN: MAIN_US},
      occurrences: f.occurrences,
    });
  });

  it('masked_sha256 is SHA-256(lit_0 ‖ MARK(slot_1) ‖ lit_1 ‖ …)', async () => {
    const f = bwIndex(MAIN_US);
    const t = await build(f);
    const o = f.occurrences[0]!;
    const stream = concat([
      f.bytes.subarray(0, o.offset),
      encoder.encode('\0INTACTWARDEN:MAIN\0'),
      f.bytes.subarray(o.offset + o.length),
    ]);
    expect(t.masked_sha256).toBe(sha256(stream));
    expect(t.parts).toEqual([
      {lit: o.offset},
      {slot: 'MAIN'},
      {lit: f.bytes.length - o.offset - 20},
    ]);
  });

  it('is independent of slot values: US and EU builds give the same template', async () => {
    const us = await build(bwMain('w4e0z', MAIN_US));
    const eu = await build(bwMain('bjwi5', MAIN_EU));
    const other = await build(bwMain('i9gaj5abc12', MAIN_US));
    expect(eu).toEqual(us);
    expect(other).toEqual(us);
    const r = await matchTemplate(us, bwMain('a', MAIN_EU).bytes);
    expect(r.ok && r.slots).toEqual({CACHE_TAG: 'a', MAIN: MAIN_EU});
  });

  it('survives a JSON round trip of the template', async () => {
    const f = bwDuo('w4e0z', DUO);
    const t = JSON.parse(JSON.stringify(await build(f))) as Template;
    const r = await matchTemplate(t, bwDuo('bjwi5', MAIN_EU).bytes);
    expect(r.ok && r.slots).toEqual({CACHE_TAG: 'bjwi5', DUO_JS: MAIN_EU});
  });

  it('matches a template without slots like a plain hash', async () => {
    const bytes = encoder.encode('console.log("hi")\n');
    const t = await buildTemplate(bytes, []);
    expect(t.parts).toEqual([{lit: bytes.length}]);
    expect(t.masked_sha256).toBe(sha256(bytes));
    expect(await matchTemplate(t, bytes)).toEqual({ok: true, slots: {}, occurrences: []});
    expectFail(await matchTemplate(t, mutate(bytes, 3, 0x41)), 'masked digest mismatch');
  });

  it('accepts bound values that match, and ignores bound slots absent from the file', async () => {
    const f = bwIndex(MAIN_US);
    const t = await build(f);
    expect((await matchTemplate(t, f.bytes, {MAIN: MAIN_US})).ok).toBe(true);
    expect((await matchTemplate(t, f.bytes, {MAIN: MAIN_US, CACHE_TAG: 'w4e0z'})).ok).toBe(true);
  });
});

// --- adversarial -----------------------------------------------------------

describe('matchTemplate: adversarial inputs', () => {
  const f = bwMain('w4e0z', MAIN_US);
  let t: Template;
  beforeAll(async () => {
    t = await build(f);
  });
  const [tag1, tag2, main] = f.occurrences as [SlotOccurrence, SlotOccurrence, SlotOccurrence];

  it('rejects any change to any literal byte (exhaustive over positions)', async () => {
    const inSlot = (p: number): boolean =>
      f.occurrences.some(o => p >= o.offset && p < o.offset + o.length);
    let checked = 0;
    for (let p = 0; p < f.bytes.length; p++) {
      if (inSlot(p)) continue;
      // A value that is not in any charset, and one that is.
      for (const v of [0x22, 0x61, (f.bytes[p]! + 1) & 0xff]) {
        if (v === f.bytes[p]) continue;
        expect((await matchTemplate(t, mutate(f.bytes, p, v))).ok, `pos ${p} value ${v}`).toBe(
          false,
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('rejects extending a slot with charset bytes beyond its bounds or inconsistently', async () => {
    // MAIN is exactly 20 hex digits.
    expectFail(await matchTemplate(t, insert(f.bytes, main.offset + 20, 'a')), 'longer than 20');
    expectFail(await matchTemplate(t, insert(f.bytes, main.offset, '0')), 'longer than 20');
    // CACHE_TAG at most 11.
    const long = 'abcdefghijkl';
    const tooLong = replaceRange(
      replaceRange(f.bytes, tag2.offset, tag2.offset + 5, long),
      tag1.offset,
      tag1.offset + 5,
      long,
    );
    expectFail(await matchTemplate(t, tooLong)); // caught by the file length bounds
    // Same, with the total length kept inside the bounds.
    const tooLongFirst = replaceRange(
      replaceRange(f.bytes, tag2.offset, tag2.offset + 5, 'a'),
      tag1.offset,
      tag1.offset + 5,
      long,
    );
    expectFail(await matchTemplate(t, tooLongFirst), 'longer than 11');
    // Only one of the two CACHE_TAG occurrences extended.
    expectFail(await matchTemplate(t, insert(f.bytes, tag1.offset + 5, 'x')), 'earlier occurrence');
    expectFail(await matchTemplate(t, insert(f.bytes, tag2.offset + 5, 'x')), 'earlier occurrence');
    // Consistent extension within bounds is a legitimate new value, unless bound.
    const both = insert(insert(f.bytes, tag2.offset + 5, 'x'), tag1.offset + 5, 'x');
    const r = await matchTemplate(t, both);
    expect(r.ok && r.slots.CACHE_TAG).toBe('w4e0zx');
    expectFail(await matchTemplate(t, both, {CACHE_TAG: 'w4e0z'}), 'bound value');
  });

  it('rejects slot values with bytes outside the charset', async () => {
    const withTag = (v: string): Uint8Array =>
      replaceRange(
        replaceRange(f.bytes, tag2.offset, tag2.offset + 5, v),
        tag1.offset,
        tag1.offset + 5,
        v,
      );
    for (const v of ['W4E0Z', 'w4-0z', 'w4e0z ', 'w4e0z\n', 'w4%30', 'w4e0é', '', 'w4.e0']) {
      expect((await matchTemplate(t, withTag(v))).ok, JSON.stringify(v)).toBe(false);
    }
    const upperMain = replaceRange(f.bytes, main.offset, main.offset + 20, MAIN_US.toUpperCase());
    expectFail(await matchTemplate(t, upperMain), 'shorter than 20');
  });

  it('makes code injection through CACHE_TAG impossible', async () => {
    const payloads = [
      '";alert(1);"',
      'w4e0z";alert(1);"',
      'w4e0z";alert(1);//',
      '${alert(1)}',
      '\\u0022;alert(1)',
      '</script><script>alert(1)</script>',
      "w4e0z'+alert(1)+'",
      'w4e0z\nalert(1)//',
    ];
    for (const p of payloads) {
      const both = replaceRange(
        replaceRange(f.bytes, tag2.offset, tag2.offset + 5, p),
        tag1.offset,
        tag1.offset + 5,
        p,
      );
      expect((await matchTemplate(t, both)).ok, p).toBe(false);
      const first = replaceRange(f.bytes, tag1.offset, tag1.offset + 5, p);
      expect((await matchTemplate(t, first)).ok, p).toBe(false);
    }
  });

  it('refuses a CACHE_TAG that is a JavaScript reserved word (a unary keyword could choose code)', async () => {
    for (const word of ['typeof', 'void', 'delete', 'new', 'await', 'yield', 'in', 'instanceof']) {
      const both = replaceRange(
        replaceRange(f.bytes, tag2.offset, tag2.offset + 5, word),
        tag1.offset,
        tag1.offset + 5,
        word,
      );
      expectFail(await matchTemplate(t, both), 'refused value');
    }
    // Any other value in the charset still matches.
    const other = replaceRange(
      replaceRange(f.bytes, tag2.offset, tag2.offset + 5, 'typeofx'),
      tag1.offset,
      tag1.offset + 5,
      'typeofx',
    );
    expect((await matchTemplate(t, other)).ok).toBe(true);
  });

  it('rejects different values for a repeated slot', async () => {
    const r = await matchTemplate(t, replaceRange(f.bytes, tag2.offset, tag2.offset + 5, 'w4e0y'));
    expectFail(r, 'earlier occurrence');
    const shorter = replaceRange(f.bytes, tag1.offset, tag1.offset + 5, 'w4e0');
    expectFail(await matchTemplate(t, shorter), 'earlier occurrence');
  });

  it('rejects bound mismatches and invalid bindings', async () => {
    expectFail(await matchTemplate(t, f.bytes, {MAIN: MAIN_EU}), 'bound value');
    expectFail(await matchTemplate(t, f.bytes, {CACHE_TAG: 'w4e0'}), 'bound value');
    expectFail(await matchTemplate(t, f.bytes, {MAIN: MAIN_US.toUpperCase()}), 'bound value');
    expectFail(
      await matchTemplate(t, f.bytes, {API_ORIGIN: 'https://a.example'}),
      'not allowlisted',
    );
    expectFail(await matchTemplate(t, f.bytes, {constructor: 'x'}), 'not allowlisted');
    expectFail(await matchTemplate(t, f.bytes, {MAIN: 1 as unknown as string}), 'not a string');
    expectFail(await matchTemplate(t, f.bytes, null as unknown as Record<string, string>), 'bound');
  });

  it('rejects truncated and extended files', async () => {
    for (let n = 1; n <= 8; n++) {
      expect((await matchTemplate(t, f.bytes.subarray(0, f.bytes.length - n))).ok, `-${n}`).toBe(
        false,
      );
    }
    expectFail(await matchTemplate(t, concat([f.bytes, encoder.encode('\n')])), 'trailing');
    expectFail(await matchTemplate(t, concat([f.bytes, encoder.encode(';alert(1)')])));
    expectFail(await matchTemplate(t, concat([encoder.encode(' '), f.bytes])));
    expectFail(await matchTemplate(t, new Uint8Array()), 'outside');
  });

  it('rejects a file containing NUL even where it would otherwise not matter', async () => {
    // NUL is never valid in a slot or a target file.
    expectFail(await matchTemplate(t, mutate(f.bytes, 3, 0)), 'NUL');
  });

  it('characterises every single-byte change exhaustively', async () => {
    // Without bindings a change matches iff it lies inside a slot that occurs
    // once (MAIN here; CACHE_TAG occurs twice) and stays inside its charset.
    const mainSpec = getSlotSpec('MAIN')!;
    const bound = {CACHE_TAG: 'w4e0z', MAIN: MAIN_US};
    let matched = 0;
    for (let p = 0; p < f.bytes.length; p++) {
      for (let v = 1; v < 256; v++) {
        if (v === f.bytes[p]) continue;
        const m = mutate(f.bytes, p, v);
        const expected = p >= main.offset && p < main.offset + 20 && mainSpec.inCharset(v);
        const r = await matchTemplate(t, m);
        if (r.ok !== expected) expect.fail(`pos ${p} value ${v}: ok=${r.ok}`);
        if (r.ok) matched++;
        if ((await matchTemplate(t, m, bound)).ok)
          expect.fail(`bound: pos ${p} value ${v} matched`);
      }
    }
    expect(matched).toBe(20 * 15);
  }, 60_000);

  it('rejects 500 random single-byte mutations of a large file (deterministic)', async () => {
    const rand = prng(0xec5eed);
    const big = bwMain('w4e0z', MAIN_US, filler(rand, 20_000));
    const tb = await build(big);
    const bound = {CACHE_TAG: 'w4e0z', MAIN: MAIN_US};
    const inSlot = (p: number): boolean =>
      big.occurrences.some(o => p >= o.offset && p < o.offset + o.length);
    let literalHits = 0;
    for (let i = 0; i < 500; i++) {
      const p = Math.floor(rand() * big.bytes.length);
      const v = (big.bytes[p]! + 1 + Math.floor(rand() * 255)) & 0xff;
      const m = mutate(big.bytes, p, v);
      expect((await matchTemplate(tb, m, bound)).ok, `pos ${p} value ${v}`).toBe(false);
      if (!inSlot(p)) {
        literalHits++;
        expect((await matchTemplate(tb, m)).ok, `unbound pos ${p} value ${v}`).toBe(false);
      }
    }
    expect(literalHits).toBeGreaterThan(450);
  });
});

// --- template object validation --------------------------------------------

describe('matchTemplate: template validation', () => {
  const f = bwDuo('w4e0z', DUO);
  const lengthWithoutSlots = f.bytes.length - f.occurrences.reduce((n, o) => n + o.length, 0);
  let t: Template;
  beforeAll(async () => {
    t = await build(f);
  });
  const tamper = (patch: Record<string, unknown>): Template => ({...t, ...patch}) as Template;

  it('accepts the genuine template', async () => {
    expect(validateTemplate(t)).toBeNull();
    const r = await matchTemplate(t, f.bytes, {DUO_JS: DUO});
    expect(r.ok && r.slots).toEqual({CACHE_TAG: 'w4e0z', DUO_JS: DUO});
  });

  it.each<[string, Record<string, unknown>]>([
    ['uppercase digest', {masked_sha256: 'A'.repeat(64)}],
    ['short digest', {masked_sha256: 'a'.repeat(63)}],
    ['negative length', {length_without_slots: -1}],
    ['fractional length', {length_without_slots: 1.5}],
    ['inconsistent length', {length_without_slots: lengthWithoutSlots + 1}],
    ['string length', {length_without_slots: String(lengthWithoutSlots)}],
    ['parts not an array', {parts: {0: {lit: 1}}}],
    ['empty parts', {parts: []}],
  ])('rejects %s', async (_label, patch) => {
    expect(validateTemplate(tamper(patch))).not.toBeNull();
    expectFail(await matchTemplate(tamper(patch), f.bytes), 'invalid template');
  });

  it('rejects malformed parts', async () => {
    const lits = t.parts.filter(p => 'lit' in p) as Array<{lit: number}>;
    const [a, b, c] = lits.map(p => p.lit) as [number, number, number];
    const total = t.length_without_slots;
    const cases: Array<[string, unknown[], number?]> = [
      ['unknown slot', [{lit: a}, {slot: 'EVIL'}, {lit: b}, {slot: 'DUO_JS'}, {lit: c}]],
      ['prototype slot', [{lit: a}, {slot: 'constructor'}, {lit: b}, {slot: 'DUO_JS'}, {lit: c}]],
      ['adjacent slots', [{lit: a}, {slot: 'CACHE_TAG'}, {slot: 'DUO_JS'}, {lit: b + c}]],
      [
        'zero literal between slots',
        [{lit: a}, {slot: 'CACHE_TAG'}, {lit: 0}, {slot: 'DUO_JS'}, {lit: b + c}],
      ],
      ['slot first', [{slot: 'CACHE_TAG'}, {lit: a + b}, {slot: 'DUO_JS'}, {lit: c}]],
      ['slot last', [{lit: a}, {slot: 'CACHE_TAG'}, {lit: b + c}, {slot: 'DUO_JS'}]],
      ['zero leading literal', [{lit: 0}, {slot: 'CACHE_TAG'}, {lit: a + b + c}]],
      ['adjacent literals', [{lit: a}, {lit: 0}, {slot: 'CACHE_TAG'}, {lit: b + c}]],
      [
        'negative literal',
        [{lit: a + 1}, {slot: 'CACHE_TAG'}, {lit: -1}, {slot: 'DUO_JS'}, {lit: b + c}],
      ],
      [
        'fractional literal',
        [{lit: a - 0.5}, {slot: 'CACHE_TAG'}, {lit: b + 0.5}, {slot: 'DUO_JS'}, {lit: c}],
      ],
      [
        'string literal',
        [{lit: String(a)}, {slot: 'CACHE_TAG'}, {lit: b}, {slot: 'DUO_JS'}, {lit: c}],
      ],
      ['NaN literal', [{lit: NaN}, {slot: 'CACHE_TAG'}, {lit: b}, {slot: 'DUO_JS'}, {lit: c}]],
      [
        'two keys',
        [{lit: a, slot: 'CACHE_TAG'}, {slot: 'CACHE_TAG'}, {lit: b}, {slot: 'DUO_JS'}, {lit: c}],
      ],
      ['no keys', [{lit: a}, {}, {lit: b}, {slot: 'DUO_JS'}, {lit: c}]],
      ['null part', [{lit: a}, null, {lit: b}, {slot: 'DUO_JS'}, {lit: c}]],
      ['array part', [{lit: a}, ['CACHE_TAG'], {lit: b}, {slot: 'DUO_JS'}, {lit: c}]],
      [
        'huge literal',
        [{lit: Number.MAX_SAFE_INTEGER}, {slot: 'CACHE_TAG'}, {lit: 1}],
        Number.MAX_SAFE_INTEGER + 1,
      ],
    ];
    for (const [label, parts, length] of cases) {
      const lengthWithoutSlots =
        length ??
        parts.reduce<number>((n, p) => {
          const lit = (p as {lit?: unknown} | null)?.lit;
          return typeof lit === 'number' ? n + lit : n;
        }, 0);
      const bad = tamper({parts, length_without_slots: lengthWithoutSlots});
      expect(validateTemplate(bad), label).not.toBeNull();
      expect((await matchTemplate(bad, f.bytes)).ok, label).toBe(false);
    }
    expect(total).toBe(a + b + c);
  });

  it('rejects a template whose parts were shifted, even with a valid shape', async () => {
    // Moving a slot boundary keeps the shape valid but breaks the digest.
    const [a, , b, , c] = t.parts as [
      {lit: number},
      unknown,
      {lit: number},
      unknown,
      {lit: number},
    ];
    const shifted = tamper({
      parts: [
        {lit: a.lit - 1},
        {slot: 'CACHE_TAG'},
        {lit: b.lit + 1},
        {slot: 'DUO_JS'},
        {lit: c.lit},
      ],
    });
    expect(validateTemplate(shifted)).toBeNull();
    expect((await matchTemplate(shifted, f.bytes)).ok).toBe(false);
  });

  it('rejects non-object templates and non-Uint8Array input', async () => {
    for (const bad of [null, undefined, 42, 'x', [], [t]]) {
      expect(validateTemplate(bad)).not.toBeNull();
      expect((await matchTemplate(bad as unknown as Template, f.bytes)).ok).toBe(false);
    }
    expectFail(await matchTemplate(t, Array.from(f.bytes) as unknown as Uint8Array), 'Uint8Array');
  });
});

// --- buildTemplate soundness -----------------------------------------------

describe('buildTemplate: soundness checks', () => {
  const f = bwMain('w4e0z', MAIN_US);
  const occ = f.occurrences;
  const [tag1, tag2, main] = occ as [SlotOccurrence, SlotOccurrence, SlotOccurrence];

  const refuse = async (
    bytes: Uint8Array,
    occurrences: SlotOccurrence[],
    message: string,
  ): Promise<void> => {
    await expect(buildTemplate(bytes, occurrences)).rejects.toThrow(TemplateError);
    await expect(buildTemplate(bytes, occurrences)).rejects.toThrow(message);
  };

  it('rejects unknown slot names', async () => {
    await refuse(f.bytes, [{...tag1, slot: 'EVIL'}], 'not allowlisted');
    await refuse(f.bytes, [{...tag1, slot: '__proto__'}], 'not allowlisted');
    await refuse(f.bytes, [{...tag1, slot: 'API_ORIGIN'}], 'not allowlisted');
  });

  it('rejects unsorted, overlapping and adjacent occurrences', async () => {
    await refuse(f.bytes, [tag2, tag1, main], 'unsorted or overlapping');
    await refuse(f.bytes, [tag1, tag1], 'unsorted or overlapping');
    await refuse(
      f.bytes,
      [
        {...tag1, length: 5},
        {...tag1, offset: tag1.offset + 2, length: 3},
      ],
      'unsorted',
    );
    // Adjacent: two hex slots back to back.
    // MAIN is followed by 'z' (outside hex), but CACHE_TAG starts right there.
    const touching = assemble([
      'x.',
      {slot: 'MAIN', value: MAIN_US},
      {slot: 'CACHE_TAG', value: 'zz'},
      '"',
    ]);
    await refuse(touching.bytes, touching.occurrences, 'adjacent');
  });

  it('rejects occurrences out of bounds or touching the start or end of the file', async () => {
    await refuse(f.bytes, [{offset: -1, length: 5, slot: 'CACHE_TAG'}], 'unsorted');
    await refuse(f.bytes, [{offset: 1.5, length: 5, slot: 'CACHE_TAG'}], 'integers');
    await refuse(f.bytes, [{offset: tag1.offset, length: NaN, slot: 'CACHE_TAG'}], 'integers');
    await refuse(
      f.bytes,
      [{offset: f.bytes.length + 10, length: 5, slot: 'CACHE_TAG'}],
      'followed',
    );
    const atStart = assemble([{slot: 'MAIN', value: MAIN_US}, '.js']);
    await refuse(atStart.bytes, atStart.occurrences, 'preceded');
    const atEnd = assemble(['main.', {slot: 'MAIN', value: MAIN_US}]);
    await refuse(atEnd.bytes, atEnd.occurrences, 'followed');
  });

  it('rejects values outside the charset or length bounds', async () => {
    await refuse(f.bytes, [{...tag1, length: 0}], 'length outside');
    await refuse(f.bytes, [{...main, length: 19}], 'length outside');
    await refuse(f.bytes, [{...tag1, offset: tag1.offset - 1, length: 6}], 'outside charset'); // '='
    const upper = assemble(['?cache=', {slot: 'CACHE_TAG', value: 'W4E0Z'}, '"']);
    await refuse(upper.bytes, upper.occurrences, 'outside charset');
    const long = assemble(['?cache=', {slot: 'CACHE_TAG', value: 'abcdefghijkl'}, '"']);
    await refuse(long.bytes, long.occurrences, 'length outside');
  });

  it('rejects slots whose neighbouring bytes are inside the charset', async () => {
    // A partial occurrence leaves charset bytes on one side.
    await refuse(f.bytes, [{...tag1, length: 4}, tag2, main], 'after');
    await refuse(f.bytes, [{...tag1, offset: tag1.offset + 1, length: 4}, tag2, main], 'before');
    const after = assemble(['?cache=', {slot: 'CACHE_TAG', value: 'w4e0z'}, 'x"']);
    await refuse(after.bytes, after.occurrences, 'after');
    const before = assemble(['?cache=x', {slot: 'CACHE_TAG', value: 'w4e0z'}, '"']);
    await refuse(before.bytes, before.occurrences, 'before');
  });

  it('rejects repeated slots with different values', async () => {
    const mixed = assemble([
      'a?cache=',
      {slot: 'CACHE_TAG', value: 'w4e0z'},
      '";b?cache=',
      {slot: 'CACHE_TAG', value: 'bjwi5'},
      '";',
    ]);
    await refuse(mixed.bytes, mixed.occurrences, 'differs');
  });

  it('rejects files containing NUL', async () => {
    const withNul = concat([f.bytes, new Uint8Array([0x0a, 0x00])]);
    await refuse(withNul, occ, 'NUL');
    await refuse(new Uint8Array([0x00]), [], 'NUL');
  });

  it('rejects malformed arguments', async () => {
    await expect(buildTemplate(Array.from(f.bytes) as unknown as Uint8Array, occ)).rejects.toThrow(
      TemplateError,
    );
    await expect(buildTemplate(f.bytes, {} as unknown as SlotOccurrence[])).rejects.toThrow(
      TemplateError,
    );
    await expect(buildTemplate(f.bytes, [null as unknown as SlotOccurrence])).rejects.toThrow(
      TemplateError,
    );
  });

  it('builds every Bitwarden fixture shape', async () => {
    for (const fx of [
      bwIndex(MAIN_EU),
      bwDuo('bjwi5', DUO),
      assemble([
        '<script src="connectors/webauthn-fallback.',
        {slot: 'WEBAUTHN_FB_JS', value: 'fedcba9876543210fedc'},
        '.js"></script>',
      ]),
    ]) {
      const tpl = await buildTemplate(fx.bytes, fx.occurrences);
      const r = await matchTemplate(tpl, fx.bytes);
      expect(r.ok && r.occurrences).toEqual(fx.occurrences);
    }
  });
});
