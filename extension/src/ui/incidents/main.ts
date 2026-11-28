/**
 * Extension page `ui/incidents.html[#<incident>]`: open origin alerts with the recovery steps and
 * one "Acknowledge" (the origin stays RECOVERING until then), and the incident log (origin and path
 * only); a notification's click opens it at its incident. Reads persisted state through messages
 * (R10); text via textContent.
 */

import type {IncidentRecord, OriginAlert} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {button, el, mount} from '../shared/dom.ts';
import {uiWarn} from '../shared/log.ts';
import {incidentFromHash, renderPageError, startPage, type PageContext} from '../shared/page.ts';
import {CHECKLIST_KEYS, incidentRow, openAlerts} from './model.ts';

const LOG_LIMIT = 200;

class IncidentsPage {
  private alerts: readonly OriginAlert[] = [];
  private incidents: readonly IncidentRecord[] = [];
  private readonly ctx: PageContext;
  private readonly focusId: string | null;
  private readonly status = el('p', {
    class: 'muted',
    attrs: {role: 'status', 'aria-live': 'polite'},
  });
  private readonly alertsBox = el('div');
  private readonly logBox = el('div');

  constructor(ctx: PageContext) {
    this.ctx = ctx;
    this.focusId = incidentFromHash(location.hash);
  }

  async start(): Promise<void> {
    mount(
      this.ctx.root,
      el('h1', null, t('incidents_heading')),
      this.status,
      el(
        'section',
        {class: 'card', attrs: {'aria-labelledby': 'alerts-h'}},
        el('h2', {id: 'alerts-h'}, t('incidents_alerts_heading')),
        this.alertsBox,
      ),
      el(
        'section',
        {class: 'card', attrs: {'aria-labelledby': 'log-h'}},
        el('h2', {id: 'log-h'}, t('incidents_log_heading')),
        el('p', {class: 'muted'}, t('incidents_log_intro')),
        this.logBox,
      ),
    );
    await this.load();
    if (this.focusId) document.getElementById(`incident-${this.focusId}`)?.scrollIntoView();
    this.ctx.bridge.onBroadcast(type => {
      if (type === 'STATE_UPDATED') void this.load();
    });
  }

  private async load(): Promise<void> {
    try {
      [this.alerts, this.incidents] = await Promise.all([
        this.ctx.bridge.call('UI_LIST_ALERTS', {}),
        this.ctx.bridge.call('UI_LIST_INCIDENTS', {limit: LOG_LIMIT}),
      ]);
    } catch (error) {
      uiWarn('incidents-unavailable', error);
      // Never "No open alerts." for a list that did not load. Into the alerts box, not the root:
      // the skeleton stays, so the next successful load (STATE_UPDATED) replaces the error.
      renderPageError(this.alertsBox);
      return;
    }
    this.renderAlerts();
    this.renderLog();
  }

  private async acknowledge(origin: string): Promise<void> {
    try {
      await this.ctx.bridge.call('UI_ACK_ALERT', {origin});
      this.status.textContent = t('incidents_acknowledged');
    } catch (error) {
      uiWarn('ack-failed', error);
      this.status.textContent = t('incidents_action_failed');
    }
    await this.load();
  }

  private renderAlerts(): void {
    const open = openAlerts(this.alerts);
    if (open.length === 0) {
      mount(this.alertsBox, el('p', {class: 'muted'}, t('incidents_alerts_none')));
      return;
    }
    mount(
      this.alertsBox,
      open.map(a =>
        el(
          'article',
          {
            class: `alert card${a.incidentId === this.focusId ? ' focus' : ''}`,
            id: `incident-${a.incidentId}`,
            attrs: {'aria-labelledby': `alert-${a.incidentId}-h`},
          },
          el(
            'div',
            {class: 'notice notice-red', attrs: {role: 'alert'}},
            el(
              'h3',
              {id: `alert-${a.incidentId}-h`},
              t('incidents_alert_title', [a.title, a.origin]),
            ),
            el('p', null, a.when),
            a.reasons.length > 0
              ? el(
                  'ul',
                  null,
                  a.reasons.map(r => el('li', null, r)),
                )
              : null,
          ),
          el('h3', null, t('incidents_checklist_heading')),
          el(
            'ol',
            {class: 'checklist'},
            CHECKLIST_KEYS.map(k => el('li', null, t(k))),
          ),
          el('p', null, t('incidents_ack_explain')),
          el(
            'div',
            {class: 'actions'},
            button(t('incidents_btn_acknowledge'), () => void this.acknowledge(a.origin), {
              kind: 'primary',
            }),
          ),
        ),
      ),
    );
  }

  private renderLog(): void {
    if (this.incidents.length === 0) {
      mount(this.logBox, el('p', {class: 'muted'}, t('incidents_log_none')));
      return;
    }
    const rows = [...this.incidents].sort((a, b) => b.at - a.at).map(incidentRow);
    mount(
      this.logBox,
      el(
        'div',
        {class: 'table-wrap'},
        el(
          'table',
          null,
          el('caption', {class: 'visually-hidden'}, t('incidents_log_heading')),
          el(
            'thead',
            null,
            el(
              'tr',
              null,
              el('th', {attrs: {scope: 'col'}}, t('incidents_col_when')),
              el('th', {attrs: {scope: 'col'}}, t('incidents_col_kind')),
              el('th', {attrs: {scope: 'col'}}, t('incidents_col_where')),
              el('th', {attrs: {scope: 'col'}}, t('incidents_col_state')),
            ),
          ),
          el(
            'tbody',
            null,
            rows.map(r =>
              el(
                'tr',
                {class: r.id === this.focusId ? 'focus' : '', id: `log-${r.id}`},
                el('td', null, r.when),
                el('td', null, r.kind),
                el(
                  'td',
                  {class: 'mono'},
                  r.where,
                  r.build ? [el('br'), r.build] : null,
                  r.hashes ? [el('br'), r.hashes] : null,
                ),
                el(
                  'td',
                  null,
                  r.state ?? '—',
                  r.reasons ? [el('br'), el('span', {class: 'muted'}, r.reasons)] : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

void startPage('incidents_page_title', async ctx => {
  await new IncidentsPage(ctx).start();
});
