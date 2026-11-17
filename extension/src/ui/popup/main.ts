/**
 * Extension page `ui/popup.html`. Reads
 * only the persisted TabStateRecord of the active tab through UI_GET_STATE
 * (R10) and re-renders on STATE_UPDATED. All text via textContent from the i18n
 * catalogue (view model: ./model.ts).
 */

import {PAGES, type TabStateRecord} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import type {PageBridge} from '../shared/bridge.ts';
import {button, el, link, mount} from '../shared/dom.ts';
import {uiWarn} from '../shared/log.ts';
import {renderPageError, startPage, type PageContext} from '../shared/page.ts';
import {missingPatterns} from '../onboarding/model.ts';
import {blockedTabView, popupView, type LinkView, type PopupView} from './model.ts';

async function activeTab(bridge: PageBridge): Promise<number | null> {
  const tabs = await bridge.ext.tabs.query({active: true, currentWindow: true});
  const id = tabs[0]?.id;
  return typeof id === 'number' ? id : null;
}

async function openPage(bridge: PageBridge, page: string, fragment = ''): Promise<void> {
  await bridge.ext.tabs.create({
    url: bridge.ext.runtime.getURL(`${page}${fragment}`),
    active: true,
  });
  window.close();
}

function linkOf(v: LinkView | null): HTMLElement | null {
  return v ? link(v.href, v.text, v.title) : null;
}

function render(
  ctx: PageContext,
  tab: number,
  view: PopupView,
  rerender: () => void,
  missingAccess: boolean,
  consentBox: HTMLElement,
): void {
  const {bridge} = ctx;
  const b = view.buttons;
  // An open consent text survives a re-render (a state update), unless its button is gone.
  if (b.allowThirdParty.length === 0) mount(consentBox);
  const header = el(
    'header',
    {class: 'popup-header'},
    el('h1', null, view.header.product),
    view.header.origin ? el('p', {class: 'mono'}, view.header.origin) : null,
    el(
      'p',
      {class: 'row'},
      view.header.deployment ? el('span', {class: 'chip'}, view.header.deployment) : null,
      view.header.badge ? el('span', {class: 'chip'}, view.header.badge) : null,
    ),
  );

  const status = el(
    'section',
    {class: `status-band state-${view.colour}`, attrs: {'aria-live': 'polite', role: 'status'}},
    view.lead ? el('p', {class: 'lead'}, view.lead) : null,
    el('p', {class: 'state-title'}, view.title),
    el('p', null, view.sentence),
    view.flags.length > 0
      ? el(
          'ul',
          {class: 'flags'},
          view.flags.map(f => el('li', null, f)),
        )
      : null,
  );

  const reasons =
    view.reasons.length > 0
      ? el(
          'section',
          {class: 'card', attrs: {'aria-label': t('popup_reasons_heading')}},
          el('h2', null, t('popup_reasons_heading')),
          el(
            'ul',
            null,
            view.reasons.map(r => el('li', null, r)),
          ),
        )
      : null;

  const notices = [view.alert, view.unknownBuild, view.coResident]
    .filter((x): x is string => x !== null)
    .map(text =>
      el('p', {class: `notice notice-${view.colour === 'red' ? 'red' : 'amber'}`}, text),
    );

  const p = view.provenance;
  const provenance = p
    ? el(
        'section',
        {class: 'card'},
        el('h2', null, t('popup_provenance_heading')),
        el(
          'dl',
          {class: 'kv'},
          el('dt', null, t('popup_label_app')),
          el('dd', null, p.app),
          p.deployment
            ? [el('dt', null, t('popup_label_deployment')), el('dd', null, p.deployment)]
            : null,
          p.version ? [el('dt', null, t('popup_label_version')), el('dd', null, p.version)] : null,
          p.release
            ? [el('dt', null, t('popup_label_release')), el('dd', null, linkOf(p.release))]
            : null,
          p.commit
            ? [el('dt', null, t('popup_label_commit')), el('dd', {class: 'mono'}, linkOf(p.commit))]
            : null,
          p.assurance
            ? [el('dt', null, t('popup_label_assurance')), el('dd', null, p.assurance)]
            : null,
        ),
        p.source ? el('p', {class: 'muted'}, p.source) : null,
        p.artifact ? el('p', {class: 'muted mono'}, p.artifact) : null,
      )
    : null;

  const coverage =
    view.coverage || view.serverStyle || view.serverStyleNote
      ? el(
          'section',
          {class: 'card'},
          el('h2', null, t('popup_coverage_heading')),
          view.coverage ? el('p', null, view.coverage) : null,
          view.serverStyle ? el('p', null, view.serverStyle) : null,
          view.serverStyleNote ? el('p', {class: 'muted'}, view.serverStyleNote) : null,
        )
      : null;

  const limits =
    view.limits.length > 0
      ? el(
          'details',
          {class: 'card'},
          el('summary', null, t('popup_limits_heading')),
          el(
            'ul',
            null,
            view.limits.map(l => el('li', null, l)),
          ),
        )
      : null;

  // Required access is missing (the "!" on the icon); the grant button below already covers this
  // tab's own origin, so the setup checklist is offered only without it.
  const access =
    missingAccess && b.grant === null
      ? [
          el('p', {class: 'notice notice-red'}, t('onboarding_permissions_missing')),
          button(t('options_link_onboarding'), () => void openPage(bridge, PAGES.onboarding), {
            kind: 'primary',
          }),
        ]
      : null;

  const actions = el(
    'div',
    {class: 'actions'},
    b.checklist
      ? button(
          t('popup_btn_checklist'),
          () => void openPage(bridge, PAGES.incidents, `#${b.checklist!.incidentId}`),
          {kind: 'primary'},
        )
      : null,
    b.grant
      ? button(
          t('popup_btn_grant'),
          () => {
            // permissions.request must be the first await of the click handler.
            void bridge.ext.permissions
              .request({origins: [b.grant!.pattern]})
              .then(() => rerender())
              .catch(error => uiWarn('grant-failed', error));
          },
          {kind: 'primary'},
        )
      : null,
    b.allowStyle
      ? button(t('popup_btn_allow_style'), () => {
          // The allowance is read when the stylesheet loads, so the tab loads again; the cache is
          // bypassed so that Firefox fetches the stylesheet instead of reusing a copy it holds.
          void bridge
            .call('UI_ALLOW_FOR_TAB', {
              tab,
              allowance: {k: 'server-style', path: b.allowStyle!.path},
            })
            .then(() => bridge.ext.tabs.reload(tab, {bypassCache: true}))
            .then(() => window.close())
            .catch(error => uiWarn('allow-style-failed', error));
        })
      : null,
    b.allowThirdParty.map(tp =>
      button(t('popup_btn_allow_third_party', [tp.label]), () => {
        // The consent text first; agreeing reloads the tab with the vendor allowed for that one
        // page load.
        mount(
          consentBox,
          el(
            'section',
            {class: 'card notice'},
            el('h2', null, t('consent_third_party_heading', [tp.label])),
            tp.consent.map(line => el('p', null, line)),
            el(
              'div',
              {class: 'actions'},
              button(
                t('consent_third_party_confirm', [tp.label]),
                () => {
                  void bridge
                    .call('UI_ALLOW_FOR_TAB', {tab, allowance: {k: 'third-party', id: tp.id}})
                    .then(() => window.close())
                    .catch(error => uiWarn('allow-third-party-failed', error));
                },
                {kind: 'danger'},
              ),
              button(t('consent_third_party_cancel'), () => mount(consentBox)),
            ),
          ),
        );
      }),
    ),
    b.details
      ? button(t('popup_btn_details'), () => void openPage(bridge, PAGES.details, `#${tab}`))
      : null,
  );

  const footer = el(
    'footer',
    {class: 'row popup-footer'},
    el(
      'button',
      {
        class: 'linklike',
        attrs: {type: 'button'},
        on: {click: () => void openPage(bridge, PAGES.incidents)},
      },
      t('popup_link_incidents'),
    ),
    el(
      'button',
      {
        class: 'linklike',
        attrs: {type: 'button'},
        on: {click: () => void bridge.ext.runtime.openOptionsPage().then(() => window.close())},
      },
      t('popup_link_options'),
    ),
  );

  const note = view.protected ? el('p', {class: 'muted small'}, t('popup_in_page_note')) : null;

  mount(
    ctx.root,
    header,
    status,
    notices,
    reasons,
    access,
    actions,
    consentBox,
    provenance,
    coverage,
    limits,
    note,
    footer,
  );
}

void startPage('popup_page_title', async ctx => {
  const tab = await activeTab(ctx.bridge);
  const version = ctx.bridge.ext.runtime.getManifest().version;
  // A denied top-level document is replaced by the blocked page and its session ends, so the tab
  // has no record. The tab's URL needs host permission; its frame's URL needs only webNavigation.
  const blockedUrl = ctx.bridge.ext.runtime.getURL(PAGES.blocked);
  const onBlockedPage = async (): Promise<boolean> => {
    if (tab === null) return false;
    const f = await ctx.bridge.ext.webNavigation
      ?.getFrame?.({tabId: tab, frameId: 0})
      .catch(() => null);
    return typeof f?.url === 'string' && f.url.startsWith(blockedUrl);
  };
  const consentBox = el('div');
  const refresh = async (): Promise<void> => {
    const onboarding = await ctx.bridge.call('UI_GET_ONBOARDING', {}).catch(() => null);
    const missingAccess = onboarding ? missingPatterns(onboarding).length > 0 : false;
    if (tab === null) {
      render(ctx, -1, popupView(null, version), () => undefined, missingAccess, consentBox);
      return;
    }
    let record: TabStateRecord | null;
    try {
      record = await ctx.bridge.call('UI_GET_STATE', {tab});
    } catch (error) {
      uiWarn('state-unavailable', error);
      renderPageError(ctx.root, 'popup_error');
      return;
    }
    const view =
      record === null && (await onBlockedPage())
        ? blockedTabView(version)
        : popupView(record, version);
    render(ctx, tab, view, () => void refresh(), missingAccess, consentBox);
  };
  await refresh();
  ctx.bridge.onBroadcast((type, payload) => {
    if (type === 'STATE_UPDATED' && (payload as {tab: number}).tab === tab) void refresh();
  });
});
