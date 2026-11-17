import {describe, expect, it} from 'vitest';
import {canonicalBytes, canonicalize} from '../src/jcs/canonicalize.ts';
import {toHex} from '../src/hash/hex.ts';

function doubleFromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe('canonicalize: RFC 8785 vectors', () => {
  it('sorts property names by UTF-16 code units (§3.2.3 example)', () => {
    const input = JSON.parse(String.raw`{
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis"
    }`) as unknown;
    const expectedOrder: [string, string][] = [
      ['\r', 'Carriage Return'],
      ['1', 'One'],
      ['\u0080', 'Control'],
      ['\u00f6', 'Latin Small Letter O With Diaeresis'],
      ['\u20ac', 'Euro Sign'],
      ['\ud83d\ude00', 'Emoji: Grinning Face'],
      ['\ufb33', 'Hebrew Letter Dalet With Dagesh'],
    ];
    const expected = `{${expectedOrder.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`;
    const out = canonicalize(input);
    expect(out).toBe(expected);
    // "\r" is escaped; U+0080 and the non-BMP emoji are emitted verbatim.
    expect(out.startsWith('{"\\r":"Carriage Return","1":"One","\u0080":')).toBe(true);
    expect(out).toContain('"\ud83d\ude00":"Emoji');
  });

  it('serialises the §3.2.2 sample and yields the §3.2.4 UTF-8 bytes', () => {
    const input = String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`;
    const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
    const expectedHex = `
      7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
      75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
      5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
      65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
      5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
      30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`.replace(/\s+/g, '');
    const value = JSON.parse(input) as unknown;
    expect(canonicalize(value)).toBe(expected);
    expect(toHex(canonicalBytes(value))).toBe(expectedHex);
  });

  it('serialises the Appendix B number samples', () => {
    const samples: [string, string][] = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ];
    for (const [hex, expected] of samples) {
      expect(canonicalize(doubleFromHex(hex)), hex).toBe(expected);
    }
    expect(() => canonicalize(doubleFromHex('7fffffffffffffff'))).toThrow(TypeError); // NaN
    expect(() => canonicalize(doubleFromHex('7ff0000000000000'))).toThrow(TypeError); // Infinity
  });

  it('normalises number spellings like ECMAScript Number::toString', () => {
    const cases: [string, string][] = [
      ['1e21', '1e+21'],
      ['1e20', '100000000000000000000'],
      ['1e-7', '1e-7'],
      ['1e-6', '0.000001'],
      ['0.000001', '0.000001'],
      ['-1e-6', '-0.000001'],
      ['-0', '0'],
      ['-0.0', '0'],
      ['333333333.33333329', '333333333.3333333'],
      ['1E30', '1e+30'],
      ['4.50', '4.5'],
      ['2e-3', '0.002'],
      ['0.000000000000000000000000001', '1e-27'],
      ['1.0', '1'],
      ['100', '100'],
      ['0.1', '0.1'],
      ['-1.5e-7', '-1.5e-7'],
      ['123456789012345680000', '123456789012345680000'],
      ['9007199254740993', '9007199254740992'],
    ];
    for (const [literal, expected] of cases) {
      expect(canonicalize(JSON.parse(literal)), literal).toBe(expected);
    }
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize([-0, 0, {a: -0}])).toBe('[0,0,{"a":0}]');
  });

  it('escapes strings exactly as §3.2.2.2 requires', () => {
    const input = '\u0000\u0001\u0008\t\n\u000b\f\r\u001f "\\/\u007f\u0080\u2028\u2029\ufeff€😀';
    const expected =
      String.raw`"\u0000\u0001\b\t\n\u000b\f\r\u001f \"\\/` + '\u007f\u0080\u2028\u2029\ufeff€😀"';
    expect(canonicalize(input)).toBe(expected);
    expect(canonicalize('\ud800\udc00')).toBe('"\u{10000}"');
    expect(canonicalize('')).toBe('""');
  });

  it('serialises literals, arrays and nested objects', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize({b: {d: 1, c: [{f: 1, e: 2}]}, a: null})).toBe(
      '{"a":null,"b":{"c":[{"e":2,"f":1}],"d":1}}',
    );
    // Integer-like keys: JS enumerates them numerically, JCS sorts by code units.
    expect(canonicalize({2: 'c', 10: 'b', 1: 'a', '': 'e', aa: 'g', a: 'f', ab: 'h'})).toBe(
      '{"":"e","1":"a","10":"b","2":"c","a":"f","aa":"g","ab":"h"}',
    );
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 1;
    bare.a = 2;
    expect(canonicalize(bare)).toBe('{"a":2,"b":1}');
    // Shared (non-cyclic) references are fine.
    const shared = {x: 1};
    expect(canonicalize({a: shared, b: [shared, shared]})).toBe(
      '{"a":{"x":1},"b":[{"x":1},{"x":1}]}',
    );
  });

  it('canonicalBytes is the UTF-8 of canonicalize', () => {
    expect(toHex(canonicalBytes({'€': '😀'}))).toBe('7b22e282ac223a22f09f9880227d');
  });
});

describe('canonicalize: input that is not plain JSON data', () => {
  class Point {
    x = 1;
  }
  const sparse: unknown[] = [];
  sparse[2] = 1;

  const cases: [string, unknown][] = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['nested NaN', {a: [1, NaN]}],
    ['undefined', undefined],
    ['undefined value', {a: undefined}],
    ['undefined element', [undefined]],
    ['function', () => 1],
    ['function value', {f() {}}],
    ['toJSON method', {toJSON: () => 1}],
    ['symbol', Symbol('s')],
    ['symbol value', {s: Symbol('s')}],
    ['bigint', 1n],
    ['bigint element', [1n]],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['Set', new Set()],
    ['RegExp', /a/],
    ['Error', new Error('x')],
    ['class instance', new Point()],
    ['boxed string', Object('a')],
    ['boxed number', Object(1)],
    ['typed array', new Uint8Array(1)],
    ['sparse array', sparse],
  ];
  for (const [name, value] of cases) {
    it(`throws on ${name}`, () => {
      expect(() => canonicalize(value)).toThrow(TypeError);
      expect(() => canonicalBytes(value)).toThrow(TypeError);
    });
  }
});

/** mulberry32: small deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gen {
  rand: () => number;
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
}

function gen(seed: number): Gen {
  const rand = mulberry32(seed);
  return {
    rand,
    int: n => Math.floor(rand() * n),
    pick: items => items[Math.floor(rand() * items.length)]!,
  };
}

function randomCodePoint(g: Gen): number {
  switch (g.int(8)) {
    case 0:
      return g.int(0x20); // C0 controls
    case 1:
      return g.pick([0x22, 0x5c, 0x2f, 0x7f, 0x2028, 0x2029, 0xfeff, 0xfffd]);
    case 2:
      return 0x80 + g.int(0x780); // two-byte UTF-8
    case 3: {
      const c = 0x800 + g.int(0xf800); // BMP, excluding surrogates
      return c >= 0xd800 && c <= 0xdfff ? 0xe000 : c;
    }
    case 4:
      return 0x10000 + g.int(0x100000); // astral (surrogate pair in UTF-16)
    default:
      return 0x20 + g.int(0x5f); // printable ASCII
  }
}

function randomString(g: Gen): string {
  let s = '';
  for (let n = g.int(8); n > 0; n--) s += String.fromCodePoint(randomCodePoint(g));
  return s;
}

function randomNumber(g: Gen): number {
  switch (g.int(6)) {
    case 0:
      return g.int(2001) - 1000;
    case 1:
      return (g.rand() * 2 - 1) * Number.MAX_SAFE_INTEGER;
    case 2: {
      const view = new DataView(new ArrayBuffer(8));
      view.setUint32(0, g.int(2 ** 32));
      view.setUint32(4, g.int(2 ** 32));
      const n = view.getFloat64(0);
      return Number.isFinite(n) ? n : 0;
    }
    case 3:
      return Math.round(g.rand() * 1e6) / 1000;
    case 4:
      return g.pick([1, -1, 2.5, 7]) * 10 ** (g.int(61) - 30);
    default:
      return g.pick([0, -0, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, Number.MIN_SAFE_INTEGER]);
  }
}

const KEY_POOL = ['', '0', '1', '2', '10', '01', '-1', '1.5', 'a', 'aa', 'ab', 'B', '€', '😀'];

function randomValue(g: Gen, depth: number): unknown {
  const kind = depth >= 4 ? g.int(4) : g.int(6);
  switch (kind) {
    case 0:
      return g.pick([null, true, false]);
    case 1:
      return randomNumber(g);
    case 2:
    case 3:
      return randomString(g);
    case 4: {
      const out: unknown[] = [];
      for (let n = g.int(5); n > 0; n--) out.push(randomValue(g, depth + 1));
      return out;
    }
    default: {
      const out: Record<string, unknown> = {};
      for (let n = g.int(6); n > 0; n--) {
        const key = g.rand() < 0.5 ? g.pick(KEY_POOL) : randomString(g);
        out[key] = randomValue(g, depth + 1);
      }
      return out;
    }
  }
}

/** Independent reference in the style of RFC 8785 Appendix A. */
function reference(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(reference).join(',')}]`;
  const record = v as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => {
    for (let i = 0; i < a.length && i < b.length; i++) {
      const d = a.charCodeAt(i) - b.charCodeAt(i);
      if (d !== 0) return d;
    }
    return a.length - b.length;
  });
  return `{${keys.map(k => `${JSON.stringify(k)}:${reference(record[k])}`).join(',')}}`;
}

describe('round-trip properties (deterministic PRNG)', () => {
  it('canonicalize agrees with the reference and is a fixed point of JSON.parse', () => {
    const g = gen(0x8785);
    const decoder = new TextDecoder();
    for (let i = 0; i < 2000; i++) {
      const value = randomValue(g, 0);
      const text = canonicalize(value);
      expect(text, `sample ${i}`).toBe(reference(value));
      expect(decoder.decode(canonicalBytes(value))).toBe(text);
      expect(canonicalize(JSON.parse(text))).toBe(text);
      // The load-time re-check (extension/src/trust/coresDb.ts): any other serialisation of the
      // same value differs from its own re-serialisation.
      for (const variant of [JSON.stringify(value), JSON.stringify(value, null, 1)]) {
        if (variant !== text) expect(canonicalize(JSON.parse(variant)), variant).not.toBe(variant);
      }
    }
  });
});
