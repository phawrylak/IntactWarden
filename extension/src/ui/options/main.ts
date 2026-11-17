/**
 * Extension page `ui/options.html`:
 * notifications, self-hosted servers, deep verify and the trust panel, private
 * windows and the privacy statement. Reads persisted state through messages
 * (R10); all text via textContent.
 */

import {
  GITHUB_PERMISSION_PATTERNS,
  type InstanceView,
  type OnboardingStatus,
  type Settings,
  type SettingsPatch,
  type TrustPanelView,
} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {button, checkbox, el, link, mount, section} from '../shared/dom.ts';
import {userDocUrl} from '../shared/docs.ts';
import {uiWarn} from '../shared/log.ts';
import {renderPageError, startPage, type PageContext} from '../shared/page.ts';
import {instanceRow, refusalText, trustModel} from './model.ts';
import {checkInstanceInput, type InputCheck} from './originCheck.ts';

interface AddFlow {
  check: Extract<InputCheck, {ok: true}> | null;
  needsLookalikeConfirm: boolean;
  lookalikeConfirmed: boolean;
  busy: boolean;
  error: string | null;
}

function newFlow(): AddFlow {
  return {
    check: null,
    needsLookalikeConfirm: false,
    lookalikeConfirmed: false,
    busy: false,
    error: null,
  };
}

class OptionsPage {
  private settings: Settings;
  private instances: readonly InstanceView[] = [];
  private trust: TrustPanelView | null = null;
  private onboarding: OnboardingStatus | null = null;
  private flow: AddFlow = newFlow();
  private inputValue = '';
  private readonly status = el('p', {
    class: 'muted',
    attrs: {role: 'status', 'aria-live': 'polite'},
  });
  private readonly alertsBox = el('div');
  private readonly instancesBox = el('div');
  private readonly addBox = el('div');
  private readonly trustBox = el('div');
  private readonly privacyBox = el('div');

  private readonly ctx: PageContext;

  /** `settings` as the background returned them; never defaults shown as the user's. */
  constructor(ctx: PageContext, settings: Settings) {
    this.ctx = ctx;
    this.settings = settings;
  }

  async start(): Promise<void> {
    mount(
      this.ctx.root,
      el('h1', null, t('options_heading')),
      el('p', {class: 'muted'}, t('onboarding_protection')),
      this.status,
      section('alerts', t('options_alerts_heading'), this.alertsBox),
      section(
        'instances',
        t('options_instances_heading'),
        el('p', {class: 'muted'}, t('options_instances_intro')),
        this.instancesBox,
        this.addBox,
      ),
      section(
        'deep-verify',
        t('options_trust_heading'),
        el('p', {class: 'muted'}, t('options_deep_verify_intro')),
        this.trustBox,
      ),
      section('privacy', t('options_privacy_heading'), this.privacyBox),
      section('statement', t('options_statement_heading'), this.statement()),
      el(
        'p',
        {class: 'row'},
        link('onboarding.html', t('options_link_onboarding')),
        link('incidents.html', t('options_link_incidents')),
      ),
      el(
        'p',
        {class: 'row'},
        link(userDocUrl('guide'), t('docs_link_guide')),
        link(userDocUrl('privacy'), t('docs_link_privacy')),
        link(userDocUrl('check-it-yourself'), t('docs_link_check')),
        link(userDocUrl('own-server'), t('docs_link_self_hosting')),
      ),
      el('p', {class: 'muted'}, t('docs_links_note')),
    );
    this.renderAlerts();
    this.renderAdd();
    this.renderPrivacy();
    await Promise.all([this.loadInstances(), this.loadTrust(), this.loadOnboarding()]);
    this.ctx.bridge.onBroadcast((type, payload) => {
      if (type === 'SETTINGS_UPDATED') {
        this.settings = (payload as {settings: Settings}).settings;
        this.renderAlerts();
      } else if (type === 'INSTANCES_UPDATED') {
        void this.loadInstances();
      } else if (type === 'JOB_UPDATED') {
        void this.loadTrust();
      }
    });
  }

  private say(key: string, subs: readonly string[] = []): void {
    this.status.textContent = t(key, subs);
  }

  private async patch(patch: SettingsPatch): Promise<void> {
    try {
      this.settings = await this.ctx.bridge.call('UI_SET_SETTINGS', {patch});
      this.say('options_saved');
    } catch (error) {
      uiWarn('settings-save-failed', error);
      this.say('options_save_failed');
    }
    this.renderAlerts();
  }

  private renderAlerts(): void {
    const s = this.settings;
    // The checkbox is replaced: keep keyboard focus on it.
    const focused = document.activeElement?.id === 'notifications';
    mount(
      this.alertsBox,
      checkbox(
        'notifications',
        t('options_notifications'),
        s.notifications,
        value => void this.patch({notifications: value}),
        {
          hint: t('options_notifications_hint'),
        },
      ),
    );
    if (focused) document.getElementById('notifications')?.focus();
  }

  // -------------------------------------------------------------------------
  // Self-hosted instances

  private async loadInstances(): Promise<void> {
    try {
      this.instances = await this.ctx.bridge.call('UI_LIST_INSTANCES', {});
    } catch (error) {
      // A list that did not load is never shown as empty ("No servers added yet."; fail closed).
      uiWarn('instances-unavailable', error);
      this.instances = [];
      renderPageError(this.instancesBox);
      return;
    }
    this.renderInstances();
  }

  private renderInstances(): void {
    if (this.instances.length === 0) {
      mount(this.instancesBox, el('p', {class: 'muted'}, t('options_instances_none')));
      return;
    }
    mount(
      this.instancesBox,
      el(
        'ul',
        {class: 'instances'},
        this.instances.map(v => {
          const row = instanceRow(v);
          let confirming = false;
          const remove = button(t('options_instance_remove'), () => {
            if (!confirming) {
              confirming = true;
              remove.textContent = t('options_instance_remove_confirm');
              remove.className = 'btn btn-danger';
              return;
            }
            void this.removeInstance(row.id, row.pattern);
          });
          return el(
            'li',
            {class: 'card instance'},
            el('h3', {class: 'mono'}, row.title),
            el(
              'ul',
              null,
              row.lines.map(l => el('li', null, l)),
            ),
            el(
              'div',
              {class: 'actions'},
              row.granted
                ? null
                : button(
                    t('options_instance_grant'),
                    () => {
                      void this.ctx.bridge.ext.permissions
                        .request({origins: [row.pattern]})
                        .then(() => this.loadInstances())
                        .catch(error => uiWarn('grant-failed', error));
                    },
                    {kind: 'primary'},
                  ),
              remove,
            ),
          );
        }),
      ),
    );
  }

  private patternInUse(pattern: string, exceptId: string | null): boolean {
    return this.instances.some(v => v.record.id !== exceptId && v.permission.pattern === pattern);
  }

  /** Drops a host permission no instance needs any more (least privilege). */
  private async releasePattern(pattern: string, exceptId: string | null): Promise<void> {
    if (this.patternInUse(pattern, exceptId)) return;
    try {
      await this.ctx.bridge.ext.permissions.remove({origins: [pattern]});
    } catch (error) {
      uiWarn('permission-remove-failed', error);
    }
  }

  private async removeInstance(id: string, pattern: string): Promise<void> {
    try {
      await this.ctx.bridge.call('UI_REMOVE_INSTANCE', {id});
      await this.releasePattern(pattern, id);
      this.say('options_instance_removed');
    } catch (error) {
      uiWarn('remove-failed', error);
      this.say('options_instance_remove_failed');
    }
    await this.loadInstances();
  }

  private renderAdd(): void {
    const f = this.flow;
    const inputId = 'instance-origin';
    const input = el('input', {
      id: inputId,
      attrs: {
        type: 'text',
        inputmode: 'url',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-describedby': `${inputId}-hint`,
        value: this.inputValue,
        disabled: f.busy,
      },
      on: {
        input: e => {
          this.inputValue = (e.target as HTMLInputElement).value;
        },
      },
    });
    const add = button(t('options_add_save'), () => this.onAdd(), {
      kind: 'primary',
      disabled: f.busy,
    });
    const parts: HTMLElement[] = [
      el('h3', null, t('options_add_heading')),
      el(
        'div',
        {class: 'field'},
        el('label', {attrs: {for: inputId}}, t('options_add_label')),
        el('div', {class: 'row'}, input, add),
        el('p', {class: 'hint', id: `${inputId}-hint`}, t('options_add_hint')),
      ),
    ];
    if (f.error) parts.push(el('p', {class: 'notice notice-red', attrs: {role: 'alert'}}, f.error));
    if (f.needsLookalikeConfirm) {
      parts.push(
        el(
          'div',
          {class: 'notice notice-red', attrs: {role: 'alert'}},
          el('p', null, t('options_add_warning_lookalike')),
          checkbox(
            'confirm-lookalike',
            t('options_add_confirm_lookalike'),
            f.lookalikeConfirmed,
            value => {
              this.flow.lookalikeConfirmed = value;
            },
          ),
        ),
      );
    }
    if (f.busy)
      parts.push(el('p', {class: 'muted', attrs: {role: 'status'}}, t('options_add_checking')));
    mount(this.addBox, el('div', {class: 'add-instance'}, parts));
  }

  /**
   * Click handler of "Add server": permissions.request must be its first await. The background
   * then identifies the server (one GET of `{base}api/config`) and stores it.
   */
  private onAdd(): void {
    const check = checkInstanceInput(this.inputValue);
    if (!check.ok) {
      this.flow = {...newFlow(), error: refusalText(check.code)};
      this.renderAdd();
      return;
    }
    const sameHost = this.flow.check?.pattern === check.pattern;
    if (check.lookalike && !(sameHost && this.flow.lookalikeConfirmed)) {
      this.flow = {...newFlow(), check, needsLookalikeConfirm: true};
      this.renderAdd();
      return;
    }
    const request = this.ctx.bridge.ext.permissions.request({origins: [check.pattern]});
    this.flow = {...newFlow(), check, busy: true};
    this.renderAdd();
    void (async () => {
      let granted = false;
      try {
        granted = await request;
      } catch (error) {
        uiWarn('permission-request-failed', error);
      }
      if (!granted) {
        this.flow = {...newFlow(), error: refusalText('permission-denied')};
        this.renderAdd();
        return;
      }
      try {
        const result = await this.ctx.bridge.call('UI_ADD_INSTANCE', {
          input: `${check.origin}${check.basePath}`,
          lookalikeConfirmed: check.lookalike,
        });
        if (result.ok) {
          this.inputValue = '';
          this.flow = newFlow();
          this.say('options_instance_added_ok', [result.instance.origin]);
        } else {
          await this.releasePattern(check.pattern, null);
          this.flow = {...newFlow(), error: refusalText(result.code)};
        }
      } catch (error) {
        uiWarn('add-failed', error);
        await this.releasePattern(check.pattern, null);
        this.flow = {...newFlow(), error: t('options_add_failed')};
      }
      this.renderAdd();
      await this.loadInstances();
    })();
  }

  // -------------------------------------------------------------------------
  // The trust panel (deep verify jobs, manifests, pins)

  private async loadTrust(): Promise<void> {
    try {
      this.trust = await this.ctx.bridge.call('UI_GET_TRUST', {});
    } catch (error) {
      uiWarn('trust-unavailable', error);
      this.trust = null;
    }
    this.renderTrust();
  }

  private renderTrust(): void {
    if (this.trust === null) {
      mount(this.trustBox, el('p', {class: 'muted'}, t('trust_unavailable')));
      return;
    }
    const m = trustModel(this.trust, Date.now());
    mount(
      this.trustBox,
      m.githubPermission
        ? null
        : el(
            'div',
            {class: 'notice notice-amber'},
            el('p', null, t('trust_github_permission_missing')),
            button(
              t('trust_github_grant'),
              () => {
                void this.ctx.bridge.ext.permissions
                  .request({origins: [...GITHUB_PERMISSION_PATTERNS]})
                  .then(() => this.loadTrust())
                  .catch(error => uiWarn('github-grant-failed', error));
              },
              {kind: 'primary'},
            ),
          ),
      el(
        'ul',
        null,
        m.summary.map(line => el('li', null, line)),
      ),
      el('h3', null, t('trust_cores_heading')),
      m.cores.length === 0
        ? el('p', {class: 'muted'}, t('trust_cores_none'))
        : el(
            'table',
            null,
            el('caption', {class: 'visually-hidden'}, t('trust_cores_heading')),
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                el('th', {attrs: {scope: 'col'}}, t('trust_col_build')),
                el('th', {attrs: {scope: 'col'}}, t('trust_col_assurance')),
                el('th', {attrs: {scope: 'col'}}, t('trust_col_source')),
              ),
            ),
            el(
              'tbody',
              null,
              m.cores.map(c =>
                el(
                  'tr',
                  null,
                  el(
                    'td',
                    {class: 'mono'},
                    c.buildId,
                    c.disputed ? el('span', {class: 'chip'}, t('trust_disputed')) : null,
                  ),
                  el('td', null, c.assurance),
                  el('td', null, c.source),
                ),
              ),
            ),
          ),
      el('h3', null, t('trust_jobs_heading')),
      m.jobs.length === 0
        ? el('p', {class: 'muted'}, t('trust_jobs_none'))
        : el(
            'ul',
            null,
            m.jobs.map(j => el('li', null, j)),
          ),
      el(
        'details',
        null,
        el('summary', null, t('trust_pins_heading')),
        m.pins.length === 0
          ? el('p', {class: 'muted'}, t('trust_pins_none'))
          : el(
              'ul',
              {class: 'mono'},
              m.pins.map(p => el('li', null, p)),
            ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Privacy, statement

  private async loadOnboarding(): Promise<void> {
    try {
      this.onboarding = await this.ctx.bridge.call('UI_GET_ONBOARDING', {});
    } catch (error) {
      uiWarn('onboarding-unavailable', error);
      this.onboarding = null;
    }
    this.renderPrivacy();
  }

  private renderPrivacy(): void {
    const o = this.onboarding;
    mount(
      this.privacyBox,
      el(
        'p',
        null,
        o === null
          ? t('options_private_unknown')
          : o.incognitoAllowed
            ? t('onboarding_private_allowed')
            : t('onboarding_private_not_allowed'),
      ),
    );
  }

  private statement(): HTMLElement {
    return el(
      'div',
      null,
      el('p', null, t('privacy_no_telemetry')),
      el('p', null, t('privacy_network_intro')),
      el(
        'ul',
        null,
        el('li', null, t('privacy_network_github')),
        el('li', null, t('privacy_network_hint')),
        el('li', null, t('privacy_network_probe')),
      ),
      el('p', null, t('privacy_storage')),
      el('p', null, t('privacy_trust_mode')),
    );
  }
}

void startPage('options_page_title', async ctx => {
  // Settings that cannot be read fail the page (startPage renders the page error).
  await new OptionsPage(ctx, await ctx.bridge.call('UI_GET_SETTINGS', {})).start();
});
