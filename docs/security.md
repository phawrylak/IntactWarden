# Security model

What IntactWarden promises, against whom, what you still have to trust, and how to check a release
yourself. To report a vulnerability: [SECURITY.md](../SECURITY.md).
A *manifest* lists the expected SHA-256 and size of every file of one build.

## The promise and its limits

On a protected site, every **active file** the browser loads (documents and frames, scripts,
workers, WASM, CSS, fonts and the data files the manifest lists) must equal, byte for byte and at
the same path, a file of a GitHub release, and it is checked before the page can use it. What does
not match is not delivered: a document becomes the blocked page, a frame stays empty, a file gets
nothing. The exceptions are responses Firefox does not let an extension hold (a document a service
worker answers, a protected page framed by another site): they reach the page, and the tab turns
red.

| App | Checked against |
|---|---|
| Bitwarden self-hosted (official image, Bitwarden lite) | The release asset `web-<v>-selfhosted-COMMERCIAL.zip` of `bitwarden/clients` |
| Bitwarden cloud (`vault.bitwarden.com`, `.eu`), Secrets Manager included | The same zip; six files are derived from it and the configuration at the release tag (`packages/core/src/derive/`) |
| Vaultwarden | The release asset `bw_web_v<v>.tar.gz` of `dani-garcia/bw_web_builds` |
| Vaultwarden `/css/vaultwarden.css` | Nothing: the server generates it, so a strict validator checks it |
| A build no release explains | Nothing: it is blocked as Build not verified |

A release file is trusted by the SHA-256 that GitHub lists for it, which this browser pins the first
time it sees the release. No vendor signature is checked: Bitwarden publishes none for its web
builds, and Vaultwarden's is not used.

**Green** (Verified) means: the document and every active file loaded so far match, nothing is
pending, the extension is healthy and has its permissions, no unverified page is open on the site
and no alert is open for it. A file the page loads later can still turn it red.

Three things can get past a block, none for Mismatch or Disputed and none giving green: **Proceed
once** for a build no release explains (that page, that tab, once; logged), **allowing a server
stylesheet** for one tab, and **allowing a Bitwarden payment script** for one page load after a
consent text. While such a page is open, the site's other pages are amber.

## Threats and countermeasures

| Threat | Countermeasure | Limit |
|---|---|---|
| The vendor's server or CDN serves modified code, to everyone or to one user | Every browser checks the bytes it received against manifests built from GitHub releases; the CSP floor; a guard on headers that could pull in other code | A build that names no known release is only Build not verified (amber): one browser cannot show that others got something else |
| Old files, mixed builds, rollback | One manifest per page; the newest build seen per site | An older genuine build is allowed, as Older build (amber) |
| Code without a file (`eval`, `blob:`, inline handlers) | An enforced CSP floor; an in-page sensor | Such code cannot be hashed, only forbidden |
| Redirects and headers | Undeclared redirects and `Refresh` are cancelled, `Link` is stripped, content types are checked | — |
| A service worker | No protected app registers one; one that does, or controls a page, is Mismatch | What a worker answers from elsewhere runs; the tab is red until the site's data is cleared |
| An unverified page of the same site scripts a verified one | Server-rendered and unknown pages never run; pages that run unverified code make the site's other pages amber | Amber, not red |
| Payment scripts on Bitwarden billing pages | Blocked by the CSP floor; allowed for one page load after consent | On that page the script can read the vault ([guide](guide.md#paying-bitwarden)) |
| A server's own stylesheet | Accepted only if it hides stock elements, otherwise replaced | An accepted stylesheet can still hide stock elements |
| A replaced release file or a moved tag on GitHub | Pins on first sight; any change is Disputed (red) | A change before this browser first saw the release goes unnoticed |
| A phishing server serving genuine files | A look-alike warning when a server is added; official sites cannot be added | A site the user has not added is not protected |
| Hostile archives or server data aimed at the parsers | Digest checked before parsing; strict readers; no patterns built from server data | — |
| The maintainer, the repository, CI or the store is compromised | Signed tags, double build, provenance, daily store comparison ([below](#trust-in-the-verifier)) | A malicious change in the source passes every package check; only review catches it |
| Someone watching network requests | No project server; GitHub requests carry no site address, cookies or `Referer` | GitHub sees your network address and which releases you fetch ([privacy](privacy.md#network-requests)) |

## Assumptions and non-goals

IntactWarden assumes that TLS works; that Firefox enforces every CSP of a response, so an added one
can only tighten; that Firefox, the store and GitHub behave as documented; and that you look at the
toolbar icon.

It does not cover: whether the upstream source and its release build are benign (it proves "the
same as GitHub", not "GitHub is benign"); the vault's API data, which a malicious server can still
use against you; who runs a self-hosted server; other extensions; a compromised browser or device;
pages where IntactWarden does not run; and Bitwarden Send.

### Why Firefox only

Only Firefox lets an extension hold a response and read its bytes before the page gets them
(`webRequest.filterResponseData`). Chromium extensions cannot read response bodies, except through
`chrome.debugger`, which shows a "started debugging this browser" bar on every page. Reading the
cache afterwards is too late, because the code has already run. Safari's webRequest cannot block.

## Trust in the verifier

A malicious or broken IntactWarden release could read the vaults it protects, exactly like the
attack it is meant to stop. So it must need less trust than what it checks, and that trust must be
checkable by someone other than its maintainer.

**Least power.** No telemetry, analytics, crash reports or project server. Nothing fetched at run
time can add a site, loosen the CSP floor, allow a third party or soften a state; every fix is a new
release. IntactWarden checks code and documents, never API data; its in-page sensor reads page
structure, never form fields; stored addresses keep only the site and path. The package holds no
third-party code and is not minified, so the code you can read is the code that ships.

**Reproducible packages.** A release is built only from a tag on `main` signed by the maintainer's
release key, twice and byte-identical, with build provenance and `SHA256SUMS`
([release](release.md#ci)). Only that zip is submitted to AMO, and from version 1.0.1 a daily
workflow compares the package AMO serves with it.

**What you still trust:**

- **Firefox and the store** that delivered the package ([step 3](#check-it-yourself) catches another
  package).
- **The maintainer.** A reproducible build shows that a package equals its tagged source, not that
  the source is benign. There is no external audit, and Firefox installs updates automatically, so a
  malicious release could reach users before anyone has read it.
- **GitHub**, at the moment this browser first sees each vendor release.
- **The vendors' source and release builds.** No release is rebuilt from source.

## Permissions and network requests

[`extension/manifest.json`](../extension/manifest.json) declares desktop Firefox 153 or later and
`data_collection_permissions: none`. Every build is checked to request exactly these permissions
and to contain no third-party code, `eval`, remote scripts or source maps
(`extension/build/bundleLint.ts`).

| Permission | Used for |
|---|---|
| `webRequest`, `webRequestBlocking`, `webRequestFilterResponse` (and `.serviceWorkerScript`) | Holding and checking responses and their headers |
| `webNavigation` | Following pages and frames |
| `scripting` | The in-page sensor on servers you add |
| `storage` | Settings, servers, alerts, incidents, manifests |
| `notifications` | A notification for each new red state (can be turned off) |

Site access: `vault.bitwarden.com`, `vault.bitwarden.eu`, and the GitHub hosts that serve release
downloads and configuration files. Access to other sites is requested one site at a time, when you
add a server; Firefox's "Access your data for all websites" must stay off. Not requested: `tabs`,
`cookies`, `history`, `debugger`, `<all_urls>`.

Every network request follows a page that runs a release IntactWarden does not have, **Retry** on a
blocked page, or adding a server; nothing runs on a schedule. The full list, with what each request
reveals: [privacy policy](privacy.md#network-requests).

## Check it yourself

These checks show that a package was built from its tagged source and that the store gave you that
package; only reading the code catches a malicious change in the source. You need Node.js 22.18 or
newer, `git`, `gpg`, `sha256sum` and the GitHub CLI `gh`.

**1. Check the permissions.** In Extensions and Themes → IntactWarden → **Permissions and data**,
the site switches must be the six required hosts plus one per server you added, and "Access your
data for all websites" must be off.

**2. Check checksums and provenance** of the release files:

```sh
sha256sum --ignore-missing -c SHA256SUMS
gh attestation verify intactwarden-<version>-firefox.zip --repo phawrylak/IntactWarden \
  --signer-workflow phawrylak/IntactWarden/.github/workflows/release-extension.yml \
  --source-ref refs/tags/v<version>
```

**3. Compare the installed package with the release.** AMO re-signs every package; the tool ignores
only its signature files and compares every other file byte for byte. (In 1.0.0 only, AMO's
`manifest.json` differs too: AMO wrote the `ł` in the author's name as `\u0142` and dropped the
final newline. From 1.0.1 the release writes it that way itself.) The installed file is in the
profile folder (`about:support` → **Profile Folder**).

```sh
git clone https://github.com/phawrylak/IntactWarden && cd IntactWarden && npm ci --ignore-scripts
npm run verify-store-package -- --expected <path>/intactwarden-<version>-firefox.zip \
  --package <profile folder>/extensions/intactwarden@phawrylak.xpi --sha256sums <path>/SHA256SUMS
```

**4. Build it yourself.**

```sh
curl -fsS https://keys.openpgp.org/vks/v1/by-email/phawrylak%40outlook.com | gpg --import
git verify-tag v<version> && git checkout v<version>
npm ci --ignore-scripts && npm run build:ext && npm run package:ext
sha256sum extension/dist/intactwarden-<version>-firefox.zip
```

`git verify-tag` must report a good signature by the key also published at
`https://github.com/phawrylak.gpg`, and the hash must equal the release's `SHA256SUMS`.

**5. Read the code**, by hand or with an AI assistant, starting from this page, and ask how the
extension could leak data, accept tampered code or raise a false alarm.
`npm run recompute -- --help` rebuilds a manifest from a release file you downloaded; its sha256
must equal the one **Details** shows.

If something does not match, report it privately as [SECURITY.md](../SECURITY.md) describes.
