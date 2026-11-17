/**
 * Links to the user documentation (docs/ in the repository, in English).
 * They are plain external links: the pages open on GitHub in a new tab
 * (`link()` adds `target="_blank"` and `rel="noopener noreferrer"`), and the
 * extension never fetches, embeds or runs anything from them.
 */

/** Where the user documentation is published (the default branch on GitHub). */
export const USER_DOCS_BASE = 'https://github.com/phawrylak/IntactWarden/blob/main/docs/';

/** Each linked page: a file in docs/, with the heading anchor when it is one section. */
export const USER_DOCS = {
  guide: 'guide.md',
  privacy: 'privacy.md',
  'not-proven': 'guide.md#what-intactwarden-does-not-prove',
  'check-it-yourself': 'security.md#check-it-yourself',
  'own-server': 'guide.md#your-own-server',
} as const;

/** The linked pages. */
export type UserDocPage = keyof typeof USER_DOCS;

/** The URL of a page, e.g. "privacy" → …/docs/privacy.md. */
export function userDocUrl(page: UserDocPage): string {
  return `${USER_DOCS_BASE}${USER_DOCS[page]}`;
}
