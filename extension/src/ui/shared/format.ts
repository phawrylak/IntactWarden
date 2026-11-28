/**
 * Locale-aware formatting and safe data helpers for the UI
 *: local times through Intl.DateTimeFormat,
 * numbers through Intl.NumberFormat, hash prefixes, and GitHub links that are
 * built only from validated pieces (never from a URL found in storage as is).
 */

import {currentLang, type Lang} from '../../i18n/t.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** "owner/repo" with GitHub's allowed characters. */
const REPO_SLUG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** A release tag as the bundled profiles produce it ("web-v2026.10.1", "v2026.10.1"). */
const TAG = /^[A-Za-z0-9._-]{1,100}$/;

function dtf(lang: Lang, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(lang, options);
}

function validTime(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
}

/** "03:47" in local time. */
export function formatTime(ms: number, lang: Lang = currentLang()): string {
  if (!validTime(ms)) return '—';
  return dtf(lang, {hour: '2-digit', minute: '2-digit'}).format(ms);
}

/** Local date, e.g. "6 Nov 2026" / "6 lis 2026". */
export function formatDate(ms: number, lang: Lang = currentLang()): string {
  if (!validTime(ms)) return '—';
  return dtf(lang, {dateStyle: 'medium'}).format(ms);
}

export function formatDateTime(ms: number, lang: Lang = currentLang()): string {
  if (!validTime(ms)) return '—';
  return dtf(lang, {dateStyle: 'medium', timeStyle: 'short'}).format(ms);
}

/** Bytes as kB / MB with one decimal (decimal units, as GitHub lists asset sizes). */
export function formatBytes(n: number, lang: Lang = currentLang()): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  const [value, unit] =
    n >= 1_000_000 ? [n / 1_000_000, 'megabyte'] : n >= 1000 ? [n / 1000, 'kilobyte'] : [n, 'byte'];
  return new Intl.NumberFormat(lang, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(value);
}

/** The whole sha256 when it is one (64 hex digits), else "—". */
export function fullHash(sha256: string | null | undefined): string {
  return typeof sha256 === 'string' && HEX64.test(sha256) ? sha256 : '—';
}

/** The first `n` digits of a sha256 and "…" (where space is short: show the whole in a tooltip). */
export function hexPrefix(sha256: string | null | undefined, n = 12): string {
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return '—';
  return `${sha256.slice(0, n)}…`;
}

/**
 * "owner/repo" from a repository URL "https://github.com/<owner>/<repo>"
 * (BindingView.repo) or a bare slug; null if it is anything else.
 */
export function repoSlug(repo: string | null | undefined): string | null {
  if (typeof repo !== 'string') return null;
  const prefix = 'https://github.com/';
  const slug = repo.startsWith(prefix) ? repo.slice(prefix.length) : repo;
  return REPO_SLUG.test(slug) ? slug : null;
}

/** https://github.com/<slug>/releases/tag/<tag>, or null when a piece does not validate. */
export function releaseUrl(
  repo: string | null | undefined,
  tag: string | null | undefined,
): string | null {
  const slug = repoSlug(repo);
  if (slug === null || typeof tag !== 'string' || !TAG.test(tag)) return null;
  return `https://github.com/${slug}/releases/tag/${tag}`;
}

/** https://github.com/<slug>/commit/<sha>, or null. */
export function commitUrl(
  repo: string | null | undefined,
  commit: string | null | undefined,
): string | null {
  const slug = repoSlug(repo);
  if (slug === null || typeof commit !== 'string' || !HEX40.test(commit)) return null;
  return `https://github.com/${slug}/commit/${commit}`;
}

/** "bitwarden/clients web-v2026.10.1", or null. */
export function releaseName(
  repo: string | null | undefined,
  tag: string | null | undefined,
): string | null {
  const slug = repoSlug(repo);
  if (slug === null || typeof tag !== 'string' || !TAG.test(tag)) return null;
  return `${slug} ${tag}`;
}

/** True for an "x.y.z" version (the only form a hint or a binding carries). */
export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value);
}
