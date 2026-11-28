# Release process

How IntactWarden is released to addons.mozilla.org (AMO, its only store) and maintained. Code and
policy ship in the package and no remote channel can change them: every fix is a new release. AMO's
version rollback is never used (it republishes an old package under a new number); a higher version
fixes a bad release.

A release is one `MAJOR.MINOR.PATCH` version, one signed tag
`v<version>` and one deterministic package, `intactwarden-<version>-firefox.zip`. The version is in
`extension/package.json` and `extension/manifest.json`; the build refuses a mismatch.

## Release checklist

1. **Prepare** the version in both files, a [CHANGELOG](../CHANGELOG.md) entry dated with the day of
   the tag (the tag's source tarball includes it), complete English and Polish strings, and a
   [privacy policy](privacy.md) that still lists every network request.
2. **Merge** the pull request once `ci.yml` is green, then push the signed, annotated tag
   `v<version>` on `main`.
3. **Build and attest** with `release-extension.yml`. Check `SHA256SUMS` and the provenance
   ([how](security.md#check-it-yourself)), then publish the draft as an immutable GitHub release.
4. **Submit** from the maintainer's computer: `bws run -- npm run publish:amo -- v<version>`. It
   checks the tag signature, `SHA256SUMS`, the provenance and the manifest, then uploads the attested
   zip unchanged with the source tarball; `--dry-run` only checks. The first version was submitted on
   AMO's website instead, with the listing text. publish-amo does not change the listing: if
   `docs/privacy.md` changed, update the privacy policy on the AMO listing to match it once AMO has
   approved the version.
5. **Compare** once AMO has approved it: `gh workflow run store-diff.yml`, then smoke-test the live
   listing on the current Firefox ESR and the latest release. The repository variable `AMO_LISTED`
   gates manual runs too (the job is skipped while it is not `true`); it is set to `true` once AMO
   serves 1.0.1, the first version whose files match the release zip byte for byte.

## CI

Nothing CI produces reaches the extension at runtime.

- `ci.yml` (pushes and pull requests to `main`): lint, typecheck, unit tests and link check on Node
  22 and 24; two builds that must be byte-identical; the corpus tests; the end-to-end suite in each
  pinned Firefox.
- `release-extension.yml` (a `v*` tag): requires an annotated tag on `main`, equal to the package
  version, signed by the release key (`RELEASE_KEY_FPR`). It builds twice and compares, adds the
  source tarball and `SHA256SUMS`, attests both with GitHub build provenance and drafts the release.
- `store-diff.yml` (daily, once the repository variable `AMO_LISTED` is `true`): compares the
  package AMO serves with the attested release zip; only AMO's signature files may differ. AMO
  rewrites `manifest.json` when it signs a package, so the build writes it in AMO's encoding
  (`serializeManifest` in `extension/build/manifest.ts`).

## Repository hardening

`tools/workflows.test.ts` enforces the workflow rules: no default token permissions, exact triggers
and job permissions, actions pinned by commit SHA, `npm ci --ignore-scripts`, no secrets, no
`pull_request_target`, and the order of the release steps.

The release key, with every signing subkey, is on the maintainer's GitHub account and on
keys.openpgp.org. The AMO API key is never stored on GitHub: it is kept in Bitwarden Secrets Manager
(`WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET`), read by a machine account limited to that project, with an
expiring token. Once the repository is public, before the first tag: private vulnerability
reporting, release immutability, a ruleset on `main` (changes only through pull requests, merged by
squash once every `ci.yml` job is green; no force-push or deletion) and a ruleset on `v*` tags (only
the maintainer creates, moves or deletes them).

## Maintenance

1. **New upstream release:** deep verify builds its manifest; no IntactWarden release is needed.
2. **Cloud derivation broken** (amber, blocked): fix `packages/core/src/derive/`, extend the test.
3. **DISPUTED release reported:** compare the reported digests and tag with GitHub and say publicly
   what happened.
4. **Compromised key or account:** revoke keys and tokens, have AMO disable the affected versions,
   release a fix from a newly signed tag and publish an advisory.
5. **Store rejection or delay:** answer with the source tarball and build instructions; fix forward.
