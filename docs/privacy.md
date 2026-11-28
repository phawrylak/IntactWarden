# IntactWarden privacy policy

**Effective date:** 2026-11-28. Applies to IntactWarden 1.0.1 and later.

## In short

- IntactWarden collects no data about you: no telemetry, analytics, crash reports, accounts or
  server of its own. In the add-on store's terms it declares `data_collection_permissions: none`.
- What it stores stays in your browser. It sends your vault data, passwords, the pages you visit and
  the addresses of your servers to no one. It shows no ads and sells or shares nothing.
- It does not read your vault. It hashes the web vault's code and documents (HTML, scripts, WASM,
  styles, fonts, the release's data files), never the vault's API responses. Its in-page sensor
  looks at the page's structure (elements and their attributes, such as script addresses), never at
  the contents of form fields or what you type. It loads no code from the network and fetches
  nothing from IntactWarden's repository.

## Network requests

These are the only requests IntactWarden makes itself. None carries cookies or credentials.

| Destination | What and why | When |
|---|---|---|
| A protected site (`vault.bitwarden.com`, `vault.bitwarden.eu`, a server you added) | Its version file (`/version.json`, or `/vw-version.json` on Vaultwarden), only to choose which release to check | When the site runs a build IntactWarden does not have; at most once a minute per site while IntactWarden's background page stays loaded |
| A server you add | `api/config` at the address you typed, to tell Bitwarden from Vaultwarden | Once, when you add it |
| GitHub: `api.github.com`, `release-assets.githubusercontent.com`, `raw.githubusercontent.com` | Deep verify: the release's metadata and file digest, the commit of its tag, the release file (about 40–50 MB) and, for the Bitwarden cloud, three configuration files at that commit | When a site runs a release IntactWarden does not have, and when you choose **Retry** on a page blocked as Build not verified ([how to refuse](#your-choices)) |

Nothing is requested on a schedule or at start-up. After a temporary failure IntactWarden retries
only while a page that needs the release is open, or when it is loaded again
([guide](guide.md#when-a-page-is-blocked)). GitHub requests carry no site address and are the same
for every cloud user of a release, in both regions, and for every self-hoster of it, but GitHub sees
your network address and which release you need; its privacy statement applies. On requests to
`raw.githubusercontent.com` Firefox adds an `Origin` header with the extension's random
`moz-extension://` address: it names no site, but links those requests to one installation.

## What is stored on your device

| What | Kept |
|---|---|
| Settings, and the servers you added (address, vault path, app, date added) | Until you change or remove them |
| Alerts per site (state, time) | Until you acknowledge one; it is then kept, closed, until a new alert for that site replaces it |
| The incident log (what happened, site and path, time, hashes of the file involved) | 90 days (older entries are hidden, and deleted when the next entry is written), at most the newest 200 entries plus any an open alert points to |
| The newest build seen per site; the file digests GitHub listed the first time this browser saw a release; failed and disputed releases | Until you remove IntactWarden |
| Manifests (expected hashes) built in your browser | Until you remove IntactWarden, or an update changes the code that builds them |
| The last 50 deep verifications, and when GitHub's request limit ends | Replaced by newer entries |
| The state of open tabs and pages | In memory; cleared when Firefox closes |

Every address IntactWarden stores, logs or shows is cut to the site and path (no query string,
fragment, user name or password). In private windows, alerts and incidents stay in memory until the
last private window closes, and no newest build is recorded. A release first met there is deep
verified and stored like any other: its manifest, its digests and an entry in the list of deep
verifications (app, version, cloud region or self-hosted, time; no site address).

## Permissions

IntactWarden needs access to `vault.bitwarden.com`, `vault.bitwarden.eu`, `api.github.com` and
`release-assets.githubusercontent.com`, where a release download starts and ends
(`raw.githubusercontent.com` needs no permission), and asks for each server you add, one at a time.
It uses `webRequest` and response filtering to hold, hash and check the responses of protected
sites; `webNavigation` to know when pages and frames change; `scripting` to run its in-page sensor
on servers you add; `storage` for the data above; and `notifications` for red states. Firefox also
reports to it requests to those two GitHub hosts and page loads in every tab: it lets them pass
unchanged and keeps no address of a site it does not protect. It never asks for **Access your data
for all websites** (leave that switch off), the `history`, `tabs` or `cookies` permissions, or the
clipboard. Full list: [security model](security.md#permissions-and-network-requests).

## Your choices

- To refuse GitHub requests, revoke IntactWarden's access to `api.github.com` or
  `release-assets.githubusercontent.com` (Extensions and Themes → IntactWarden → **Permissions and
  data**). Without either, IntactWarden sends no request to any GitHub host. Pages of a release
  IntactWarden does not have are then blocked ([user guide](guide.md#when-a-page-is-blocked)); the
  setup page opens at each Firefox start and the icon shows a red "!" badge, until you grant the
  access again.
- Do not allow IntactWarden in private windows if you do not want it to run there.
- Remove a server to delete its record and IntactWarden's access to it. Its alert, incident-log
  entries and newest build stay as the table above says. Remove IntactWarden to delete all its data.

## Contact and changes

Questions: open an issue at `https://github.com/phawrylak/IntactWarden/issues`. Security problems:
report them privately as [SECURITY.md](../SECURITY.md) describes. Every endpoint is listed here
before a version that contacts it is released ([release checklist](release.md#release-checklist)),
and changes to this policy are listed here with the date they take effect.

- 2026-11-28, version 1.0.1: release files are downloaded through `api.github.com`, so `github.com`
  and `objects.githubusercontent.com` are no longer contacted. IntactWarden needs access to two
  GitHub hosts instead of four: `api.github.com` and `release-assets.githubusercontent.com`.
  Firefox now adds the `Origin` header to requests to `raw.githubusercontent.com` instead of
  `api.github.com`.
