/**
 * Extension page `ui/details.html#<tab>`:
 * the per-file table, server stylesheets with the selectors they hide, the
 * bound build, and "Copy redacted report". Reads only persisted state through
 * UI_GET_DETAILS (R10); all text via textContent.
 */

import type {DetailsView} from '../../contracts.ts';
import {t} from '../../i18n/t.ts';
import {button, el, mount} from '../shared/dom.ts';
import {uiWarn} from '../shared/log.ts';
import {renderPageError, startPage, tabFromHash, type PageContext} from '../shared/page.ts';
import {detailsModel, redactedReport, type DocView} from './model.ts';

function docSection(doc: DocView, index: number): HTMLElement {
  const id = `doc-${index}`;
  return el(
    'section',
    {class: 'card', id, attrs: {'aria-labelledby': `${id}-h`}},
    el('h2', {id: `${id}-h`}, doc.heading),
    el('p', null, el('strong', null, doc.state), ' · ', doc.docClass),
    doc.build ? el('p', {class: 'mono'}, doc.build) : null,
    doc.source ? el('p', {class: 'muted'}, doc.source) : null,
    doc.core ? el('p', {class: 'mono muted'}, doc.core) : null,
    doc.dispute.map(line => el('p', {class: 'mono notice notice-red'}, line)),
    doc.rows.length === 0
      ? el('p', {class: 'muted'}, t('details_no_items'))
      : el(
          'div',
          {class: 'table-wrap'},
          el(
            'table',
            null,
            el('caption', {class: 'visually-hidden'}, t('details_table_caption')),
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                el('th', {attrs: {scope: 'col'}}, t('details_col_path')),
                el('th', {attrs: {scope: 'col'}}, t('details_col_class')),
                el('th', {attrs: {scope: 'col'}}, t('details_col_expected')),
                el('th', {attrs: {scope: 'col'}}, t('details_col_observed')),
                el('th', {attrs: {scope: 'col'}}, t('details_col_result')),
              ),
            ),
            el(
              'tbody',
              null,
              doc.rows.map(r =>
                el(
                  'tr',
                  null,
                  el('td', {class: 'mono'}, r.path),
                  el('td', null, r.cls),
                  el('td', {class: 'mono', attrs: {title: r.expectedFull}}, r.expected),
                  el('td', {class: 'mono', attrs: {title: r.observedFull}}, r.observed),
                  el('td', {class: `result-${r.tone}`}, r.result),
                ),
              ),
            ),
          ),
        ),
    doc.styles.map(s =>
      el(
        'div',
        {class: 'server-style'},
        el('h3', null, t('details_style_heading', [s.path])),
        el('p', {class: 'mono'}, s.sha256),
        el('p', null, s.verdict),
        s.hidden.length > 0
          ? el(
              'ul',
              {class: 'mono'},
              s.hidden.map(sel => el('li', null, sel)),
            )
          : null,
      ),
    ),
  );
}

function render(ctx: PageContext, view: DetailsView, now: () => number): void {
  const model = detailsModel(view);
  const status = el('p', {class: 'muted', attrs: {role: 'status', 'aria-live': 'polite'}});
  const copy = button(t('details_copy_report'), () => {
    void navigator.clipboard
      .writeText(redactedReport(view, now(), ctx.bridge.ext.runtime.getManifest().version))
      .then(() => {
        status.textContent = t('details_copied');
      })
      .catch(error => {
        uiWarn('copy-failed', error);
        status.textContent = t('details_copy_failed');
      });
  });
  mount(
    ctx.root,
    el('h1', null, t('details_heading')),
    el('p', {class: 'mono'}, model.origin),
    el('p', {class: 'muted'}, t('details_intro')),
    el('div', {class: 'actions'}, copy, status),
    model.docs.map(docSection),
  );
}

void startPage('details_page_title', async ctx => {
  const tab = tabFromHash(location.hash);
  if (tab === null) {
    renderPageError(ctx.root, 'details_no_tab');
    return;
  }
  const refresh = async (): Promise<void> => {
    let view: DetailsView | null;
    try {
      view = await ctx.bridge.call('UI_GET_DETAILS', {tab});
    } catch (error) {
      uiWarn('details-unavailable', error);
      renderPageError(ctx.root);
      return;
    }
    if (view === null) {
      renderPageError(ctx.root, 'details_no_state');
      return;
    }
    render(ctx, view, () => Date.now());
  };
  await refresh();
  ctx.bridge.onBroadcast((type, payload) => {
    if (type === 'STATE_UPDATED' && (payload as {tab: number}).tab === tab) void refresh();
  });
});
