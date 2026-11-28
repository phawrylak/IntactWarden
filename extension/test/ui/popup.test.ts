/**
 * Toolbar icon selection (CHECKING rule), state wording and the popup view
 * model from persisted TabStateRecords (R10).
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {LATTICE, rankOf} from '@intactwarden/core/verdict/states.ts';
import {coverageLine, popupView} from '../../src/ui/popup/model.ts';
import {
  actionTitle,
  reasonText,
  stateDescription,
  toolbarIconFor,
} from '../../src/ui/shared/stateText.ts';
import {alert, counts, resetI18n, tabRecord, topDoc, useLang} from './helpers.ts';

/** The extension's own version (runtime.getManifest().version in the popup). */
const EXT_VERSION = '0.1.0';

beforeEach(() => useLang('en'));
afterEach(() => resetI18n());

describe('toolbarIconFor', () => {
  it('shows each state its lattice icon when nothing is pending', () => {
    for (const row of LATTICE) expect(toolbarIconFor(row.state, [])).toBe(row.icon);
  });

  it('never shows green while CHECKING: grey spinner below rank 4, the higher state otherwise', () => {
    for (const row of LATTICE) {
      const icon = toolbarIconFor(row.state, ['CHECKING']);
      if (rankOf(row.state) < 4) expect(icon, row.state).toBe('grey-spinner');
      else expect(icon, row.state).toBe(row.icon);
      expect(icon).not.toMatch(/^green/);
    }
  });

  it('shows the solid green shield only for VERIFIED', () => {
    expect(toolbarIconFor('VERIFIED', [])).toBe('green-solid');
  });
});

describe('state wording (title, description, reason lines)', () => {
  it('MISMATCH and DISPUTED tell the user not to type secrets, in English and Polish', () => {
    for (const state of ['MISMATCH', 'DISPUTED'] as const)
      expect(stateDescription(state), state).toMatch(/Do not type secrets/);
    useLang('pl');
    for (const state of ['MISMATCH', 'DISPUTED'] as const)
      expect(stateDescription(state), state).toMatch(/Nie wpisuj/);
  });

  it('is never "targeted delivery": no state claims a build was served to this user only', () => {
    for (const row of LATTICE) {
      const lines = [
        stateDescription(row.state),
        ...row.reasons.map(r => reasonText(row.state, r) ?? ''),
      ];
      for (const s of lines) expect(s, row.state).not.toMatch(/targeted/i);
    }
  });
});

describe('actionTitle', () => {
  it('holds the state title and description', () => {
    expect(actionTitle(tabRecord())).toBe(
      'IntactWarden: Verified. Verified before running: every file this page loaded matches its GitHub release.',
    );
  });

  it('says "Checking…" while CHECKING withholds green, and "Grant access" when a permission is missing', () => {
    expect(actionTitle(tabRecord({flags: ['CHECKING']}))).toBe('IntactWarden: Checking…');
    expect(actionTitle(tabRecord({permissionMissing: true}))).toMatch(
      /^IntactWarden: Grant access/,
    );
    expect(actionTitle(null)).toBe('IntactWarden');
  });
});

describe('popupView', () => {
  it('shows a non-protected tab without buttons or provenance', () => {
    const v = popupView(null, EXT_VERSION);
    expect(v.protected).toBe(false);
    expect(v.title).toBe('This site is not protected');
    expect(v.sentence).toBe(
      'IntactWarden checks only the Bitwarden cloud and the servers you add in Settings.',
    );
    expect(v.buttons.details).toBe(false);
    expect(v.provenance).toBeNull();
  });

  it('renders a verified cloud tab: header, provenance, coverage', () => {
    const v = popupView(tabRecord(), EXT_VERSION);
    expect(v.protected).toBe(true);
    expect(v.colour).toBe('green');
    expect(v.header).toEqual({
      product: 'IntactWarden',
      origin: 'https://vault.bitwarden.com',
      deployment: 'Bitwarden cloud (US)',
      badge: 'Blocks code it cannot verify',
    });
    expect(v.lead).toBeNull();
    expect(v.provenance).toMatchObject({
      app: 'Bitwarden web vault',
      version: '2026.10.1',
      release: {
        text: 'bitwarden/clients web-v2026.10.1',
        href: 'https://github.com/bitwarden/clients/releases/tag/web-v2026.10.1',
      },
      commit: {
        text: '0123456789ab',
        href: 'https://github.com/bitwarden/clients/commit/0123456789abcdef0123456789abcdef01234567',
        // The whole commit in the tooltip of the shortened link.
        title: '0123456789abcdef0123456789abcdef01234567',
      },
      // The release file's whole sha256 (it wraps in the popup).
      artifact: `Release file sha256 ${'a'.repeat(64)}`,
      assurance: 'Matches GitHub release + published config',
      source: 'Manifest bundled with IntactWarden 0.1.0.',
    });
    expect(v.coverage).toBe(
      'Document 1/1 · Scripts 41/41 · WASM 1/1 · Styles 1/1 · Data 3/3 · Unverifiable 0 · Third-party 0',
    );
    expect(v.buttons.details).toBe(true);
    expect(v.buttons).not.toHaveProperty('deepVerify');
    expect(v.buttons.checklist).toBeNull();
  });

  it('leads self-hosted states with the origin date and names where the manifest was built', () => {
    const v = popupView(
      tabRecord({
        origin: 'http://localhost:8080',
        app: 'vaultwarden-web',
        deploymentId: 'self-hosted',
        kind: 'instance',
        instance: {added_at: Date.UTC(2026, 10, 1)},
        top: topDoc({
          binding: {
            ...topDoc().binding!,
            app: 'vaultwarden-web',
            variant: 'release',
            assurance: 'release-exact',
            source: 'deep-verify',
            repo: 'https://github.com/dani-garcia/bw_web_builds',
            tag: 'v2026.10.1',
          },
          serverStyle: {path: '/css/vaultwarden.css', accepted: true, hiddenCount: 12},
        }),
      }),
      EXT_VERSION,
    );
    expect(v.lead).toMatch(
      /^Server you added on .*2026\. This proves the code, not who runs the server\.$/,
    );
    expect(v.provenance?.source).toBe(
      'Manifest built in your browser from GitHub release dani-garcia/bw_web_builds v2026.10.1.',
    );
    expect(v.serverStyle).toBe('Server stylesheet: accepted, hides 12 element types.');
    expect(v.serverStyleNote).toMatch(/^Vaultwarden servers add their own stylesheet/);
  });

  it('an open alert offers the recovery checklist (acknowledged on the incidents page); a closed one nothing', () => {
    const red = popupView(
      tabRecord({state: 'MISMATCH', reasons: ['bytes'], alert: alert()}),
      EXT_VERSION,
    );
    expect(red.colour).toBe('red');
    expect(red.reasons).toEqual(["A file's bytes differ from the GitHub release."]);
    expect(red.buttons.checklist).toEqual({incidentId: '0123456789abcdef'});
    expect(red.alert).toMatch(/^Alert: Mismatch on this site/);
    const recovering = popupView(tabRecord({state: 'RECOVERING', alert: alert()}), EXT_VERSION);
    expect(recovering.buttons.checklist).toEqual({incidentId: '0123456789abcdef'});
    const closed = popupView(
      tabRecord({state: 'VERIFIED', alert: alert({acknowledged: true})}),
      EXT_VERSION,
    );
    expect(closed.buttons.checklist).toBeNull();
    expect(closed.alert).toBeNull();
  });

  it('names the assurance class of the bound manifest, except under a red state', () => {
    // "Matches GitHub release…" below "Code on this page does not match its GitHub release".
    for (const state of ['MISMATCH', 'DISPUTED'] as const) {
      const red = popupView(tabRecord({state, reasons: []}), EXT_VERSION);
      expect(red.colour, state).toBe('red');
      expect(red.provenance, state).toMatchObject({version: '2026.10.1', assurance: null});
    }
    const amber = popupView(tabRecord({state: 'RECOVERING', alert: alert()}), EXT_VERSION);
    expect(amber.colour).toBe('amber');
    expect(amber.provenance?.assurance).toBe('Matches GitHub release + published config');
  });

  it('offers Grant on a revoked permission with the host pattern', () => {
    const v = popupView(
      tabRecord({state: 'PROTECTION_LOST', reasons: ['permission-revoked'], top: null}),
      EXT_VERSION,
    );
    expect(v.buttons.grant).toEqual({pattern: 'https://vault.bitwarden.com/*'});
    expect(v.reasons).toEqual(["IntactWarden's access to this site was removed."]);
  });

  it('offers the server stylesheet for the tab and each blocked payment script for one page load', () => {
    const style = topDoc({
      serverStyle: {
        path: '/css/vaultwarden.css',
        accepted: false,
        hiddenCount: 0,
        reason: 'custom-rules',
      },
    });
    const v = popupView(
      tabRecord({state: 'UNVERIFIED_STYLE', reasons: ['custom-rules'], top: style}),
      EXT_VERSION,
    );
    expect(v.serverStyle).toBe(
      "Server stylesheet: not accepted. The stylesheet has rules beyond hiding the vault's stock elements.",
    );
    expect(v.buttons.allowStyle).toEqual({path: '/css/vaultwarden.css'});
    const allowed = popupView(
      tabRecord({
        state: 'UNVERIFIED_STYLE',
        reasons: ['custom-rules'],
        top: style,
        allowances: {
          tab: 7,
          thirdPartyGrant: null,
          serverStyles: ['/css/vaultwarden.css'],
          proceedOnce: [],
        },
      }),
      EXT_VERSION,
    );
    expect(allowed.buttons.allowStyle).toBeNull();
    // Only the payment scripts the floor kept out are offered, each behind its consent.
    const tp = popupView(
      tabRecord({
        state: 'THIRD_PARTY_CODE',
        reasons: ['js.stripe.com'],
        top: topDoc({
          counts: counts({thirdParty: ['stripe', 'paypal', 'duo']}),
          thirdPartyBlocked: ['stripe'],
        }),
      }),
      EXT_VERSION,
    );
    expect(tp.buttons.allowThirdParty.map(b => [b.id, b.label])).toEqual([['stripe', 'Stripe']]);
    const consent = tp.buttons.allowThirdParty[0]!.consent.join(' ');
    expect(consent).toContain('This code comes from Stripe, not from the Bitwarden release.');
    expect(consent).toContain('can read your vault');
    expect(consent).toContain('Allow it only to make a payment');
    expect(consent).toContain('private window');
    // Firefox runs no add-on in private windows unless the user allows it: the advice says so.
    expect(consent).toContain('only if IntactWarden may run there');
    expect(consent).toContain('not checked at all');
    expect(tp.reasons).toEqual(['Third-party code from js.stripe.com.']);
  });

  it('keeps green out of the popup while CHECKING, in words as well', () => {
    const v = popupView(tabRecord({flags: ['CHECKING']}), EXT_VERSION);
    expect(v.colour).toBe('grey');
    expect(v.title).toBe('Checking…');
    expect(v.sentence).toBe('Checking… some files are still being verified.');
    expect(v.flags).toEqual([]);
    expect(actionTitle(tabRecord({flags: ['CHECKING']}))).toBe('IntactWarden: Checking…');
  });

  it('shows a protected top document that is still being classified as checking', () => {
    const v = popupView(
      tabRecord({state: 'NOT_PROTECTED', reasons: [], flags: ['CHECKING']}),
      EXT_VERSION,
    );
    expect(v.protected).toBe(true);
    expect(v.colour).toBe('grey');
    expect(v.title).toBe('Checking…');
    expect(v.sentence).toBe('Checking… some files are still being verified.');
    expect(v.flags).toEqual([]);
  });

  it('keeps the state wording when CHECKING does not withhold green (rank 4 and above)', () => {
    const v = popupView(
      tabRecord({state: 'MISMATCH', reasons: ['bytes'], flags: ['CHECKING']}),
      EXT_VERSION,
    );
    expect(v.colour).toBe('red');
    expect(v.title).toBe('Mismatch');
    expect(v.flags[0]).toBe('Checking… some files are still being verified.');
  });

  it('shows RETRO with the local time', () => {
    const v = popupView(
      tabRecord({
        flags: ['RETRO'],
        top: topDoc({binding: {...topDoc().binding!, retroAt: Date.UTC(2026, 10, 6, 3, 47)}}),
      }),
      EXT_VERSION,
    );
    expect(v.flags[0]).toMatch(/^Verified after the fact at \d\d:\d\d(?: [AP]M)?\.$/);
  });

  it('a file outside the bound build (a Secrets Manager chunk on Vaultwarden): the unknown-path reason, no flag', () => {
    const reason = {
      en: 'A script or other active file that is not in the release was loaded.',
      pl: 'Wczytano skrypt lub inny aktywny plik, którego nie ma w wydaniu.',
    } as const;
    for (const lang of ['en', 'pl'] as const) {
      useLang(lang);
      const v = popupView(
        tabRecord({state: 'MISMATCH', reasons: ['unknown-path'], app: 'vaultwarden-web'}),
        EXT_VERSION,
      );
      expect(v.colour, lang).toBe('red');
      expect(v.reasons, lang).toEqual([reason[lang]]);
      expect(v.sentence, lang).toMatch(lang === 'en' ? /Do not type secrets/ : /Nie wpisuj/);
      expect(v.flags, lang).toEqual([]);
    }
  });

  it('shows the hinted version and the running deep verify when no build is bound', () => {
    const r = tabRecord({
      state: 'NEW_BUILD',
      reasons: ['catching-up'],
      app: 'vaultwarden-web',
      deploymentId: 'self-hosted',
      top: topDoc({binding: null}),
      hint: {version: '2026.11.0', at: 1},
      unknownBuild: {phase: 'deep-verify', failure: null},
    });
    const v = popupView(r, EXT_VERSION);
    expect(v.provenance?.version).toBe('2026.11.0 (according to the server)');
    expect(v.unknownBuild).toBe('Fetching and checking the GitHub release in your browser…');
    expect(v.sentence).toBe(
      'This site runs a new build that IntactWarden has not checked against its GitHub release yet.',
    );
  });

  it('builds the coverage line with third-party names', () => {
    expect(
      coverageLine(counts({fonts: {ok: 2, total: 2}, thirdParty: ['stripe', 'unknown-id']})),
    ).toBe(
      'Document 1/1 · Scripts 41/41 · WASM 1/1 · Styles 1/1 · Data 3/3 · Fonts 2/2 · Unverifiable 0 · Third-party 2 (Stripe, unknown-id)',
    );
  });

  it('renders in Polish', () => {
    useLang('pl');
    const v = popupView(tabRecord(), EXT_VERSION);
    expect(v.title).toBe('Zweryfikowano');
    expect(v.header.badge).toBe('Blokuje kod, którego nie może zweryfikować');
    expect(v.coverage).toBe(
      'Dokument 1/1 · Skrypty 41/41 · WASM 1/1 · Style 1/1 · Dane 3/3 · Nie do sprawdzenia 0 · Zewnętrzne 0',
    );
    expect(v.limits[0]).toMatch(/^Odpowiedzi API/);
  });
});
