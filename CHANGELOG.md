# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/) from the first release on.

## 1.0.0 (2026-11-25), the first release

Published on [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/intactwarden/) and as a
[GitHub release](https://github.com/phawrylak/IntactWarden/releases/tag/v1.0.0).

IntactWarden 1.0.0 checks, in desktop Firefox 153 or newer, that the web vault runs exactly the code
of the vendor's GitHub release, and blocks code that does not match.

- **Supported apps**: the Bitwarden web vault on `vault.bitwarden.com` and `vault.bitwarden.eu`,
  self-hosted Bitwarden (the official COMMERCIAL build), both including Secrets Manager, and the
  self-hosted Vaultwarden web vault.
- **Block only**: every page and code file of a protected site is held, hashed and released only if
  it matches the release; API responses are not held. A server that serves different code is
  blocked, with no override other than disabling the add-on.
- **Ways past, all limited to one page or one tab**: "Proceed once" for a build that no release
  explains; a stylesheet your own server generates, allowed for one tab; a Stripe, Braintree or
  PayPal script, allowed for one page load after a consent text.
- **Always blocked**: pages a self-hosted server renders itself (`/admin`, and SSO and identity pages
  with code of their own).
- **Expected files from GitHub, built in your browser**: the first visit to a vault downloads its
  release from GitHub once; deep verify checks GitHub's listed digest, pins it on first sight and
  builds the manifest locally, which an update keeps unless the code that builds manifests changed.
  If that fails, **Retry** on the blocked page asks GitHub again at once.
- **Your own servers**: add a self-hosted server by its address; IntactWarden asks for access to that
  server only. `http:` is accepted only for this computer (loopback).
- **States**: the toolbar icon and popup show each tab's state (green, amber, red, grey); a build
  that no release explains is amber, never red. Notifications for new red states can be turned off.
- **Privacy**: no telemetry, no project server, no third-party code in the package; the only network
  requests go to the protected sites and to GitHub ([privacy policy](docs/privacy.md)).
- **Languages**: the extension's interface is in English and Polish and follows Firefox's language.
- **Verifiable package**: reproducible builds, `SHA256SUMS`, GitHub build provenance, and
  `npm run verify-store-package` to compare an installed package with the release zip.
