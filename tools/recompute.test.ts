import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';
import {createCoreBuilder} from '@intactwarden/builders/coreBuilder.ts';
import {
  bitwardenRequest,
  buildReleaseZip,
  CONFIGS,
  CLOUD,
  BASE,
  COMMIT,
  sha256,
  VERSION,
} from '../packages/builders/test/helpers/bitwardenFixture.ts';
import {
  VW_COMMIT,
  VW_TAG_OBJECT,
  VW_VERSION,
  vwRequest,
  vwTarball,
} from '../packages/builders/test/helpers/vaultwardenFixture.ts';
import {main, USAGE} from './recompute.ts';

const dir = mkdtempSync(join(tmpdir(), 'intactwarden-recompute-'));
afterAll(() => rmSync(dir, {recursive: true, force: true}));

const builder = createCoreBuilder();
const ZIP = buildReleaseZip();
const zipPath = join(dir, 'release.zip');
writeFileSync(zipPath, ZIP);
const configDir = join(dir, 'config');
mkdirSync(configDir);
// Only the files of cloud-us: the other region's euprd.json may be absent.
writeFileSync(join(configDir, 'base.json'), CONFIGS[BASE]!);
writeFileSync(join(configDir, 'cloud.json'), CONFIGS[CLOUD]!);

const BITWARDEN = [
  '--app',
  'bitwarden-web',
  '--version',
  VERSION,
  '--asset',
  zipPath,
  '--asset-sha256',
  sha256(ZIP),
  '--commit',
  COMMIT,
];

async function run(args: string[]): Promise<{code: number; stdout: string; stderr: string}> {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {stdout: t => void (stdout += t), stderr: t => void (stderr += t)});
  return {code, stdout, stderr};
}

describe('recompute', () => {
  it('writes the core the CoreBuilder builds and prints its sha256', async () => {
    for (const variant of ['selfhosted-commercial', 'cloud-us'] as const) {
      const out = join(dir, 'out', `${variant}.json`);
      const r = await run([
        ...BITWARDEN,
        '--variant',
        variant,
        '--config-dir',
        configDir,
        '--out',
        out,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const bytes = new Uint8Array(readFileSync(out));
      expect(r.stdout).toBe(`${sha256(bytes)}\n`);
      expect(bytes).toEqual((await builder.build(bitwardenRequest(ZIP, variant))).bytes);
      expect(r.stderr).toContain(`bitwarden-web@${VERSION}+${variant}: `);
    }
  });

  it('builds a Vaultwarden core with its tag object', async () => {
    const tarball = vwTarball();
    const asset = join(dir, 'release.tar.gz');
    writeFileSync(asset, tarball);
    const out = join(dir, 'vw.json');
    const r = await run([
      '--app',
      'vaultwarden-web',
      '--variant',
      'release',
      '--version',
      VW_VERSION,
      '--asset',
      asset,
      '--asset-sha256',
      sha256(tarball),
      '--commit',
      VW_COMMIT,
      '--tag-object',
      VW_TAG_OBJECT,
      '--out',
      out,
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(new Uint8Array(readFileSync(out))).toEqual(
      (await builder.build(vwRequest(tarball))).bytes,
    );
  });

  it('exits 1 when the build is refused, and writes nothing', async () => {
    const out = join(dir, 'refused.json');
    const digest = await run([
      ...BITWARDEN.slice(0, 7),
      '0'.repeat(64),
      '--commit',
      COMMIT,
      '--variant',
      'selfhosted-commercial',
      '--out',
      out,
    ]);
    expect(digest.code).toBe(1);
    expect(digest.stderr).toContain('refused (digest-mismatch)');
    // cloud-eu needs euprd.json, which the config directory does not have.
    const config = await run([
      ...BITWARDEN,
      '--variant',
      'cloud-eu',
      '--config-dir',
      configDir,
      '--out',
      out,
    ]);
    expect(config.code).toBe(1);
    expect(config.stderr).toContain('refused (unsupported)');
    expect(() => readFileSync(out)).toThrow();
  });

  it('exits 2 with the usage for bad arguments, 0 for --help', async () => {
    for (const args of [
      [],
      [...BITWARDEN, '--variant', 'selfhosted-commercial'],
      [...BITWARDEN, '--variant', 'selfhosted-oss', '--out', 'x'],
      [...BITWARDEN, '--variant', 'release', '--out', 'x'],
      ['--app', 'bitwarden-web', '--variant', 'cloud-us', '--version', '2026.10', '--out', 'x'],
      [...BITWARDEN, '--variant', 'cloud-us', '--out', 'x', '--sha256sums', 'y'],
      [...BITWARDEN, '--variant', 'cloud-us', '--out', 'x', 'extra'],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toContain(USAGE);
    }
    expect(await run(['--help'])).toEqual({code: 0, stdout: USAGE, stderr: ''});
  });

  it('runs as a script', () => {
    const script = fileURLToPath(new URL('./recompute.ts', import.meta.url));
    const out = join(dir, 'script.json');
    const stdout = execFileSync(
      process.execPath,
      [script, ...BITWARDEN, '--variant', 'selfhosted-commercial', '--out', out],
      {encoding: 'utf8'},
    );
    expect(stdout).toBe(`${sha256(new Uint8Array(readFileSync(out)))}\n`);
  });
});
