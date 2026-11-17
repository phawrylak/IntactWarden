/**
 * Extension page `ui/blocked.html#<incident>`. The blocked
 * bytes never reached the page. Reads only persisted state (R10).
 *
 * - A denied document: what failed, the path, the whole expected and observed hashes; "Go back",
 *   "Retry" and "Proceed once (unverified)" behind a confirmation checkbox (logged by the
 *   background as an incident; scoped to the document hash and this tab). On Build not verified
 *   with a failed release (`view.release`), Retry first asks GitHub for it again (UI_DEEP_VERIFY,
 *   which ignores the stored failure), shows the job's progress, and loads the page once the
 *   release is known.
 * - NEW_BUILD (`view.retry`): the deep verify of the new build and its progress. The page polls
 *   UI_GET_BLOCKED every 60 s and on every JOB_UPDATED broadcast, and reloads the page's origin and
 *   path once the build is known or the background says that only a new load can decide
 *   (`view.reload`). While no job runs for it (GitHub's limit, a failed attempt) the
 *   page says so and "Check now" loads the page again instead of re-reading. Once a reload would
 *   be BUILD_UNVERIFIED (a failed deep verify, the give-up time), the view the background returns
 *   is final, with "Proceed once" and the failed job: the page shows it and stops polling.
 *   The fragment of the original URL is never stored, so a hash route restarts at the vault's home.
 */

import {
  PAGES,
  type BlockedView,
  type DeepVerifyJobView,
  type EnsureReleaseOutcome,
  type ReleaseKey,
} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {blockedPageView, jobLine, retryLine, shouldReload} from '../shared/blocking.ts';
import {button, checkbox, el, mount} from '../shared/dom.ts';
import {uiWarn} from '../shared/log.ts';
import {incidentFromHash, renderPageError, startPage, type PageContext} from '../shared/page.ts';
import {colourFor} from '../shared/stateText.ts';

const POLL_MS = 60_000;

async function currentTab(ctx: PageContext): Promise<number | null> {
  const tabs = await ctx.bridge.ext.tabs.query({active: true, currentWindow: true});
  return typeof tabs[0]?.id === 'number' ? tabs[0].id : null;
}

function goBack(): void {
  if (history.length > 1) history.back();
  else window.close();
}

/**
 * Retry of a Build not verified page whose release failed: asks GitHub for `key` again, shows the
 * job's progress in `line`, and loads `target` once the release is known.
 */
function retryRelease(
  ctx: PageContext,
  key: ReleaseKey,
  target: string,
  retry: HTMLButtonElement,
  line: HTMLElement,
): void {
  retry.disabled = true;
  let job: DeepVerifyJobView | null = null;
  let outcome: EnsureReleaseOutcome | null = null;
  const show = (): void => {
    line.textContent = retryLine(job, outcome);
  };
  show();
  const off = ctx.bridge.onBroadcast((type, payload) => {
    if (type !== 'JOB_UPDATED' || outcome !== null) return;
    const j = (payload as {job: DeepVerifyJobView}).job;
    if (j.app === key.app && j.variant === key.variant && j.version === key.version) {
      job = j;
      show();
    }
  });
  void ctx.bridge
    .call('UI_DEEP_VERIFY', {key})
    .catch((error: unknown): EnsureReleaseOutcome => {
      uiWarn('deep-verify-failed', error);
      return {ok: false, failure: 'network', transient: true, retryAt: null};
    })
    .then(o => {
      outcome = o;
      off();
      if (o.ok) {
        location.assign(target);
        return;
      }
      show();
      retry.disabled = false;
    });
}

function render(ctx: PageContext, view: BlockedView, incidentId: string): void {
  const v = blockedPageView(view);
  // A NEW_BUILD page that turned final: why its deep verify failed.
  const failed = view.job?.phase === 'failed' ? jobLine(view.job) : null;
  // The band has the state's colour (Build not verified is amber, Not covered grey); only a red
  // state is announced as an alert.
  const colour = colourFor(view.state, []);
  document.title = t('blocked_page_title');
  const status = el('p', {class: 'muted', attrs: {role: 'status', 'aria-live': 'polite'}});
  const retryStatus = el('p', {class: 'muted', attrs: {role: 'status', 'aria-live': 'polite'}});
  const target = v.target;
  const release = view.release;
  const retry =
    target === null
      ? null
      : button(t('blocked_btn_retry'), () => {
          if (release === undefined) location.assign(target);
          else retryRelease(ctx, release, target, retry!, retryStatus);
        });
  let confirmed = false;
  const proceed = button(
    t('blocked_btn_proceed_once'),
    () => {
      if (!confirmed || v.target === null || view.observed === null) return;
      const target = v.target;
      const sha256 = view.observed;
      void (async () => {
        try {
          const tab = await currentTab(ctx);
          if (tab === null) throw new Error('no tab');
          await ctx.bridge.call('UI_ALLOW_FOR_TAB', {tab, allowance: {k: 'proceed-once', sha256}});
          location.assign(target);
        } catch (error) {
          uiWarn('proceed-once-failed', error);
          status.textContent = t('blocked_proceed_failed');
        }
      })();
    },
    {kind: 'danger', disabled: true},
  );
  const confirm = checkbox(
    'confirm-proceed',
    t('blocked_confirm_proceed'),
    false,
    value => {
      confirmed = value;
      proceed.disabled = !value;
    },
    {hint: t('blocked_confirm_hint')},
  );
  mount(
    ctx.root,
    el(
      'section',
      {class: `status-band state-${colour}`, attrs: {role: colour === 'red' ? 'alert' : 'status'}},
      el('h1', {class: 'state-title'}, v.title),
      el('p', null, v.sentence),
      v.reasons.length > 0
        ? el(
            'ul',
            null,
            v.reasons.map(r => el('li', null, r)),
          )
        : null,
      failed ? el('p', null, failed) : null,
      v.dispute.map(line => el('p', {class: 'mono'}, line)),
    ),
    el(
      'section',
      {class: 'card'},
      el('h2', null, t('blocked_details_heading')),
      el(
        'dl',
        {class: 'kv'},
        v.rows.map(r => [
          el('dt', null, r.label),
          el('dd', {class: r.mono ? 'mono' : ''}, r.value),
        ]),
      ),
    ),
    el(
      'div',
      {class: 'actions'},
      button(t('blocked_btn_back'), goBack, {kind: 'primary'}),
      retry,
      view.state === 'MISMATCH' || view.state === 'DISPUTED'
        ? button(
            t('popup_btn_checklist'),
            () =>
              void ctx.bridge.ext.tabs.create({
                url: ctx.bridge.ext.runtime.getURL(`${PAGES.incidents}#${incidentId}`),
                active: true,
              }),
          )
        : null,
    ),
    retryStatus,
    v.canProceedOnce && v.target
      ? el(
          'section',
          {class: 'card proceed'},
          el('h2', null, t('blocked_proceed_heading')),
          el('p', null, t('blocked_proceed_explain')),
          confirm,
          el('div', {class: 'actions'}, proceed),
          status,
        )
      : el(
          'p',
          {class: 'muted'},
          view.state === 'NOT_COVERED'
            ? t('blocked_not_covered_note')
            : t('blocked_no_override_note'),
        ),
  );
}

/** Whether a deep verify for the page is running (attached and not finished). */
function jobRunning(view: BlockedView): boolean {
  return view.job !== null && view.job.finishedAt === undefined;
}

/** NEW_BUILD: the deep verify the page waits for (amber; no "Proceed once"). */
function renderNewBuild(ctx: PageContext, view: BlockedView, checkNow: () => void): void {
  const v = blockedPageView(view);
  // Say only what is true: a job is fetching the release, or nothing is right now (GitHub's limit,
  // an earlier attempt that failed).
  const running = jobRunning(view);
  const sentence = running ? t('retry_sentence') : t('retry_sentence_idle');
  const line = jobLine(view.job);
  const job = view.job;
  const progress =
    job &&
    job.phase === 'downloading' &&
    typeof job.bytes === 'number' &&
    typeof job.total === 'number' &&
    job.total > 0
      ? el('progress', {
          attrs: {max: job.total, value: job.bytes, 'aria-label': t('retry_progress_label')},
        })
      : null;
  document.title = running ? t('retry_page_title') : t('blocked_page_title');
  mount(
    ctx.root,
    el(
      'section',
      {class: 'status-band state-amber', attrs: {role: 'status', 'aria-live': 'polite'}},
      el('h1', {class: 'state-title'}, running ? t('retry_heading') : v.title),
      el('p', null, sentence),
      line ? el('p', null, line) : null,
      progress,
    ),
    el(
      'section',
      {class: 'card'},
      el(
        'dl',
        {class: 'kv'},
        v.rows.slice(0, 2).map(r => [el('dt', null, r.label), el('dd', {class: 'mono'}, r.value)]),
      ),
      el('p', {class: 'muted'}, t('retry_explain')),
    ),
    el(
      'div',
      {class: 'actions'},
      button(t('retry_btn_check_now'), checkNow, {kind: 'primary'}),
      button(t('blocked_btn_back'), goBack),
    ),
  );
}

void startPage('blocked_page_title', async ctx => {
  const incidentId = incidentFromHash(location.hash);
  if (incidentId === null) {
    renderPageError(ctx.root, 'blocked_not_found');
    return;
  }
  let reloading = false;
  let polling = false;
  // A final view is shown: nothing more to wait for (a re-render would clear the confirmation).
  let final = false;
  const load = async (): Promise<void> => {
    if (reloading || final) return;
    let view: BlockedView | null;
    try {
      view = await ctx.bridge.call('UI_GET_BLOCKED', {incidentId});
    } catch (error) {
      uiWarn('blocked-unavailable', error);
      renderPageError(ctx.root);
      return;
    }
    // Two loads can be in flight at once (two broadcasts): only the first may navigate (a second
    // navigation would cancel the first one's request, and the failed filter of that request would
    // raise a false origin alert) or show a final view.
    if (reloading || final) return;
    if (view === null) {
      renderPageError(ctx.root, 'blocked_not_found');
      return;
    }
    if (!view.retry) {
      final = true;
      render(ctx, view, incidentId);
      return;
    }
    const target = blockedPageView(view).target;
    if (shouldReload(view) && target !== null) {
      reloading = true;
      location.assign(target);
      return;
    }
    // Polling cannot help while no job runs for the page (GitHub's limit, a failed attempt):
    // "Check now" then loads the page again, which checks the build again.
    const reloadTo = jobRunning(view) ? null : target;
    renderNewBuild(ctx, view, () => (reloadTo !== null ? location.assign(reloadTo) : void load()));
    if (polling) return;
    polling = true;
    setInterval(() => void load(), POLL_MS);
  };
  // Before the first read, so that a job update during it is not missed.
  ctx.bridge.onBroadcast(type => {
    if (type === 'JOB_UPDATED') void load();
  });
  await load();
});
