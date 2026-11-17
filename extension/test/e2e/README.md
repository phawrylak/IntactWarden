# End-to-end tests (`npm run test:e2e`)

The end-to-end tests run IntactWarden in a real Firefox against local servers that replay the
pinned Bitwarden and Vaultwarden 2026.10.1 releases and a mirror of the GitHub endpoints of deep
verify. The scenarios are in `scenarios.ts` and `encodings.ts`.

## Prerequisites

- Linux on x86_64 (the pinned Firefox and geckodriver builds exist only for it) with the system
  libraries Firefox needs (GTK 3, ALSA, D-Bus, X11). Firefox runs headless: no display is needed.
- Node.js 22.18 or newer, and `npm ci --ignore-scripts` done.
- The system `openssl` (a throw-away certificate for the local TLS endpoint) and `tar` with `xz`.
- Network access to `github.com`, `*.githubusercontent.com` and `archive.mozilla.org` on the first
  run. Downloads are checked by sha256 and cached in `fixtures/corpora/.downloads/`.

## Commands

```sh
npm run test:e2e                                   # build the packages, then run every scenario
npm run test:e2e -- --no-build                     # reuse the packages in extension/dist-test/
npm run test:e2e -- --no-build -- -t "vw-genuine"  # arguments after a second -- go to vitest
```

`run.ts` builds two test packages and the shipping package into `extension/dist-test/`, obtains
Firefox and geckodriver, and runs the vitest `e2e` project. The test packages bundle the manifests
of the fixture releases (all of them, or only Bitwarden's); the shipping package bundles none and
deep-verifies each release from the GitHub mirror. The exit code is non-zero if any scenario fails
or a browser cannot be obtained. `npm test` never runs these tests.

## Environment variables

- `INTACTWARDEN_E2E_FIREFOX_VERSION`: use another Firefox version pinned in `browsers.lock.json`
  (CI runs each of them). `run.ts` sets the other `INTACTWARDEN_E2E_*` variables itself.
- `NODE_USE_ENV_PROXY=1`: make Node use `HTTPS_PROXY` for downloads (Node 22.21 or newer).

## Browsers

Firefox and geckodriver are pinned by sha256 in `browsers.lock.json`; an archive with another digest
is never unpacked. They are unpacked into `.cache/browsers/`. To bump Firefox, check Mozilla's
`SHA256SUMS` with its `.asc` signature, copy the digest of
`linux-x86_64/en-US/firefox-<version>.tar.xz` into the lock, and update the matrix in `ci.yml`.

## Results and logs

Every scenario's evidence is printed at the end and kept in `.cache/e2e/firefox.json`, with one log
per scenario in `.cache/e2e/firefox-logs/`. CI uploads `.cache/e2e` as an artifact if the job fails.
