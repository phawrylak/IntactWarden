/**
 * Background entry and composition root: the Firefox event page.
 *
 * - Every listener is registered synchronously at the top level (MV3: listeners added after an
 *   await are missed when the event page wakes for an event): the router, the engine's tab listener
 *   and the backend's webRequest and webNavigation listeners (backend.start adds them before its
 *   first await). Work that needs readiness waits inside the listeners.
 * - IndexedDB opens asynchronously; a deferred handle lets everything be constructed synchronously.
 * - The engine rehydrates before deciding (R7). Nothing keeps the event page alive: it rests when
 *   idle and wakes for the next event.
 */

import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {createFirefoxBackend} from '../backends/firefox/index.ts';
import {createRegistry} from '../deployments/index.ts';
import {AlertBook} from '../engine/alerts.ts';
import {registerEngineHandlers} from '../engine/handlers.ts';
import {createEngine} from '../engine/index.ts';
import type {EngineRuntime} from '../engine/types.ts';
import {getExt} from '../platform/api.ts';
import {errorName, logWarn} from '../platform/guard.ts';
import {deferredExtensionDb, openExtensionDb} from '../platform/idb.ts';
import {createRouter} from '../platform/messaging.ts';
import {createSettingsStore, registerSettingsHandlers} from '../platform/settings.ts';
import {createLocalStore, createSessionStore} from '../platform/storage.ts';
import {registerTrustHandlers} from '../trust/handlers.ts';
import {createTrustStore} from '../trust/index.ts';
import {createActionController} from '../ui/action/index.ts';
import {registerUiHandlers} from '../ui/background.ts';
import {createAlertSink} from '../ui/notify/index.ts';

export async function main(): Promise<void> {
  const ext = getExt();
  const now = (): number => Date.now();
  const fetchFn: typeof fetch = globalThis.fetch.bind(globalThis);
  const router = createRouter(ext);
  const settings = createSettingsStore(ext);
  const registry = createRegistry({ext, fetch: fetchFn, now});
  // IndexedDB can be unavailable: each call then fails (idb.ts).
  const db = deferredExtensionDb(openExtensionDb());
  // Origin alerts and the incident log: the engine writes it.
  const alerts = new AlertBook(createLocalStore(ext), now, createSessionStore(ext));
  const trust = createTrustStore({
    ext,
    db,
    builder: createCoreBuilder(),
    fetch: fetchFn,
    now,
  });
  const holder: {engine?: EngineRuntime} = {};
  const whenReady = (): Promise<void> => holder.engine?.whenReady() ?? Promise.resolve();
  const backend = createFirefoxBackend({
    ext,
    now,
    whenReady,
    lookup: origin => registry.lookup(origin),
  });
  const tabSink = createActionController(ext, registry);
  const engine = createEngine({
    ext,
    backend,
    registry,
    trust,
    tabSink,
    alertSink: createAlertSink(ext, () => settings.get()),
    alerts,
    now,
  });
  holder.engine = engine;
  registerSettingsHandlers(router, settings);
  registerTrustHandlers(router, trust, registry, ext);
  registerEngineHandlers(router, engine);
  registerUiHandlers(router, ext, registry);
  router.start();
  // Adds the webRequest listeners synchronously; the rest waits for the engine.
  const started = backend.start(engine);
  trust.onReleaseKnown(refs => void engine.releaseKnown(refs));
  trust.onReleaseDisputed((key, reason) => void engine.releaseDisputed(key, reason));
  registry.onChange(o => void engine.originsChanged(o));
  await settings.ready();
  await engine.start();
  await started;
}

main().catch(error => logWarn('background-start', {error: errorName(error)}));
