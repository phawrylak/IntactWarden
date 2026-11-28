/**
 * Origin alerts, incidents and "last seen" builds.
 *
 * - Origin alerts live in storage.local `l:v1:originAlerts`: a red state with evidence (MISMATCH,
 *   DISPUTED, PROTECTION_LOST where code nobody verified may have run) raises one; it stays open until the user
 *   acknowledges it, and while it is open no page of the origin is green (RECOVERING). A milder
 *   alert never replaces an open worse one.
 * - Incidents go to storage.local `l:v1:incidents`, one array (origin and path only, random id,
 *   TTL 90 days). The log is bounded: at most INCIDENT_CAP records survive a write, oldest first
 *   out, except one an open origin alert points to (its evidence must not be flushed by a flood
 *   of later incidents). Expired records are never listed and go with the next write.
 * - `l:v1:lastSeen` remembers the newest build seen per origin (ROLLBACK).
 * - A denial without evidence (a document denied where nothing ran and nothing points to an
 *   attack: an unknown or server-rendered page) is no incident: the record its blocked page reads
 *   lives in storage.session (memory), at most DENIAL_CAP of them, and is never listed.
 * - Private-browsing windows: their incidents, denials and alerts go to storage.session only
 *   (memory, never written to disk), the last-seen build is not recorded, and all of it is purged
 *   when the last private tab closes.
 *
 * All writes of the log are serialised here.
 */

import {rankOf} from '@intactwarden/core/verdict/states.ts';
import {
  INCIDENT_TTL_MS,
  LOCAL_KEYS,
  type IncidentRecord,
  type LastSeenEntry,
  type NewIncident,
  type Origin,
  type OriginAlert,
  type VerdictState,
} from '../contracts.ts';
import type {LocalStore, SessionStore} from '../platform/storage.ts';
import {compareVersions, randomHex} from './urls.ts';

/** Records kept in the incident log (the incidents page shows as many). */
export const INCIDENT_CAP = 200;

/** Denial records kept for the blocked pages that read them (newest first). */
export const DENIAL_CAP = 20;

const PRIVATE_ALERTS = 's:v1:private:alerts';
const PRIVATE_INCIDENTS = 's:v1:private:incidents';
const DENIALS = 's:v1:denials';
const PRIVATE_DENIALS = 's:v1:private:denials';

export class AlertBook {
  readonly #local: LocalStore;
  readonly #now: () => number;
  readonly #session: SessionStore;
  #alerts: Record<Origin, OriginAlert> = {};
  /** Alerts raised by private-window documents (storage.session only). */
  #private: Record<Origin, OriginAlert> = {};
  #lastSeen: Record<Origin, LastSeenEntry> = {};
  /** The last write of an incident log: each write reads the log, adds one record, writes it. */
  #writes: Promise<void> = Promise.resolve();

  constructor(local: LocalStore, now: () => number, session: SessionStore) {
    this.#local = local;
    this.#now = now;
    this.#session = session;
  }

  async load(): Promise<void> {
    const [alerts, lastSeen, priv] = await Promise.all([
      this.#local.get(LOCAL_KEYS.originAlerts as 'l:v1:originAlerts'),
      this.#local.get(LOCAL_KEYS.lastSeen as 'l:v1:lastSeen'),
      this.#session.get<Record<Origin, OriginAlert>>(PRIVATE_ALERTS),
    ]);
    this.#alerts = isRecord(alerts) ? {...(alerts as Record<Origin, OriginAlert>)} : {};
    this.#lastSeen = isRecord(lastSeen) ? {...(lastSeen as Record<Origin, LastSeenEntry>)} : {};
    this.#private = isRecord(priv) ? {...(priv as Record<Origin, OriginAlert>)} : {};
  }

  /** The origin's alert: the newer of the stored one and a private window's. */
  get(origin: Origin): OriginAlert | null {
    const a = this.#alerts[origin];
    const p = this.#private[origin];
    if (p === undefined) return a ?? null;
    if (a === undefined) return p;
    return p.at >= a.at ? p : a;
  }

  list(): OriginAlert[] {
    const origins = new Set([...Object.keys(this.#alerts), ...Object.keys(this.#private)]);
    return [...origins]
      .map(o => this.get(o))
      .filter((a): a is OriginAlert => a !== null)
      .sort((a, b) => b.at - a.at);
  }

  async #savePrivate(): Promise<void> {
    if (Object.keys(this.#private).length === 0) await this.#session.remove(PRIVATE_ALERTS);
    else await this.#session.set({[PRIVATE_ALERTS]: this.#private});
  }

  /**
   * The last private tab closed: forget everything private windows left. Returns the origins
   * whose private-window alert went (their open documents are evaluated again).
   */
  async purgePrivate(): Promise<Origin[]> {
    const origins = Object.keys(this.#private);
    this.#private = {};
    await this.#session.remove([PRIVATE_ALERTS, PRIVATE_INCIDENTS, PRIVATE_DENIALS]);
    return origins;
  }

  /** Opens an origin alert, unless an open one of the same or a worse state stays as it is. */
  async raise(
    origin: Origin,
    state: VerdictState,
    reasons: readonly string[],
    incidentId: string,
    privateWindow = false,
  ): Promise<void> {
    const prev = (privateWindow ? this.get(origin) : this.#alerts[origin]) ?? undefined;
    if (prev !== undefined && !prev.acknowledged && rankOf(prev.state) >= rankOf(state)) return;
    const alert: OriginAlert = {
      origin,
      at: this.#now(),
      state,
      reasons: [...reasons].slice(0, 20),
      incident_id: incidentId,
      acknowledged: false,
    };
    if (privateWindow) {
      this.#private = {...this.#private, [origin]: alert};
      await this.#savePrivate();
      return;
    }
    this.#alerts = {...this.#alerts, [origin]: alert};
    await this.#local.set(LOCAL_KEYS.originAlerts as 'l:v1:originAlerts', this.#alerts);
  }

  /** Closes the origin's alert (the user read the recovery steps). */
  async acknowledge(origin: Origin): Promise<OriginAlert | null> {
    const shown = this.get(origin);
    if (shown === null) return null;
    await this.#update(origin, a => ({...a, acknowledged: true}));
    return this.get(origin);
  }

  async #update(origin: Origin, f: (a: OriginAlert) => OriginAlert): Promise<void> {
    const stored = this.#alerts[origin];
    if (stored !== undefined) {
      this.#alerts = {...this.#alerts, [origin]: f(stored)};
      await this.#local.set(LOCAL_KEYS.originAlerts as 'l:v1:originAlerts', this.#alerts);
    }
    const priv = this.#private[origin];
    if (priv !== undefined) {
      this.#private = {...this.#private, [origin]: f(priv)};
      await this.#savePrivate();
    }
  }

  /** Records an incident and returns its id (a private window's goes to storage.session). */
  async incident(n: NewIncident, privateWindow = false, id = randomHex(8)): Promise<string> {
    const record: IncidentRecord = {
      ...n,
      reasons: [...n.reasons].slice(0, 20),
      id,
      at: this.#now(),
    };
    const write = this.#writes.then(async () => {
      const kept = this.#bounded([record, ...(await this.#log(privateWindow))], id);
      if (privateWindow) await this.#session.set({[PRIVATE_INCIDENTS]: kept});
      else await this.#local.set(LOCAL_KEYS.incidents as 'l:v1:incidents', kept);
    });
    // Storage unavailable: the alert still carries the id; the log entry is lost.
    this.#writes = write.catch(() => undefined);
    await this.#writes;
    return id;
  }

  async #log(priv: boolean): Promise<IncidentRecord[]> {
    const v = priv
      ? await this.#session.get<unknown>(PRIVATE_INCIDENTS)
      : await this.#local.get(LOCAL_KEYS.incidents as 'l:v1:incidents');
    // storage.local is reachable from content scripts: keep only well-formed records.
    return Array.isArray(v) ? (v as unknown[]).filter(isIncident) : [];
  }

  /**
   * The log a write keeps: records younger than INCIDENT_TTL_MS, newest first, at most
   * INCIDENT_CAP, plus any an open origin alert points to (a stored or a private-window alert,
   * also one a newer alert of the other kind hides in list()) and `keep`, the record just written,
   * which an alert may be about to point to whatever the clock says.
   */
  #bounded(records: readonly IncidentRecord[], keep: string): IncidentRecord[] {
    const now = this.#now();
    const open = new Set(
      [...Object.values(this.#alerts), ...Object.values(this.#private)].flatMap(a =>
        a.acknowledged ? [] : [a.incident_id],
      ),
    );
    open.add(keep);
    return records
      .filter(r => r.id === keep || now - r.at < INCIDENT_TTL_MS)
      .sort((a, b) => b.at - a.at)
      .filter((r, i) => i < INCIDENT_CAP || open.has(r.id));
  }

  async #all(): Promise<IncidentRecord[]> {
    const logs = await Promise.all([
      this.#log(false).catch((): IncidentRecord[] => []),
      this.#log(true).catch((): IncidentRecord[] => []),
    ]);
    return logs.flat();
  }

  async getIncident(id: string): Promise<IncidentRecord | null> {
    return (await this.#all()).find(r => r.id === id) ?? null;
  }

  /**
   * Records the denial of a document where nothing ran and nothing points to an attack, for its
   * blocked page only: it is no incident (the log does not list it) and raises nothing.
   */
  async denial(n: NewIncident, privateWindow = false, id = randomHex(8)): Promise<string> {
    const record: IncidentRecord = {
      ...n,
      reasons: [...n.reasons].slice(0, 20),
      id,
      at: this.#now(),
    };
    const key = privateWindow ? PRIVATE_DENIALS : DENIALS;
    const write = this.#writes.then(async () => {
      const v = await this.#session.get<unknown>(key);
      const kept = [record, ...(Array.isArray(v) ? (v as unknown[]).filter(isIncident) : [])];
      await this.#session.set({[key]: kept.slice(0, DENIAL_CAP)});
    });
    this.#writes = write.catch(() => undefined);
    await this.#writes;
    return id;
  }

  /** The record a blocked page shows: an incident, or a denial without evidence. */
  async getBlocked(id: string): Promise<IncidentRecord | null> {
    const incident = await this.getIncident(id);
    if (incident !== null) return incident;
    for (const key of [DENIALS, PRIVATE_DENIALS]) {
      const v = await this.#session.get<unknown>(key).catch(() => undefined);
      const hit = Array.isArray(v)
        ? (v as unknown[]).filter(isIncident).find(r => r.id === id)
        : null;
      if (hit !== undefined && hit !== null) return hit;
    }
    return null;
  }

  async listIncidents(limit: number): Promise<IncidentRecord[]> {
    const now = this.#now();
    return (await this.#all())
      .filter(r => now - r.at < INCIDENT_TTL_MS)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(0, Math.min(limit, 500)));
  }

  /** Whether `version` is older than the newest build this origin served before (ROLLBACK). */
  isRollback(origin: Origin, version: string): boolean {
    const seen = this.#lastSeen[origin];
    return seen !== undefined && compareVersions(version, seen.version) < 0;
  }

  async noteSeen(origin: Origin, buildId: string, version: string): Promise<void> {
    const seen = this.#lastSeen[origin];
    if (seen !== undefined && compareVersions(version, seen.version) < 0) return;
    if (seen !== undefined && seen.buildId === buildId) return;
    this.#lastSeen = {...this.#lastSeen, [origin]: {buildId, version, at: this.#now()}};
    await this.#local.set(LOCAL_KEYS.lastSeen as 'l:v1:lastSeen', this.#lastSeen);
  }
}

function isRecord(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIncident(v: unknown): v is IncidentRecord {
  if (!isRecord(v)) return false;
  const r = v as Partial<IncidentRecord>;
  return typeof r.id === 'string' && typeof r.at === 'number' && Array.isArray(r.reasons);
}
