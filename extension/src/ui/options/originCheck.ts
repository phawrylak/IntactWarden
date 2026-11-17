/**
 * Pre-check of a typed self-hosted origin in Options → "Add server"
 * (address normalisation and look-alike guards).
 *
 * Runs synchronously in the click handler, before `permissions.request`
 * (which must be the handler's first await to keep the user gesture), so it
 * must not message the background. It uses the same pure functions as the
 * background, which repeats both checks where it stores the instance: the
 * address parser (deployments/serverAddress.ts `parseInstanceInput`: https always,
 * http only for this computer, the official and GitHub hosts refused, so the
 * host permission requested and later released here is never a required one)
 * and the look-alike check (`isLookalikeHost`), whose hit needs an explicit
 * confirmation before the permission is requested.
 */

import type {AddInstanceRefusal} from '../../contracts.ts';
import {
  isLookalikeHost,
  matchPatternFor,
  parseInstanceInput,
} from '../../deployments/serverAddress.ts';

export type InputCheck =
  | {readonly ok: false; readonly code: AddInstanceRefusal}
  | {
      readonly ok: true;
      readonly origin: string;
      readonly basePath: string;
      /** The one host permission to request: "https://<host>/*" or "http://<host>/*". */
      readonly pattern: string;
      readonly lookalike: boolean;
    };

/** Checks what the user typed. Never throws. */
export function checkInstanceInput(input: string): InputCheck {
  const parsed = parseInstanceInput(input);
  if (!parsed.ok) return {ok: false, code: parsed.code};
  return {
    ok: true,
    origin: parsed.origin,
    basePath: parsed.basePath,
    pattern: matchPatternFor(parsed.origin),
    lookalike: isLookalikeHost(new URL(parsed.origin).hostname),
  };
}
