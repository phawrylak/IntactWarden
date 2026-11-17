/**
 * The promise-only `ext` namespace. The only module that touches Firefox's `browser` global;
 * everything else receives an `Ext`, so unit tests pass a fake.
 */

import type {Ext} from './webext.ts';

interface ExtGlobals {
  readonly browser?: unknown;
}

function resolveExt(): Ext {
  const ns = (globalThis as ExtGlobals).browser;
  if (ns === undefined || ns === null) {
    // Fail closed outside an extension context: callers catch and do nothing.
    throw new Error('IntactWarden: no WebExtension namespace in this context');
  }
  return ns as Ext;
}

/** Resolved lazily so importing this module in tests does not throw. */
export function getExt(): Ext {
  cached ??= resolveExt();
  return cached;
}

let cached: Ext | undefined;
