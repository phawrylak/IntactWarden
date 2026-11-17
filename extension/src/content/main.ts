/**
 * Content-script entry (isolated world, document_start, all frames):
 * CS_HELLO → SensorConfig, once per document, and the sensors: sentinel.ts, swCheck.ts. Signals
 * only: nothing here derives a state, and nothing is ever shown in the page (the toolbar icon, the
 * notification and the blocked page are the user's channels).
 */

import {redactUrl} from '@intactwarden/core/privacy/redactUrl.ts';
import type {SensorConfig} from '../contracts.ts';
import {getExt} from '../platform/api.ts';
import {send} from '../platform/messaging.ts';
import type {Ext} from '../platform/webext.ts';
import {startSentinel} from './sentinel.ts';
import {countServiceWorkers} from './swCheck.ts';

export function boot(ext: Ext): void {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  let config: SensorConfig | null = null;

  // The sentinel starts before any page script; it reports once the configuration arrived.
  const sentinel = startSentinel(document, (event, detail) => {
    if (config === null) return;
    void send(ext, 'CS_DOM', {doc: config.doc, event, detail}).catch(() => undefined);
  });

  void (async () => {
    const c = await send(ext, 'CS_HELLO', {}).catch(() => null);
    if (c === null || !c.protected || c.doc === '') {
      sentinel.stop();
      return;
    }
    config = c;
    sentinel.configure();
    const sw = navigator.serviceWorker as ServiceWorkerContainer | undefined;
    const n = await countServiceWorkers({
      getRegistrations: sw === undefined ? null : () => sw.getRegistrations(),
      controlled: () => sw !== undefined && sw.controller !== null,
    });
    if (n > 0) {
      void send(ext, 'CS_DOM', {doc: c.doc, event: 'sw-register', detail: {count: n}}).catch(
        () => undefined,
      );
    }
    document.addEventListener('securitypolicyviolation', e => {
      // Only the browser's own reports: a page can dispatch a forged event (false red).
      if (!e.isTrusted) return;
      const blocked =
        e.blockedURI === 'inline' || e.blockedURI === 'eval'
          ? e.blockedURI
          : redactUrl(e.blockedURI);
      void send(ext, 'CS_CSP_VIOLATION', {
        doc: c.doc,
        directive: e.effectiveDirective,
        blockedUrl: blocked,
      }).catch(() => undefined);
    });
  })();
}

try {
  boot(getExt());
} catch {
  // Not an extension context (or the extension was reloaded): nothing to do.
}
