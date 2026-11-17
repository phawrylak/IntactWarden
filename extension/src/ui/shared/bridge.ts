/**
 * Typed client for extension pages. Pages talk to the background
 * only through messages (R10: they read persisted state the background
 * returns and never compute a verdict). The transport is
 * platform/messaging.ts.
 *
 * There is no keep-alive port: Firefox stops an idle event page whatever ports
 * are open (e2e event-page-idle); a running deep verify keeps it alive itself
 * (trust/jobHost.ts `withKeepAlive`).
 */

import {
  type BroadcastMap,
  type MessageRequest,
  type MessageResponse,
  type MessageType,
  type Unsubscribe,
} from '../../contracts.ts';
import {onBroadcast, send} from '../../platform/messaging.ts';
import type {Ext} from '../../platform/webext.ts';

export type BroadcastListener = <T extends keyof BroadcastMap>(
  type: T,
  payload: BroadcastMap[T],
) => void;

export interface PageBridge {
  readonly ext: Ext;
  call<T extends MessageType>(type: T, payload: MessageRequest<T>): Promise<MessageResponse<T>>;
  onBroadcast(listener: BroadcastListener): Unsubscribe;
}

export function createBridge(ext: Ext): PageBridge {
  return {
    ext,
    call: (type, payload) => send(ext, type, payload),
    onBroadcast: listener => onBroadcast(ext, listener),
  };
}
