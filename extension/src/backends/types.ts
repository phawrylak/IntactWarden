/**
 * What the engine asks of the backend beyond `start` and `command`: what only the backend knows,
 * namely the DocKey of the document a content-script message came from (the current
 * `tab:frame:navSeq` of the sender's frame) and whether a document's frame is gone.
 */

import type {Backend, DocKey, RedactedUrl} from '../contracts.ts';

/** The sender of a content-script message, as validated by the router (never from the payload). */
export interface SenderDoc {
  readonly tab: number;
  readonly frame: number;
  readonly url: RedactedUrl | null;
  /** The sender's tab is in a private-browsing window. */
  readonly incognito?: boolean;
}

export interface ContentBridge {
  /** DocKey of the sending document, or null when the backend has no record of it (R2). */
  docKeyFor(sender: SenderDoc): DocKey | null;
  /**
   * Whether Firefox confirms the frame gone: webNavigation.getFrame finds no such frame or
   * reports a discarded tab, or the tab does not exist. False when that cannot be confirmed.
   * Nothing a page controls answers it.
   */
  documentGone(tab: number, frame: number): Promise<boolean>;
  /**
   * A protected document announced itself (content-script hello) in a frame the backend knows
   * nothing about (it loaded before IntactWarden started: install, update, enable; or a page the
   * extension may not access frames it): allocate and commit a DocKey for it, so it gets an R2
   * session. Null when the frame already has a document.
   */
  adopt(tab: number, frame: number, url: RedactedUrl): DocKey | null;
}

export type ObservingBackend = Backend & ContentBridge;

/**
 * Resolves when the engine can take observations (rehydrated, trust and registry ready). The
 * backend registers its listeners synchronously at start (event-page wake-up) and waits on this
 * before deciding anything.
 */
export type WhenReady = () => Promise<void>;
