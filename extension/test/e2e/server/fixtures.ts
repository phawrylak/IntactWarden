/**
 * All fixture servers of the e2e suite: the genuine, tampered-script, injected-inline,
 * script-redirect, Refresh, tampered-Secrets-Manager and revalidating Bitwarden self-hosted sites,
 * the Vaultwarden sites (among them the blob: trampoline, the locale answered 203, the one that
 * adds Link headers, the one that answers frames with attacker documents and the one that
 * registers a service worker), the cloud emulator, the GitHub mirror and the payment hosts.
 */

import type {Fixtures} from '../scenarios.ts';
import {IMAGE_ONLY_VERSION, startGitHubMirror} from './github.ts';
import {startPaymentHosts} from './payments.ts';
import {startBitwardenCloud, startBitwardenSelfhost, startVaultwarden} from './sites.ts';

export interface RunningFixtures extends Fixtures {
  close(): Promise<void>;
}

export async function startFixtures(): Promise<RunningFixtures> {
  const bitwarden = await startBitwardenSelfhost();
  const bitwardenTampered = await startBitwardenSelfhost({tamper: 'main-js'});
  const bitwardenInline = await startBitwardenSelfhost({tamper: 'inline-script'});
  const bitwardenScriptRedirect = await startBitwardenSelfhost({tamper: 'script-redirect'});
  const bitwardenRefresh = await startBitwardenSelfhost({tamper: 'refresh'});
  const bitwardenSmTampered = await startBitwardenSelfhost({tamper: 'sm-chunk'});
  const bitwardenRevalidating = await startBitwardenSelfhost({revalidate: true});
  const vaultwarden = await startVaultwarden();
  const vaultwardenInline = await startVaultwarden({tamper: 'inline-script'});
  const vaultwardenSubpath = await startVaultwarden({basePath: '/vw/'});
  const vaultwardenCustomCss = await startVaultwarden({css: 'custom'});
  const vaultwardenImageOnly = await startVaultwarden({versionHint: IMAGE_ONLY_VERSION});
  // The attacker pages of these two are BUILD_UNVERIFIED (their hint names an image-only release).
  const vaultwardenForgedPagehide = await startVaultwarden({
    tamper: 'forged-pagehide',
    versionHint: IMAGE_ONLY_VERSION,
  });
  const vaultwardenSmChunk = await startVaultwarden({bitwardenSmChunk: true});
  const vaultwardenBlob = await startVaultwarden({
    tamper: 'blob-trampoline',
    versionHint: IMAGE_ONLY_VERSION,
  });
  const vaultwardenLocale203 = await startVaultwarden({localeStatus: 203});
  const vaultwardenHeldWasm = await startVaultwarden({holdWasm: true});
  const vaultwardenHeldWasmGzip = await startVaultwarden({holdWasm: 'gzip'});
  const vaultwardenHeldHeaders = await startVaultwarden({holdDocument: 'headers'});
  const vaultwardenHeldDocument = await startVaultwarden({holdDocument: 'body'});
  const vaultwardenLink = await startVaultwarden({link: true});
  const vaultwardenFramed = await startVaultwarden({framed: true});
  const vaultwardenServiceWorker = await startVaultwarden({serviceWorker: true});
  const bitwardenCloud = await startBitwardenCloud();
  const github = await startGitHubMirror();
  const payments = startPaymentHosts();
  const sites = [
    bitwarden,
    bitwardenTampered,
    bitwardenInline,
    bitwardenScriptRedirect,
    bitwardenRefresh,
    bitwardenSmTampered,
    bitwardenRevalidating,
    vaultwarden,
    vaultwardenInline,
    vaultwardenSubpath,
    vaultwardenCustomCss,
    vaultwardenImageOnly,
    vaultwardenForgedPagehide,
    vaultwardenSmChunk,
    vaultwardenBlob,
    vaultwardenLocale203,
    vaultwardenHeldWasm,
    vaultwardenHeldWasmGzip,
    vaultwardenHeldHeaders,
    vaultwardenHeldDocument,
    vaultwardenLink,
    vaultwardenFramed,
    vaultwardenServiceWorker,
    bitwardenCloud,
  ];
  return {
    bitwarden,
    bitwardenTampered,
    bitwardenInline,
    bitwardenScriptRedirect,
    bitwardenRefresh,
    bitwardenSmTampered,
    bitwardenRevalidating,
    vaultwarden,
    vaultwardenInline,
    vaultwardenSubpath,
    vaultwardenCustomCss,
    vaultwardenImageOnly,
    vaultwardenForgedPagehide,
    vaultwardenSmChunk,
    vaultwardenBlob,
    vaultwardenLocale203,
    vaultwardenHeldWasm,
    vaultwardenHeldWasmGzip,
    vaultwardenHeldHeaders,
    vaultwardenHeldDocument,
    vaultwardenLink,
    vaultwardenFramed,
    vaultwardenServiceWorker,
    bitwardenCloud,
    github,
    payments,
    close: async () => {
      await Promise.all([...sites, github].map(s => s.close()));
    },
  };
}
