/**
 * Page view models: details (redacted report), blocked (with NEW_BUILD),
 * incidents and the recovery checklist, onboarding, options (instance rows,
 * refusals, trust panel) and deep verify. All pure.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {
  BlockedView,
  DeepVerifyJobView,
  DetailsView,
  IncidentRecord,
  InstanceView,
  OnboardingStatus,
  TrustPanelView,
} from '../../src/contracts.ts';
import {
  detailsModel,
  itemRow,
  redactedReport,
  stripQueryFragment,
} from '../../src/ui/details/model.ts';
import {CHECKLIST_KEYS, incidentRow, openAlerts} from '../../src/ui/incidents/model.ts';
import {onboardingModel} from '../../src/ui/onboarding/model.ts';
import {instanceRow, refusalText, trustModel} from '../../src/ui/options/model.ts';
import {
  blockedPageView,
  jobLine,
  retryLine,
  retryTarget,
  shouldReload,
} from '../../src/ui/shared/blocking.ts';
import {tabFromHash, incidentFromHash} from '../../src/ui/shared/page.ts';
import {alert, resetI18n, topDoc, useLang} from './helpers.ts';

beforeEach(() => useLang('en'));
afterEach(() => resetI18n());

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('details', () => {
  const view: DetailsView = {
    tab: 7,
    origin: 'https://vault.bitwarden.com',
    docs: [
      {
        summary: topDoc(),
        coreSha256: SHA_A,
        dispute: null,
        serverStyles: {
          '/css/vaultwarden.css': {sha256: SHA_B, accepted: true, hidden: ['.org-tab', '#billing']},
        },
        items: [
          {
            req: '1',
            path: '/app/main.js',
            url: 'https://vault.bitwarden.com/app/main.js',
            type: 'script',
            cls: 'script',
            key: 'app/main.js',
            sha256: SHA_A,
            expected: SHA_A,
            outcome: {r: 'ok', how: 'exact'},
            at: 1,
          },
          {
            req: '2',
            path: '/app/evil.js?x=1#y',
            url: 'https://vault.bitwarden.com/app/evil.js',
            type: 'script',
            cls: 'script',
            key: null,
            sha256: SHA_B,
            expected: null,
            outcome: {r: 'mismatch', reason: 'unknown-path'},
            at: 2,
          },
        ],
      },
    ],
  };

  it('lists mismatches first, with shortened hashes (whole in the tooltip) and reasons', () => {
    const m = detailsModel(view);
    expect(m.docs[0]!.rows.map(r => r.path)).toEqual(['/app/evil.js', '/app/main.js']);
    expect(m.docs[0]!.rows[0]).toMatchObject({
      tone: 'bad',
      expected: '—',
      observed: 'bbbbbbbbbbbb…',
      expectedFull: null,
      observedFull: SHA_B,
      result: 'Mismatch: A script or other active file that is not in the release was loaded.',
    });
    expect(m.docs[0]!.rows[1]).toMatchObject({
      tone: 'ok',
      result: 'OK (exact)',
      expected: 'aaaaaaaaaaaa…',
      expectedFull: SHA_A,
    });
    expect(m.docs[0]!.styles[0]).toEqual({
      path: '/css/vaultwarden.css',
      sha256: SHA_B,
      verdict: 'Accepted. It hides 2 element types (listed below).',
      hidden: ['.org-tab', '#billing'],
    });
    expect(m.docs[0]!.build).toBe(
      'Build bitwarden-web@2026.10.1+cloud-us from bitwarden/clients web-v2026.10.1',
    );
  });

  it('says "Checking…" while the toolbar shows the spinner, never "Not protected" or "Verified"', () => {
    const doc = (summary: ReturnType<typeof topDoc>) => ({
      summary,
      coreSha256: null,
      dispute: null,
      serverStyles: {},
      items: [],
    });
    const m = detailsModel({
      tab: 1,
      origin: 'https://vault.bitwarden.com',
      docs: [
        doc(topDoc({state: 'NOT_PROTECTED', flags: ['CHECKING'], docClass: 'pending'})),
        doc(topDoc({state: 'VERIFIED', flags: ['CHECKING']})),
        doc(topDoc({state: 'VERIFIED'})),
      ],
    });
    expect(m.docs.map(d => d.state)).toEqual(['Checking…', 'Checking…', 'Verified']);
  });

  it('shows a dispute: the value this browser recorded and the one GitHub reports now', () => {
    const disputed = detailsModel({
      ...view,
      docs: [
        {
          ...view.docs[0]!,
          summary: topDoc({state: 'DISPUTED'}),
          dispute: {
            k: 'disputed',
            reason: 'pin-changed',
            at: 1,
            evidence: {recorded: SHA_A, observed: SHA_B},
          },
        },
      ],
    });
    expect(disputed.docs[0]?.dispute).toEqual([
      `Recorded in this browser: ${SHA_A}`,
      `GitHub reports now: ${SHA_B}`,
    ]);
    expect(detailsModel(view).docs[0]?.dispute).toEqual([]);
  });

  it('copies a report with no query or fragment anywhere', () => {
    const report = redactedReport(view, Date.UTC(2026, 10, 6), '0.1.0');
    expect(report).not.toMatch(/[?#]/);
    expect(JSON.parse(report)).toMatchObject({
      schema: 'intactwarden.report/1',
      generated_at: '2026-11-06T00:00:00.000Z',
    });
    expect(stripQueryFragment('/a/b?c#d')).toBe('/a/b');
  });

  it('labels template expectations and unverifiable items', () => {
    const row = itemRow({
      req: null,
      path: '/',
      url: 'https://x/',
      type: 'main_frame',
      cls: 'document',
      key: 'index.html',
      expected: 'template',
      outcome: {r: 'unverifiable', reason: 'timeout'},
      at: 1,
    });
    expect(row).toMatchObject({
      expected: 'template',
      observed: '—',
      result: 'Not verifiable: took too long',
      tone: 'warn',
    });
  });
});

describe('blocked page', () => {
  const view: BlockedView = {
    incidentId: '0123456789abcdef',
    origin: 'https://vault.example.org',
    path: '/index.html',
    state: 'MISMATCH',
    reasons: ['bytes'],
    expected: SHA_A,
    observed: SHA_B,
    canProceedOnce: false,
    retry: false,
    dispute: null,
    job: null,
  };

  it('shows what failed, with the whole hashes', () => {
    const v = blockedPageView(view);
    expect(v.title).toBe('IntactWarden blocked this page: Mismatch');
    expect(v.rows.map(r => r.value)).toEqual([
      'https://vault.example.org',
      '/index.html',
      SHA_A,
      SHA_B,
    ]);
    expect(v.canProceedOnce).toBe(false);
    expect(v.target).toBe('https://vault.example.org/index.html');
    expect(
      blockedPageView({...view, state: 'BUILD_UNVERIFIED', canProceedOnce: true}).canProceedOnce,
    ).toBe(true);
    expect(blockedPageView({...view, canProceedOnce: true, observed: null}).canProceedOnce).toBe(
      false,
    );
  });

  it('navigates only to a well-formed origin and path', () => {
    expect(retryTarget('https://vault.example.org', '/vw/')).toBe('https://vault.example.org/vw/');
    expect(retryTarget('https://vault.example.org', '//evil.example/')).toBeNull();
    expect(retryTarget('https://vault.example.org', '/a?b')).toBeNull();
    expect(retryTarget('javascript:alert(1)', '/')).toBeNull();
    expect(retryTarget('https://vault.example.org/x', '/')).toBeNull();
  });

  it('reloads the blocked page on NEW_BUILD once the build is known', () => {
    const job: DeepVerifyJobView = {
      jobId: 'j',
      app: 'vaultwarden-web',
      version: '2026.11.0',
      assetName: 'bw_web_v2026.11.0.tar.gz',
      variant: 'release',
      trigger: 'unknown-build',
      phase: 'downloading',
      bytes: 20_000_000,
      total: 41_793_283,
      startedAt: 1,
    };
    const waiting = {...view, state: 'NEW_BUILD' as const, retry: true, job};
    expect(shouldReload(waiting)).toBe(false);
    expect(shouldReload({...waiting, job: {...job, phase: 'done'}})).toBe(true);
    // A denied document that is not NEW_BUILD is shown as blocked and never reloads by itself.
    expect(shouldReload({...waiting, retry: false, job: {...job, phase: 'done'}})).toBe(false);
    expect(shouldReload({...waiting, job: null})).toBe(false);
    // The background says that only a new load can decide: no job to wait for.
    expect(shouldReload({...waiting, job: null, reload: true})).toBe(true);
    expect(shouldReload({...waiting, retry: false, job: null, reload: true})).toBe(false);
    expect(shouldReload(null)).toBe(false);
    expect(jobLine(job)).toBe('Downloaded 20 MB of 41.8 MB');
    expect(jobLine({...job, phase: 'failed', failure: 'rate-limited'})).toBe(
      "Failed: GitHub's request limit was reached.",
    );
  });

  it('parses page fragments strictly', () => {
    expect(tabFromHash('#42')).toBe(42);
    expect(tabFromHash('#4x')).toBeNull();
    expect(incidentFromHash('#0123456789abcdef')).toBe('0123456789abcdef');
    expect(incidentFromHash('#0123456789ABCDEF')).toBeNull();
  });
});

describe('incidents', () => {
  it('lists open (unacknowledged) alerts newest first; acknowledged ones are closed', () => {
    const open = openAlerts([
      alert({origin: 'https://a', at: 1, acknowledged: true}),
      alert({origin: 'https://b', at: 2}),
      alert({
        origin: 'https://d',
        at: 4,
        state: 'PROTECTION_LOST',
        reasons: ['filter-failed'],
      }),
    ]);
    expect(open.map(a => a.origin)).toEqual(['https://d', 'https://b']);
    expect(open[1]).toMatchObject({
      title: 'Mismatch',
      reasons: ["A file's bytes differ from the GitHub release."],
    });
  });

  it('has the five recovery checklist steps', () => {
    expect(CHECKLIST_KEYS).toHaveLength(5);
  });

  it('renders incident rows from codes only', () => {
    const r: IncidentRecord = {
      id: 'ffffffffffffffff',
      at: 1,
      kind: 'mismatch',
      origin: 'https://vault.example.org',
      path: '/app/main.js',
      state: 'MISMATCH',
      reasons: ['bytes', 'not-a-code'],
      buildId: 'vaultwarden-web@2026.10.1+release',
      expected: SHA_A,
      observed: SHA_B,
    };
    expect(incidentRow(r)).toMatchObject({
      kind: 'Mismatch',
      where: 'https://vault.example.org/app/main.js',
      state: 'Mismatch',
      reasons: "A file's bytes differ from the GitHub release.",
      hashes: `expected ${SHA_A} · observed ${SHA_B}`,
    });
  });
});

describe('onboarding', () => {
  const status: OnboardingStatus = {
    permissions: [
      {
        pattern: 'https://vault.bitwarden.com/*',
        origin: 'https://vault.bitwarden.com',
        purpose: 'official',
        required: true,
        granted: true,
      },
      {
        pattern: 'https://release-assets.githubusercontent.com/*',
        origin: 'https://release-assets.githubusercontent.com',
        purpose: 'deep-verify',
        required: true,
        granted: false,
      },
      {
        pattern: 'https://vw.example/*',
        origin: 'https://vw.example',
        purpose: 'instance',
        required: false,
        granted: true,
      },
    ],
    incognitoAllowed: false,
    pinned: null,
    openProtectedTabs: 2,
  };

  it('lists required permissions and the missing ones to request together', () => {
    const m = onboardingModel(status);
    expect(m.permissions.map(p => [p.pattern, p.status])).toEqual([
      ['https://vault.bitwarden.com/*', 'granted'],
      ['https://release-assets.githubusercontent.com/*', 'not granted'],
    ]);
    expect(m.missing).toEqual(['https://release-assets.githubusercontent.com/*']);
    expect(m.protection).toMatch(/^IntactWarden checks every file before/);
    expect(m.protectionDetail).toMatch(/only in Firefox with IntactWarden/);
    expect(m.pin).toBe('Make sure the IntactWarden icon is pinned to the toolbar.');
    expect(m.openTabs).toBe(
      '2 protected tabs were opened before IntactWarden was ready. Reload them with Ctrl+Shift+R (Cmd+Shift+R on macOS) to verify them.',
    );
    expect(onboardingModel({...status, openProtectedTabs: 1}).openTabs).toBe(
      '1 protected tab was opened before IntactWarden was ready. Reload it with Ctrl+Shift+R (Cmd+Shift+R on macOS) to verify it.',
    );
    expect(m.privateWindows).toMatch(/Run in Private Windows/);
  });

  it('speaks Polish', () => {
    useLang('pl');
    expect(onboardingModel({...status, openProtectedTabs: 5}).openTabs).toBe(
      '5 chronionych kart zostało otwartych, zanim IntactWarden był gotowy. Odśwież je skrótem Ctrl+Shift+R (na macOS Cmd+Shift+R), aby je zweryfikować.',
    );
    expect(onboardingModel({...status, openProtectedTabs: 2}).openTabs).toBe(
      '2 chronione karty zostały otwarte, zanim IntactWarden był gotowy. Odśwież je skrótem Ctrl+Shift+R (na macOS Cmd+Shift+R), aby je zweryfikować.',
    );
    expect(onboardingModel({...status, openProtectedTabs: 1}).openTabs).toBe(
      '1 chroniona karta została otwarta, zanim IntactWarden był gotowy. Odśwież ją skrótem Ctrl+Shift+R (na macOS Cmd+Shift+R), aby ją zweryfikować.',
    );
  });
});

describe('options', () => {
  it('names every refusal of an added server', () => {
    expect(refusalText('refused-official-origin')).toMatch(/official Bitwarden cloud address/);
    expect(refusalText('no-server')).toBe(
      'No Bitwarden or Vaultwarden server answers at this address. Check the address, including the path if the vault is not at the root.',
    );
    expect(refusalText('http-not-loopback')).toMatch(/only on this computer/);
  });

  it('renders instance rows with permission status and the last build', () => {
    const v: InstanceView = {
      record: {
        id: 'abcdef0123456789',
        app: 'bitwarden-web',
        origin: 'http://localhost:8080',
        base_path: '/',
        added_at: Date.UTC(2026, 10, 1),
      },
      permission: {
        pattern: 'http://localhost/*',
        origin: 'http://localhost:8080',
        purpose: 'instance',
        required: false,
        granted: false,
      },
      lastBuild: 'bitwarden-web@2026.10.1+selfhosted-commercial',
    };
    const row = instanceRow(v);
    expect(row.granted).toBe(false);
    expect(row.lines).toContain('Access missing: IntactWarden cannot check this server.');
    expect(row.lines).toContain('Last build: bitwarden-web@2026.10.1+selfhosted-commercial');
    expect(row.lines.some(l => l.startsWith('Last result'))).toBe(false);
  });

  it('builds the trust panel', () => {
    const view: TrustPanelView = {
      snapshot: {ready: true, loaded: true, githubBackoffUntil: Date.UTC(2030, 0, 1)},
      cores: [
        {
          buildId: 'vaultwarden-web@2026.10.1+release',
          app: 'vaultwarden-web',
          variant: 'release',
          version: '2026.10.1',
          assurance: 'release-exact',
          sha256: SHA_A,
          size: 1,
          source: 'bundled',
          addedAt: 1,
          status: 'current',
        },
      ],
      jobs: [],
      pins: {
        schema: 'intactwarden.localpins/1',
        pins: [
          {
            kind: 'release-asset',
            repo: 'dani-garcia/bw_web_builds',
            tag: 'v2026.10.1',
            tag_commit: 'c'.repeat(40),
            asset: 'bw_web_v2026.10.1.tar.gz',
            sha256: SHA_B,
            size: 41793283,
            source: 'bundled',
          },
        ],
      },
      githubPermission: true,
    };
    const m = trustModel(view, Date.UTC(2026, 10, 6));
    expect(m.summary[0]).toBe('Manifests are built in this browser from GitHub releases.');
    expect(m.summary).toContain('1 manifest available.');
    expect(m.summary.some(s => s.startsWith("GitHub's request limit was reached"))).toBe(true);
    expect(m.summary.some(s => s.includes('could not be loaded'))).toBe(false);
    expect(m.cores[0]).toMatchObject({
      buildId: 'vaultwarden-web@2026.10.1+release',
      source: 'Bundled with IntactWarden',
    });
    expect(m.pins).toEqual([
      `dani-garcia/bw_web_builds v2026.10.1 · bw_web_v2026.10.1.tar.gz · sha256 ${SHA_B} · bundled`,
    ]);
  });

  it('names the failure detail in the job list (a rebuild that differs)', () => {
    const job: DeepVerifyJobView = {
      jobId: '0123456789abcdef',
      app: 'vaultwarden-web',
      version: '2026.10.1',
      assetName: 'bw_web_v2026.10.1.tar.gz',
      variant: 'release',
      trigger: 'user',
      phase: 'failed',
      startedAt: Date.UTC(2026, 10, 6),
      failure: 'build-refused',
      detail: 'rebuild-differs',
    };
    const m = trustModel(
      {
        snapshot: {ready: true, loaded: false, githubBackoffUntil: null},
        cores: [],
        jobs: [job],
        pins: {schema: 'intactwarden.localpins/1', pins: []},
        githubPermission: true,
      },
      Date.UTC(2026, 10, 6),
    );
    expect(m.jobs[0]).toContain('differs from the one in use');
    expect(m.summary).toContain(
      'The stored manifests could not be loaded: every protected page shows "Protection lost".',
    );
  });
});

describe('Retry on a Build not verified page', () => {
  it('shows that it runs, then the job progress, then why it failed', () => {
    const job: DeepVerifyJobView = {
      jobId: 'j',
      app: 'bitwarden-web',
      version: '2026.10.1',
      assetName: 'web-2026.10.1-selfhosted-COMMERCIAL.zip',
      variant: 'cloud-us',
      trigger: 'user',
      phase: 'building',
      startedAt: 5,
    };
    expect(retryLine(null, null)).toBe('Fetching and checking the GitHub release in your browser…');
    expect(retryLine(job, null)).toBe('Building the manifest');
    expect(
      retryLine(null, {
        ok: false,
        failure: 'release-not-found',
        transient: false,
        retryAt: null,
      }),
    ).toMatch(/^The release could not be checked: /);
    expect(
      retryLine(null, {
        ok: false,
        failure: 'build-refused',
        transient: false,
        retryAt: null,
        detail: 'archive-invalid',
      }),
    ).toBe(
      'The release could not be checked: the release file could not be turned into a manifest (the archive is invalid).',
    );
  });
});
