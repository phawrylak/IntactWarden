/**
 * Core manifest `intactwarden.manifest/1`: the content-addressed
 * list of files of one build, a pure function of a GitHub release asset (plus closed
 * derivation code). Only packages/builders writes cores; the extension keeps their exact
 * bytes under their sha256 and does not validate them again when it loads them.
 *
 * coreProblem() is the builders' postcondition (finishCore): the rules the TypeScript types
 * cannot express. Slot specs and template rules come from template/slots.ts and
 * template/match.ts, key rules from routing/fileIndex.ts and routing consistency from
 * routing/mapUrl.ts, so the builders and the extension can never disagree about them.
 */

import {createFileIndex, placeholderNames, templateSlotResolver} from '../routing/fileIndex.ts';
import {checkRoutingConfig, type Hosting} from '../routing/mapUrl.ts';
import type {Template} from '../template/build.ts';
import {validateTemplate} from '../template/match.ts';
import {pathProblem} from './validate.ts';

export type ResourceClass =
  'document' | 'script' | 'style' | 'wasm' | 'font' | 'data' | 'image' | 'media' | 'sourcemap';

export interface ExactEntry {
  readonly sha256: string;
  readonly size: number;
  readonly class: ResourceClass;
}

/**
 * Masked-hash template entry.
 */
export interface TemplateEntry {
  readonly class: 'document' | 'script';
  readonly template: Template;
}

/** Server-generated data file (e.g. Bitwarden self-hosted /app-id.json): never code. */
export interface DynamicEntry {
  readonly class: 'data';
  readonly dynamic: true;
}

export type FileEntry = ExactEntry | TemplateEntry | DynamicEntry;

export interface Source {
  /** "https://github.com/<owner>/<repo>". */
  readonly repo: string;
  /** Numeric GitHub repository id; pins the repository against renames. */
  readonly repo_id: number;
  readonly tag?: string;
  readonly commit: string;
  /**
   * Object id of the annotated tag `tag`; pinned with the commit, so a moved or re-created
   * tag is a dispute.
   */
  readonly tag_object?: string;
}

/** The upstream artifact a core's files come from: a GitHub release asset (the only kind). */
export interface ReleaseAssetArtifact {
  readonly kind: 'github-release-asset';
  readonly name: string;
  readonly sha256: string;
  readonly size?: number;
  /** Archive directory that maps to the deployment base path, e.g. "build/". */
  readonly root?: string;
}

/** The Bitwarden cloud derivation (`cloud.json` for the US cloud, `euprd.json` for the EU one). */
export interface Derivation {
  readonly env: 'cloud' | 'euprd';
  readonly inputs: readonly {
    readonly path: string;
    readonly commit: string;
    readonly sha256: string;
  }[];
}

/** Same shape as routing/mapUrl.ts `RoutingConfig`. */
export interface Routing {
  readonly hosting: Hosting;
  /** "/" or "/<segments>/". */
  readonly base_path: string;
  readonly index: string;
  /** Body of a 404 response. */
  readonly not_found?: string;
}

export interface CoreManifest {
  readonly schema: 'intactwarden.manifest/1';
  /** "<app>@<version>+<variant>". */
  readonly build_id: string;
  readonly app: string;
  readonly variant: string;
  readonly version: {readonly label: string};
  readonly source: Source;
  readonly artifact: ReleaseAssetArtifact;
  readonly derivation?: Derivation;
  readonly routing: Routing;
  readonly files: Readonly<Record<string, FileEntry>>;
}

export function isTemplateEntry(entry: FileEntry): entry is TemplateEntry {
  return 'template' in entry;
}

export function isDynamicEntry(entry: FileEntry): entry is DynamicEntry {
  return 'dynamic' in entry;
}

export function isExactEntry(entry: FileEntry): entry is ExactEntry {
  return 'sha256' in entry;
}

/**
 * A file key is a canonical absolute path (normalizePath(key) === key), so no two keys can
 * name one request path. In a slot path each "{SLOT}" placeholder is checked as a value.
 */
function keyProblem(key: string): string | null {
  const names = placeholderNames(key);
  if (names === null) return 'malformed "{SLOT}" placeholder (at most one per segment)';
  let probe = key;
  for (const name of names) probe = probe.replace(`{${name}}`, 'x');
  return pathProblem(probe);
}

function templateProblem(key: string, template: Template): string | null {
  const reason = validateTemplate(template);
  if (reason !== null) return reason;
  const slots = template.parts.flatMap(p => ('slot' in p ? [p.slot] : []));
  if (slots.length === 0) return 'a template needs at least one slot';
  // A placeholder binds the slot from the request path; the bytes must then contain that
  // slot, or the file-name hash would not be tied to the content.
  const missing = (placeholderNames(key) ?? []).find(name => !slots.includes(name));
  return missing === undefined ? null : `placeholder {${missing}} does not occur in the template`;
}

/**
 * The builders' postcondition on a core they built. Returns the first problem, or null.
 * Checked: the build id, canonical and pairwise disjoint file keys (placeholders only in
 * template keys, with allowlisted slots), well-formed templates, and a consistent routing
 * whose index and 404 body are documents.
 */
export function coreProblem(core: CoreManifest): string | null {
  if (core.build_id !== `${core.app}@${core.version.label}+${core.variant}`) {
    return `build_id must be "${core.app}@${core.version.label}+${core.variant}"`;
  }
  for (const [key, entry] of Object.entries(core.files)) {
    const problem =
      keyProblem(key) ?? (isTemplateEntry(entry) ? templateProblem(key, entry.template) : null);
    if (problem !== null) return `files ${JSON.stringify(key)}: ${problem}`;
  }
  try {
    createFileIndex(Object.keys(core.files), templateSlotResolver(core.files));
    checkRoutingConfig(core.routing);
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid files or routing';
  }
  for (const doc of [core.routing.index, core.routing.not_found]) {
    if (doc !== undefined && core.files[doc]?.class !== 'document') {
      return `routing: ${JSON.stringify(doc)} must be a document entry in files`;
    }
  }
  return null;
}
