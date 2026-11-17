/**
 * Common start-up of every extension page: open the bridge, apply
 * Firefox's language to `<html lang>` and the document title, and render into
 * `#app`. A failure renders a fail-closed message instead of a blank page;
 * nothing here ever implies a positive state.
 */

import {currentLang, t} from '../../i18n/t.ts';
import {getExt} from '../../platform/api.ts';
import {createBridge, type PageBridge} from './bridge.ts';
import {el, mount} from './dom.ts';
import {uiWarn} from './log.ts';

export interface PageContext {
  readonly bridge: PageBridge;
  readonly root: HTMLElement;
}

/** Renders a page error (the background did not answer, or rendering threw). */
export function renderPageError(root: HTMLElement, messageKey = 'page_error'): void {
  mount(root, el('p', {class: 'notice notice-red', attrs: {role: 'alert'}}, t(messageKey)));
}

export async function startPage(
  titleKey: string,
  render: (ctx: PageContext) => Promise<void> | void,
): Promise<void> {
  const root = document.getElementById('app') ?? document.body;
  let bridge: PageBridge;
  try {
    bridge = createBridge(getExt());
  } catch (error) {
    uiWarn('bridge-failed', error);
    renderPageError(root);
    return;
  }
  document.documentElement.lang = currentLang();
  document.title = t(titleKey);
  try {
    await render({bridge, root});
  } catch (error) {
    uiWarn('render-failed', error);
    renderPageError(root);
  }
}

/** The tab id in the page's fragment ("details.html#42"), or null. */
export function tabFromHash(hash: string): number | null {
  const m = /^#(\d{1,10})$/.exec(hash);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** An incident id in the page's fragment ("blocked.html#<16 hex>"), or null. */
export function incidentFromHash(hash: string): string | null {
  const m = /^#([0-9a-f]{16})$/.exec(hash);
  return m ? m[1]! : null;
}
