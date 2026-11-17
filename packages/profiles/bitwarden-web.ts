/**
 * Bitwarden Web Vault: the cloud vaults (vault.bitwarden.com, vault.bitwarden.eu) and
 * self-hosted Bitwarden, Secrets Manager included.
 *
 * A self-hosted server whose `/api/config` names itself Vaultwarden is added with the
 * vaultwarden-web profile instead (extension/src/deployments): its web vault is a patched build
 * released by dani-garcia/bw_web_builds, never a bitwarden/clients release. send.bitwarden.com
 * and send.bitwarden.eu become cloud deployments of this profile only if they turn out to serve
 * the vault build (not known yet; docs/security.md).
 */

import type {AppProfile} from '@intactwarden/core/schema/profile.ts';

export const bitwardenWeb: AppProfile = {
  app: 'bitwarden-web',
  upstream: {
    repo: 'bitwarden/clients',
    repo_id: 53538899,
    tag_pattern: 'web-v{version}',
    // The COMMERCIAL edition: what the official images and Bitwarden lite serve. The cloud
    // variants are derived from it (packages/builders/src/bitwarden/cloudCore.ts).
    asset: 'web-{version}-selfhosted-COMMERCIAL.zip',
    archive_root: 'build/',
  },
  variants: {
    'selfhosted-commercial': {assurance: 'release-exact'},
    'cloud-us': {assurance: 'release-derived'},
    'cloud-eu': {assurance: 'release-derived'},
  },
  deployments: [
    {
      id: 'cloud-us',
      kind: 'cloud',
      origins: ['https://vault.bitwarden.com'],
      variant: 'cloud-us',
    },
    {
      id: 'cloud-eu',
      kind: 'cloud',
      origins: ['https://vault.bitwarden.eu'],
      variant: 'cloud-eu',
    },
    {
      id: 'self-hosted',
      kind: 'self-hosted',
      origins: 'user',
      variant: 'selfhosted-commercial',
      server_rendered: [
        {path: '/admin/**', class: 'admin-portal'},
        {path: '/sso/**', class: 'auth-flow'},
        {path: '/identity/**', class: 'auth-flow'},
      ],
    },
  ],
  identify: {
    documents: ['/', '/index.html', '/*-connector.html'],
    hint_endpoints: ['/version.json'],
  },
  resources: {
    dynamic_same_origin: [
      {path: '/api/**'},
      {path: '/identity/**'},
      {path: '/notifications/**'},
      {path: '/icons/**'},
      // Attachment downloads and event uploads on a self-hosted server (inferred, not observed):
      // declared, so they are never buffered as build files.
      {path: '/attachments/**'},
      {path: '/events/**'},
      {path: '/app-id.json', deployments: ['self-hosted']},
    ],
    not_covered_paths: [],
  },
  third_party: [
    {
      id: 'stripe',
      match: ['https://js.stripe.com/v3*'],
      kind: 'unpinnable-script',
      csp_allowance: {'script-src': ['https://js.stripe.com']},
    },
    {
      id: 'braintree',
      match: ['https://js.braintreegateway.com/web/*'],
      kind: 'unpinnable-script',
      csp_allowance: {'script-src': ['https://js.braintreegateway.com']},
    },
    {
      id: 'paypal',
      match: ['https://www.paypalobjects.com/api/checkout.min.js', 'https://www.paypal.com/*'],
      kind: 'unpinnable-script',
      csp_allowance: {'script-src': ['https://www.paypalobjects.com', 'https://www.paypal.com']},
    },
    {
      id: 'duo',
      match: ['https://*.duosecurity.com/*', 'https://*.duofederal.com/*'],
      kind: 'cross-origin-frame',
    },
    {id: '2fa-directory', match: ['https://api.2fa.directory/v3/totp.json'], kind: 'data'},
  ],
  csp_floor: {
    'base-uri': "'self'",
    'script-src-attr': "'none'",
    'script-src': "'self' 'wasm-unsafe-eval'",
  },
};
