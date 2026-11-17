/**
 * Extension page `ui/onboarding.html`:
 * status and explanation only. "Grant access" calls permissions.request inside
 * the click handler: Firefox grants the required hosts at installation since
 * version 127, but the user can revoke them at any time. The documentation
 * links open on GitHub in a new tab (shared/docs.ts).
 */

import type {OnboardingStatus} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {userDocUrl} from '../shared/docs.ts';
import {button, el, link, mount, section} from '../shared/dom.ts';
import {uiWarn} from '../shared/log.ts';
import {renderPageError, startPage, type PageContext} from '../shared/page.ts';
import {NOT_PROVEN_KEYS, onboardingModel} from './model.ts';

class OnboardingPage {
  private readonly ctx: PageContext;
  private status: OnboardingStatus | null = null;
  private readonly feedback = el('p', {
    class: 'muted',
    attrs: {role: 'status', 'aria-live': 'polite'},
  });

  constructor(ctx: PageContext) {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    await this.load();
    this.ctx.bridge.ext.permissions.onAdded.addListener(() => void this.load());
    this.ctx.bridge.ext.permissions.onRemoved.addListener(() => void this.load());
  }

  private async load(): Promise<void> {
    try {
      this.status = await this.ctx.bridge.call('UI_GET_ONBOARDING', {});
    } catch (error) {
      uiWarn('onboarding-unavailable', error);
      renderPageError(this.ctx.root);
      return;
    }
    this.render();
  }

  private render(): void {
    const s = this.status;
    if (s === null) return;
    const m = onboardingModel(s);
    const grant = button(
      t('onboarding_grant'),
      () => {
        // permissions.request must be the first await of the click handler.
        void this.ctx.bridge.ext.permissions
          .request({origins: [...m.missing]})
          .then(granted => {
            this.feedback.textContent = granted
              ? t('onboarding_grant_ok')
              : t('onboarding_grant_refused');
            return this.load();
          })
          .catch(error => uiWarn('grant-failed', error));
      },
      {kind: 'primary', disabled: m.missing.length === 0},
    );
    mount(
      this.ctx.root,
      el('h1', null, t('onboarding_heading')),
      el('p', null, t('onboarding_intro')),
      this.feedback,
      section(
        'step-browser',
        t('onboarding_step_browser'),
        el('p', null, m.protection),
        el('p', {class: 'muted'}, m.protectionDetail),
      ),
      section(
        'permissions',
        t('onboarding_step_permissions'),
        el('p', null, m.permissionsIntro),
        el(
          'ul',
          {class: 'permissions'},
          m.permissions.map(p =>
            el(
              'li',
              {class: p.granted ? 'result-ok' : 'result-bad'},
              el('span', {class: 'mono'}, p.pattern),
              ' — ',
              p.purpose,
              ' — ',
              el('strong', null, p.status),
            ),
          ),
        ),
        m.missing.length > 0
          ? el(
              'p',
              {class: 'notice notice-red', attrs: {role: 'alert'}},
              t('onboarding_permissions_missing'),
            )
          : el('p', {class: 'notice notice-green'}, t('onboarding_permissions_ok')),
        el('div', {class: 'actions'}, grant),
      ),
      section('step-private', t('onboarding_step_private'), el('p', null, m.privateWindows)),
      section(
        'pin',
        t('onboarding_step_pin'),
        el('p', null, m.pin),
        el('p', {class: 'muted'}, m.pinHint),
        el('p', {class: 'muted'}, t('onboarding_icon_authoritative')),
      ),
      m.openTabs
        ? section('step-tabs', t('onboarding_step_tabs'), el('p', null, m.openTabs))
        : null,
      section(
        'step-github',
        t('onboarding_step_github'),
        el('p', null, t('onboarding_github_explain')),
        el(
          'p',
          {class: 'row'},
          link(userDocUrl('privacy'), t('docs_link_privacy')),
          link('options.html', t('popup_link_options')),
        ),
      ),
      section(
        'step-limits',
        t('onboarding_step_limits'),
        el(
          'ul',
          null,
          NOT_PROVEN_KEYS.map(k => el('li', null, t(k))),
        ),
        el('p', null, link(userDocUrl('not-proven'), t('docs_link_not_proven'))),
        el('p', {class: 'muted'}, t('docs_links_note')),
      ),
    );
    if (location.hash === '#permissions') document.getElementById('permissions')?.scrollIntoView();
  }
}

void startPage('onboarding_page_title', async ctx => {
  await new OnboardingPage(ctx).start();
});
