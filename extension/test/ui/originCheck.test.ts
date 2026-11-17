/**
 * Options "Add server" pre-check:
 * normalisation, official-origin refusal, http only on this computer, and the
 * look-alike guard (the same functions the background runs again).
 */

import {domainToASCII} from 'node:url';
import {describe, expect, it} from 'vitest';
import {checkInstanceInput} from '../../src/ui/options/originCheck.ts';

describe('checkInstanceInput', () => {
  it('normalises to origin, base path and one host pattern (https by default)', () => {
    expect(checkInstanceInput('  vault.example.org ')).toEqual({
      ok: true,
      origin: 'https://vault.example.org',
      basePath: '/',
      pattern: 'https://vault.example.org/*',
      lookalike: false,
    });
    expect(checkInstanceInput('https://Example.ORG:8443/vw/sub?x=1#frag')).toMatchObject({
      ok: true,
      origin: 'https://example.org:8443',
      basePath: '/vw/sub/',
      pattern: 'https://example.org/*',
    });
  });

  it('refuses the official cloud origins however they are spelled', () => {
    for (const input of [
      'https://vault.bitwarden.com',
      'vault.bitwarden.eu',
      'HTTPS://VAULT.BITWARDEN.COM:443/#/vault',
      'https://vault.bitwarden.com./',
      // With a port the pattern is still the required one.
      'https://vault.bitwarden.com:8443',
      'vault.bitwarden.eu:4443/vw',
    ]) {
      expect(checkInstanceInput(input), input).toEqual({
        ok: false,
        code: 'refused-official-origin',
      });
    }
  });

  it('refuses the GitHub hosts of deep verify (their permission is required)', () => {
    for (const input of [
      'github.com',
      'https://GitHub.com:8443/owner/repo',
      'raw.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com.',
    ]) {
      expect(checkInstanceInput(input), input).toEqual({ok: false, code: 'invalid-input'});
    }
  });

  it('accepts http only on this computer (loopback)', () => {
    expect(checkInstanceInput('http://localhost:8080')).toMatchObject({
      ok: true,
      pattern: 'http://localhost/*',
    });
    expect(checkInstanceInput('http://127.0.0.2').ok).toBe(true);
    expect(checkInstanceInput('http://vault.localhost').ok).toBe(true);
    expect(checkInstanceInput('http://[::1]:8000')).toMatchObject({
      ok: true,
      pattern: 'http://[::1]/*',
    });
    // The vault needs a secure context, which Firefox gives plain http on loopback only.
    for (const input of [
      'http://192.168.1.10',
      'http://172.20.0.3',
      'http://nas.local',
      'http://vault.home.arpa',
      'http://[fd12:3456::1]',
      'http://vault.example.org',
    ]) {
      expect(checkInstanceInput(input), input).toEqual({
        ok: false,
        code: 'http-not-loopback',
      });
    }
  });

  it('refuses input that is not a plain http(s) origin', () => {
    for (const input of [
      '',
      'ftp://example.org',
      'javascript:alert(1)',
      'https://user:pw@example.org',
      'https://exa mple.org',
      // A `*` in the host would make the requested permission a wildcard pattern.
      '*',
      'https://*.example.org',
      'https://%2A.example.org',
      'http://*.localhost',
    ]) {
      expect(checkInstanceInput(input).ok, input).toBe(false);
    }
    // The URL parser resolves dot segments before the check sees the path.
    expect(checkInstanceInput('https://example.org/a/../vw')).toMatchObject({
      ok: true,
      basePath: '/vw/',
    });
  });

  it('flags look-alikes of the official origins for a blocking warning', () => {
    expect(checkInstanceInput('https://vault.bitwarden.co')).toMatchObject({
      ok: true,
      lookalike: true,
    });
    expect(checkInstanceInput('https://vault-bitwarden.com')).toMatchObject({
      ok: true,
      lookalike: true,
    });
    expect(checkInstanceInput('https://vauIt.bitvvarden.com')).toMatchObject({
      ok: true,
      lookalike: true,
    });
    expect(checkInstanceInput(`https://${domainToASCII('vаult.bitwarden.com')}`)).toMatchObject({
      ok: true,
      lookalike: true,
    });
    expect(checkInstanceInput('https://send.bitwarden.com')).toMatchObject({
      ok: true,
      lookalike: true,
    });
    expect(checkInstanceInput('https://vaultwarden.example.org')).toMatchObject({
      ok: true,
      lookalike: false,
    });
    expect(checkInstanceInput('https://bitwarden.mycompany.net')).toMatchObject({
      ok: true,
      lookalike: false,
    });
    // Any internationalised host needs the confirmation: a non-ASCII letter can imitate any other.
    expect(checkInstanceInput(`https://${domainToASCII('bücher.example')}`)).toMatchObject({
      ok: true,
      lookalike: true,
    });
    // A raw edit distance of 2 counts even where the skeleton (rn → m) moves it further away.
    expect(checkInstanceInput('https://vault.bitwarnem.com')).toMatchObject({lookalike: true});
    for (const h of ['vault.example.org', 'vw.home.lan', 'passwords.acme.io', '10.0.0.5']) {
      expect(checkInstanceInput(`https://${h}`), h).toMatchObject({ok: true, lookalike: false});
    }
  });
});
