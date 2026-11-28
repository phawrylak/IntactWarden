/**
 * The repository-hardening rules of docs/release.md as exact expectations on the three
 * GitHub Actions workflows. The tables below are the reviewed policy: a change to permissions,
 * triggers, actions or the release steps must change them in the same commit.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {parse} from 'yaml';
import {readLock} from './e2e/browsers.ts';

const DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
type Job = Record<string, unknown> & {steps: Step[]};

/** The only actions a workflow may use, by full commit SHA (the tag is in the workflow's comment). */
const ACTIONS = new Set([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
  'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
]);

/** Each workflow's whole `on:` value. No pull_request_target, no dispatch inputs. */
const TRIGGERS: Record<string, unknown> = {
  'ci.yml': {push: {branches: ['main']}, pull_request: {branches: ['main']}},
  'release-extension.yml': {push: {tags: ['v*']}},
  'store-diff.yml': {schedule: [{cron: '23 5 * * *'}], workflow_dispatch: null},
};

/** Job permissions other than `contents: read`, keyed `<file>/<job>`. */
const PERMISSIONS: Record<string, unknown> = {
  'release-extension.yml/attest': {contents: 'read', 'id-token': 'write', attestations: 'write'},
  'release-extension.yml/publish': {contents: 'write'},
};

/**
 * The conditions of the release's tag step. Each one stands in `if <condition>; then`, followed by
 * one message line and `exit 1`.
 */
const TAG_REFUSALS: readonly string[] = [
  '! [[ "$GITHUB_REF_NAME" =~ ^v([0-9]+\\.[0-9]+\\.[0-9]+)$ ]]',
  '[ "$ref_type" != tag ] || ! [[ "$tag_object" =~ ^[0-9a-f]{40}$ ]]',
  // Fails closed while the fingerprint of the release key is not set.
  '! [[ "$RELEASE_KEY_FPR" =~ ^[0-9A-F]{40}$ ]]',
  '! signature="$(git verify-tag --raw "$tag_object" 2>&1)"',
  '! grep -Eq "^\\[GNUPG:\\] VALIDSIG .* $RELEASE_KEY_FPR\\$" <<<"$signature"',
  '[ "$target" != "$commit" ]',
  '! [[ "$main_sha" =~ ^[0-9a-f]{40}$ ]]',
  `[ "$on_main" != 'identical 0' ] && [ "$on_main" != 'behind 0' ]`,
  '[ "$package_version" != "$version" ]',
];

/** `text` as a regular-expression source that matches it literally. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The release: a signed tag on main, then provenance, then the draft release. */
function checkRelease(jobs: Record<string, Job>): void {
  expect(Object.keys(jobs), 'release jobs').toEqual(['build', 'attest', 'publish']);
  expect(jobs['build']!['if'], 'release: repository guard').toBe(
    "github.repository == 'phawrylak/IntactWarden'",
  );
  const tag = jobs['build']!.steps.find(s => s.run?.includes('git verify-tag --raw'));
  for (const condition of TAG_REFUSALS) {
    expect(tag?.run, `release: tag step refuses on ${condition}`).toMatch(
      new RegExp(`if ${literal(condition)}; then\\n[^\\n]*\\n\\s*exit 1\\n`),
    );
  }
  expect(tag?.run, 'release: tag on main').toContain('repos/$REPO/compare/$main_sha...$commit');
  expect(tag?.run, 'release: the key is the pinned one').toContain(
    'curl -fsS "https://keys.openpgp.org/vks/v1/by-fingerprint/$RELEASE_KEY_FPR" |\n  gpg --batch --import\n',
  );
  const provenance = jobs['attest']!.steps.find(s =>
    s.uses?.startsWith('actions/attest-build-provenance@'),
  );
  expect(String(provenance?.with?.['subject-path']), 'release: attested zip').toContain(
    '-firefox.zip',
  );
  // The profiles are typed constants checked by tsc and a unit test, not at build time.
  const runs = jobs['build']!.steps.map(s => s.run ?? '');
  const build = runs.indexOf('npm run build:ext');
  expect(runs.indexOf('npm run typecheck'), 'release: typecheck before build').toBeGreaterThan(-1);
  expect(runs.indexOf('npm run typecheck'), 'release: typecheck before build').toBeLessThan(build);
  expect(runs.indexOf('npm test -- packages/profiles'), 'release: profile test').toBeGreaterThan(
    -1,
  );
  expect(runs.indexOf('npm test -- packages/profiles'), 'release: profile test').toBeLessThan(
    build,
  );
  // The package is built twice from scratch and the two outputs are compared.
  const again = runs.indexOf(
    'mv extension/dist "$RUNNER_TEMP/dist-first"\nnpm run build:ext\nnpm run package:ext\n',
  );
  const compare = runs.indexOf('diff -r "$RUNNER_TEMP/dist-first" extension/dist');
  expect(again, 'release: second build').toBeGreaterThan(runs.indexOf('npm run package:ext'));
  expect(compare, 'release: the two builds are compared').toBeGreaterThan(again);
  const publish = jobs['publish']!.steps.at(-1)!.run ?? '';
  expect(publish, 'release: checksums before the release').toMatch(
    /sha256sum --check --strict SHA256SUMS\n\s*gh release create /,
  );
  expect(publish, 'release: a draft').toMatch(/^\s*--draft \\$/m);
  expect(publish, 'release: only an existing tag').toMatch(/^\s*--verify-tag \\$/m);
  expect(jobs['attest']!['needs'], 'release: attest after build').toBe('build');
  expect(jobs['publish']!['needs'], 'release: publish after attest').toEqual(['build', 'attest']);
}

/** Throws on the first broken rule. */
function check(file: string, source: string): void {
  // YAML 1.2; a duplicate key, a second document or a syntax error throws.
  const workflow = parse(source, {merge: false});
  expect(workflow.permissions, `${file}: top-level permissions`).toEqual({});
  expect(workflow.on, `${file}: triggers`).toEqual(TRIGGERS[file]);
  // No secret is referenced at all: the token is `github.token`.
  expect(source, `${file}: secrets`).not.toMatch(/\bsecrets\b/i);
  // No npm configuration through the environment (npm_config_ignore_scripts=false and the like).
  expect(source, `${file}: npm_config`).not.toMatch(/npm_config_/i);
  if (file !== 'ci.yml') {
    const concurrency = workflow.concurrency ?? workflow.jobs['store-diff'].concurrency;
    expect(concurrency['cancel-in-progress'], `${file}: concurrency`).toBe(false);
  }
  if (file === 'ci.yml') {
    // The package is built twice from scratch and the two outputs are compared.
    const runs = (workflow.jobs.extension as Job).steps.map(s => s.run ?? '').join('\n');
    expect(runs, 'ci: the two builds are compared').toContain(
      'diff -r "$RUNNER_TEMP/dist-first" extension/dist\n',
    );
  }
  if (file === 'release-extension.yml') {
    expect(workflow.env.RELEASE_KEY_FPR, 'release: key fingerprint').toMatch(/^(?:[0-9A-F]{40})?$/);
    checkRelease(workflow.jobs);
  }
  for (const [id, job] of Object.entries<Job>(workflow.jobs)) {
    const key = `${file}/${id}`;
    expect(job.permissions, `${key}: permissions`).toEqual(PERMISSIONS[key] ?? {contents: 'read'});
    expect(job['runs-on'], `${key}: runner`).toMatch(/^ubuntu-(latest|\d\d\.\d\d)$/);
    const timeout = job['timeout-minutes'];
    expect(
      Number.isInteger(timeout) && (timeout as number) >= 1 && (timeout as number) <= 360,
      `${key}: timeout-minutes is a whole number from 1 to 360`,
    ).toBe(true);
    for (const keyword of ['uses', 'container', 'services', 'secrets', 'environment']) {
      expect(job[keyword], `${key}: ${keyword}`).toBeUndefined();
    }
    job.steps.forEach((step, index) => {
      const where = `${key}:steps[${index}]`;
      if (step.uses !== undefined) {
        expect(ACTIONS.has(step.uses), `${where}: ${step.uses} is not a reviewed pin`).toBe(true);
        if (step.uses.startsWith('actions/checkout@')) {
          expect(step.with, where).toEqual({'persist-credentials': false});
        }
        if (step.uses.startsWith('actions/setup-node@')) {
          expect(Object.keys(step.with ?? {}), where).toEqual([
            'node-version',
            'package-manager-cache',
          ]);
          expect(step.with?.['package-manager-cache'], where).toBe(false);
        }
      }
      if (step.run !== undefined) {
        expect(step.run, `${where}: expression in run`).not.toContain('${{');
        // npm runs only `ci --ignore-scripts`, `run <script>` and `test`; no other package manager,
        // and nothing turns lifecycle scripts back on (`--ignore-scripts=false`,
        // `--no-ignore-scripts`).
        expect(step.run, where).not.toMatch(
          /\bnpm\b(?! (ci --ignore-scripts(?=\s|$)|run [a-z]|test\b))/,
        );
        expect(step.run, where).not.toMatch(/ignore-scripts=|no-ignore-scripts/);
        expect(step.run, where).not.toMatch(/\b(npx|yarn|pnpm|bunx?)\b/);
      }
    });
  }
}

const files = readdirSync(DIR).sort();
const read = (file: string): string => readFileSync(DIR + file, 'utf8');

describe('the workflows', () => {
  it('are exactly the planned three', () => {
    expect(files).toEqual(Object.keys(TRIGGERS));
  });

  it('runs the e2e job on exactly the Firefox versions pinned in browsers.lock.json', () => {
    const ci = parse(read('ci.yml'));
    expect(ci.jobs.e2e.strategy.matrix.firefox).toEqual(readLock().firefox.map(f => f.version));
  });

  it.each(files)('%s follows the hardening rules', file => {
    check(file, read(file));
  });

  // One mutation per rule, so a rule that stops firing is noticed.
  it.each([
    ['ci.yml', 'permissions: {}', 'permissions: read-all'],
    ['ci.yml', '      contents: read\n', '      contents: write\n'],
    ['ci.yml', '  pull_request:', '  pull_request_target:'],
    ['ci.yml', '@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7'],
    ['ci.yml', '          persist-credentials: false\n', ''],
    ['ci.yml', 'package-manager-cache: false', 'package-manager-cache: true'],
    ['ci.yml', 'run: npm ci --ignore-scripts', 'run: npm ci'],
    ['ci.yml', 'run: npm ci --ignore-scripts', 'run: npm ci --ignore-scripts=false'],
    ['ci.yml', 'run: npm ci --ignore-scripts', 'run: npm ci --ignore-scripts --no-ignore-scripts'],
    [
      'ci.yml',
      'run: npm ci --ignore-scripts',
      'run: npm ci --ignore-scripts\n        env:\n          npm_config_ignore_scripts: false',
    ],
    ['ci.yml', 'run: npm run lint', 'run: npm rebuild'],
    ['ci.yml', 'run: npm run lint', 'run: npx eslint .'],
    ['ci.yml', 'run: npm run lint', 'run: echo ${{ github.head_ref }}'],
    ['ci.yml', 'runs-on: ubuntu-latest', 'runs-on: self-hosted'],
    ['ci.yml', '    timeout-minutes: 20\n', ''],
    ['ci.yml', '    timeout-minutes: 20\n', '    timeout-minutes: 0\n'],
    ['ci.yml', '    timeout-minutes: 20\n', '    timeout-minutes: -5\n'],
    ['ci.yml', '    timeout-minutes: 20\n', '    timeout-minutes: 0.5\n'],
    ['ci.yml', '    timeout-minutes: 20\n', '    timeout-minutes: 361\n'],
    ['ci.yml', '    timeout-minutes: 20\n', '    timeout-minutes: 20\n    environment: store\n'],
    ['ci.yml', '          diff -r', '          echo'],
    ['store-diff.yml', '${{ github.token }}', '${{ toJSON(secrets) }}'],
    ['store-diff.yml', 'cancel-in-progress: false', 'cancel-in-progress: true'],
    [
      'release-extension.yml',
      '      contents: write\n',
      '      contents: write\n      id-token: write\n',
    ],
    ['release-extension.yml', "    if: github.repository == 'phawrylak/IntactWarden'\n", ''],
    ...TAG_REFUSALS.map(c => ['release-extension.yml', `if ${c}; then`, 'if false; then']),
    ['release-extension.yml', 'by-fingerprint/$RELEASE_KEY_FPR"', 'by-email/release@example.org"'],
    ['release-extension.yml', '  RELEASE_KEY_FPR: ', '  RELEASE_KEY_FPR: x'],
    ['release-extension.yml', 'run: npm test -- packages/profiles\n', 'run: echo skipped\n'],
    [
      'release-extension.yml',
      'mv extension/dist "$RUNNER_TEMP/dist-first"\n',
      'cp -r extension/dist "$RUNNER_TEMP/dist-first"\n',
    ],
    ['release-extension.yml', 'run: diff -r', 'run: echo'],
    [
      'release-extension.yml',
      '          sha256sum --check --strict SHA256SUMS\n          gh',
      '          gh',
    ],
    ['release-extension.yml', '            --draft \\\n', ''],
    ['release-extension.yml', '            --verify-tag \\\n', ''],
    ['release-extension.yml', '    needs: [build, attest]\n', '    needs: build\n'],
    ['release-extension.yml', '-firefox.zip\n            ${{', '-other.zip\n            ${{'],
  ])('%s: replacing %j with %j is refused', (file, from, to) => {
    expect(read(file)).toContain(from);
    expect(() => check(file, read(file).replace(from, to))).toThrow();
  });
});
