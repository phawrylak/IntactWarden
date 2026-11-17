import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {crc32} from '@intactwarden/core/archive/crc32.ts';
import {LATTICE} from '@intactwarden/core/verdict/states.ts';
import {describe, expect, it} from 'vitest';
import {EXTENSION_DIR} from '../../build/paths.ts';
import {
  ACTION_ICONS,
  actionIconFile,
  actionIconPaths,
  ICON_DIR,
  PRODUCT_ICON_SIZES,
  productIconPath,
} from '../../src/platform/iconPaths.ts';

// The icons are committed files (extension/assets/icons/), copied into the package by the build.
const committed = (dir: string): string[] =>
  readdirSync(dir, {withFileTypes: true, recursive: true})
    .filter(e => e.isFile())
    .map(e => relative(EXTENSION_DIR, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort();
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(join(EXTENSION_DIR, path)));

describe('icon set', () => {
  it('covers every lattice icon plus the CHECKING spinner, and no other', () => {
    // An icon of a removed state must leave the package with the state.
    const shown = new Set<string>([...LATTICE.map(r => r.icon), 'grey-spinner']);
    expect([...ACTION_ICONS].sort()).toEqual([...shown].sort());
  });

  it('maps icons to package paths', () => {
    expect(actionIconPaths('amber')).toEqual({
      '16': 'assets/icons/state/amber.svg',
      '32': 'assets/icons/state/amber.svg',
    });
    expect(productIconPath(128)).toBe('assets/icons/icon-128.png');
  });

  it('the committed directory holds exactly one SVG per toolbar icon and the product PNGs', () => {
    expect(committed(join(EXTENSION_DIR, ICON_DIR))).toEqual(
      [...ACTION_ICONS.map(actionIconFile), ...PRODUCT_ICON_SIZES.map(productIconPath)].sort(),
    );
  });
});

describe('committed icon files', () => {
  it('each SVG is a plain document of shapes, and no two are alike', () => {
    const seen = new Set<string>();
    for (const icon of ACTION_ICONS) {
      const svg = new TextDecoder('utf-8', {fatal: true}).decode(read(actionIconFile(icon)));
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).not.toMatch(/<script|on[a-z]+=|href|<style|url\(|<!|<\?/i);
      for (const m of svg.matchAll(/<([a-z]+)\b/gi))
        expect(['svg', 'path', 'circle']).toContain(m[1]);
      seen.add(svg);
    }
    expect(seen.size).toBe(ACTION_ICONS.length);
  });

  it('each PNG holds only IHDR, IDAT and IEND, with valid CRCs and the size of its name', () => {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const size of PRODUCT_ICON_SIZES) {
      const png = read(productIconPath(size));
      expect([...png.subarray(0, 8)]).toEqual(signature);
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      const chunks: string[] = [];
      for (let o = 8; o < png.length;) {
        const len = view.getUint32(o);
        const typeAndData = png.subarray(o + 4, o + 8 + len);
        chunks.push(String.fromCharCode(...typeAndData.subarray(0, 4)));
        expect(crc32(typeAndData)).toBe(view.getUint32(o + 8 + len));
        o += 12 + len;
      }
      expect(chunks[0]).toBe('IHDR');
      expect(chunks.at(-1)).toBe('IEND');
      expect(chunks.slice(1, -1).every(c => c === 'IDAT')).toBe(true);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([size, size]);
    }
  });
});
