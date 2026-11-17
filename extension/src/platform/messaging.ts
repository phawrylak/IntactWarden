/**
 * Typed runtime messaging over the `ext` namespace.
 *
 * - Wire format: `{iw: 1, type, payload}` (RawEnvelope below) and Reply from ../contracts.ts;
 *   JSON-serialisable payloads only.
 * - The background router validates every sender (validateSender): `sender.id`
 *   must equal `runtime.id`; tab and frame are taken only from
 *   `sender`, never from the payload; the sender kind must match
 *   MESSAGE_SENDERS[type] (content script: a non-extension URL in a tab;
 *   page: an extension URL).
 * - Handlers are wrapped (R1): an exception becomes
 *   {ok: false, error: 'internal-error'}, logged without its message.
 * - Firefox takes the Promise a listener returns as the answer; a listener
 *   that returns `undefined` leaves the message to other listeners.
 */

import {redactUrl} from '@intactwarden/core/privacy/redactUrl.ts';
import {
  MESSAGE_SENDERS,
  type BroadcastEnvelope,
  type BroadcastMap,
  type ErrorCode,
  type MessageRequest,
  type MessageResponse,
  type MessageType,
  type RedactedUrl,
  type Reply,
  type SenderKind,
} from '../contracts.ts';
import {errorName, logWarn} from './guard.ts';
import type {Ext, MessageSender} from './webext.ts';

/** What a handler may know about the sender (all from `sender`, never from the payload). */
export interface SenderContext {
  readonly kind: SenderKind;
  readonly tab: number | null;
  readonly frame: number | null;
  readonly url: RedactedUrl | null;
  /** Content scripts: the sender's tab is in a private-browsing window. */
  readonly incognito?: boolean;
}

export type Handler<T extends MessageType> = (
  payload: MessageRequest<T>,
  sender: SenderContext,
) => Promise<MessageResponse<T>>;

export interface Router {
  /** Registers the one handler of a message type; registering twice throws. */
  handle<T extends MessageType>(type: T, handler: Handler<T>): void;
  /** Adds the runtime.onMessage listener (call once, synchronously at top level). */
  start(): void;
}

/** A handler may reject with this to send a specific error code. */
export class MessageError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.name = 'MessageError';
    this.code = code;
  }
}

interface RawEnvelope {
  readonly iw: 1;
  readonly type: MessageType;
  readonly payload: unknown;
}

function isEnvelope(m: unknown): m is RawEnvelope {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as {iw?: unknown; type?: unknown; payload?: unknown};
  return (
    o.iw === 1 &&
    typeof o.type === 'string' &&
    Object.hasOwn(MESSAGE_SENDERS, o.type) &&
    'payload' in o &&
    (typeof o.payload === 'object' || o.payload === undefined)
  );
}

/** Classifies and validates a sender; null when the message must be refused. */
export function validateSender(ext: Ext, sender: MessageSender): SenderContext | null {
  if (sender.id !== ext.runtime.id) return null;
  const base = ext.runtime.getURL('');
  const url = sender.url ?? '';
  const isExtensionUrl = url !== '' && url.startsWith(base);
  let kind: SenderKind;
  if (isExtensionUrl) {
    kind = 'page';
  } else if (sender.tab?.id !== undefined && url !== '') {
    kind = 'content';
  } else {
    return null;
  }
  return {
    kind,
    tab: sender.tab?.id ?? null,
    frame: sender.frameId ?? null,
    url: url === '' ? null : redactUrl(url),
    ...(kind === 'content' && sender.tab?.incognito === true ? {incognito: true} : {}),
  };
}

export function createRouter(ext: Ext): Router {
  const handlers = new Map<MessageType, Handler<MessageType>>();
  let started = false;
  return {
    handle(type, handler) {
      if (handlers.has(type)) throw new Error(`handler for ${type} registered twice`);
      handlers.set(type, handler as unknown as Handler<MessageType>);
    },
    start() {
      if (started) return;
      started = true;
      ext.runtime.onMessage.addListener((message, sender): Promise<Reply> | undefined => {
        // Broadcasts and foreign messages are not ours to answer.
        if (!isEnvelope(message)) return undefined;
        const handler = handlers.get(message.type);
        // A type this context does not handle is left to the context that does.
        if (handler === undefined) return undefined;
        const ctx = validateSender(ext, sender);
        if (ctx === null || MESSAGE_SENDERS[message.type] !== ctx.kind) {
          return Promise.resolve({ok: false, error: 'bad-sender'});
        }
        const payload = message.payload ?? {};
        let pending: Promise<unknown>;
        try {
          pending = handler(payload as MessageRequest<MessageType>, ctx);
        } catch (e) {
          pending = Promise.reject(e);
        }
        return pending.then(
          (value): Reply => ({ok: true, value: value as MessageResponse<MessageType>}),
          (e: unknown): Reply => {
            const code: ErrorCode = e instanceof MessageError ? e.code : 'internal-error';
            if (code === 'internal-error') {
              logWarn('handler-error', {type: message.type, error: errorName(e)});
            }
            return {ok: false, error: code};
          },
        );
      });
    },
  };
}

function unwrap<T extends MessageType>(reply: unknown): MessageResponse<T> {
  if (typeof reply === 'object' && reply !== null && 'ok' in reply) {
    const r = reply as Reply<T>;
    if (r.ok) return r.value;
    throw new MessageError(r.error);
  }
  throw new MessageError('not-ready');
}

/** Content script or extension page → background. Rejects on an error reply. */
export async function send<T extends MessageType>(
  ext: Ext,
  type: T,
  payload: MessageRequest<T>,
): Promise<MessageResponse<T>> {
  const reply = await ext.runtime.sendMessage({iw: 1, type, payload});
  return unwrap<T>(reply);
}

/** Background → all open extension pages; never fails (no receivers is fine). */
export function broadcast<T extends keyof BroadcastMap>(
  ext: Ext,
  type: T,
  payload: BroadcastMap[T],
): void {
  const env: BroadcastEnvelope<T> = {iw: 1, broadcast: type, payload};
  try {
    void Promise.resolve(ext.runtime.sendMessage(env)).catch(() => undefined);
  } catch {
    // No receiver.
  }
}

/** Extension pages: listen to broadcasts. */
export function onBroadcast(
  ext: Ext,
  listener: <T extends keyof BroadcastMap>(type: T, payload: BroadcastMap[T]) => void,
): () => void {
  const raw = (message: unknown, sender: MessageSender): undefined => {
    if (sender.id !== ext.runtime.id) return undefined;
    if (typeof message !== 'object' || message === null) return undefined;
    const m = message as Partial<BroadcastEnvelope>;
    if (m.iw !== 1 || typeof m.broadcast !== 'string' || m.payload === undefined) return undefined;
    try {
      listener(m.broadcast, m.payload as BroadcastMap[typeof m.broadcast]);
    } catch (e) {
      logWarn('broadcast-listener', {error: errorName(e)});
    }
    return undefined;
  };
  ext.runtime.onMessage.addListener(raw);
  return () => ext.runtime.onMessage.removeListener(raw);
}
