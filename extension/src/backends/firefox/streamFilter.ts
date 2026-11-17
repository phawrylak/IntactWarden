/**
 * One StreamFilter per covered response.
 *
 * Bytes are buffered until `onstop` and never written before (one code path, no
 * time-of-check/time-of-use gap); the buffer is handed to `body`, which hashes it (WebCrypto) and
 * asks the engine, and exactly that buffer is written (allow) or nothing is (block). R4: a filter
 * pending longer than its timeout is reported `timeout` and closed empty, so a decision that never
 * comes cannot hold a response past R4; so is a response over the buffering budget (`too-large`).
 * An exception while the decision is made or applied fails closed (R1): the filter closes empty.
 * A chunk `ondata` cannot copy is only logged: the filter stays open and the shortened body is
 * judged as received, so it fails the check of any listed file.
 */

import type {Decision, RequestId, UnverifiableReason} from '../../contracts.ts';
import {errorName, logWarn} from '../../platform/guard.ts';
import type {StreamFilter} from '../../platform/webext.ts';

export interface FilterHooks {
  readonly req: RequestId;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** The whole body: hash it and ask the engine. A rejection fails closed (R1). */
  body(bytes: Uint8Array): Promise<Decision>;
  /**
   * The response could not be verified. `delivered`: the filter no longer holds it, so what the
   * network sends goes on to the page (onerror); false when it closed with nothing written.
   */
  unverifiable(reason: UnverifiableReason, delivered: boolean): void;
  /** The filter is finished (closed or disconnected) one way or another. */
  done(): void;
  /** A blocked top-level document: navigate to the extension page. */
  blocked(decision: Extract<Decision, {act: 'block'}>): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

export function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.length === size) return chunks[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function attachFilter(f: StreamFilter, h: FilterHooks): void {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    h.clearTimer(timer);
    h.done();
  };
  const safeClose = (): void => {
    try {
      f.close();
    } catch {
      // Already closed.
    }
  };
  /** Closes the filter: nothing more is written (all of it is denied if nothing was). */
  const end = (): void => {
    safeClose();
    finish();
  };
  const timer = h.setTimer(() => {
    if (finished) return;
    h.unverifiable('timeout', false);
    end();
  }, h.timeoutMs);

  f.ondata = event => {
    if (finished) return;
    try {
      const chunk = new Uint8Array(event.data.slice(0));
      chunks.push(chunk);
      size += chunk.length;
      if (size > h.maxBytes) {
        h.unverifiable('too-large', false);
        end();
      }
    } catch (e) {
      logWarn('filter-data', {error: errorName(e)});
    }
  };
  f.onerror = () => {
    if (finished) return;
    // Firefox drops a filter that fails: it holds nothing any more, so the rest of the response
    // flows to the page unfiltered.
    h.unverifiable('filter-failed', true);
    finish();
  };
  f.onstop = () => {
    if (finished) return;
    const bytes = concat(chunks, size);
    h.body(bytes).then(
      decision => {
        if (finished) return;
        try {
          // Only exactly the hashed bytes, and only on 'allow'.
          if (decision.act === 'allow') f.write(bytes);
          safeClose();
          if (decision.act === 'block') h.blocked(decision);
        } finally {
          end();
        }
      },
      (e: unknown) => {
        logWarn('filter-decision', {error: errorName(e)});
        end();
      },
    );
  };
}
