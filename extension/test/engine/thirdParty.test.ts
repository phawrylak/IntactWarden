/**
 * Third-party scripts: webRequest never reports requests to hosts the extension has no permission
 * for, so declared third parties are seen through the content script (a `<script src>` of another
 * origin, or a CSP report of the floor's `script-src`). A declared `unpinnable-script` is
 * THIRD_PARTY_CODE (amber); a declared `unexpected` one is a MISMATCH; an undeclared host is left
 * to the vendor CSP and the enforced floor.
 *
 * A payment script is allowed for one page load (docs/guide.md). The click reloads the
 * tab; the next top-level document of the origin in that tab takes the grant (within 60 s); its
 * floor admits the vendor for as long as it lives, and it taints the origin meanwhile.
 */

import {vaultwardenWeb} from '@intactwarden/profiles';
import {describe, expect, it} from 'vitest';
import type {ProtectedOrigin} from '../../src/contracts.ts';
import {details} from './helpers/fakeExt.ts';
import {bytes, createWorld, VW_ORIGIN, vwCore, vwOrigin, type World} from './helpers/world.ts';

const INDEX = bytes('<!doctype html><html></html>');
const HTML = [{name: 'Content-Type', value: 'text/html'}];
const STRIPE = 'https://js.stripe.com/v3/';

/** A Vaultwarden origin whose profile declares Stripe as an unpinnable script (as Bitwarden's does). */
function billingOrigin(origin = VW_ORIGIN): ProtectedOrigin {
  const base = vwOrigin();
  return {
    ...base,
    origin,
    instance: {
      ...base.instance!,
      origin,
      id: origin === VW_ORIGIN ? base.instance!.id : '1111111111111111',
    },
    profile: {
      ...vaultwardenWeb,
      third_party: [
        ...vaultwardenWeb.third_party.filter(t => t.id !== 'billing-scripts'),
        {
          id: 'stripe',
          match: ['https://js.stripe.com/v3*'],
          kind: 'unpinnable-script',
          csp_allowance: {'script-src': ['https://js.stripe.com']},
        },
      ],
    } as ProtectedOrigin['profile'],
  };
}

let seq = 1;

/**
 * Loads the vault in `tab` (in frame `frame`, a frame of the top document when not 0); returns its
 * DocKey and the enforced CSP the header guard appended.
 */
async function navigate(
  w: World,
  tab = 1,
  origin = VW_ORIGIN,
  frame = 0,
): Promise<{doc: string; csp: string}> {
  const url = `${origin}/`;
  const req = `d${seq++}`;
  const d = details({
    requestId: req,
    url,
    type: frame === 0 ? 'main_frame' : 'sub_frame',
    tabId: tab,
    ...(frame === 0 ? {} : {frameId: frame, parentFrameId: 0, documentUrl: url}),
  });
  await w.env.webRequest.onBeforeRequest.fire(d);
  const [hr] = await w.env.webRequest.onHeadersReceived.fire({
    ...d,
    statusCode: 200,
    responseHeaders: HTML,
  });
  w.env.onCommitted.emit({
    tabId: tab,
    frameId: frame,
    parentFrameId: frame === 0 ? -1 : 0,
    url,
    timeStamp: 0,
  });
  w.env.filters.get(req)!.respond(INDEX);
  await w.settle();
  const headers: {name: string; value?: string}[] = hr?.responseHeaders ?? [];
  const csp = headers
    .filter(h => h.name === 'content-security-policy')
    .map(h => h.value ?? '')
    .join('; ');
  return {doc: w.backend.docKeyFor({tab, frame, url})!, csp};
}

async function load(w: World): Promise<string> {
  const {doc} = await navigate(w);
  expect((await w.tab(1))?.state).toBe('VERIFIED');
  return doc;
}

const sender = {tab: 1, frame: 0, url: `${VW_ORIGIN}/`};

const billingWorld = (): Promise<World> =>
  createWorld({cores: [vwCore('2026.10.1', {'/index.html': INDEX})], origins: [billingOrigin()]});

describe('third-party scripts seen by the content script', () => {
  it('a declared unpinnable script element is THIRD_PARTY_CODE, kept out and offered to the popup', async () => {
    const w = await billingWorld();
    const doc = await load(w);
    await w.engine.contentDom(sender, {
      doc,
      event: 'third-party-script',
      detail: {count: 1, url: STRIPE},
    });
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('THIRD_PARTY_CODE');
    expect(t?.reasons).toEqual(['js.stripe.com']);
    expect(t?.top?.counts.thirdParty).toEqual(['stripe']);
    expect(t?.top?.thirdPartyBlocked).toEqual(['stripe']);
    const item = (await w.engine.details(1))?.docs[0]?.items.find(i => i.path === STRIPE);
    expect(item?.outcome).toMatchObject({r: 'third-party', id: 'stripe', allowed: false});
  });

  it('the enforced floor blocks the script and its CSP report is THIRD_PARTY_CODE', async () => {
    const w = await createWorld({
      cores: [vwCore('2026.10.1', {'/index.html': INDEX})],
      origins: [billingOrigin()],
    });
    const doc = await load(w);
    await w.engine.contentCspViolation(sender, {
      doc,
      directive: 'script-src-elem',
      blockedUrl: STRIPE,
    });
    await w.settle();
    expect((await w.tab(1))?.state).toBe('THIRD_PARTY_CODE');
  });

  it('a billing script on Vaultwarden (declared unexpected) is a MISMATCH', async () => {
    const w = await createWorld({cores: [vwCore('2026.10.1', {'/index.html': INDEX})]});
    const doc = await load(w);
    await w.engine.contentDom(sender, {
      doc,
      event: 'third-party-script',
      detail: {count: 1, url: STRIPE},
    });
    await w.settle();
    const t = await w.tab(1);
    expect(t?.state).toBe('MISMATCH');
    expect(t?.reasons).toContain('unknown-path');
  });

  it('an undeclared host is left to the CSP: no item, no state change', async () => {
    const w = await createWorld({
      cores: [vwCore('2026.10.1', {'/index.html': INDEX})],
      origins: [billingOrigin()],
    });
    const doc = await load(w);
    await w.engine.contentDom(sender, {
      doc,
      event: 'third-party-script',
      detail: {count: 1, url: 'https://cdn.example/x.js'},
    });
    await w.engine.contentCspViolation(sender, {
      doc,
      directive: 'script-src-elem',
      blockedUrl: 'https://cdn.example/x.js',
    });
    await w.settle();
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const items = (await w.engine.details(1))?.docs[0]?.items ?? [];
    expect(items.some(i => i.cls === 'third-party')).toBe(false);
  });
});

describe('a payment script for one page load', () => {
  it('the grant reloads the tab and is consumed by exactly one document, whose floor admits the vendor', async () => {
    const w = await billingWorld();
    const first = await navigate(w);
    expect(first.csp).not.toContain('js.stripe.com');
    await w.engine.allowForTab(1, {k: 'third-party', id: 'stripe'});
    await w.settle();
    expect(w.env.tabsReloaded).toEqual([1]);
    // The open document is unchanged: its floor was fixed when its headers came.
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    const allowed = await navigate(w);
    expect(allowed.csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://js.stripe.com");
    // THIRD_PARTY_CODE from the moment the floor admits the vendor, whether or not a script is seen.
    expect(await w.tab(1)).toMatchObject({state: 'THIRD_PARTY_CODE', reasons: ['js.stripe.com']});
    await w.engine.contentDom(sender, {
      doc: allowed.doc,
      event: 'third-party-script',
      detail: {count: 1, url: STRIPE},
    });
    await w.settle();
    const item = (await w.engine.details(1))?.docs[0]?.items.find(i => i.path === STRIPE);
    expect(item?.outcome).toMatchObject({r: 'third-party', id: 'stripe', allowed: true});
    expect((await w.tab(1))?.top?.thirdPartyBlocked).toEqual([]);
    // The allowance ends with the document: the next reload blocks the scripts again.
    const after = await navigate(w);
    expect(after.csp).not.toContain('js.stripe.com');
    expect((await w.tab(1))?.state).toBe('VERIFIED');
  });

  it('a second vault tab is CO_RESIDENT_UNVERIFIED while the first runs the payment script', async () => {
    const w = await billingWorld();
    await navigate(w, 1);
    await w.engine.allowForTab(1, {k: 'third-party', id: 'stripe'});
    await navigate(w, 1);
    expect((await w.tab(1))?.state).toBe('THIRD_PARTY_CODE');
    await navigate(w, 2);
    expect(await w.tab(2)).toMatchObject({
      state: 'CO_RESIDENT_UNVERIFIED',
      reasons: ['third-party-code'],
    });
    // The first tab reloads: its document (and the allowance) ends; a new vault tab is green.
    await navigate(w, 1);
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await navigate(w, 3);
    expect((await w.tab(3))?.state).toBe('VERIFIED');
  });

  it('a grant goes to neither another origin in the tab nor a frame of the page', async () => {
    const OTHER = 'http://127.0.0.1:8082';
    const w = await createWorld({
      cores: [vwCore('2026.10.1', {'/index.html': INDEX})],
      origins: [billingOrigin(), billingOrigin(OTHER)],
    });
    await navigate(w, 1);
    await w.engine.allowForTab(1, {k: 'third-party', id: 'stripe'});
    // Another protected origin whose profile declares the same vendor, loaded in the tab first.
    expect((await navigate(w, 1, OTHER)).csp).not.toContain('js.stripe.com');
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    await navigate(w, 1);
    await w.engine.allowForTab(1, {k: 'third-party', id: 'stripe'});
    // A same-origin frame whose headers come before the reload's.
    expect((await navigate(w, 1, VW_ORIGIN, 5)).csp).not.toContain('js.stripe.com');
    expect((await navigate(w, 1)).csp).toContain('https://js.stripe.com');
  });

  it('an unused grant expires; it is only for its tab and origin and only for a payment script', async () => {
    const w = await billingWorld();
    await navigate(w, 1);
    await w.engine.allowForTab(1, {k: 'third-party', id: 'stripe'});
    // Another tab never takes it.
    expect((await navigate(w, 2)).csp).not.toContain('js.stripe.com');
    w.timers.advance(61_000);
    const late = await navigate(w, 1);
    expect(late.csp).not.toContain('js.stripe.com');
    expect((await w.tab(1))?.state).toBe('VERIFIED');
    // A third party of another kind is never granted (and nothing reloads).
    const reloads = w.env.tabsReloaded.length;
    await w.engine.allowForTab(1, {k: 'third-party', id: 'duo'});
    expect(w.env.tabsReloaded).toHaveLength(reloads);
    expect((await navigate(w, 1)).csp).not.toContain('duosecurity');
  });
});
