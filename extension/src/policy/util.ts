/**
 * Small pure helpers shared by the policy kernel (no I/O, no globals beyond URL).
 */

import {normalizePath} from '@intactwarden/core/routing/normalizePath.ts';
import type {ItemClass, ProtectedOrigin, ResType} from '../contracts.ts';

export function originOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Normalised path of a URL, or null. */
export function pathOfUrl(url: string): string | null {
  try {
    return normalizePath(new URL(url).pathname);
  } catch {
    return null;
  }
}

/** Path relative to the origin's base path ("/x" for "<base>x"), or null when outside it. */
export function relativePath(origin: ProtectedOrigin, path: string): string | null {
  const base = origin.basePath.endsWith('/') ? origin.basePath : origin.basePath + '/';
  if (!path.startsWith(base)) return null;
  return '/' + path.slice(base.length);
}

/** Whether a profile rule with an optional `deployments` list applies to the origin's deployment. */
export function applies(
  origin: ProtectedOrigin,
  deployments: readonly string[] | undefined,
): boolean {
  return deployments === undefined || deployments.includes(origin.deployment.id);
}

export function isDocumentType(type: ResType): boolean {
  return type === 'main_frame' || type === 'sub_frame';
}

/** Request types that execute or render code. */
export function isActiveType(type: ResType): boolean {
  return (
    type === 'main_frame' ||
    type === 'sub_frame' ||
    type === 'script' ||
    type === 'stylesheet' ||
    type === 'font' ||
    type === 'object'
  );
}

/** Item classes that are active (an unverifiable one withholds green, R11). */
export function isActiveClass(cls: ItemClass): boolean {
  return (
    cls === 'document' ||
    cls === 'script' ||
    cls === 'style' ||
    cls === 'wasm' ||
    cls === 'font' ||
    cls === 'server-style' ||
    cls === 'unknown'
  );
}

/**
 * The value, as received, of the first header named `name` (the backend lowercases names, not
 * values).
 */
export function header(
  headers: readonly (readonly [string, string])[],
  name: string,
): string | null {
  for (const [n, v] of headers) if (n === name) return v;
  return null;
}

/** Item class of a request type when no manifest entry says better. */
export function classOfType(type: ResType, path: string): ItemClass {
  switch (type) {
    case 'main_frame':
    case 'sub_frame':
      return 'document';
    case 'script':
      return 'script';
    case 'stylesheet':
      return 'style';
    case 'font':
      return 'font';
    case 'image':
      return 'image';
    case 'media':
      return 'media';
    case 'xmlhttprequest':
      return path.endsWith('.wasm') ? 'wasm' : path.endsWith('.map') ? 'sourcemap' : 'data';
    default:
      return 'unknown';
  }
}
