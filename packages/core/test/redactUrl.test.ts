import {describe, expect, it} from 'vitest';
import {INVALID_URL, redactUrl} from '../src/privacy/redactUrl.ts';

describe('redactUrl', () => {
  const cases: [string, string][] = [
    // Bitwarden Send keys live in the fragment; queries can carry tokens.
    ['https://send.bitwarden.com/?t=abc#key=secretkeymaterial', 'https://send.bitwarden.com/'],
    ['https://vault.bitwarden.com/#/send/abc/def', 'https://vault.bitwarden.com/'],
    [
      'https://vault.example.org/attachments/1/2?token=x',
      'https://vault.example.org/attachments/1/2',
    ],
    [
      'https://user:password@vault.example.org:8443/api/sync?x#y',
      'https://vault.example.org:8443/api/sync',
    ],
    ['https://VAULT.Bitwarden.COM/app/main.js', 'https://vault.bitwarden.com/app/main.js'],
    ['https://vault.bitwarden.com:443/x', 'https://vault.bitwarden.com/x'],
    ['http://localhost:3000/a/b?c', 'http://localhost:3000/a/b'],
    ['http://[::1]:8080/x#y', 'http://[::1]:8080/x'],
    ['https://bücher.example/p', 'https://xn--bcher-kva.example/p'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/a%20b/c?', 'https://example.com/a%20b/c'],
    [
      'wss://notifications.bitwarden.com/hub?access_token=abc',
      'wss://notifications.bitwarden.com/hub',
    ],
    ['moz-extension://1234-uuid/popup.html?tab=1', 'moz-extension://1234-uuid/popup.html'],
    ['chrome-extension://abcdef/gate.html#target', 'chrome-extension://abcdef/gate.html'],
    ['file:///home/user/secret.txt?x', 'file:///home/user/secret.txt'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'data:'],
    ['blob:https://vault.bitwarden.com/2b1f-uuid', 'blob:'],
    ['javascript:alert(document.cookie)', 'javascript:'],
    ['about:blank', 'about:'],
    ['about:srcdoc', 'about:'],
    ['mailto:someone@example.com?subject=x', 'mailto:'],
    ['JAVASCRIPT:alert(1)', 'javascript:'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(redactUrl(input)).toBe(expected);
    });
  }

  it('returns <invalid-url> for anything that does not parse', () => {
    for (const bad of [
      '',
      'not a url',
      '/relative/path?x',
      '//host/path',
      'https://',
      'http://exa mple.com/',
      'https://[::1/x',
    ]) {
      expect(redactUrl(bad), bad).toBe(INVALID_URL);
    }
    for (const bad of [
      undefined,
      null,
      42,
      {href: 'https://a.com/?x'},
      new URL('https://a.com/?x'),
    ]) {
      expect(redactUrl(bad)).toBe(INVALID_URL);
    }
  });

  it('never keeps "?" or "#" and never keeps userinfo', () => {
    const inputs = [
      'https://a.com/p?q=1#f',
      'https://a.com/p?#',
      'https://u:p@a.com/p',
      'https://a.com/%3Fnot-a-query%23',
      'https://a.com/path#?',
    ];
    for (const input of inputs) {
      const out = redactUrl(input);
      expect(out).not.toMatch(/[?#@]/);
    }
  });
});
