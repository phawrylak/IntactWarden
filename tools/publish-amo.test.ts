// publish-amo: every check runs against fakes of git, gh and the AMO API; nothing is sent to AMO
// unless all of them pass.
import {createHash, createHmac} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createZip} from '../extension/build/zip.ts';
import {amoToken, EXIT, main, type Deps, type RunResult} from './publish-amo.ts';
import {RELEASE_WORKFLOW, REPO} from './verify-store-package.ts';

const FPR = 'EBEDF02CDFE151093FDF3C3728D33FF55626F337';
const OTHER = '0123456789ABCDEF0123456789ABCDEF01234567';
const COMMIT = 'c'.repeat(40);
const ID = 'intactwarden@phawrylak';
const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const manifest = (version: string, id = ID) =>
  JSON.stringify({manifest_version: 3, version, browser_specific_settings: {gecko: {id}}});
const zipOf = (version: string, id?: string) =>
  createZip([
    {path: 'manifest.json', bytes: enc.encode(manifest(version, id))},
    {path: 'background.js', bytes: enc.encode('x')},
  ]);

interface Opts {
  readonly zip?: Uint8Array;
  readonly sums?: (zip: string, src: string) => string;
  readonly signer?: string;
  readonly verifyCode?: number;
  readonly attestCode?: number;
  readonly workflowFpr?: string;
  readonly env?: Record<string, string>;
  readonly upload?: Record<string, unknown>;
  readonly versionsStatus?: number;
}

function world(o: Opts = {}) {
  const zip = o.zip ?? zipOf('0.1.0');
  const src = enc.encode('source tarball');
  const files = new Map<string, Uint8Array>();
  const runs: string[] = [];
  const fetches: {method: string; url: string; auth: string; body: FormData | undefined}[] = [];
  const out: string[] = [];
  const ok = (stdout = ''): RunResult => ({code: 0, stdout, stderr: ''});
  const deps: Deps = {
    run: async (cmd, args) => {
      runs.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args[0] === 'rev-parse') return ok(`${COMMIT}\n`);
      if (cmd === 'git' && args[0] === 'show' && args[1]!.endsWith('release-extension.yml')) {
        return ok(`env:\n  REPO: ${REPO}\n  RELEASE_KEY_FPR: '${o.workflowFpr ?? FPR}'\n`);
      }
      if (cmd === 'git' && args[0] === 'show' && args[1]!.endsWith('manifest.json'))
        return ok(manifest('0.1.0'));
      if (cmd === 'git' && args[0] === 'verify-tag') {
        return {
          code: o.verifyCode ?? 0,
          stdout: '',
          stderr: `[GNUPG:] GOODSIG X\n[GNUPG:] VALIDSIG ${'B'.repeat(40)} 2026-11-17 1 0 4 0 22 10 00 ${o.signer ?? FPR}\n`,
        };
      }
      if (cmd === 'gh' && args[0] === 'release') {
        const dir = args[args.indexOf('--dir') + 1]!;
        files.set(`${dir}/intactwarden-0.1.0-firefox.zip`, zip);
        files.set(`${dir}/intactwarden-0.1.0-source.tar.gz`, src);
        const zipLine = `${sha(zip)}  intactwarden-0.1.0-firefox.zip`;
        const srcLine = `${sha(src)}  intactwarden-0.1.0-source.tar.gz`;
        files.set(
          `${dir}/SHA256SUMS`,
          enc.encode(o.sums ? o.sums(zipLine, srcLine) : `${zipLine}\n${srcLine}\n`),
        );
        return ok();
      }
      if (cmd === 'gh' && args[0] === 'attestation')
        return {code: o.attestCode ?? 0, stdout: '', stderr: 'attestation said no'};
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    },
    fetch: (async (input: URL, init: RequestInit) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      fetches.push({
        method,
        url,
        auth: String((init.headers as Record<string, string>)['Authorization']),
        body: init.body as FormData | undefined,
      });
      const json = (status: number, data: unknown) => new Response(JSON.stringify(data), {status});
      if (method === 'POST' && url.endsWith('/addons/upload/'))
        return json(201, {uuid: 'a'.repeat(32), processed: false});
      if (method === 'GET' && url.includes('/addons/upload/')) {
        return json(200, {
          uuid: 'a'.repeat(32),
          processed: true,
          valid: true,
          version: '0.1.0',
          ...o.upload,
        });
      }
      if (method === 'POST' && url.endsWith('/versions/')) {
        return o.versionsStatus
          ? json(o.versionsStatus, {detail: 'no'})
          : json(201, {id: 7, version: '0.1.0'});
      }
      return json(404, {});
    }) as typeof fetch,
    env: o.env ?? {WEB_EXT_API_KEY: 'user:1:2', WEB_EXT_API_SECRET: 'top-secret-value'},
    tempDir: async () => ({dir: '/tmp/amo', remove: async () => undefined}),
    readFile: async path => {
      const b = files.get(path);
      if (b === undefined) throw new Error(`no ${path}`);
      return b;
    },
    sleep: async () => undefined,
    now: () => 1_794_000_000_000,
    stdout: t => void out.push(t),
    stderr: t => void out.push(t),
  };
  return {deps, runs, fetches, out: () => out.join('')};
}

describe('publish-amo', () => {
  it('a dry run checks the tag, the checksums, the provenance and the manifest, and sends nothing', async () => {
    const w = world({env: {}});
    expect(await main(['--dry-run', 'v0.1.0'], w.deps)).toBe(EXIT.submitted);
    expect(w.fetches).toEqual([]);
    expect(w.runs).toContain('git verify-tag --raw v0.1.0');
    for (const f of ['firefox.zip', 'source.tar.gz']) {
      expect(w.runs).toContain(
        `gh attestation verify /tmp/amo/intactwarden-0.1.0-${f} --repo ${REPO} --signer-workflow ${RELEASE_WORKFLOW} --source-ref refs/tags/v0.1.0 --source-digest ${COMMIT}`,
      );
    }
    expect(w.out()).toContain('dry run: nothing was sent to AMO');
  });

  it('uploads the attested zip unchanged, waits for validation, then creates the version with the source', async () => {
    const w = world();
    const zip = zipOf('0.1.0');
    expect(await main(['v0.1.0'], w.deps)).toBe(EXIT.submitted);
    expect(w.fetches.map(f => `${f.method} ${f.url}`)).toEqual([
      'POST https://addons.mozilla.org/api/v5/addons/upload/',
      `GET https://addons.mozilla.org/api/v5/addons/upload/${'a'.repeat(32)}/`,
      `POST https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(ID)}/versions/`,
    ]);
    const upload = w.fetches[0]!.body!;
    expect(upload.get('channel')).toBe('listed');
    const sent = upload.get('upload') as File;
    expect(sent.name).toBe('intactwarden-0.1.0-firefox.zip');
    expect(sha(new Uint8Array(await sent.arrayBuffer()))).toBe(sha(zip));
    const create = w.fetches[2]!.body!;
    expect(create.get('upload')).toBe('a'.repeat(32));
    expect((create.get('source') as File).name).toBe('intactwarden-0.1.0-source.tar.gz');
    expect(w.out()).toContain('gh workflow run store-diff.yml');
    expect(w.out()).not.toContain('top-secret-value');
  });

  it('signs each AMO request with a short-lived HS256 token', () => {
    const t = amoToken('user:1:2', 'top-secret-value', 1_794_000_000_000);
    const [head, body, sig] = t.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
    expect(claims).toMatchObject({iss: 'user:1:2', iat: 1_794_000_000, exp: 1_794_000_060});
    expect(typeof claims.jti).toBe('string');
    expect(sig).toBe(
      createHmac('sha256', 'top-secret-value').update(`${head}.${body}`).digest('base64url'),
    );
  });

  it.each<[string, Opts]>([
    ['a tag signed by another key', {signer: OTHER}],
    ['a tag whose signature does not verify', {verifyCode: 1}],
    ['a release workflow without a key', {workflowFpr: ''}],
    [
      'a zip that does not match SHA256SUMS',
      {sums: (_z, s) => `${'0'.repeat(64)}  intactwarden-0.1.0-firefox.zip\n${s}\n`},
    ],
    ['a zip listed twice', {sums: (z, s) => `${z}\n${z}\n${s}\n`}],
    ['a missing source tarball line', {sums: z => `${z}\n`}],
    ['a failed provenance check', {attestCode: 1}],
    ['a zip of another version', {zip: zipOf('0.2.0')}],
    ['a zip of another add-on', {zip: zipOf('0.1.0', 'other@example.org')}],
  ])('refuses %s and sends nothing to AMO', async (_name, o) => {
    const w = world(o);
    expect(await main(['v0.1.0'], w.deps)).toBe(EXIT.refused);
    expect(w.fetches).toEqual([]);
    expect(w.out()).toContain('refused:');
  });

  it('creates no version when AMO rejects the upload', async () => {
    const w = world({upload: {valid: false, validation: {errors: 1}}});
    expect(await main(['v0.1.0'], w.deps)).toBe(EXIT.refused);
    expect(w.fetches.some(f => f.url.endsWith('/versions/'))).toBe(false);
  });

  it('creates no version when AMO read another version from the upload', async () => {
    const w = world({upload: {version: '9.9.9'}});
    expect(await main(['v0.1.0'], w.deps)).toBe(EXIT.refused);
    expect(w.fetches.some(f => f.url.endsWith('/versions/'))).toBe(false);
  });

  it('reports an AMO error without the secret', async () => {
    const w = world({versionsStatus: 403});
    expect(await main(['v0.1.0'], w.deps)).toBe(EXIT.refused);
    expect(w.out()).toContain('AMO answered 403');
    expect(w.out()).not.toContain('top-secret-value');
  });

  it.each([[[]], [['0.1.0']], [['v0.1']], [['v0.1.0', 'v0.2.0']], [['--bogus', 'v0.1.0']]])(
    'rejects the arguments %j before doing anything',
    async argv => {
      const w = world();
      expect(await main(argv, w.deps)).toBe(EXIT.usage);
      expect(w.runs).toEqual([]);
    },
  );

  it('needs the AMO key before checking anything unless it is a dry run', async () => {
    const w = world({env: {WEB_EXT_API_KEY: 'user:1:2'}});
    expect(await main(['v0.1.0'], w.deps)).toBe(EXIT.usage);
    expect(w.runs).toEqual([]);
    expect(w.out()).toContain('WEB_EXT_API_SECRET');
  });
});
