import {describe, expect, it} from 'vitest';
import {classifyPath, compareStrings, manifestKey, RefusalError} from '../src/files.ts';

describe('classifyPath', () => {
  it('maps extensions case-insensitively and treats a leading dot as no extension', () => {
    expect(classifyPath('/a/B.JS')).toBe('script');
    expect(classifyPath('/x.module.wasm')).toBe('wasm');
    expect(classifyPath('/a.js.map')).toBe('sourcemap');
    expect(classifyPath('/i.jpg')).toBe('image');
    expect(classifyPath('/.nojekyll')).toBe('data');
    expect(classifyPath('/LICENSE')).toBe('data');
  });

  it('refuses unknown extensions', () => {
    for (const p of ['/a.php', '/a.exe', '/a.', '/a.js~']) {
      expect(() => classifyPath(p), p).toThrow(RefusalError);
    }
  });
});

describe('manifestKey', () => {
  it('returns the normalised request path of a member', () => {
    expect(manifestKey('/images/logo-primary@2x.png')).toBe('/images/logo-primary@2x.png');
    expect(manifestKey('/a b.js')).toBe('/a%20b.js');
    expect(manifestKey('/100%.txt')).toBe('/100%25.txt');
    expect(manifestKey('/q?.txt')).toBe('/q%3F.txt');
    expect(manifestKey('/h#.txt')).toBe('/h%23.txt');
    expect(manifestKey('/é.txt')).toBe('/%C3%A9.txt');
  });

  it('refuses names a browser cannot request as that file', () => {
    for (const p of ['/a/../b.js', '/a//b.js', '/a/', '/a\\b.js', '/\u0001.js']) {
      expect(() => manifestKey(p), p).toThrow(RefusalError);
    }
  });
});

describe('compareStrings', () => {
  it('orders by UTF-16 code units, independent of locale', () => {
    expect(['b', 'B', 'a', 'é', '_'].sort(compareStrings)).toEqual(['B', '_', 'a', 'b', 'é']);
  });
});
