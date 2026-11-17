/**
 * Engine-internal types: the mutable in-memory form of a document session, and the runtime surface
 * the content-script and UI handlers call (engine/handlers.ts).
 */

import type {
  DocKey,
  DocumentSessionRecord,
  DomDetail,
  DomEvent,
  Engine,
  IncidentRecord,
  ItemRecord,
  OriginAlert,
  RedactedUrl,
  RequestId,
  ResType,
  SensorConfig,
} from '../contracts.ts';
import type {SenderDoc} from '../backends/types.ts';

export type Mutable<T> = {-readonly [K in keyof T]: T[K]};

export interface PendingEntry {
  readonly path: string;
  readonly type: ResType;
  readonly since: number;
  /** Redacted URL, so a request can be rebuilt after a restart. */
  readonly url?: RedactedUrl;
}

/** In-memory session: the persisted record with mutable top-level fields. */
export type SessionRec = Mutable<
  Omit<DocumentSessionRecord, 'items' | 'pending' | 'serverStyles'>
> & {
  items: Record<string, ItemRecord>;
  pending: Record<RequestId, PendingEntry>;
  serverStyles: Mutable<DocumentSessionRecord['serverStyles']>;
};

export interface ContentPayloads {
  readonly dom: {doc: DocKey; event: DomEvent; detail: DomDetail};
  readonly csp: {doc: DocKey; directive: string; blockedUrl: RedactedUrl};
}

export interface EngineRuntime extends Engine {
  hello(sender: SenderDoc): Promise<SensorConfig>;
  contentDom(sender: SenderDoc, payload: ContentPayloads['dom']): Promise<void>;
  contentCspViolation(sender: SenderDoc, payload: ContentPayloads['csp']): Promise<void>;
  listAlerts(): Promise<readonly OriginAlert[]>;
  listIncidents(limit: number): Promise<readonly IncidentRecord[]>;
  /** Resolves once start() finished (rehydrated; trust and registry ready). */
  whenReady(): Promise<void>;
}
