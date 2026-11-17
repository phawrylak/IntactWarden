/**
 * Diagnostics for UI code: forwards to platform/guard.ts logWarn
 * (codes and redacted details only, never a URL or page content) and never
 * throws, so a logging failure cannot break a page or a background listener.
 */

import {logWarn} from '../../platform/guard.ts';

export function uiWarn(code: string, error?: unknown): void {
  try {
    logWarn(`ui.${code}`, error instanceof Error ? {error: error.name} : undefined);
  } catch {
    // Logging must never fail the caller.
  }
}
