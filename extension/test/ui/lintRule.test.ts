/**
 * The `no-literal-ui-strings` lint rule.
 */

import {RuleTester} from 'eslint';
import {describe, it} from 'vitest';
import rule from '../../lint/no-literal-ui-strings.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({languageOptions: {ecmaVersion: 2024, sourceType: 'module'}});
const error = {messageId: 'literal'};

tester.run('no-literal-ui-strings', rule, {
  valid: [
    "node.textContent = t('state_VERIFIED');",
    "node.textContent = '';",
    "el('p', {class: 'muted mono'}, t('x'), ' · ', view.origin);",
    "el('a', {attrs: {href: 'https://github.com/x/y', rel: 'noopener noreferrer'}}, t('x'));",
    "button(t('popup_btn_details'), () => undefined, {kind: 'primary'});",
    "node.setAttribute('role', 'alert');",
    "node.setAttribute('aria-label', t('x'));",
    "document.title = t('popup_page_title');",
    "const key = 'state_VERIFIED';",
    "logWarn('ui.badge-failed');",
    "el('td', null, r.state ?? '—');",
  ],
  invalid: [
    {code: "node.textContent = 'Verified';", errors: [error]},
    {code: 'node.textContent = `Verified ${x}`;', errors: [error]},
    {code: "document.title = 'IntactWarden settings';", errors: [error]},
    {code: "alert('Something went wrong');", errors: [error]},
    {code: "el('p', null, 'Hello', t('x'));", errors: [error]},
    {code: "el('p', null, ['Hello']);", errors: [error]},
    {code: "el('p', null, ok ? t('a') : 'Fallback');", errors: [error]},
    {code: "button('Go back', () => undefined);", errors: [error]},
    {code: "checkbox('id', 'Enable', true, () => undefined);", errors: [error]},
    {code: "link('details.html', 'Details');", errors: [error]},
    {code: "mount(root, 'Nothing here');", errors: [error]},
    {code: "node.setAttribute('aria-label', 'Close');", errors: [error]},
    {code: "el('input', {attrs: {placeholder: 'https://vault.example.org'}});", errors: [error]},
    {code: "el('button', {attrs: {'aria-label': 'Close'}});", errors: [error]},
    {code: "parent.append('Zamknij');", errors: [error]},
    {code: "document.createTextNode('Ostrzeżenie');", errors: [error]},
  ],
});
