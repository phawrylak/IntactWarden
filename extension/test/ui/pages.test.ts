/**
 * Real page modules against a tiny fake document and a fake `browser`.
 *
 * - Pages fail closed when the background does not answer: a list that
 *   did not load is never shown as empty ("No open alerts."), and Options never shows the default
 *   settings as if they were the user's.
 * - Options asks for a look-alike server's permission only once the user confirmed it.
 * - The blocked page renders a denied document, and on NEW_BUILD the deep verify it waits
 *   for: it reloads the vault once that job is done, and while no job runs it says so and
 *   "Check now" loads the vault again. A final view the background returns later replaces it for
 *   good.
 * - The popup reloads the tab after allowing the server stylesheet, and keeps an open payment
 *   consent across state updates.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  DEFAULT_SETTINGS,
  type BlockedView,
  type DeepVerifyJobView,
  type OriginAlert,
} from '../../src/contracts.ts';
import {LOCALES_DIR, tabRecord, topDoc} from './helpers.ts';

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  className = '';
  id = '';
  disabled = false;
  readonly nodeName: string;
  private readonly ownText: string;
  constructor(nodeName: string, ownText = '') {
    this.nodeName = nodeName;
    this.ownText = ownText;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  appendChild(c: FakeNode): FakeNode {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c: FakeNode): FakeNode {
    this.childNodes.splice(this.childNodes.indexOf(c), 1);
    c.parentNode = null;
    return c;
  }
  get textContent(): string {
    return this.nodeName === '#text'
      ? this.ownText
      : this.childNodes.map(c => c.textContent).join('\n');
  }
  set textContent(v: string) {
    this.childNodes = [];
    if (v !== '') this.appendChild(new FakeNode('#text', v));
  }
  setAttribute(n: string, v: string): void {
    this.attributes.set(n, v);
  }
  removeAttribute(n: string): void {
    this.attributes.delete(n);
  }
  readonly listeners = new Map<string, ((event?: unknown) => void)[]>();
  addEventListener(type: string, fn: (event?: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  /** Fires `type` with an event whose target is `target` (an input's value or checked). */
  fire(type: string, target: Record<string, unknown>): void {
    for (const fn of this.listeners.get(type) ?? []) fn({target});
  }
  focus(): void {
    (g.document as {activeElement?: FakeNode}).activeElement = this;
  }
  scrollIntoView(): void {}
  /** The first button whose text is `text`. */
  button(text: string): FakeNode | null {
    if (this.nodeName === 'button' && this.textContent === text) return this;
    for (const c of this.childNodes) {
      const r = c.button(text);
      if (r) return r;
    }
    return null;
  }
  find(id: string): FakeNode | null {
    if (this.id === id) return this;
    for (const c of this.childNodes) {
      const r = c.find(id);
      if (r) return r;
    }
    return null;
  }
  /** The first element that has the class `name`. */
  byClass(name: string): FakeNode | null {
    if (this.className.split(' ').includes(name)) return this;
    for (const c of this.childNodes) {
      const r = c.byClass(name);
      if (r) return r;
    }
    return null;
  }
}

type Reply = {ok: true; value: unknown} | {ok: false; error: string};
type Answer = (type: string, payload?: unknown) => Reply | Promise<Reply>;

const catalogue = JSON.parse(
  readFileSync(join(LOCALES_DIR, 'en', 'messages.json'), 'utf8'),
) as Record<string, {message: string; placeholders?: Record<string, {content: string}>}>;

function getMessage(name: string, subs?: string | string[]): string {
  const e = catalogue[name];
  if (!e) return '';
  const list = subs === undefined ? [] : typeof subs === 'string' ? [subs] : subs;
  return e.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (_m, p: string) =>
    (e.placeholders?.[p.toLowerCase()]?.content ?? '').replace(
      /\$(\d)/g,
      (_x, i: string) => list[Number(i) - 1] ?? '',
    ),
  );
}

const g = globalThis as Record<string, unknown>;
const saved = {
  document: g.document,
  location: g.location,
  window: g.window,
  browser: g.browser,
  setInterval: g.setInterval,
};
afterEach(() => Object.assign(g, saved));

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
};

/** Loads a page module with a fresh module graph; `answer` replies to every message. */
async function openPage(page: string, answer: {current: Answer}, hash = '') {
  vi.resetModules();
  const app = new FakeNode('main');
  app.id = 'app';
  g.document = {
    documentElement: {lang: ''},
    title: '',
    body: new FakeNode('body'),
    getElementById: (id: string) => (id === 'app' ? app : app.find(id)),
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => new FakeNode('#text', text),
  };
  const assigned: string[] = [];
  g.location = {hash, reload: () => undefined, assign: (url: string) => assigned.push(url)};
  let closed = 0;
  g.window = {close: () => void closed++};
  const reloaded: unknown[][] = [];
  const requested: unknown[] = [];
  // The blocked page polls every 60 s; the tests drive it by broadcasts instead.
  g.setInterval = () => 0;
  const listeners: ((m: unknown, s: {id: string}) => void)[] = [];
  const noop = {addListener: () => undefined, removeListener: () => undefined};
  g.browser = {
    runtime: {
      id: 'test-id',
      getURL: (p: string) => `moz-extension://test-id/${p}`,
      getManifest: () => ({version: '0.1.0'}),
      sendMessage: async (m: {type: string; payload?: unknown}) =>
        answer.current(m.type, m.payload),
      onMessage: {
        addListener: (l: (typeof listeners)[number]) => listeners.push(l),
        removeListener: () => undefined,
      },
    },
    i18n: {getMessage, getUILanguage: () => 'en'},
    permissions: {
      onAdded: noop,
      onRemoved: noop,
      contains: async () => true,
      request: async (p: unknown) => {
        requested.push(p);
        return false;
      },
    },
    tabs: {
      query: async () => [{id: 7}],
      reload: async (...args: unknown[]) => void reloaded.push(args),
    },
  };
  await import(`../../src/ui/${page}/main.ts`);
  await settle();
  return {
    app,
    assigned,
    reloaded,
    requested,
    closed: () => closed,
    title: () => (g.document as {title: string}).title,
    async broadcast(type: string, payload: unknown = {}): Promise<void> {
      for (const l of listeners) l({iw: 1, broadcast: type, payload}, {id: 'test-id'});
      await settle();
    },
  };
}

const PAGE_ERROR = 'IntactWarden could not load this page. Close it and try again.';
const dead: Answer = () => {
  throw new Error('Could not establish connection. Receiving end does not exist.');
};
const RED: OriginAlert = {
  origin: 'https://vault.bitwarden.com',
  at: Date.UTC(2026, 10, 6, 9, 30),
  state: 'MISMATCH',
  reasons: ['bytes'],
  incident_id: '0123456789abcdef',
  acknowledged: false,
};

function answering(lists: {alerts: Reply; incidents: Reply}): Answer {
  return type => {
    if (type === 'UI_GET_SETTINGS') return {ok: true, value: DEFAULT_SETTINGS};
    if (type === 'UI_LIST_ALERTS') return lists.alerts;
    if (type === 'UI_LIST_INCIDENTS') return lists.incidents;
    return {ok: false, error: 'unknown-type'};
  };
}

describe('incidents page when a list fails to load', () => {
  it('shows the page error, not "No open alerts." or "No incidents."', async () => {
    const {app} = await openPage('incidents', {current: dead});
    expect(app.textContent).toContain(PAGE_ERROR);
    expect(app.textContent).not.toContain('No open alerts.');
    expect(app.textContent).not.toContain('No incidents.');
  });

  it('never hides a loaded red alert behind "No open alerts." when only the log fails', async () => {
    const answer = {
      current: answering({
        alerts: {ok: true, value: [RED]},
        incidents: {ok: false, error: 'internal-error'},
      }),
    };
    const {app, broadcast} = await openPage('incidents', answer, `#${RED.incident_id}`);
    expect(app.textContent).toContain(PAGE_ERROR);
    expect(app.textContent).not.toContain('No open alerts.');
    // The next successful load (a STATE_UPDATED broadcast) replaces the error with the alert.
    answer.current = answering({
      alerts: {ok: true, value: [RED]},
      incidents: {ok: true, value: []},
    });
    await broadcast('STATE_UPDATED');
    expect(app.textContent).toContain(RED.origin);
    expect(app.textContent).not.toContain(PAGE_ERROR);
  });
});

describe('settings pages when the background does not answer', () => {
  it('Options shows the page error instead of the default settings', async () => {
    const {app} = await openPage('options', {current: dead});
    expect(app.textContent).toBe(PAGE_ERROR);
    expect(app.find('notifications')).toBeNull();
  });
});

describe('Options notifications checkbox', () => {
  it('keeps keyboard focus when a saved setting renders it again', async () => {
    const answer: Answer = type =>
      type === 'UI_GET_SETTINGS'
        ? {ok: true, value: DEFAULT_SETTINGS}
        : {ok: false, error: 'internal-error'};
    const {app, broadcast} = await openPage('options', {current: answer});
    const doc = g.document as {activeElement?: FakeNode};
    const before = app.find('notifications')!;
    await broadcast('SETTINGS_UPDATED', {settings: DEFAULT_SETTINGS});
    expect(app.find('notifications')).not.toBe(before);
    // Not focused before: the page does not take the focus.
    expect(doc.activeElement).toBeUndefined();
    app.find('notifications')!.focus();
    const focused = doc.activeElement;
    await broadcast('SETTINGS_UPDATED', {settings: DEFAULT_SETTINGS});
    expect(doc.activeElement).toBe(app.find('notifications'));
    expect(doc.activeElement).not.toBe(focused);
  });
});

describe('Options when only the server list fails to load', () => {
  it('shows the page error in the servers section, never "No servers added yet."', async () => {
    const answer: Answer = type => {
      if (type === 'UI_GET_SETTINGS') return {ok: true, value: DEFAULT_SETTINGS};
      if (type === 'UI_LIST_INSTANCES') return {ok: false, error: 'internal-error'};
      return {ok: false, error: 'unknown-type'};
    };
    const {app} = await openPage('options', {current: answer});
    expect(app.find('notifications')).not.toBeNull();
    expect(app.textContent).not.toContain('No servers added yet.');
    expect(app.textContent).toContain(PAGE_ERROR);
  });

  it('explains deep verify above the trust panel, also when the trust data does not load', async () => {
    const answer: Answer = type =>
      type === 'UI_GET_SETTINGS'
        ? {ok: true, value: DEFAULT_SETTINGS}
        : {ok: false, error: 'internal-error'};
    const {app} = await openPage('options', {current: answer});
    expect(app.textContent).toContain('your browser downloads it from GitHub (about 40–50 MB)');
    expect(app.textContent).toContain('The trust data could not be loaded.');
  });
});

describe('Options add server', () => {
  it('asks for a look-alike host only once the user confirmed it', async () => {
    const answer: Answer = type =>
      type === 'UI_GET_SETTINGS'
        ? {ok: true, value: DEFAULT_SETTINGS}
        : {ok: false, error: 'internal-error'};
    const {app, requested} = await openPage('options', {current: answer});
    app.find('instance-origin')!.fire('input', {value: 'https://vault.bitwarnem.com'});
    app.button('Add server')!.click();
    expect(requested).toEqual([]);
    app.find('confirm-lookalike')!.fire('change', {checked: true});
    app.button('Add server')!.click();
    expect(requested).toEqual([{origins: ['https://vault.bitwarnem.com/*']}]);
  });
});

describe('blocked page', () => {
  const INCIDENT = '0123456789abcdef';
  const view = (partial: Partial<BlockedView>): BlockedView => ({
    incidentId: INCIDENT,
    origin: 'https://vault.example.org',
    path: '/',
    state: 'NEW_BUILD',
    reasons: ['catching-up'],
    expected: null,
    observed: 'a'.repeat(64),
    canProceedOnce: false,
    retry: true,
    dispute: null,
    job: null,
    ...partial,
  });
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
  const blocked = (current: {v: BlockedView}): Answer => {
    return type => {
      if (type === 'UI_GET_SETTINGS') return {ok: true, value: DEFAULT_SETTINGS};
      if (type === 'UI_GET_BLOCKED') return {ok: true, value: current.v};
      return {ok: false, error: 'unknown-type'};
    };
  };

  it('shows a denied document in red, without the NEW_BUILD controls', async () => {
    const current = {
      v: view({state: 'MISMATCH', reasons: ['bytes'], retry: false, expected: 'b'.repeat(64)}),
    };
    const {app, assigned} = await openPage('blocked', {current: blocked(current)}, `#${INCIDENT}`);
    expect(app.textContent).toContain('IntactWarden blocked this page: Mismatch');
    expect(app.button('Retry')).not.toBeNull();
    expect(app.button('Check now')).toBeNull();
    expect(assigned).toEqual([]);
    const band = app.byClass('status-band')!;
    expect(band.className).toBe('status-band state-red');
    expect(band.attributes.get('role')).toBe('alert');
  });

  it("gives the band the state's colour: only a red state is red and an alert", async () => {
    for (const [state, colour, role] of [
      ['DISPUTED', 'red', 'alert'],
      ['PROTECTION_LOST', 'red', 'alert'],
      ['BUILD_UNVERIFIED', 'amber', 'status'],
      ['NOT_COVERED', 'grey', 'status'],
    ] as const) {
      const current = {v: view({state, reasons: [], retry: false})};
      const {app} = await openPage('blocked', {current: blocked(current)}, `#${INCIDENT}`);
      const band = app.byClass('status-band')!;
      expect(band.className, state).toBe(`status-band state-${colour}`);
      expect(band.attributes.get('role'), state).toBe(role);
    }
  });

  it('NEW_BUILD: shows the running deep verify, then reloads the vault once it is done', async () => {
    const current = {v: view({job})};
    const page = await openPage('blocked', {current: blocked(current)}, `#${INCIDENT}`);
    expect(page.title()).toBe('IntactWarden: checking a new build');
    expect(page.app.textContent).toContain('A new build is being checked');
    expect(page.app.textContent).toContain('Downloaded 20 MB of 41.8 MB');
    expect(page.app.button('Proceed once (unverified)')).toBeNull();
    expect(page.assigned).toEqual([]);
    current.v = view({job: {...job, phase: 'done', finishedAt: 2}});
    await page.broadcast('JOB_UPDATED');
    expect(page.assigned).toEqual(['https://vault.example.org/']);
  });

  it('NEW_BUILD: reloads the vault when the background says that only a new load can decide', async () => {
    // The denied document is gone, or its release is known or disputed by now: no job to wait for.
    const current = {v: view({})};
    const page = await openPage('blocked', {current: blocked(current)}, `#${INCIDENT}`);
    expect(page.assigned).toEqual([]);
    current.v = view({reload: true});
    await page.broadcast('JOB_UPDATED');
    expect(page.assigned).toEqual(['https://vault.example.org/']);
  });

  it('NEW_BUILD: two job updates at once reload the vault only once', async () => {
    // A second navigation cancels the first load's request, whose filter then fails: that would
    // raise a false origin alert (PROTECTION_LOST filter-failed) over the verified reload.
    const current = {v: view({job})};
    const page = await openPage('blocked', {current: blocked(current)}, `#${INCIDENT}`);
    current.v = view({job: {...job, phase: 'done', finishedAt: 2}});
    await Promise.all([page.broadcast('JOB_UPDATED'), page.broadcast('JOB_UPDATED')]);
    expect(page.assigned).toEqual(['https://vault.example.org/']);
  });

  it('NEW_BUILD with no job running: never claims a fetch, and "Check now" loads the vault again', async () => {
    // No job runs for the page (GitHub's limit, an earlier attempt that failed, GitHub access
    // revoked): it loads again on "Check now", which checks the build again.
    const current = {v: view({})};
    const page = await openPage('blocked', {current: blocked(current)}, `#${INCIDENT}`);
    expect(page.app.textContent).toContain('IntactWarden blocked this page: New build');
    expect(page.app.textContent).toContain(
      'IntactWarden is not fetching its GitHub release right now',
    );
    expect(page.app.textContent).not.toContain('A new build is being checked');
    expect(page.assigned).toEqual([]);
    page.app.button('Check now')!.click();
    expect(page.assigned).toEqual(['https://vault.example.org/']);
    // A job that failed is not running either; the page says why.
    const failed = {
      v: view({job: {...job, phase: 'failed', failure: 'permission-missing', finishedAt: 2}}),
    };
    const again = await openPage('blocked', {current: blocked(failed)}, `#${INCIDENT}`);
    expect(again.app.textContent).toContain('not fetching its GitHub release right now');
    expect(again.app.textContent).toContain('Failed: access to GitHub is not granted.');
    again.app.button('Check now')!.click();
    expect(again.assigned).toEqual(['https://vault.example.org/']);
  });

  it('NEW_BUILD that turns final: switches to Build not verified with "Proceed once" and the failed job, then stops re-reading', async () => {
    const current = {v: view({job})};
    let reads = 0;
    const answer: Answer = type => {
      if (type === 'UI_GET_BLOCKED') reads++;
      return blocked(current)(type);
    };
    const page = await openPage('blocked', {current: answer}, `#${INCIDENT}`);
    expect(page.title()).toBe('IntactWarden: checking a new build');
    // The deep verify failed (or the give-up time passed): the view the background returns is final.
    current.v = view({
      state: 'BUILD_UNVERIFIED',
      reasons: ['selfhost-unpublished'],
      canProceedOnce: true,
      retry: false,
      job: {...job, phase: 'failed', failure: 'network', finishedAt: 2},
    });
    await page.broadcast('JOB_UPDATED');
    expect(page.app.textContent).toContain('IntactWarden blocked this page: Build not verified');
    expect(page.app.textContent).toContain('Failed: GitHub could not be reached.');
    expect(page.title()).toBe('IntactWarden: page blocked');
    const proceed = page.app.button('Proceed once');
    expect(proceed).not.toBeNull();
    expect(page.assigned).toEqual([]);
    // Nothing reads or renders it again, so a ticked confirmation stays ticked.
    const n = reads;
    await page.broadcast('JOB_UPDATED');
    expect(reads).toBe(n);
    expect(page.app.button('Proceed once')).toBe(proceed);
  });

  it('Build not verified with a failed release: Retry asks GitHub again, shows the progress and loads the vault once the release is known', async () => {
    const key = {app: 'vaultwarden-web', variant: 'release', version: '2026.11.0'} as const;
    const current = {
      v: view({
        state: 'BUILD_UNVERIFIED',
        reasons: ['selfhost-unpublished'],
        canProceedOnce: true,
        retry: false,
        release: key,
      }),
    };
    const sent: unknown[] = [];
    let answerRetry: (r: Reply) => void = () => undefined;
    const answer: Answer = (type, payload) => {
      if (type === 'UI_DEEP_VERIFY') {
        sent.push(payload);
        return new Promise<Reply>(r => (answerRetry = r));
      }
      return blocked(current)(type);
    };
    const page = await openPage('blocked', {current: answer}, `#${INCIDENT}`);
    const retry = page.app.button('Retry')!;
    retry.click();
    await settle();
    expect(sent).toEqual([{key}]);
    expect(retry.disabled).toBe(true);
    expect(page.app.textContent).toContain(
      'Fetching and checking the GitHub release in your browser…',
    );
    // Progress of this release's job only.
    await page.broadcast('JOB_UPDATED', {job: {...job, version: '2026.12.0', bytes: 1}});
    expect(page.app.textContent).not.toContain('Downloaded');
    await page.broadcast('JOB_UPDATED', {job: {...job, trigger: 'user'}});
    expect(page.app.textContent).toContain('Downloaded 20 MB of 41.8 MB');
    expect(page.assigned).toEqual([]);
    answerRetry({ok: true, value: {ok: true, refs: []}});
    await settle();
    expect(page.assigned).toEqual(['https://vault.example.org/']);
  });

  it('Build not verified: a Retry that fails says why and can be tried again; without a failed release Retry only loads the page', async () => {
    const key = {app: 'vaultwarden-web', variant: 'release', version: '2026.11.0'} as const;
    const failing = {
      v: view({
        state: 'BUILD_UNVERIFIED',
        reasons: [],
        canProceedOnce: true,
        retry: false,
        release: key,
      }),
    };
    const answer: Answer = type =>
      type === 'UI_DEEP_VERIFY'
        ? {
            ok: true,
            value: {ok: false, failure: 'release-not-found', transient: false, retryAt: null},
          }
        : blocked(failing)(type);
    const page = await openPage('blocked', {current: answer}, `#${INCIDENT}`);
    const retry = page.app.button('Retry')!;
    retry.click();
    await settle();
    expect(page.app.textContent).toContain(
      'The release could not be checked: the release was not found on GitHub.',
    );
    expect(retry.disabled).toBe(false);
    expect(page.assigned).toEqual([]);

    const sent: string[] = [];
    const plain = {
      v: view({state: 'BUILD_UNVERIFIED', reasons: [], canProceedOnce: true, retry: false}),
    };
    const other = await openPage(
      'blocked',
      {
        current: type => {
          sent.push(type);
          return blocked(plain)(type);
        },
      },
      `#${INCIDENT}`,
    );
    other.app.button('Retry')!.click();
    await settle();
    expect(other.assigned).toEqual(['https://vault.example.org/']);
    expect(sent).not.toContain('UI_DEEP_VERIFY');
  });

  it('NEW_BUILD: a job update while the first read is pending reads again', async () => {
    let release: (r: Reply) => void = () => undefined;
    const first = new Promise<Reply>(r => (release = r));
    const done = view({job: {...job, phase: 'done', finishedAt: 2}});
    let reads = 0;
    const answer: Answer = type => {
      if (type !== 'UI_GET_BLOCKED') return blocked({v: done})(type);
      reads++;
      return reads === 1 ? first : {ok: true, value: done};
    };
    const page = await openPage('blocked', {current: answer}, `#${INCIDENT}`);
    await page.broadcast('JOB_UPDATED');
    expect(reads).toBe(2);
    expect(page.assigned).toEqual(['https://vault.example.org/']);
    release({ok: true, value: view({job})});
    await page.broadcast('NOTHING');
    expect(page.assigned).toEqual(['https://vault.example.org/']);
  });
});

describe('popup', () => {
  const ONBOARDING = {permissions: [], incognitoAllowed: true, pinned: true, openProtectedTabs: 0};
  const popup = (current: {record: unknown}, sent: unknown[] = []): Answer => {
    return (type, payload) => {
      if (type === 'UI_GET_ONBOARDING') return {ok: true, value: ONBOARDING};
      if (type === 'UI_GET_STATE') return {ok: true, value: current.record};
      if (type === 'UI_ALLOW_FOR_TAB') {
        sent.push(payload);
        return {ok: true, value: null};
      }
      return {ok: false, error: 'unknown-type'};
    };
  };

  it('allowing the server stylesheet reloads the tab past the cache and closes the popup', async () => {
    // The allowance is read when the stylesheet loads: without a reload nothing would change.
    const record = tabRecord({
      state: 'UNVERIFIED_STYLE',
      reasons: ['custom-rules'],
      top: topDoc({
        serverStyle: {
          path: '/css/vaultwarden.css',
          accepted: false,
          hiddenCount: 0,
          reason: 'custom-rules',
        },
      }),
    });
    const sent: unknown[] = [];
    const page = await openPage('popup', {current: popup({record}, sent)});
    page.app.button('Allow the server stylesheet for this tab and reload')!.click();
    await settle();
    expect(sent).toEqual([{tab: 7, allowance: {k: 'server-style', path: '/css/vaultwarden.css'}}]);
    expect(page.reloaded).toEqual([[7, {bypassCache: true}]]);
    expect(page.closed()).toBe(1);
  });

  it('keeps an open payment consent across a state update, until its button is gone', async () => {
    const blockedStripe = tabRecord({
      state: 'THIRD_PARTY_CODE',
      reasons: ['js.stripe.com'],
      top: topDoc({thirdPartyBlocked: ['stripe']}),
    });
    const current: {record: unknown} = {record: blockedStripe};
    const page = await openPage('popup', {current: popup(current)});
    expect(page.app.textContent).not.toContain('Allow Stripe for one page load?');
    page.app.button('Allow Stripe for one page load…')!.click();
    expect(page.app.textContent).toContain('Allow Stripe for one page load?');
    await page.broadcast('STATE_UPDATED', {tab: 7});
    expect(page.app.textContent).toContain('Allow Stripe for one page load?');
    expect(page.app.button('Allow Stripe and reload')).not.toBeNull();
    current.record = tabRecord();
    await page.broadcast('STATE_UPDATED', {tab: 7});
    expect(page.app.textContent).not.toContain('Allow Stripe for one page load?');
  });
});

describe('details page', () => {
  const sha = 'c'.repeat(64);
  const details = {
    tab: 7,
    origin: 'https://vault.bitwarden.com',
    docs: [
      {
        summary: topDoc(),
        coreSha256: 'd'.repeat(64),
        dispute: null,
        serverStyles: {},
        items: [
          {
            req: '1',
            path: '/app/main.js',
            url: 'https://vault.bitwarden.com/app/main.js',
            type: 'script',
            cls: 'script',
            key: 'app/main.js',
            sha256: sha,
            expected: sha,
            outcome: {r: 'ok', how: 'exact'},
            at: 1,
          },
        ],
      },
    ],
  };

  it('shows the manifest hash whole, and the whole file hashes as tooltips of the shortened cells', async () => {
    const answer: Answer = type =>
      type === 'UI_GET_DETAILS' ? {ok: true, value: details} : {ok: false, error: 'unknown-type'};
    const {app} = await openPage('details', {current: answer}, '#7');
    expect(app.textContent).toContain(`Manifest sha256 ${'d'.repeat(64)}`);
    const cells: FakeNode[] = [];
    const walk = (n: FakeNode): void => {
      if (n.nodeName === 'td' && n.textContent === `${sha.slice(0, 12)}…`) cells.push(n);
      n.childNodes.forEach(walk);
    };
    walk(app);
    expect(cells).toHaveLength(2);
    for (const c of cells) expect(c.attributes.get('title')).toBe(sha);
  });
});
