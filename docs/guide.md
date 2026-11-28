# IntactWarden user guide

For people who use IntactWarden with a Bitwarden or Vaultwarden web vault or run their own server.
What it stores and sends: [privacy policy](privacy.md).

## Install and set up

IntactWarden runs only in desktop Firefox 153 or newer ([why](security.md#why-firefox-only)).
Install it from [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/intactwarden/).
Bitwarden Secrets Manager is part of the web vault and checked with it. The interface is Polish if
Firefox is, otherwise English.

The setup page opens after installation, and again if required access goes missing (IntactWarden
icon → **Settings** → **Setup checklist**):

- **Site access** to the Bitwarden cloud and to GitHub. Firefox grants it at installation; while any
  of it is missing, the icon shows a red "!" badge. Choose **Grant access**.
- **Private windows.** IntactWarden runs there only if you allow it (Extensions and Themes →
  IntactWarden → "Run in Private Windows").
- **Pin the icon** (extensions button → gear next to IntactWarden → "Pin to Toolbar"). Only the
  toolbar icon counts: a page can fake anything it draws, so IntactWarden never shows "verified"
  inside one.
- **Reload vault tabs** that were open before, with Ctrl+Shift+R (Cmd+Shift+R on macOS).

The first visit to a vault, and the first after each vault release, is blocked as **New build**
while your browser fetches the release from GitHub ([deep verify](#new-releases-and-deep-verify)).

### Updates

Firefox installs new versions of IntactWarden automatically. To read each version before it runs,
open Extensions and Themes → IntactWarden and set "Allow automatic updates" to **Off**, then install
updates yourself (gear menu → "Check for Updates"). New Bitwarden and Vaultwarden releases are still
checked without an update, but fixes to IntactWarden reach you only when you install them.

## The toolbar icon

| Icon | State of the current tab |
|---|---|
| Green shield with a check mark | **Verified**: every file the page loaded matches its GitHub release and was checked before the page could use it |
| Amber shield with a dash | Not proven, but no sign of an attack; treat the vault as unverified ([amber states](#amber-not-proven)) |
| Amber shield with a spinner | **New build**: being checked against GitHub |
| Red shield with "!" | **Mismatch** or **Disputed**: a sign of an attack |
| Red outline with "!" | **Protection lost**: IntactWarden could not check this page |
| Grey shield with a spinner | Files are still being checked |
| Grey outline | **Not covered**: a page your server generates, such as `/admin`. Always blocked |
| Dark shield with a keyhole | **Not protected**: IntactWarden does not protect this site, or the tab shows a [blocked page](#when-a-page-is-blocked) |

A red number on the icon counts open [alerts](#alerts-and-recovery). The popup says why the tab is in
its state and where the code comes from. **Details** lists every file with its expected and observed
hash; **Copy redacted report** copies that list without the part of each address after `?` or `#`.

### Amber: not proven

| State | Meaning | What to do |
|---|---|---|
| New build | The site runs a release IntactWarden does not have yet; your browser is fetching it from GitHub | Wait; the page reloads by itself |
| Build not verified | No GitHub release explains the build: it is unpublished, custom or cannot be downloaded. On the Bitwarden cloud it can be a release not yet on GitHub, which IntactWarden cannot tell apart from a build served only to you | Blocked, with **Retry** and **Proceed once** ([blocked pages](#when-a-page-is-blocked)) |
| Unverified page on this site | Another open page of the site runs code nobody verified, and could control this tab | Close that page and any tab it opened, then reload |
| Third-party code | The page wants a payment script that no release contains | See [paying Bitwarden](#paying-bitwarden) |
| Server stylesheet not accepted | A Vaultwarden server's own stylesheet does more than hide standard elements; it is replaced with an empty one | Ask the admin ([generated pages](#pages-your-server-generates)) |
| Older build | Older than the newest build this browser has seen on the site; allowed | Usually a cache that is behind; on your own server, upgrade |
| Recovering | The page matches its release, but an alert for the site is still open | Work through the [recovery checklist](#alerts-and-recovery) |

### Red: evidence of an attack, or no check

| State | Meaning | What to do |
|---|---|---|
| Mismatch | Code on this page differs from its GitHub release, or the server did something the release never does (extra code, a redirect). The popup names the cause | **Do not type secrets.** Follow the [recovery checklist](#alerts-and-recovery) |
| Disputed | GitHub now shows another checksum or tag for this release than the one this browser recorded | **Do not type secrets.** Please [report it](#troubleshooting-and-reporting) |
| Protection lost | IntactWarden could not check this page: a file could not be checked in time, site access was removed, or IntactWarden restarted | Reload with Ctrl+Shift+R and grant access if asked |

## When a page is blocked

A blocked page never ran. It shows the state, the address and the hashes, with **Go back** and
**Retry**.

- **Mismatch, Disputed, Protection lost:** no way past other than turning IntactWarden off.
- **Build not verified:** if fetching the release failed, **Retry** asks GitHub again and loads the
  page once the release is checked. Otherwise tick the confirmation and choose **Proceed once**: it
  loads exactly this page once, in this tab, and logs it. A modified server looks the same as an
  unpublished build, so proceed only if you trust whoever runs the server.
- **New build:** the page shows the download and reloads by itself. If that fails for 10 minutes,
  it becomes Build not verified.
- **Not covered:** always blocked ([generated pages](#pages-your-server-generates)).

A payment script or a rejected server stylesheet is blocked on its own; the page keeps working.

## Alerts and recovery

An **alert** means IntactWarden saw signs of an attack on a site, or that unchecked code may have
run there. It stays until you acknowledge it, and until then no page of the site is green. Each
alert shows a Firefox notification (you can turn them off in the settings).

Open **Alerts and incidents** (**Recovery checklist** in the popup or on the blocked page) and:

1. Check that the address is the server you expect.
2. If a service worker was reported, clear the site's data (shield left of the address bar →
   **Clear cookies and site data**) and log in again. Until you do, the site stays red.
3. Log out all other sessions.
4. Change your master password if you typed it while the page was red.
5. Review your account's recent devices and emergency-access settings.

Then choose **Acknowledge**. The incident log keeps addresses cut to site and path, for 90 days, in
this browser only.

## New releases and deep verify

IntactWarden compares each file with a list of expected hashes, the **manifest**, built from the
GitHub release. The first visit to a vault release downloads that release from GitHub once
(40–50 MB) and your browser builds the manifest from it: this is **deep verify**. Later visits use
the stored manifest. Nothing from the vault's server goes into a manifest. What goes to GitHub, and
how to refuse it: [privacy policy](privacy.md#network-requests).

## Paying Bitwarden

The Bitwarden cloud's billing pages load payment scripts from Stripe, Braintree and PayPal. No
release contains them, so IntactWarden blocks them and the payment forms stay empty.

- **Recommended: Add credit.** Billing page → **Account credit** → **Add credit** → **PayPal** or
  **Bitcoin**. Neither runs a script in the vault page, and Bitwarden applies the credit to your next
  payment.
- **A card or PayPal payment method** needs Stripe or Braintree. Click the toolbar icon, choose
  **Allow Stripe for one page load…** (or Braintree, PayPal), read the consent text and choose
  **Allow Stripe and reload**. On that page the script can read your vault. Reload when you have
  paid; the script is blocked again. A private window (log in, pay, log out) is safest, if
  IntactWarden may run there.

## Your own server

In the settings under **Your servers**, type the address, with the vault's path if it is not at the
root (`https://vault.example.org`, `https://example.org/vault/`), and choose **Add server**. Firefox
asks for access to that one site, and IntactWarden asks the server once whether it is Bitwarden or
Vaultwarden.

- **Use `https://`.** Plain `http://` is accepted only on this computer (`localhost`).
- **Include the sub-path.** Vaultwarden serves everything below the path of its `DOMAIN` setting.
- An address that looks like an official one needs a confirmation; IntactWarden never adds a server
  from a link or a page.

Tabs opened before you added the server show Protection lost until a forced reload.

### Which builds verify

- **Bitwarden self-hosted** (official images, Bitwarden lite): verified against the
  `bitwarden/clients` release `web-v<version>`.
- **Vaultwarden**: verified against `bw_web_v<version>.tar.gz` of the `dani-garcia/bw_web_builds`
  release. A release published only as a container image is Build not verified.
- **A build from source** (built, forked or patched) is never green: Build not verified, or Mismatch
  if it names a published release, because it then looks exactly like a tampered copy.
- **Distribution packages** that ship the upstream release file (Alpine, FreeBSD) should verify;
  those that rebuild it (Arch Linux, NixOS) do not. For green, point `WEB_VAULT_FOLDER` at the
  unpacked upstream `bw_web_v<version>.tar.gz`.

### Reverse proxies

IntactWarden compares the bytes Firefox receives after decoding. TLS termination, HTTP/2,
compression, chunked transfer, caching and most header changes are fine (nginx, Apache httpd,
HAProxy and Caddy were tested). Anything that changes a file of the release gives Mismatch, even
your own change: body rewriting (`sub_filter`, `mod_substitute`), injected banners or analytics,
minifiers, CDN page rewriting, a wrong `Content-Type`, a `Refresh` header, or a redirect to another
site. Check the toolbar icon after any proxy or CDN change. A vault framed by another site is not
checked and does not load; open it in its own tab.

### Pages your server generates

**Admin and sign-in pages** (`/admin`, Vaultwarden's `/vw_static/`, self-hosted Bitwarden's `/sso/`
and `/identity/`, Vaultwarden's SSO sign-in pages) are always blocked: they are in no release and would run next to the vault. To use
one, open it in a private window where IntactWarden does not run, or in a Firefox profile without
it.

**`/css/vaultwarden.css`** is accepted only if it just hides standard elements, such as "Create
account" when sign-ups are off (**Details** lists them).

**Other pages on the same host name** (outside the vault's path, error pages) are blocked. Serve
other sites from another host name.

## What IntactWarden does not prove

Green means only that the page's files match its GitHub release. It does not cover malicious code in
the release itself, the vault's API data a malicious server sends, code you let through (**Proceed
once**, an allowed payment script or stylesheet), other extensions, a compromised device, look-alike
sites, pages where IntactWarden does not run, Bitwarden Send, or what other people were served.
More: [security model](security.md).

## Troubleshooting and reporting

| Problem | What to do |
|---|---|
| A "!" badge on every site | Site access was revoked: **Setup checklist** → **Grant access** |
| New build does not go away | GitHub cannot be reached, or its limit of 60 requests an hour per network address is used up. After 10 minutes the page becomes Build not verified, with **Retry**. **Settings** → **Deep verify and trust data** shows the limit |
| Build not verified on a site that verified before | The new release may not be on GitHub yet. Choose **Retry** later rather than **Proceed once** |
| Protection lost after an update, or after two very quick reloads | Reload once more |
| Mismatch for one file right after you pressed **Stop** | A stopped load can cut a file short. Reload; if Mismatch returns, treat it as an attack |
| Mismatch or Protection lost after a proxy change | See [reverse proxies](#reverse-proxies) |
| A vault feature stops working with IntactWarden on | Please open an issue |

- **Security vulnerabilities**, above all anything that shows Verified while unverified code runs:
  report them privately as [SECURITY.md](../SECURITY.md) describes.
- **Other bugs and false alarms:** open an issue at `https://github.com/phawrylak/IntactWarden/issues`
  with the Firefox version, the state shown and expected, and the **Copy redacted report** text.
  Issues are public: replace your server's address before you post.
