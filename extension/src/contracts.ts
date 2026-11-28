/**
 * Shared contracts of the IntactWarden extension: every module of extension/src imports its
 * cross-module types, storage keys and messages from here. Rules:
 *
 * - Types plus a few frozen constants and tiny pure helpers; no I/O.
 * - Every URL in these types is a RedactedUrl (core/privacy/redactUrl: scheme, host, port and path
 *   only). No query, fragment or userinfo is ever stored, logged or messaged.
 * - Hashes are lowercase 64-hex sha256 (rule R9).
 * - State names, ranks, icons and actions come from the verdict lattice in @intactwarden/core
 *; nothing here redefines them.
 * - Messages carry JSON-serialisable values only (they are persisted and compared as JSON): no
 *   Uint8Array, Map, Set or class instance.
 * - Desktop Firefox only: one backend (webRequest.filterResponseData), which hashes every protected
 *   response before the page can use it.
 */

import type {
  AssetPlan,
  BuildRefusal,
  BuilderApp,
  BuilderVariant,
} from '@intactwarden/builders/api.ts';
import type {FileIndex} from '@intactwarden/core/routing/fileIndex.ts';
import type {RouteResult} from '@intactwarden/core/routing/mapUrl.ts';
import type {CoreManifest} from '@intactwarden/core/schema/manifest.ts';
import type {
  AppDeployment,
  AppProfile,
  ResourceType,
  ServerRenderedClass,
  ServerStyle,
  ThirdPartyKind,
} from '@intactwarden/core/schema/profile.ts';
import type {Assurance, VerdictFlag, VerdictState} from '@intactwarden/core/verdict/states.ts';

export type {AssetPlan, Assurance, BuildRefusal, CoreManifest, VerdictFlag, VerdictState};

// ===========================================================================
// 1. Identifiers and scalars

/** Bundled app profiles. */
export type AppId = BuilderApp;
/** Profile variants of those apps. */
export type VariantId = BuilderVariant;
/** A core's build_id: "<app>@<x.y.z>+<variant>". */
export type BuildId = string;
/** Lowercase 64-hex sha256. */
export type Sha256Hex = string;
/** Output of redactUrl(): "scheme://host[:port]/path" (or "scheme:" for opaque URLs). */
export type RedactedUrl = string;
/** Exact origin serialisation, e.g. "https://vault.bitwarden.com" or "http://127.0.0.1:8080". */
export type Origin = string;
/** Document key: "<tabId>:<frameId>:<navSeq>". */
export type DocKey = string;
/** webRequest requestId. */
export type RequestId = string;
/** Milliseconds since the Unix epoch, local clock. */
export type EpochMs = number;
export type Unsubscribe = () => void;

/**
 * Status of a build as far as this browser knows: 'disputed' when GitHub now contradicts the local
 * pin of its release (policy/evaluate.ts votes DISPUTED `pin-changed`).
 */
export type BuildStatus = 'current' | 'disputed';

/** A release of one app variant. */
export interface ReleaseKey {
  readonly app: AppId;
  readonly variant: VariantId;
  /** "x.y.z". */
  readonly version: string;
}

/** "<app>@<version>+<variant>", the build_id the builders produce for a key. */
export function buildIdOf(key: ReleaseKey): BuildId {
  return `${key.app}@${key.version}+${key.variant}`;
}

// ===========================================================================
// 2. Settings (storage.local `l:v1:settings`)

export interface Settings {
  readonly v: 1;
  /** Browser notification on every new red state (default on; needs the permission). */
  readonly notifications: boolean;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  v: 1,
  notifications: true,
}) as Settings;

/** A partial update of Settings. */
export interface SettingsPatch {
  readonly notifications?: boolean;
}

// ===========================================================================
// 3. Deployments: profiles, self-hosted instances

/** storage.local `l:v1:instances` entries. */
export interface InstanceRecord {
  /** Random 16 lowercase hex. */
  readonly id: string;
  /** vaultwarden-web when the server's `api/config` names itself Vaultwarden, else bitwarden-web. */
  readonly app: AppId;
  /** https, or http on this computer (loopback). */
  readonly origin: Origin;
  /** "/" or "/<segments>/" (ends with "/"), as the user typed it. */
  readonly base_path: string;
  readonly added_at: EpochMs;
}

/** One origin IntactWarden protects: an official cloud origin or a granted instance. */
export interface ProtectedOrigin {
  readonly origin: Origin;
  readonly app: AppId;
  readonly profile: AppProfile;
  readonly deployment: AppDeployment;
  /** Deployment or instance base path. */
  readonly basePath: string;
  readonly kind: 'official' | 'instance';
  readonly instance: InstanceRecord | null;
  /** Whether the host permission is currently granted (revocation gives PROTECTION_LOST permission-revoked). */
  readonly granted: boolean;
}

export interface ProtectedOrigins {
  readonly origins: readonly ProtectedOrigin[];
}

export interface PermissionStatus {
  readonly pattern: string;
  readonly origin: Origin;
  readonly purpose: 'official' | 'instance' | 'deep-verify';
  readonly required: boolean;
  readonly granted: boolean;
}

/** Server-asserted version from the profile's hint endpoint (`/version.json`, `/vw-version.json`). */
export interface HintResult {
  /** "x.y.z", or null when absent, malformed, not x.y.z or unreachable (a hint is never a verdict). */
  readonly version: string | null;
  readonly at: EpochMs;
}

export type AddInstanceRefusal =
  | 'invalid-input'
  | 'refused-official-origin'
  /** http other than this computer (loopback). */
  | 'http-not-loopback'
  /** A look-alike host the user did not confirm as their own server. */
  | 'lookalike-unconfirmed'
  | 'permission-denied'
  | 'unreachable'
  /** `{base}api/config` is not the JSON a Bitwarden or Vaultwarden server answers. */
  | 'no-server'
  | 'duplicate-instance';

export interface AddInstanceRequest {
  /** What the user typed: origin and base path. */
  readonly input: string;
  /** The user confirmed that a look-alike host is their own server. */
  readonly lookalikeConfirmed: boolean;
}

export type AddInstanceResult =
  | {readonly ok: true; readonly instance: InstanceRecord}
  | {readonly ok: false; readonly code: AddInstanceRefusal};

/**
 * Official origins (from @intactwarden/profiles) plus granted instances.
 * The engine and the backend only read it.
 */
export interface ProfileRegistry {
  ready(): Promise<void>;
  /** Exact origin serialisation → protected origin, or null (also for a revoked permission: see `granted`). */
  lookup(origin: Origin): ProtectedOrigin | null;
  protectedOrigins(): ProtectedOrigins;
  instances(): readonly InstanceRecord[];
  /**
   * Parses the typed address, checks the refusal list, the look-alike confirmation and the host
   * permission (requested by the options page inside the click handler), asks `{base}api/config`
   * which app the server runs (one credential-less GET), then persists and announces the instance.
   */
  addInstance(request: AddInstanceRequest): Promise<AddInstanceResult>;
  removeInstance(id: string): Promise<void>;
  /** Fetches the profile's hint endpoint for a protected origin (≤ 1 request per origin per minute). */
  fetchHint(origin: ProtectedOrigin): Promise<HintResult>;
  permissionStatus(): Promise<readonly PermissionStatus[]>;
  onChange(listener: (origins: ProtectedOrigins) => void): Unsubscribe;
}

// ===========================================================================
// 4. Trust: local deep verify, pins, bundled cores of test packages

/**
 * Where a core came from. Never 'vendor': no core is ever built from vendor-served bytes.
 * 'bundled' only in test packages: the shipping package bundles no cores.
 */
export type CoreSource = 'bundled' | 'deep-verify';

export interface CoreRef {
  readonly buildId: BuildId;
  readonly app: AppId;
  readonly variant: VariantId;
  readonly version: string;
  readonly assurance: Assurance;
  /** Content address of the core's JCS bytes. */
  readonly sha256: Sha256Hex;
  readonly size: number;
  readonly source: CoreSource;
  readonly addedAt: EpochMs;
  readonly status: BuildStatus;
}

/** A core ready for matching. */
export interface LoadedCore {
  readonly ref: CoreRef;
  readonly core: CoreManifest;
  /** fileIndexOf(core.files), built once per load. */
  readonly fileIndex: FileIndex;
}

export interface CandidateQuery {
  readonly app: AppId;
  /** The deployment's variant. */
  readonly variant: VariantId;
  /** Server-asserted version, if known; it only orders candidates. */
  readonly hintVersion?: string | null;
}

/** Why a release could not be made known. */
export type ReleaseFailure =
  /** No such tag or release in the profile's upstream repository. */
  | 'release-not-found'
  /** The release exists but lacks the asset the profile names. */
  | 'asset-not-found'
  /** Vaultwarden: the release has no tarball (published as a container image only). */
  | 'image-only-release'
  /** GitHub lists no sha256 digest for the asset, so the download cannot be checked. */
  | 'digest-unavailable'
  /** The downloaded bytes do not hash to GitHub's listed digest. */
  | 'digest-mismatch'
  /** The builder refused the asset (see `detail`). */
  | 'build-refused'
  /** GitHub now reports a different digest, size, tag commit or tag object than the pin. */
  | 'disputed'
  /** Transient: network error or timeout. */
  | 'network'
  /** Transient: GitHub rate limit; retry after `retryAt`. */
  | 'rate-limited'
  /** A GitHub host permission is missing. */
  | 'permission-missing'
  /**
   * The deep-verify budget is spent: this origin (or all origins together) already started deep
   * verifies of too many other releases in the last 24 hours. A server's version hint cannot
   * make the extension download and build releases without bound.
   */
  | 'limit-reached';

export type DisputeReason = 'pin-changed' | 'tag-moved';

/** Why a release failed in detail: a builder refusal. */
export type ReleaseDetail = BuildRefusal;

export type ReleaseState =
  | {readonly k: 'unknown'}
  | {readonly k: 'known'; readonly refs: readonly CoreRef[]}
  | {
      readonly k: 'working';
      readonly jobId: string;
      readonly phase: JobPhase;
      readonly since: EpochMs;
    }
  | {
      readonly k: 'failed';
      readonly failure: ReleaseFailure;
      readonly transient: boolean;
      readonly at: EpochMs;
      readonly retryAt: EpochMs | null;
      readonly detail?: ReleaseDetail;
    }
  | {
      readonly k: 'disputed';
      readonly reason: DisputeReason;
      readonly at: EpochMs;
      readonly evidence?: DisputeEvidence;
    };

/**
 * What GitHub contradicted: the value this browser recorded in the pin and the one GitHub reports
 * now (the asset sha256 for `pin-changed`; for `tag-moved` the tag commit, or with the same
 * commit the tag object). Shown on the blocked
 * page of a denied document and on the details page of one that stays open.
 */
export interface DisputeEvidence {
  readonly recorded: string;
  readonly observed: string;
}

export interface EnsureReleaseRequest {
  readonly key: ReleaseKey;
  readonly trigger: 'unknown-build' | 'user';
}

export type EnsureReleaseOutcome =
  | {readonly ok: true; readonly refs: readonly CoreRef[]}
  | {
      readonly ok: false;
      readonly failure: ReleaseFailure;
      readonly transient: boolean;
      readonly retryAt: EpochMs | null;
      readonly dispute?: DisputeReason;
      readonly detail?: ReleaseDetail;
    };

export type JobPhase =
  'queued' | 'resolving' | 'downloading' | 'verifying' | 'building' | 'storing' | 'done' | 'failed';

/** What the deep-verify job (in the background event page) executes; resolved by the store first. */
export interface ReleaseJobSpec {
  readonly jobId: string;
  readonly plan: AssetPlan;
  readonly commit: string;
  readonly tagObject?: string;
  /**
   * Downloaded from api.github.com/repositories/<repoId>/releases/assets/<id>, which redirects to
   * release-assets.
   */
  readonly asset: {
    /** GitHub's numeric asset id. */
    readonly id: number;
    readonly name: string;
    /** GitHub's listed digest (already compared with the local pin, if any). */
    readonly sha256: Sha256Hex;
    readonly size: number;
  };
  /** Config files at `commit` (raw.githubusercontent.com), with their pinned digest when one exists. */
  readonly configs: readonly {readonly path: string; readonly sha256?: Sha256Hex}[];
}

export type ReleaseJobResult =
  | {
      readonly ok: true;
      /** The built core's exact bytes; the store checks them before it writes them to IndexedDB. */
      readonly core: {readonly sha256: Sha256Hex; readonly bytes: Uint8Array};
      /** Digests of the config files used, for local pins. */
      readonly configs: readonly {readonly path: string; readonly sha256: Sha256Hex}[];
    }
  | {readonly ok: false; readonly failure: ReleaseFailure; readonly detail?: BuildRefusal};

export interface DeepVerifyJobView {
  readonly jobId: string;
  readonly app: AppId;
  readonly version: string;
  readonly assetName: string;
  readonly variant: VariantId;
  readonly trigger: 'unknown-build' | 'user';
  readonly phase: JobPhase;
  readonly bytes?: number;
  readonly total?: number;
  readonly startedAt: EpochMs;
  readonly finishedAt?: EpochMs;
  readonly failure?: ReleaseFailure;
  readonly detail?: ReleaseDetail;
}

/** A release-asset pin: what this browser (or a test package) saw on GitHub for a release asset. */
export interface ReleaseAssetPin {
  readonly kind: 'release-asset';
  readonly repo: string;
  readonly tag: string;
  readonly tag_commit: string;
  readonly tag_object?: string;
  readonly asset: string;
  readonly sha256: Sha256Hex;
  readonly size: number;
  /** bundled: data of a test package; local: first seen by this browser (TOFU). */
  readonly source: 'bundled' | 'local';
}

/** Config file content at a commit (cloud derivation input). */
export interface ConfigFilePin {
  readonly kind: 'config-file';
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
  readonly sha256: Sha256Hex;
  readonly source: 'bundled' | 'local';
}

export type LocalPin = ReleaseAssetPin | ConfigFilePin;

/**
 * storage.local `l:v1:pins` (local pins) and the bundled `pins` of a test
 * package's bootstrap index. A local storage layout, not an interchange format.
 * Bundled pins win; a local pin is never replaced, only disputed.
 */
export interface LocalPins {
  readonly schema: 'intactwarden.localpins/1';
  readonly pins: readonly LocalPin[];
}

/**
 * Bundled bootstrap data of a test package: `data/bootstrap/index.json` (generated by
 * extension/build/bootstrap.ts, loaded by trust/bootstrap.ts). The shipping package has none.
 */
export interface BootstrapIndex {
  readonly schema: 'intactwarden.bootstrap/1';
  /** The corpus lock files the data was generated from, with their sha256. */
  readonly generated_from: readonly {readonly lock: string; readonly sha256: Sha256Hex}[];
  readonly cores: readonly {
    readonly app: AppId;
    readonly variant: VariantId;
    readonly version: string;
    readonly build_id: BuildId;
    readonly assurance: Assurance;
    readonly sha256: Sha256Hex;
    readonly size: number;
    /** Package path of the core's exact JCS bytes, "data/bootstrap/cores/<sha256>.json". */
    readonly path: string;
  }[];
  readonly pins: LocalPins;
}

export const BOOTSTRAP_INDEX_PATH = 'data/bootstrap/index.json';

export interface TrustSnapshot {
  readonly ready: boolean;
  /**
   * R5: false means the trust store failed to start (PROTECTION_LOST internal-error). Having no
   * core is normal: deep verify builds each release.
   */
  readonly loaded: boolean;
  /** GitHub rate-limit back-off, if active. */
  readonly githubBackoffUntil: EpochMs | null;
}

/**
 * The local trust store: cores built in this browser from GitHub release assets with the same
 * builders as `npm run recompute`, and the bundled cores of a test package.
 */
export interface TrustStore {
  ready(): Promise<TrustSnapshot>;
  snapshot(): TrustSnapshot;
  /** Candidate cores in selection order: version-hint match first, then newest version. */
  candidates(query: CandidateQuery): Promise<readonly LoadedCore[]>;
  getCoreBySha256(sha256: Sha256Hex): Promise<LoadedCore | null>;
  releaseState(key: ReleaseKey): ReleaseState;
  /**
   * Makes a release known: resolve on GitHub (release, asset digest, tag →
   * commit), check against pins (TOFU), download, verify the digest, build
   * with the CoreBuilder, store. Concurrent calls for one release (build id)
   * share one job; a job builds the one variant asked for.
   */
  ensureRelease(request: EnsureReleaseRequest): Promise<EnsureReleaseOutcome>;
  onReleaseKnown(listener: (refs: readonly CoreRef[]) => void): Unsubscribe;
  onReleaseDisputed(listener: (key: ReleaseKey, reason: DisputeReason) => void): Unsubscribe;
  listCores(): Promise<readonly CoreRef[]>;
  listJobs(): Promise<readonly DeepVerifyJobView[]>;
  pins(): Promise<LocalPins>;
}

// ===========================================================================
// 5. Backend and observations

/** webRequest types (profile ResourceType plus the ones only webRequest reports; others map to 'other'). */
export type ResType =
  | ResourceType
  | 'csp_report'
  | 'beacon'
  | 'imageset'
  | 'web_manifest'
  | 'speculative'
  | 'xslt'
  | 'xml_dtd'
  | 'object_subrequest'
  | 'webtransport';

/** Item-level reasons a response could not be verified. Closed list. */
export type UnverifiableReason =
  | 'empty-body'
  /** A service worker answered the request (no StreamFilter possible). */
  | 'sw-served'
  | 'no-host-permission'
  | 'timeout'
  | 'filter-failed'
  /**
   * A subresource whose document was still unbound after the 5-s wait, or whose document's own
   * bytes were never judged (adopted at hello, empty or unverifiable body), so it can never bind.
   */
  | 'unbound'
  /** A persisted filter this instance did not close (restart). */
  | 'verifier-restarted'
  /** Body larger than the buffering budget. */
  | 'too-large'
  | 'internal-error';

/** Lowercased header name and value. */
export type HeaderPair = readonly [name: string, value: string];

export type DomEvent =
  | 'inline-script'
  | 'inline-handler'
  | 'sw-register'
  | 'blob-frame'
  | 'data-frame'
  | 'srcdoc'
  | 'base-element'
  | 'object-element'
  | 'javascript-url'
  /**
   * A `<script src>` of another origin in a protected document (`detail.url`, redacted): how
   * third-party code is seen, since the extension has no host permission for third-party hosts
   * and webRequest never reports their requests.
   */
  | 'third-party-script';

/** Detail of a DOM sensor hit: counts and redacted locations only, never page content. */
export interface DomDetail {
  readonly count: number;
  /** Attribute name for inline handlers ("onclick"), element name otherwise. */
  readonly what?: string;
  readonly url?: RedactedUrl;
}

/** The evidence about one response body. */
export interface BodyEvidence {
  readonly sha256: Sha256Hex;
  readonly size: number;
  /**
   * The bytes, held in the background while the response is buffered (and,
   * for unbound documents, retained in memory for retro-verification). Never
   * persisted or messaged. Absent after a restart.
   */
  readonly bytes?: Uint8Array;
}

export interface DocStartObs {
  readonly k: 'doc-start';
  readonly at: EpochMs;
  readonly doc: DocKey;
  readonly tab: number;
  readonly frame: number;
  readonly parentDoc: DocKey | null;
  readonly req: RequestId | null;
  readonly url: RedactedUrl;
  readonly type: 'main_frame' | 'sub_frame';
  /** A private-browsing window: nothing about the document outlives the private session. */
  readonly incognito?: boolean;
}

export interface RequestObs {
  readonly k: 'request';
  readonly at: EpochMs;
  readonly req: RequestId;
  /** The document this request belongs to; null when it cannot be attributed (R2). */
  readonly doc: DocKey | null;
  readonly tab: number;
  readonly frame: number;
  readonly url: RedactedUrl;
  readonly type: ResType;
}

/** A response's status and headers, for the header guard (ObservationSink.headers). */
export interface HeadersObs {
  readonly req: RequestId;
  readonly status: number;
  readonly headers: readonly HeaderPair[];
}

/** Firefox followed a redirect of the request (the next hop reuses its request id). */
export interface RedirectObs {
  readonly k: 'redirect';
  readonly req: RequestId;
}

export interface BodyObs extends BodyEvidence {
  readonly k: 'body';
  readonly req: RequestId;
  /** The request's URL: a body the engine has no request record of is judged by it (R1). */
  readonly url: RedactedUrl;
  /**
   * A subresource whose frame, or a frame above it, started a navigation after the request began:
   * its document is being replaced. Firefox cuts such a response off and can still report its
   * request completed, so the bytes may be only a prefix of what the server sent
   * (e2e vw-reload-cuts-response).
   */
  readonly leaving?: boolean;
}

export interface CompletedObs {
  readonly k: 'completed';
  readonly req: RequestId;
  readonly status: number;
}

export interface UnverifiableObs {
  readonly k: 'unverifiable';
  readonly req: RequestId;
  /** As BodyObs.url. */
  readonly url: RedactedUrl;
  readonly reason: UnverifiableReason;
  /**
   * The response goes on to the page unverified: its StreamFilter failed after it held it
   * (onerror), or a service worker answered it. False when the backend withheld it (the request
   * was cancelled, or the filter closed with nothing written): nothing of it ran.
   */
  readonly delivered: boolean;
}

/**
 * A document the backend had ended renders after all: its commit arrived after its load was
 * reported failed or superseded (DocKeys.commit `revived`). Its session, and its taint, come back.
 */
export interface RevivedObs {
  readonly k: 'revived';
  readonly doc: DocKey;
}

/**
 * The frame shows this document now: webNavigation.onCommitted reported its load, or a request
 * or content script of it named it before that commit arrived. From here on what reached it runs.
 */
export interface CommittedObs {
  readonly k: 'committed';
  readonly doc: DocKey;
}

/** The document ended: its frame committed another document, its load failed or was redirected. */
export interface DocEndObs {
  readonly k: 'doc-end';
  readonly doc: DocKey;
}

/**
 * A document opened a new tab or window (webNavigation.onCreatedNavigationTarget). The opener can
 * script what it opened, including an `about:blank` window no request ever names, so a taint source
 * that opens a window keeps tainting its origin until that window closes.
 */
export interface OpenedObs {
  readonly k: 'opened';
  readonly sourceTab: number;
  /** The opener's DocKey, when the backend knows it. */
  readonly sourceDoc: DocKey | null;
  readonly tab: number;
}

/**
 * A frame committed a `blob:` document of a protected origin (webNavigation.onCommitted). It has
 * the origin of the document that created it and can script that origin's windows, but no request
 * and no content script ever names it, so it is never a session: its tab taints the origin until
 * the tab closes, as a window a taint source opened does.
 */
export interface BlobDocObs {
  readonly k: 'blob-doc';
  readonly tab: number;
  readonly origin: Origin;
}

/**
 * A frame committed a document of a registered origin that the backend saw no load of. Either its
 * host permission is missing (webNavigation.onCommitted needs none): webRequest never reported its
 * load, so it ran unchecked (docs/security.md: a revoked permission is visible). Or the frame is
 * the tab's top-level one and no request preceded the commit (a page restored from the
 * back/forward cache). The backend allocated its DocKey; the engine gives it a session in
 * PROTECTION_LOST (`permission-revoked` or `untracked`), a taint source until it ends.
 */
export interface UnwatchedDocObs {
  readonly k: 'unwatched-doc';
  readonly doc: DocKey;
  readonly tab: number;
  readonly frame: number;
  readonly url: RedactedUrl;
}

/**
 * `verifier-restarted`: a filter the previous background instance never closed (R7).
 * `internal-error`: a blocking backend handler threw (R1); for the request's document, else for
 * every live document of its origin.
 */
export interface EngineFaultObs {
  readonly k: 'engine-fault';
  readonly fault: 'verifier-restarted' | 'internal-error';
  readonly doc?: DocKey;
  readonly origin?: Origin;
}

export type Observation =
  | DocStartObs
  | RequestObs
  | RedirectObs
  | BodyObs
  | CompletedObs
  | UnverifiableObs
  | RevivedObs
  | CommittedObs
  | DocEndObs
  | OpenedObs
  | BlobDocObs
  | UnwatchedDocObs
  | EngineFaultObs;

/** What the backend does with a response before any byte reaches the page. */
export type Decision =
  | {readonly act: 'allow'}
  | {
      readonly act: 'block';
      readonly state: VerdictState;
      readonly reason: string | null;
      /** A blocked top-level document is replaced by `blocked.html#<incidentId>`. */
      readonly incidentId?: string;
    };

/** Header decision for the blocking onHeadersReceived listener. */
export interface HeaderDecision {
  readonly act: 'allow' | 'cancel';
  /** Full replacement header list (floor appended, Link/Speculation-Rules removed, no-store rewrite). */
  readonly responseHeaders?: readonly HeaderPair[];
}

export interface ObservationSink {
  /** Every observation goes here; the backend awaits the decision. Never throws (R1 inside). */
  push(observation: Observation): Promise<Decision>;
  /** The header guard for one response, before any byte is released. */
  headers(observation: HeadersObs, request: RequestObs): Promise<HeaderDecision>;
}

/** Per-tab user allowances (storage.session `s:v1:allow:<tab>`). */
export interface TabAllowances {
  readonly tab: number;
  /**
   * A payment script the user allowed for ONE page load: the next top-level document
   * of `origin` in this tab takes it (DocumentSessionRecord.allowedThirdParty) if its headers come
   * before `until`; then the grant is gone.
   */
  readonly thirdPartyGrant: {
    readonly id: string;
    readonly origin: Origin;
    readonly until: EpochMs;
  } | null;
  /** Server-stylesheet paths. */
  readonly serverStyles: readonly string[];
  /** "Proceed once" document sha256 values (logged as incidents). */
  readonly proceedOnce: readonly Sha256Hex[];
}

/** Navigate a tab to the blocked page of an incident (`blocked.html#<incidentId>`). */
export interface BackendCommand {
  readonly k: 'show-page';
  readonly tab: number;
  readonly incidentId: string;
}

/**
 * The Firefox backend: reports
 * observations and applies decisions; it never decides a state. It reads the
 * protected origins when it needs them (registry.lookup), so it holds no copy
 * that could be stale.
 */
export interface Backend {
  start(sink: ObservationSink): Promise<void>;
  command(command: BackendCommand): Promise<void>;
}

// ===========================================================================
// 6. Document sessions, tab state, alerts (the engine writes, the UI reads)

/** A document's binding to exactly one core (one manifest per document). */
export interface Binding {
  readonly buildId: BuildId;
  readonly app: AppId;
  readonly variant: VariantId;
  readonly version: string;
  readonly assurance: Assurance;
  readonly coreSha256: Sha256Hex;
  readonly source: CoreSource;
  /** Manifest key the document matched. */
  readonly key: string;
  readonly slots: Readonly<Record<string, string>>;
  readonly boundAt: EpochMs;
  /** Bound after the fact (flag RETRO). */
  readonly retro: boolean;
}

export type DocClass =
  | 'pending'
  | 'manifest'
  | 'server-rendered'
  | 'not-covered'
  | 'dynamic-document'
  /** A navigation outside the document paths of the manifest (an unknown document). */
  | 'unknown';

/** Origin-taint source classes (CO_RESIDENT_UNVERIFIED reasons). */
export type TaintClass =
  /** A document allowed to run a payment script nobody can verify. */
  'third-party-code' | 'released-mismatch' | 'unverifiable';

export type ItemClass =
  | 'document'
  | 'script'
  | 'style'
  | 'wasm'
  | 'font'
  | 'data'
  | 'image'
  | 'media'
  | 'sourcemap'
  | 'server-style'
  | 'dynamic'
  | 'third-party'
  | 'unknown';

export type MismatchReason =
  'bytes' | 'header' | 'unknown-path' | 'release-differs' | 'inline-code' | 'service-worker';

export type ItemOutcome =
  | {readonly r: 'ok'; readonly how: 'exact' | 'template' | 'style-accepted'}
  | {readonly r: 'mismatch'; readonly reason: MismatchReason}
  | {
      readonly r: 'unverifiable';
      readonly reason: UnverifiableReason;
      /**
       * Present when the response went on to the page unverified (UnverifiableObs.delivered):
       * code nobody verified may have run. Absent when it was withheld.
       */
      readonly delivered?: true;
    }
  | {
      readonly r: 'third-party';
      readonly id: string;
      readonly host: string;
      readonly kind: ThirdPartyKind;
      readonly allowed: boolean;
    }
  | {readonly r: 'style-rejected'; readonly reason: 'custom-rules' | 'malformed'}
  /** Unlisted passive file or dynamic data: counted only. */
  | {readonly r: 'passive'}
  /** A 404 subresource with a server-rendered body (never executed). */
  | {readonly r: 'non-executing'}
  /** The document is unbound: the hash is kept for retro-verification. */
  | {readonly r: 'recorded'};

export interface ItemRecord {
  readonly req: RequestId | null;
  /** Normalised path on the protected origin, or the redacted URL of a cross-origin item. */
  readonly path: string;
  readonly url: RedactedUrl;
  readonly type: ResType;
  readonly cls: ItemClass;
  /** Manifest key it mapped to (with slots), null if none. */
  readonly key: string | null;
  readonly sha256?: Sha256Hex;
  readonly size?: number;
  /** Expected exact hash, 'template' for a template entry, or null. */
  readonly expected?: Sha256Hex | 'template' | null;
  readonly outcome: ItemOutcome;
  /**
   * Recorded items of an unbound document: the response status and Content-Type, so that
   * retro-verification of exact entries survives an event-page restart (the other evidence is in
   * memory only).
   */
  readonly status?: number;
  readonly ctype?: string;
  readonly at: EpochMs;
}

export interface ServerStyleRecord {
  readonly sha256: Sha256Hex;
  readonly accepted: boolean;
  /** Selectors an accepted stylesheet hides (≤ 50). */
  readonly hidden: readonly string[];
  readonly reason?: 'custom-rules' | 'malformed';
}

/**
 * What evidence says about code nobody verified in a document: `ran` when
 * such code may have run there (a response that went on to the page unverified, an open filter a
 * restarted instance did not close, a content sensor's report), which raises the origin alert;
 * `unchecked` when IntactWarden can no longer vouch for what the document runs (its host permission
 * is missing, a request no document owns, an engine fault), which makes a verified document a taint
 * source but raises no alert. A response IntactWarden denied is neither: nothing of it ran.
 */
export type UnverifiedCode = 'ran' | 'unchecked';

/** One piece of evidence's vote. */
export interface Contribution {
  readonly state: VerdictState;
  readonly reason: string | null;
  /** Set only on evidence about code nobody verified (absent for a denied response). */
  readonly unverifiedCode?: UnverifiedCode;
}

/** Unknown-build resolution decision (policy/unknownBuild.ts). */
export type UnknownBuildDecision =
  /** Fetch the hint endpoint first. */
  | {readonly k: 'fetch-hint'; readonly contribution: Contribution}
  /** Ask the trust store to build this release; NEW_BUILD (catching-up) meanwhile. */
  | {
      readonly k: 'ensure';
      readonly key: ReleaseKey;
      readonly contribution: Contribution;
    }
  /** Nothing to do now; re-check at `retryAt` (NEW_BUILD catching-up or unavailable). */
  | {readonly k: 'wait'; readonly retryAt: EpochMs | null; readonly contribution: Contribution}
  /**
   * Final for this document: MISMATCH(release-differs), BUILD_UNVERIFIED(reason) or DISPUTED(reason).
   * `ensure`: past the give-up time, a transient failure's retry is due; deep verify of this
   * release starts in the background and the decision stays final.
   */
  | {readonly k: 'final'; readonly contribution: Contribution; readonly ensure?: ReleaseKey};

export interface UnknownBuildRecord {
  readonly since: EpochMs;
  readonly sha256: Sha256Hex;
  readonly size: number;
  readonly hint: HintResult | null;
  readonly attempts: readonly {
    readonly key: ReleaseKey;
    readonly state: ReleaseState['k'];
    readonly failure?: ReleaseFailure;
    readonly at: EpochMs;
  }[];
  readonly decision: UnknownBuildDecision | null;
}

/** storage.session `s:v1:doc:<docKey>`. Bounded: see limits below. */
export interface DocumentSessionRecord {
  readonly v: 1;
  readonly doc: DocKey;
  readonly tab: number;
  readonly frame: number;
  readonly parentDoc: DocKey | null;
  readonly topLevel: boolean;
  readonly origin: Origin;
  readonly path: string;
  readonly app: AppId;
  readonly deploymentId: string;
  /** In a private-browsing window: incidents and alerts stay in memory. */
  readonly incognito?: boolean;
  readonly startedAt: EpochMs;
  readonly endedAt: EpochMs | null;
  readonly alive: boolean;
  readonly docClass: DocClass;
  /** server-rendered class, not-covered reason or unknown-path detail. */
  readonly docClassDetail: string | null;
  readonly docSha256: Sha256Hex | null;
  readonly docVerified: boolean;
  readonly binding: Binding | null;
  readonly unknownBuild: UnknownBuildRecord | null;
  /** By path; at most SESSION_LIMITS.items, overflow sets `overflow`. */
  readonly items: Readonly<Record<string, ItemRecord>>;
  /** Requests still waiting for a result; at most SESSION_LIMITS.pending (overflow ⇒ PROTECTION_LOST unverifiable-active). */
  readonly pending: Readonly<
    Record<RequestId, {readonly path: string; readonly type: ResType; readonly since: EpochMs}>
  >;
  readonly overflow: boolean;
  readonly serverStyles: Readonly<Record<string, ServerStyleRecord>>;
  readonly sensors: readonly {
    readonly event: DomEvent;
    readonly count: number;
    readonly at: EpochMs;
  }[];
  /** PROTECTION_LOST reason caused by the engine, if any. */
  readonly engineFault: string | null;
  /**
   * The strongest evidence about code nobody verified seen in the document's lifetime (`ran` over
   * `unchecked`; sticky, as the state is under R6): `ran` meets the origin alert's condition, either
   * makes a verified document a taint source. Null when everything not verified was denied.
   */
  readonly unverifiedCode: UnverifiedCode | null;
  /**
   * The document's own filter failed (its bytes are no longer held) before its load was seen to
   * commit. Nothing of it runs unless it commits: the commit makes it a filter failure on a shown
   * document, an event-page restart before then counts it as run (verifier-restarted), and a load
   * that never commits ends with it unused.
   */
  readonly uncommittedFailure: ItemRecord | null;
  /** R2: observation for an unknown document. */
  readonly untracked: boolean;
  readonly coResident: {
    readonly class: TaintClass;
    readonly since: EpochMs;
    readonly sourcePath: string;
  } | null;
  readonly blocked: boolean;
  /**
   * The payment script this document may run: its CSP floor admits the vendor, so
   * the document is THIRD_PARTY_CODE and an origin-taint source for as long as it lives.
   */
  readonly allowedThirdParty: {readonly id: string; readonly host: string} | null;
  readonly state: VerdictState;
  readonly reasons: readonly string[];
  readonly flags: readonly VerdictFlag[];
  /** Highest state reached in this document's lifetime (R6, with its exceptions). */
  readonly peakState: VerdictState;
  /**
   * The incident logged for this document and the `kind:state` it was logged for: persisted, so an
   * event-page restart does not log the same document again.
   */
  readonly incidentId: string | null;
  readonly incidentState: string | null;
}

export const SESSION_LIMITS = Object.freeze({
  items: 2000,
  pending: 500,
  reasons: 20,
  hiddenSelectors: 50,
  sensors: 32,
  /** Wait for a document binding before a subresource is PROTECTION_LOST (unbound). */
  unboundWaitMs: 5000,
  /** How long a payment-script grant waits for the reload that uses it. */
  thirdPartyGrantMs: 60_000,
});

/**
 * R4: how long a request may stay pending, transfer included, before it is
 * `unverifiable:timeout`: 5 min for scripts and fetches (workers, lazy chunks of up to 18 MB
 * from servers that do not compress them), else 30 s.
 */
export function r4Ms(type: ResType): number {
  return type === 'script' || type === 'xmlhttprequest' ? 300_000 : 30_000;
}

/**
 * storage.local `l:v1:originAlerts[origin]`: raised by a red state with
 * evidence; open until acknowledged.
 */
export interface OriginAlert {
  readonly origin: Origin;
  readonly at: EpochMs;
  readonly state: VerdictState;
  readonly reasons: readonly string[];
  readonly incident_id: string;
  readonly acknowledged: boolean;
}

export interface Count {
  readonly ok: number;
  readonly total: number;
}

export interface CoverageCounts {
  readonly document: Count;
  readonly scripts: Count;
  readonly wasm: Count;
  readonly styles: Count;
  readonly data: Count;
  readonly fonts: Count;
  readonly unverifiable: number;
  /** Third-party ids seen. */
  readonly thirdParty: readonly string[];
}

export interface BindingView {
  readonly buildId: BuildId;
  readonly app: AppId;
  readonly variant: VariantId;
  readonly version: string;
  readonly assurance: Assurance;
  readonly source: CoreSource;
  /** "https://github.com/<owner>/<repo>". */
  readonly repo: string;
  readonly tag: string;
  readonly commit: string;
  readonly artifactSha256: Sha256Hex | null;
  readonly retroAt: EpochMs | null;
}

export interface DocSummary {
  readonly doc: DocKey;
  readonly frame: number;
  readonly path: string;
  readonly docClass: DocClass;
  readonly state: VerdictState;
  readonly reasons: readonly string[];
  readonly flags: readonly VerdictFlag[];
  readonly counts: CoverageCounts;
  readonly binding: BindingView | null;
  readonly serverStyle: {
    readonly path: string;
    readonly accepted: boolean;
    readonly hiddenCount: number;
    readonly reason?: string;
  } | null;
  readonly coResident: {readonly class: TaintClass; readonly sourcePath: string} | null;
  /** Payment scripts the floor kept out of this document (ids); the popup offers one page each. */
  readonly thirdPartyBlocked: readonly string[];
}

/** storage.session `s:v1:tab:<tabId>`: everything the popup and the icon show (R10). */
export interface TabStateRecord {
  readonly v: 1;
  readonly tab: number;
  readonly updatedAt: EpochMs;
  readonly origin: Origin | null;
  readonly app: AppId | null;
  readonly deploymentId: string | null;
  readonly kind: 'official' | 'instance' | null;
  readonly instance: {readonly added_at: EpochMs} | null;
  /** Tab state: highest-ranked state of the tab's live sessions. */
  readonly state: VerdictState;
  readonly reasons: readonly string[];
  readonly flags: readonly VerdictFlag[];
  readonly top: DocSummary | null;
  readonly frames: readonly DocSummary[];
  /** Server-asserted version when no build is bound (labelled "server-asserted"). */
  readonly hint: HintResult | null;
  readonly unknownBuild: {
    readonly phase: 'hint' | 'deep-verify' | 'final';
    readonly jobId: string | null;
    readonly failure: ReleaseFailure | null;
  } | null;
  readonly alert: OriginAlert | null;
  readonly incidentId: string | null;
  readonly allowances: TabAllowances | null;
  readonly permissionMissing: boolean;
}

export interface DetailsView {
  readonly tab: number;
  readonly origin: Origin;
  readonly docs: readonly {
    readonly summary: DocSummary;
    readonly items: readonly ItemRecord[];
    readonly serverStyles: Readonly<Record<string, ServerStyleRecord>>;
    readonly coreSha256: Sha256Hex | null;
    /** The bound release's dispute, when GitHub contradicts its pin. */
    readonly dispute: Extract<ReleaseState, {k: 'disputed'}> | null;
  }[];
}

/** How long an incident record is kept. */
export const INCIDENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** storage.local `l:v1:incidents` records (origin and path only; TTL 90 days, at most 200). */
export type IncidentKind =
  | 'mismatch'
  | 'protection-lost'
  | 'build-unverified'
  | 'release-disputed'
  | 'deep-verify-failed'
  | 'proceed-once';

export interface IncidentRecord {
  /** Random 16 lowercase hex. */
  readonly id: string;
  readonly at: EpochMs;
  readonly kind: IncidentKind;
  readonly origin: Origin;
  readonly path: string;
  readonly state: VerdictState | null;
  readonly reasons: readonly string[];
  readonly buildId: BuildId | null;
  readonly expected: Sha256Hex | null;
  readonly observed: Sha256Hex | null;
}

/** What a caller logs; the incident log adds the id and the time. */
export type NewIncident = Omit<IncidentRecord, 'id' | 'at'>;

export interface BlockedView {
  readonly incidentId: string;
  readonly origin: Origin;
  readonly path: string;
  readonly state: VerdictState;
  readonly reasons: readonly string[];
  readonly expected: Sha256Hex | null;
  readonly observed: Sha256Hex | null;
  /** BUILD_UNVERIFIED and other rows with `proceed_once`. */
  readonly canProceedOnce: boolean;
  /** NEW_BUILD: the page shows the deep verify, polls and reloads once the build is known. */
  readonly retry: boolean;
  /**
   * NEW_BUILD: the page reloads now, whatever `job` says. The release the denied document named
   * is known or disputed by now, or that document is gone, so only a new load decides.
   */
  readonly reload?: boolean;
  /**
   * BUILD_UNVERIFIED: the release the denied document named, whose deep verify failed or is
   * retried in the background. "Retry" asks GitHub for it again (UI_DEEP_VERIFY) before it loads
   * the page.
   */
  readonly release?: ReleaseKey;
  /** DISPUTED: the pinned value this browser recorded and the one GitHub reports now. */
  readonly dispute: DisputeEvidence | null;
  /**
   * NEW_BUILD: the deep verify of the release the denied document named, while it runs, else one
   * that finished at or after the incident.
   */
  readonly job: DeepVerifyJobView | null;
}

/** The engine: the ObservationSink plus what the router and main.ts call. */
export interface Engine extends ObservationSink {
  start(): Promise<void>;
  releaseKnown(refs: readonly CoreRef[]): Promise<void>;
  releaseDisputed(key: ReleaseKey, reason: DisputeReason): Promise<void>;
  originsChanged(origins: ProtectedOrigins): Promise<void>;
  tabState(tab: number): Promise<TabStateRecord | null>;
  details(tab: number): Promise<DetailsView | null>;
  blockedView(incidentId: string): Promise<BlockedView | null>;
  acknowledgeAlert(origin: Origin): Promise<OriginAlert | null>;
  allowForTab(tab: number, allowance: AllowanceRequest): Promise<void>;
}

export type AllowanceRequest =
  | {readonly k: 'third-party'; readonly id: string}
  | {readonly k: 'server-style'; readonly path: string}
  | {readonly k: 'proceed-once'; readonly sha256: Sha256Hex};

// ===========================================================================
// 7. Pure policy kernel (extension/src/policy, lint-enforced pure)

/** How a same-origin URL is served, before routing. */
export type ServerPathClass =
  | {readonly k: 'server-style'; readonly style: ServerStyle}
  | {readonly k: 'dynamic'}
  | {readonly k: 'not-covered'; readonly reason: string}
  | {readonly k: 'server-rendered'; readonly class: ServerRenderedClass}
  | {readonly k: 'build'}
  | {readonly k: 'cross-origin'}
  | {readonly k: 'outside-base'};

export interface BindInput {
  readonly origin: ProtectedOrigin;
  readonly url: RedactedUrl;
  readonly status: number;
  readonly body: BodyEvidence;
  readonly candidates: readonly LoadedCore[];
  readonly now: EpochMs;
}

export type BindResult =
  | {readonly k: 'bound'; readonly core: LoadedCore; readonly binding: Binding}
  | {
      readonly k: 'unbound';
      /** Per candidate, why it did not bind (for Details and tests). */
      readonly tried: readonly {
        readonly buildId: BuildId;
        readonly route: RouteResult['kind'];
        /** The document path is a manifest path of this core and the bytes differ there. */
        readonly differsAtManifestPath: boolean;
      }[];
    }
  /**
   * Not a document of any candidate and not at a document path (a path outside the manifest, a 404
   * that is not the build's not-found document, an error page): an unknown document.
   */
  | {readonly k: 'invalid'; readonly reason: string};

export interface VerifyItemInput {
  readonly origin: ProtectedOrigin;
  readonly core: LoadedCore;
  readonly binding: Binding;
  readonly request: RequestObs;
  readonly status: number;
  readonly headers: readonly HeaderPair[];
  readonly body: BodyEvidence | null;
  /** The third party allowed for the document (DocumentSessionRecord.allowedThirdParty id). */
  readonly allowedThirdParty: string | null;
  readonly now: EpochMs;
}

export interface EvaluateInput {
  readonly session: DocumentSessionRecord;
  readonly trust: TrustSnapshot;
  /** Status of the bound build, null when unbound. */
  readonly buildStatus: BuildStatus | null;
  readonly originAlert: OriginAlert | null;
  readonly engineHealthy: boolean;
  readonly permissionGranted: boolean;
  /** lastSeen says this origin served a newer version before (ROLLBACK). */
  readonly rollback: boolean;
}

/** What happens to the session's document now. */
export type DocumentAction = 'allow' | 'deny' | 'deny-with-retry';

export interface Evaluation {
  readonly state: VerdictState;
  readonly reasons: readonly string[];
  readonly flags: readonly VerdictFlag[];
  readonly action: DocumentAction;
  /**
   * The row that denies the document and its reasons: the top state's, or a stricter one below it
   * (a NEW_BUILD document while a taint source makes the top CO_RESIDENT_UNVERIFIED). The decision,
   * the incident and the blocked page follow it. null when the document is allowed.
   */
  readonly denial: {readonly state: VerdictState; readonly reasons: readonly string[]} | null;
  /** Origin alert to raise (red states with evidence), if any. */
  readonly alert: {
    readonly state: VerdictState;
    readonly reasons: readonly string[];
  } | null;
  /** DocumentSessionRecord.unverifiedCode after this evaluation. */
  readonly unverifiedCode: UnverifiedCode | null;
  /** True when this evaluation entered a red state the session was not in before (notify). */
  readonly newRed: boolean;
}

export interface UnknownBuildInput {
  readonly deploymentKind: 'cloud' | 'self-hosted';
  /** null: not fetched yet. */
  readonly hint: HintResult | null;
  /** The hinted release of the deployment's variant and its state; null without a hinted version. */
  readonly release: {readonly key: ReleaseKey; readonly state: ReleaseState} | null;
  /** After a rebind against the hinted cores: the document path is a manifest path and the bytes differ. */
  readonly differsAtManifestPath: boolean;
  /**
   * The give-up time counts from here: the first deep verify of the release for this origin in
   * this browser session (the deep-verify budget's record), else the document's start.
   */
  readonly waitingSince: EpochMs;
  /** The deep verify running for the release is a background retry (a final decision's `ensure`). */
  readonly backgroundRetry: boolean;
  readonly now: EpochMs;
}

export interface HeaderGuardInput {
  readonly origin: ProtectedOrigin;
  readonly request: RequestObs;
  readonly response: HeadersObs;
  readonly isDocument: boolean;
  /** Cores the document may bind to (header time), or the bound core. */
  readonly candidates: readonly LoadedCore[];
  readonly binding: Binding | null;
  /** The third party allowed for this document (one vendor, one page load), or none. */
  readonly allowedThirdParty: string | null;
}

export type HeaderViolation = 'location' | 'refresh' | 'content-type' | 'charset';

export interface HeaderGuardResult {
  readonly action: 'allow' | 'cancel';
  /** Lowercased header names to remove (Link, Speculation-Rules, a build document's Content-Disposition). */
  readonly strip: readonly string[];
  /** Headers to append (the enforced CSP floor). */
  readonly append: readonly HeaderPair[];
  /** Rewrite to Cache-Control: no-store (protected code and documents). */
  readonly noStore: boolean;
  readonly violation: HeaderViolation | null;
}

/** Function signatures of the policy kernel; the modules in extension/src/policy export these names. */
export type ClassifyServerPath = (
  origin: ProtectedOrigin,
  url: RedactedUrl,
  type: ResType,
) => ServerPathClass;
export type BindDocument = (input: BindInput) => Promise<BindResult>;
export type VerifyItem = (input: VerifyItemInput) => Promise<ItemRecord>;
export type ItemContribution = (item: ItemRecord, binding: Binding | null) => Contribution | null;
export type EvaluateSession = (input: EvaluateInput) => Evaluation;
export type DecisionFor = (
  evaluation: Evaluation,
  allowances: TabAllowances | null,
  docSha256: Sha256Hex | null,
) => Decision;
export type DecideUnknownBuild = (input: UnknownBuildInput) => UnknownBuildDecision;
export type TaintSourceClass = (session: DocumentSessionRecord) => TaintClass | null;
export type HeaderGuard = (input: HeaderGuardInput) => HeaderGuardResult;
/** The enforced CSP floor of a document (null when the profile has none). */
export type CspFloor = (origin: ProtectedOrigin, allowedThirdParty: string | null) => string | null;

// ===========================================================================
// 8. UI sinks used by the background

/** Renders the toolbar icon, badge and title from the persisted TabStateRecord (R10). */
export interface TabStateSink {
  tabStateChanged(tab: number): Promise<void>;
}

export interface RedAlertEvent {
  readonly origin: Origin;
  readonly state: VerdictState;
  readonly reasons: readonly string[];
  readonly incidentId: string;
}

/** The system notification of a new red state. */
export interface AlertSink {
  redAlert(event: RedAlertEvent): Promise<void>;
}

// ===========================================================================
// 9. Messaging (transport: platform/messaging.ts)

/** Sensor configuration the background returns to a content script. */
export interface SensorConfig {
  readonly doc: DocKey;
  readonly protected: boolean;
}

export interface TrustPanelView {
  readonly snapshot: TrustSnapshot;
  readonly cores: readonly CoreRef[];
  readonly jobs: readonly DeepVerifyJobView[];
  readonly pins: LocalPins;
  readonly githubPermission: boolean;
}

export interface OnboardingStatus {
  readonly permissions: readonly PermissionStatus[];
  readonly incognitoAllowed: boolean;
  /** null when the browser cannot tell; even a reported value may not be reliable. */
  readonly pinned: boolean | null;
  /** Protected tabs whose page was open before IntactWarden watched it ("Reload to verify"). */
  readonly openProtectedTabs: number;
}

export interface InstanceView {
  readonly record: InstanceRecord;
  readonly permission: PermissionStatus;
  readonly lastBuild: BuildId | null;
}

type Empty = Readonly<Record<string, never>>;

/** Request and response payload of every runtime message. */
export interface MessageMap {
  // content script → background
  CS_HELLO: {req: Empty; res: SensorConfig};
  CS_DOM: {req: {doc: DocKey; event: DomEvent; detail: DomDetail}; res: null};
  CS_CSP_VIOLATION: {req: {doc: DocKey; directive: string; blockedUrl: RedactedUrl}; res: null};
  // extension pages → background
  UI_GET_STATE: {req: {tab: number}; res: TabStateRecord | null};
  UI_GET_DETAILS: {req: {tab: number}; res: DetailsView | null};
  UI_GET_SETTINGS: {req: Empty; res: Settings};
  UI_SET_SETTINGS: {req: {patch: SettingsPatch}; res: Settings};
  UI_ACK_ALERT: {req: {origin: Origin}; res: OriginAlert | null};
  UI_LIST_ALERTS: {req: Empty; res: readonly OriginAlert[]};
  UI_LIST_INCIDENTS: {req: {limit: number}; res: readonly IncidentRecord[]};
  UI_ADD_INSTANCE: {req: AddInstanceRequest; res: AddInstanceResult};
  UI_REMOVE_INSTANCE: {req: {id: string}; res: null};
  UI_LIST_INSTANCES: {req: Empty; res: readonly InstanceView[]};
  UI_DEEP_VERIFY: {req: {key: ReleaseKey}; res: EnsureReleaseOutcome};
  UI_GET_TRUST: {req: Empty; res: TrustPanelView};
  UI_ALLOW_FOR_TAB: {req: {tab: number; allowance: AllowanceRequest}; res: null};
  UI_GET_ONBOARDING: {req: Empty; res: OnboardingStatus};
  UI_GET_BLOCKED: {req: {incidentId: string}; res: BlockedView | null};
}

export type MessageType = keyof MessageMap;
export type MessageRequest<T extends MessageType> = MessageMap[T]['req'];
export type MessageResponse<T extends MessageType> = MessageMap[T]['res'];

export type ErrorCode = 'bad-sender' | 'bad-message' | 'not-ready' | 'internal-error';

/** Wire format of a response. */
export type Reply<T extends MessageType = MessageType> =
  | {readonly ok: true; readonly value: MessageResponse<T>}
  | {readonly ok: false; readonly error: ErrorCode};

/** Who may send each message (enforced by validateSender). */
export type SenderKind = 'content' | 'page';

export const MESSAGE_SENDERS: Readonly<Record<MessageType, SenderKind>> = Object.freeze({
  CS_HELLO: 'content',
  CS_DOM: 'content',
  CS_CSP_VIOLATION: 'content',
  UI_GET_STATE: 'page',
  UI_GET_DETAILS: 'page',
  UI_GET_SETTINGS: 'page',
  UI_SET_SETTINGS: 'page',
  UI_ACK_ALERT: 'page',
  UI_LIST_ALERTS: 'page',
  UI_LIST_INCIDENTS: 'page',
  UI_ADD_INSTANCE: 'page',
  UI_REMOVE_INSTANCE: 'page',
  UI_LIST_INSTANCES: 'page',
  UI_DEEP_VERIFY: 'page',
  UI_GET_TRUST: 'page',
  UI_ALLOW_FOR_TAB: 'page',
  UI_GET_ONBOARDING: 'page',
  UI_GET_BLOCKED: 'page',
});

/** Background → extension pages broadcasts (runtime.sendMessage; no reply). */
export interface BroadcastMap {
  STATE_UPDATED: {tab: number};
  JOB_UPDATED: {job: DeepVerifyJobView};
  SETTINGS_UPDATED: {settings: Settings};
  INSTANCES_UPDATED: Empty;
}

export interface BroadcastEnvelope<T extends keyof BroadcastMap = keyof BroadcastMap> {
  readonly iw: 1;
  readonly broadcast: T;
  readonly payload: BroadcastMap[T];
}

// ===========================================================================
// 10. Storage layout

/** storage.local keys (survive restarts and updates). */
export const LOCAL_KEYS = Object.freeze({
  settings: 'l:v1:settings',
  instances: 'l:v1:instances',
  originAlerts: 'l:v1:originAlerts',
  lastSeen: 'l:v1:lastSeen',
  /** Local (TOFU) pins. */
  pins: 'l:v1:pins',
  /** Known releases (CoreRef per build id) and release states (disputes, failures with retry). */
  releases: 'l:v1:releases',
  /** Deep-verify jobs (last 50), for the UI. */
  jobs: 'l:v1:jobs',
  /** GitHub client state: rate-limit back-off. */
  github: 'l:v1:github',
  /** The incident log, newest first (engine/alerts.ts bounds it). */
  incidents: 'l:v1:incidents',
});

/** storage.session keys (survive event-page restarts, not browser restarts). */
export const SESSION_KEYS = Object.freeze({
  tab: (tab: number): string => `s:v1:tab:${tab}`,
  doc: (doc: DocKey): string => `s:v1:doc:${doc}`,
  taint: (origin: Origin): string => `s:v1:taint:${origin}`,
  allow: (tab: number): string => `s:v1:allow:${tab}`,
  /** Set by the first background instance of the browser session (R7 restart detection). */
  boot: 's:v1:boot',
  /** Deep verifies started per origin in the last 24 hours (engine/budget.ts). */
  deepVerifyBudget: 's:v1:dv-budget',
  /** Opened tab → the tab that opened it, for origin taint (engine/taint.ts). */
  openers: 's:v1:openers',
});

export interface LastSeenEntry {
  readonly buildId: BuildId;
  readonly version: string;
  readonly at: EpochMs;
}

export interface ReleasesState {
  /**
   * Builder fingerprint (extension/build/fingerprint.ts) of the code that wrote this; with another
   * one, the cores built in this browser are dropped.
   */
  readonly builder: string;
  readonly cores: Readonly<Record<BuildId, CoreRef>>;
  /** Keyed by buildIdOf(key); only non-trivial states (failed, disputed) are persisted. */
  readonly states: Readonly<Record<BuildId, ReleaseState>>;
}

export interface TaintRecord {
  readonly origin: Origin;
  readonly sources: Readonly<
    Record<
      DocKey,
      {
        readonly class: TaintClass;
        readonly since: EpochMs;
        readonly path: string;
        readonly tab: number;
      }
    >
  >;
}

/** Typed view of storage.local. */
export interface LocalStorageSchema {
  'l:v1:settings': Settings;
  'l:v1:instances': readonly InstanceRecord[];
  'l:v1:originAlerts': Readonly<Record<Origin, OriginAlert>>;
  'l:v1:lastSeen': Readonly<Record<Origin, LastSeenEntry>>;
  'l:v1:pins': LocalPins;
  'l:v1:releases': ReleasesState;
  'l:v1:jobs': readonly DeepVerifyJobView[];
  'l:v1:github': unknown;
  'l:v1:incidents': readonly IncidentRecord[];
}

/** IndexedDB database (the default quota holds cores of about 50 KB each). */
export const IDB = Object.freeze({
  name: 'intactwarden',
  /** Never lower it: IndexedDB refuses to open a database with a lower version. */
  version: 2,
  stores: Object.freeze({
    /** keyPath 'sha256': raw JCS bytes of cores (self-validating). */
    cores: 'cores',
  }),
});

export interface CoreBlobRecord {
  readonly sha256: Sha256Hex;
  readonly bytes: Uint8Array;
  readonly buildId: BuildId;
  readonly addedAt: EpochMs;
}

/** Minimal async key-value store over one IndexedDB object store (memory implementation in tests). */
export interface KeyValueStore<V> {
  get(key: string): Promise<V | undefined>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ExtensionDb {
  readonly cores: KeyValueStore<CoreBlobRecord>;
}

// ===========================================================================
// 11. Package layout shared by the build and the code that opens pages

/** Package paths of extension pages (relative to the package root, dist/firefox/). */
export const PAGES = Object.freeze({
  popup: 'ui/popup.html',
  details: 'ui/details.html',
  options: 'ui/options.html',
  onboarding: 'ui/onboarding.html',
  incidents: 'ui/incidents.html',
  blocked: 'ui/blocked.html',
});

/** i18n keys the manifest references (`__MSG_<key>__`); both catalogues (en, pl) define them. */
export const MANIFEST_MESSAGE_KEYS = Object.freeze([
  'extName',
  'extDescription',
  'actionTitle',
] as const);

/**
 * Hosts the deep verify contacts. A release file is downloaded through api.github.com, which
 * redirects to release-assets.githubusercontent.com: both need a host permission, because
 * release-assets sends no CORS headers and Firefox applies CORS to a whole redirect chain that
 * starts at a host without one. raw.githubusercontent.com answers with
 * `Access-Control-Allow-Origin: *` and needs none. github.com is never contacted.
 */
export const GITHUB_HOSTS = Object.freeze({
  api: 'https://api.github.com',
  releaseAssets: 'https://release-assets.githubusercontent.com',
  raw: 'https://raw.githubusercontent.com',
});

/**
 * Host-permission patterns deep verify needs (required; users can revoke them). Without them, deep
 * verify sends no request to GitHub at all.
 */
export const GITHUB_PERMISSION_PATTERNS: readonly string[] = Object.freeze([
  `${GITHUB_HOSTS.api}/*`,
  `${GITHUB_HOSTS.releaseAssets}/*`,
]);
